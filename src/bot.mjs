// Two-way Telegram: a long-poll listener that lives inside the dashboard
// process (the one long-lived autoloop process on the machine). Lets the user
// drive autoloop from the phone:
//   /status              → live "card" per run: HTML-bold name, ▰▰▰▱ progress
//                          bar, what Claude is doing now — with inline buttons
//                          (🔄 refresh edits the same message in place,
//                           ⏹ stop / ▶ continue act per run)
//   /stop [n]            → graceful stop via the stop-signal file (never force)
//   /continue [n]        → rerun a capped/stopped run with a fresh round budget
//   /help, /start        → command list
// Replies ONLY to the configured chatId — anyone else messaging the bot is ignored.
// Telegram allows a single getUpdates consumer per bot, so exactly one poller
// (this one) may run; pause() lets the setup modal borrow getUpdates briefly.
import { requestStop, updateRuntime } from './state.mjs';
import { fmtDateTime, progressBar } from './notify.mjs';
import { delay } from './sleep.mjs';

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const shortName = (r) => (r.cwd || r.stateFile || '').split(/[\\/]/).filter(Boolean).pop() || 'run';
const isAlive = (r) => r.alive && ['running', 'sleeping'].includes(r.status);
const canRerun = (r) => !isAlive(r) && ['stopped', 'error', 'unknown'].includes(r.status)
  || (!isAlive(r) && r.status === 'done' && r.doneReason === 'max-cycles')
  || (!r.alive && ['running', 'sleeping'].includes(r.status)); // died mid-run

/** สถานะหนึ่งบรรทัดต่อ run — ภาษาเดียวกับ chip บนหน้าเว็บ */
function statusLine(r) {
  const st = (r.status === 'running' || r.status === 'sleeping') && !r.alive ? 'dead' : r.status;
  if (st === 'running') return `🟢 กำลังทำงาน (รอบที่ ${(r.cycles ?? 0) + 1})`;
  if (st === 'sleeping') return `🟡 รอโควตา${r.resumeAt ? ` — จะกลับมา ${fmtDateTime(r.resumeAt)}` : ''}`;
  if (st === 'done' && r.doneReason === 'max-cycles') return '🟠 ครบรอบที่ตั้งไว้ — งานยังไม่จบ (กดปุ่มทำต่อได้เลย)';
  if (st === 'done') return '✅ เสร็จแล้ว';
  if (st === 'stopped') return '⏹ หยุดไว้';
  if (st === 'error') return `🔴 เจอปัญหา — เข้ามาดูหน่อย${r.lastError ? `\n   ${escHtml(String(r.lastError).slice(0, 120))}` : ''}`;
  if (st === 'dead') return '⚫ ตายกลางคัน — กดปุ่มทำต่อเพื่อกู้งาน';
  return `ℹ️ ${escHtml(st)}`;
}

/** Compose the /status reply (Telegram HTML). Pure → testable. */
export function formatStatusReply(runs) {
  if (!runs.length) return 'ยังไม่มีงานในระบบ — เริ่มงานแรกได้จากหน้า dashboard';
  const blocks = runs.map((r, i) => {
    const lines = [`<b>${i + 1}) ${escHtml(shortName(r))}</b>`, statusLine(r)];
    if (r.plan && r.plan.total) lines.push(`${progressBar(r.plan.pct)} ${r.plan.done}/${r.plan.total} ข้อ (${r.plan.pct}%)`);
    if (r.plan && r.plan.nextItem) lines.push(`ถัดไป: ${escHtml(String(r.plan.nextItem).slice(0, 90))}`);
    if (r.activity && r.status === 'running' && r.alive) lines.push(`ตอนนี้: ${escHtml(String(r.activity).slice(0, 90))}`);
    if (r.stopRequestedAt && isAlive(r)) lines.push('⏳ สั่งหยุดแล้ว — รอจบงานรอบปัจจุบัน');
    return lines.join('\n');
  });
  return `📊 <b>สถานะล่าสุด</b>\n\n${blocks.join('\n\n')}`;
}

