import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { runClaudeOnce } from './runner.mjs';
import { classifyResult, parseResetMs } from './limit.mjs';
import { sleepUntil } from './sleep.mjs';
import { log } from './log.mjs';
import { stopMarkerPresent, updateRuntime } from './state.mjs';
import { notifyAll } from './notify.mjs';
import { readPlanProgress, renderWaitPanel, makePanelPainter, renderWorkHeader, makeSplitScreen } from './tui.mjs';
import { formatStreamEvent, makeJsonlSplitter } from './stream.mjs';
import { loadModelRules, pickModelForCycle } from './model-rules.mjs';

function humanizeWait(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Re-read the prompt each cycle so the user can hot-edit the prompt file mid-run. */
function resolvePrompt(cfg) {
  if (cfg.promptFile) {
    try {
      const text = readFileSync(cfg.promptFile, 'utf8').trim();
      if (text) return text;
      log('warn', `prompt file ว่าง (${cfg.promptFile}) — ใช้ --prompt แทน`);
    } catch (err) {
      log('warn', `อ่าน prompt file ไม่ได้ (${cfg.promptFile}): ${err.message} — ใช้ --prompt แทน`);
    }
  }
  return cfg.prompt;
}

/**
 * The autoloop core: drive one Claude session round-by-round until the work
 * state contains the stop marker (or limits/cycles run out).
 *
 * Per cycle:
 *   1. stop-marker check (work state file)          → done? exit 0
 *   2. run one headless `claude` turn (the round)
 *   3. limited? → parse real reset time from output → sleep until reset+buffer
 *      (unparsable → sleep `fallbackWaitMin`, default 300 = the "+5h" rule)
 *   4. ok?      → count cycle, marker in reply? → exit 0 · else next cycle
 *   5. other error → stop and surface (never blind-loop on real errors)
 *
 * Runtime heartbeat is merged into `<state-file>.autoloop.json` at every
 * transition so anything (humans, other agents) can watch progress.
 */
export async function runEngine(cfg) {
  const targets = cfg.notifyTargets || [];
  const project = basename(cfg.cwd || '');
  // awaited (≤10s timeout each) so terminal notifications aren't killed by
  // process.exit before they reach Telegram; never throws, never crashes the loop
  const notify = async (event) => {
    if (!targets.length) return;
    try {
      const results = await notifyAll(targets, { project, ...event });
      const failed = results.filter((r) => !r.ok && !r.skipped);
      if (failed.length) log('warn', `notify ล้มเหลว ${failed.length}/${results.length}: ${JSON.stringify(failed[0])}`);
    } catch {
      /* ignore */
    }
  };

  let stopRequested = false;
  const onSigint = () => {
    stopRequested = true;
    log('warn', 'SIGINT — จะหยุดหลังจบรอบปัจจุบัน (กดอีกครั้งเพื่อบังคับออก)');
    process.once('SIGINT', () => process.exit(130));
  };
  process.on('SIGINT', onSigint);

  updateRuntime(cfg.stateFile, {
    pid: process.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
    cwd: cfg.cwd,
    sessionId: cfg.sessionId || null,
    stopMarker: cfg.stopMarker,
    cycles: 0,
    waits: 0,
    lastResult: null,
  });
  await notify({ status: 'start', message: `จะทำงานเองสูงสุด ${cfg.maxCycles} รอบจนกว่างานจะเสร็จ · ถ้าโควตาหมดจะพักรอแล้วกลับมาทำต่อเองอัตโนมัติ` });

  let cycles = 0;
  let waits = 0;
  let wasLimited = false;

  try {
    while (!stopRequested) {
      // 1) stop marker beats everything — checked BEFORE burning a turn
      if (stopMarkerPresent(cfg.stateFile, cfg.stopMarker)) {
        log('info', `พบ stop marker "${cfg.stopMarker}" ใน ${cfg.stateFile} — งานจบแล้ว ✅`);
        updateRuntime(cfg.stateFile, { status: 'done', doneReason: 'stop-marker', cycles, waits });
        await notify({ status: 'done', message: 'งานครบทุกข้อตามแผนแล้ว ปิดจ๊อบเรียบร้อย 🎉', cycles });
        return 0;
      }

      const prompt = resolvePrompt(cfg);
      const planNow = readPlanProgress(cfg.stateFile);

      // ── per-cycle model/effort: match the NEXT work item against rules
      //    (hot-reloaded each cycle so the user can tune mid-run) ──
      const { rules, warn: rulesWarn } = loadModelRules(cfg.modelRulesFile);
      if (rulesWarn) log('warn', rulesWarn);
      const picked = pickModelForCycle(rules, planNow?.nextItem, { model: cfg.model, effort: cfg.effort });

      log(
        'info',
        `→ cycle ${cycles + 1}/${cfg.maxCycles} · ${cfg.sessionId ? 'resume ' + cfg.sessionId.slice(0, 8) : 'continue'}` +
          ` · model ${picked.model || '(default)'}${picked.effort ? '/' + picked.effort : ''}${picked.matched ? ` (rule: ${picked.matched})` : ''}` +
          (planNow ? ` · แผน ${planNow.done}/${planNow.total} ข้อ (${planNow.pct}%)${planNow.nextItem ? ` · ถัดไป: ${planNow.nextItem}` : ''}` : ''),
      );
      updateRuntime(cfg.stateFile, { status: 'running', lastCycleStartedAt: new Date().toISOString() });

      // ── live split-screen: pinned progress header on top, Claude's activity
      //    streaming underneath (TTY only; detached/log mode stays plain) ──
      const live = process.stdout.isTTY;
      let split = null;
      let headerTimer = null;
      let lastActivity = null;
      const cycleStartedAt = Date.now();
      const headerLines = () =>
        renderWorkHeader({
          project,
          cycles,
          maxCycles: cfg.maxCycles,
          plan: readPlanProgress(cfg.stateFile),
          startedAt: cycleStartedAt,
          activity: lastActivity,
          model: picked.model ? `${picked.model}${picked.effort ? '/' + picked.effort : ''}` : null,
        });
      let onStdout;
      if (live) {
        split = makeSplitScreen();
        split.open(headerLines());
        headerTimer = setInterval(() => split.update(headerLines()), 1000);
        onStdout = makeJsonlSplitter((obj) => {
          const { lines, activity } = formatStreamEvent(obj);
          if (activity) lastActivity = activity;
          for (const ln of lines) split.writeLine(ln);
        });
      }

      let res;
      try {
        res = await runClaudeOnce({ ...cfg, prompt, model: picked.model, effort: picked.effort, streamJson: true, onStdout });
      } finally {
        if (headerTimer) clearInterval(headerTimer);
        if (split) split.close();
      }
      const verdict = classifyResult(res);

      // 2) usage limit → sleep until the real reset time (or the +Nh fallback)
      if (verdict.limited) {
        waits += 1;
        const now = Date.now();
        const reset = parseResetMs(verdict.text, now);
        const target =
          reset != null
            ? Math.max(reset + cfg.bufferSec * 1000, now + cfg.minRetrySec * 1000)
            : now + cfg.fallbackWaitMin * 60_000;

        log(
          'warn',
          `โดน usage limit (ครั้งที่ ${waits}/${cfg.maxWaits}) · ` +
            (reset != null
              ? `อ่านเวลา reset ได้ → ตื่น ~${new Date(target).toLocaleString('sv-SE')}`
              : `อ่านเวลา reset ไม่ได้ → ใช้ fallback +${cfg.fallbackWaitMin} นาที`) +
            ` (รอ ~${humanizeWait(target - now)})`,
        );
        updateRuntime(cfg.stateFile, {
          status: 'sleeping',
          lastResult: 'limited',
          limitedAt: new Date(now).toISOString(),
          resumeAt: new Date(target).toISOString(),
          waits,
        });
        await notify({
          status: 'limited',
          message: `พักรอครั้งที่ ${waits} (เพดาน ${cfg.maxWaits} ครั้ง)${reset == null ? ' · ระบบกะเวลาปลดล็อกไม่ได้ เลยใช้เวลาสำรองแทน' : ''}`,
          cycles,
          resumeAt: target,
        });
        wasLimited = true;

        if (waits >= cfg.maxWaits) {
          log('error', `ครบ maxWaits (${cfg.maxWaits}) — หยุด`);
          updateRuntime(cfg.stateFile, { status: 'error', doneReason: 'max-waits' });
          await notify({ status: 'error', message: `พักรอโควตาครบ ${cfg.maxWaits} ครั้งแล้วยังไปต่อไม่ได้ — หยุดไว้ก่อน รบกวนเข้ามาเช็คครับ`, cycles });
          return 1;
        }

        if (process.stdout.isTTY) {
          // live cool-mode: repaint a countdown panel every second
          const paint = makePanelPainter();
          const panelState = () => ({
            project,
            cycles,
            maxCycles: cfg.maxCycles,
            waits,
            maxWaits: cfg.maxWaits,
            plan: readPlanProgress(cfg.stateFile),
            resetAt: reset,
            resumeAt: target,
          });
          paint(renderWaitPanel(panelState()));
          await sleepUntil(target, {
            shouldStop: () => stopRequested,
            tickMs: 1000,
            onTick: () => paint(renderWaitPanel(panelState())),
          });
          paint(renderWaitPanel(panelState())); // final 0s frame
          process.stdout.write('\n');
          log('info', stopRequested ? '⏹ ยกเลิกการรอ — หยุดตามคำสั่งผู้ใช้' : '⏰ ถึงเวลาแล้ว — กลับมาทำงานต่อ');
        } else {
          await sleepUntil(target, {
            shouldStop: () => stopRequested,
            onTick: (left) => log('debug', `… นอนรอ limit reset เหลือ ~${Math.ceil(left / 60_000)} นาที`),
          });
        }
        // ping ทันทีที่ตื่น — ไม่ต้องรอรอบแรกสำเร็จ (ผู้ใช้จะได้รู้ว่ากลับมาแล้ว;
        // ถ้าติดลิมิตซ้ำ/มีปัญหา จะมีข้อความตามมาเอง — เงียบ = กำลังทำงาน)
        if (!stopRequested) {
          await notify({
            status: 'resumed',
            message: 'ตื่นตามเวลาแล้ว เริ่มทำงานต่อ — เงียบหลังจากนี้ = กำลังทำงานปกติ (ติดลิมิตซ้ำ/มีปัญหาจะแจ้งอีกครั้ง)',
            cycles,
          });
        }
        continue;
      }

      // 3) clean round
      if (verdict.ok) {
        cycles += 1;
        log('info', `✓ รอบสำเร็จ (${cycles}/${cfg.maxCycles})`);
        updateRuntime(cfg.stateFile, {
          status: 'running',
          lastResult: 'ok',
          cycles,
          lastCycleFinishedAt: new Date().toISOString(),
        });
        if (wasLimited) {
          await notify({ status: 'resumed', message: 'ยืนยัน: รอบแรกหลังพักทำสำเร็จ โควตากลับมาเต็มตัว เดินหน้าต่อเอง', cycles });
          wasLimited = false;
        }

        // agent announced completion in its reply (belt & braces with the file marker)
        if (cfg.stopMarker && verdict.text.includes(cfg.stopMarker)) {
          log('info', `agent ตอบ stop marker "${cfg.stopMarker}" — งานจบแล้ว ✅`);
          updateRuntime(cfg.stateFile, { status: 'done', doneReason: 'reply-marker' });
          await notify({ status: 'done', message: 'ตัวทำงานยืนยันว่างานเสร็จครบแล้ว 🎉', cycles });
          return 0;
        }
        if (cycles >= cfg.maxCycles) {
          log('info', 'ครบ maxCycles — หยุดตามเพดานที่ตั้งไว้');
          updateRuntime(cfg.stateFile, { status: 'done', doneReason: 'max-cycles' });
          await notify({ status: 'done', message: `ทำครบโควตา ${cfg.maxCycles} รอบที่ตั้งไว้แล้ว — งานอาจยังไม่จบ เข้ามาดูความคืบหน้าแล้วสั่งรอบเพิ่มได้`, cycles });
          return 0;
        }
        if (cfg.cooldownSec > 0) {
          await sleepUntil(Date.now() + cfg.cooldownSec * 1000, { shouldStop: () => stopRequested });
        }
        continue;
      }

      // 4) genuine non-limit error → surface, don't blind-loop
      log('error', `claude จบด้วย error ที่ไม่ใช่ limit (code=${res.code}) — หยุด`);
      const tail = (res.stderr || res.stdout || '').slice(-1500).trim();
      if (tail) log('error', tail);
      updateRuntime(cfg.stateFile, { status: 'error', doneReason: 'claude-error', lastError: tail.slice(-500) });
      await notify({ status: 'error', message: `หยุดเพราะเจอปัญหา (ไม่ใช่เรื่องโควตา) — รายละเอียดท้ายนี้\n${tail.slice(-300)}`, cycles });
      return 1;
    }

    log('info', 'หยุดตามคำสั่งผู้ใช้ (SIGINT)');
    updateRuntime(cfg.stateFile, { status: 'stopped', doneReason: 'sigint' });
    await notify({ status: 'stopped', message: 'หยุดเรียบร้อย งานที่ทำไว้ถูกเก็บครบ กลับมาสั่งต่อเมื่อไหร่ก็ได้', cycles });
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