/** Inline buttons under the status card: refresh + per-run stop/continue. Pure → testable. */
export function buildKeyboard(runs) {
  const rows = [[{ text: '🔄 อัปเดตสถานะ', callback_data: 'status' }]];
  runs.forEach((r, i) => {
    const name = shortName(r).slice(0, 24);
    if (isAlive(r) && !r.stopRequestedAt) rows.push([{ text: `⏹ หยุด ${name}`, callback_data: `stop:${i}` }]);
    else if (canRerun(r)) rows.push([{ text: `▶ ทำต่อ ${name}`, callback_data: `rerun:${i}` }]);
  });
  return { inline_keyboard: rows };
}

const HELP =
  'คุยกับ autoloop ได้จากที่นี่เลย:\n' +
  '/status — สถานะล่าสุดของทุกงาน (มีปุ่มกดสั่งงานใต้ข้อความ)\n' +
  '/stop — สั่งหยุดแบบรอให้งานรอบปัจจุบันเสร็จก่อน (หลายงาน: /stop <เลข>)\n' +
  '/continue — งานที่ครบรอบ/หยุดไว้ ให้ทำต่อด้วยงบรอบชุดใหม่ (หลายงาน: /continue <เลข>)\n' +
  '/help — ข้อความนี้';

function stopByIndex(runs, idx) {
  const target = runs[idx];
  if (!target) return `ไม่มีงานหมายเลข ${idx + 1} — ดูเลขจาก /status`;
  if (!isAlive(target)) return `งานหมายเลข ${idx + 1} ไม่ได้ทำงานอยู่`;
  requestStop(target.stateFile);
  updateRuntime(target.stateFile, { stopRequestedAt: new Date().toISOString() });
  return `รับทราบ ⏹ ${shortName(target)} จะหยุดเองหลังงานรอบปัจจุบันเสร็จ (เดี๋ยวมีข้อความยืนยันตามมา)`;
}

async function rerunByIndex(runs, idx, rerun) {
  const target = runs[idx];
  if (!target) return `ไม่มีงานหมายเลข ${idx + 1} — ดูเลขจาก /status`;
  if (isAlive(target)) return `${shortName(target)} ยังทำงานอยู่ ไม่ต้องสั่งต่อ`;
  if (!rerun) return 'ฟีเจอร์ทำต่อยังไม่พร้อมใช้งาน';
  const r = await rerun(target.stateFile);
  return r.code === 200
    ? `รับทราบ ▶ ${shortName(target)} กลับมาทำต่อแล้ว (session เดิม แผนเดิม) — เดี๋ยวมีรายงานความคืบหน้าตามมา`
    : `เริ่มไม่สำเร็จ: ${r.body?.error || 'unknown'}`;
}

/**
 * Handle one incoming command. Returns { text, keyboard? }.
 * `runs` comes from the same collector the dashboard uses.
 */
export async function handleCommand(text, runs, { rerun } = {}) {
  const cmd = String(text || '').trim();
  if (/^\/(start|help)\b/i.test(cmd)) return { text: HELP };
  if (/^\/status\b/i.test(cmd) || /^สถานะ/.test(cmd)) return { text: formatStatusReply(runs), keyboard: buildKeyboard(runs) };

  const stop = cmd.match(/^\/stop(?:\s+(\d+))?\s*$/i);
  if (stop) {
    const alive = runs.filter(isAlive);
    if (!alive.length) return { text: 'ไม่มีงานที่กำลังทำอยู่ให้หยุด' };
    if (stop[1]) return { text: stopByIndex(runs, Number(stop[1]) - 1) };
    if (alive.length === 1) return { text: stopByIndex(runs, runs.indexOf(alive[0])) };
    return { text: `มีงานทำอยู่ ${alive.length} ตัว — ระบุเลขด้วย เช่น /stop ${runs.indexOf(alive[0]) + 1}`, keyboard: buildKeyboard(runs) };
  }

  const cont = cmd.match(/^\/(?:continue|more)(?:\s+(\d+))?\s*$/i) || (/^ทำต่อ/.test(cmd) ? [cmd, ''] : null);
  if (cont) {
    const eligible = runs.filter(canRerun);
    if (!eligible.length) return { text: 'ไม่มีงานที่หยุด/ครบรอบให้ทำต่อ — ดูสถานะด้วย /status' };
    if (cont[1]) return { text: await rerunByIndex(runs, Number(cont[1]) - 1, rerun) };
    if (eligible.length === 1) return { text: await rerunByIndex(runs, runs.indexOf(eligible[0]), rerun) };
    return { text: `มีงานให้ทำต่อได้ ${eligible.length} ตัว — ระบุเลขด้วย เช่น /continue ${runs.indexOf(eligible[0]) + 1}`, keyboard: buildKeyboard(runs) };
  }

  return { text: `ไม่เข้าใจคำสั่งนี้\n\n${HELP}` };
}

/**
 * Start the long-poll loop. Returns { stop, pause, resume }.
 * Never throws — network hiccups just back off and retry.
 */
export function startTelegramBot({ token, chatId, getRuns, rerun, say = () => {} }) {
  let stopped = false;
  let paused = false;
  let offset = 0;
  let controller = null;

  const api = async (method, params) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    });
    return res.json();
  };

  const send = (payload) =>
    api('sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...payload }).catch(() => {});

  async function handleUpdate(u) {
    // ── inline button presses ──
    if (u.callback_query) {
      const cq = u.callback_query;
      if (String(cq.message?.chat?.id) !== String(chatId)) return;
      const runs = getRuns();
      const [action, idxRaw] = String(cq.data || '').split(':');
      let toast = '';
      try {
        if (action === 'status') {
          await api('editMessageText', {
            chat_id: chatId,
            message_id: cq.message.message_id,
            parse_mode: 'HTML',
            text: formatStatusReply(runs),
            reply_markup: buildKeyboard(runs),
          }).catch(() => {});
          toast = 'อัปเดตแล้ว';
        } else if (action === 'stop') {
          const reply = stopByIndex(runs, Number(idxRaw));
          await send({ text: reply });
          toast = 'สั่งหยุดแล้ว';
        } else if (action === 'rerun') {
          toast = 'กำลังเริ่ม…';
          await api('answerCallbackQuery', { callback_query_id: cq.id, text: toast }).catch(() => {});
          const reply = await rerunByIndex(runs, Number(idxRaw), rerun);
          await send({ text: reply });
          return;
        }
      } catch (err) {
        toast = `ผิดพลาด: ${err.message}`.slice(0, 190);
      }
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: toast }).catch(() => {});
      return;
    }

    // ── plain text commands ──
    const msg = u.message || u.edited_message;
    const text = msg?.text;
    if (!text) return;
    if (String(msg.chat?.id) !== String(chatId)) return; // ไม่ใช่เจ้าของ — เงียบไว้
    let out;
    try {
      out = await handleCommand(text, getRuns(), { rerun });
    } catch (err) {
      out = { text: `อ่านสถานะไม่สำเร็จ: ${err.message}` };
    }
    await send({ text: out.text, ...(out.keyboard ? { reply_markup: out.keyboard } : {}) });
  }

  (async () => {
    while (!stopped) {
      if (paused) {
        await delay(1000);
        continue;
      }
      try {
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40_000); // long poll 30s + slack
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`,
          { signal: controller.signal },
        );
        clearTimeout(timer);
        const body = await res.json();
        if (body.ok) {
          for (const u of body.result) {
            offset = u.update_id + 1;
            await handleUpdate(u);
          }
        } else {
          // 409 = someone else is consuming getUpdates (e.g. notify-setup wizard) — back off
          await delay(body.error_code === 409 ? 10_000 : 3000);
        }
      } catch {
        if (!stopped && !paused) await delay(3000);
      }
    }
  })();

  say(`🤖 Telegram bot รับคำสั่งแล้ว — ทัก /status หาบอทได้เลย`);
  return {
    stop() {
      stopped = true;
      try { controller?.abort(); } catch { /* ignore */ }
    },
    pause() {
      paused = true;
      try { controller?.abort(); } catch { /* ignore */ }
    },
    resume() {
      paused = false;
    },
  };
}
