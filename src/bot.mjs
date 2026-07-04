// Two-way Telegram: a long-poll listener that lives inside the dashboard
// process (the one long-lived autoloop process on the machine). Lets the user
// chat with their notify bot from the phone:
//   /status          → live summary of every run (same data as the dashboard)
//   /stop [n]        → graceful stop via the stop-signal file (never force-kills)
//   /help, /start    → command list
// Replies ONLY to the configured chatId — anyone else messaging the bot is ignored.
// Telegram allows a single getUpdates consumer per bot, so exactly one poller
// (this one) may run; pause() lets the setup modal borrow getUpdates briefly.
import { requestStop, updateRuntime } from './state.mjs';
import { fmtDateTime } from './notify.mjs';
import { delay } from './sleep.mjs';

/** สถานะหนึ่งบรรทัดต่อ run — ภาษาเดียวกับ chip บนหน้าเว็บ */
function statusLine(r) {
  const st = (r.status === 'running' || r.status === 'sleeping') && !r.alive ? 'dead' : r.status;
  if (st === 'running') return `🟢 กำลังทำงาน (รอบที่ ${(r.cycles ?? 0) + 1})`;
  if (st === 'sleeping') return `🟡 รอโควตา${r.resumeAt ? ` — จะกลับมา ${fmtDateTime(r.resumeAt)}` : ''}`;
  if (st === 'done' && r.doneReason === 'max-cycles') return '🟠 ครบรอบที่ตั้งไว้ — งานยังไม่จบ (สั่ง /stop ไม่ได้ ใช้ปุ่มรันต่อบนหน้าเว็บ)';
  if (st === 'done') return '✅ เสร็จแล้ว';
  if (st === 'stopped') return '⏹ หยุดไว้';
  if (st === 'error') return `🔴 เจอปัญหา — เข้ามาดูหน่อย${r.lastError ? `\n   ${String(r.lastError).slice(0, 120)}` : ''}`;
  if (st === 'dead') return '⚫ ตายกลางคัน — เข้ามาเช็คแล้วสั่งรันต่อได้';
  return `ℹ️ ${st}`;
}

/** Compose the /status reply. Pure → testable. */
export function formatStatusReply(runs) {
  if (!runs.length) return 'ยังไม่มีงานในระบบ — เริ่มงานแรกได้จากหน้า dashboard';
  const blocks = runs.map((r, i) => {
    const name = (r.cwd || r.stateFile || '').split(/[\\/]/).filter(Boolean).pop() || `run ${i + 1}`;
    const lines = [`${i + 1}) ${name}`, `   ${statusLine(r)}`];
    if (r.plan && r.plan.total) lines.push(`   แผน ${r.plan.done}/${r.plan.total} ข้อ (${r.plan.pct}%)`);
    if (r.plan && r.plan.nextItem) lines.push(`   ถัดไป: ${String(r.plan.nextItem).slice(0, 90)}`);
    if (r.activity && r.status === 'running' && r.alive) lines.push(`   ตอนนี้: ${String(r.activity).slice(0, 90)}`);
    return lines.join('\n');
  });
  return `📊 สถานะล่าสุด\n\n${blocks.join('\n\n')}`;
}

const HELP =
  'คุยกับ autoloop ได้จากที่นี่เลย:\n' +
  '/status — สถานะล่าสุดของทุกงาน\n' +
  '/stop — สั่งหยุดแบบรอให้งานรอบปัจจุบันเสร็จก่อน (หลายงาน: /stop <เลข>)\n' +
  '/help — ข้อความนี้';

/**
 * Handle one incoming command. Returns the reply text.
 * `runs` comes from the same collector the dashboard uses. Pure except /stop,
 * which drops the graceful stop-signal file (never a force kill from chat).
 */
export function handleCommand(text, runs) {
  const cmd = String(text || '').trim();
  if (/^\/(start|help)\b/i.test(cmd)) return HELP;
  if (/^\/status\b/i.test(cmd) || /^สถานะ/.test(cmd)) return formatStatusReply(runs);

  const stop = cmd.match(/^\/stop(?:\s+(\d+))?\s*$/i);
  if (stop) {
    const alive = runs.filter((r) => r.alive && ['running', 'sleeping'].includes(r.status));
    if (!alive.length) return 'ไม่มีงานที่กำลังทำอยู่ให้หยุด';
    let target;
    if (stop[1]) {
      target = runs[Number(stop[1]) - 1];
      if (!target) return `ไม่มีงานหมายเลข ${stop[1]} — ดูเลขจาก /status`;
      if (!(target.alive && ['running', 'sleeping'].includes(target.status))) return `งานหมายเลข ${stop[1]} ไม่ได้ทำงานอยู่`;
    } else if (alive.length === 1) {
      target = alive[0];
    } else {
      return `มีงานทำอยู่ ${alive.length} ตัว — ระบุเลขด้วย เช่น /stop ${runs.indexOf(alive[0]) + 1}\n\n${formatStatusReply(runs)}`;
    }
    requestStop(target.stateFile);
    updateRuntime(target.stateFile, { stopRequestedAt: new Date().toISOString() });
    const name = (target.cwd || target.stateFile).split(/[\\/]/).filter(Boolean).pop();
    return `รับทราบ ⏹ ${name} จะหยุดเองหลังงานรอบปัจจุบันเสร็จ (เดี๋ยวมีข้อความยืนยันตามมา)`;
  }

  return `ไม่เข้าใจคำสั่งนี้\n\n${HELP}`;
}

/**
 * Start the long-poll loop. Returns { stop, pause, resume }.
 * Never throws — network hiccups just back off and retry.
 */
export function startTelegramBot({ token, chatId, getRuns, say = () => {} }) {
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

  async function handleUpdate(u) {
    const msg = u.message || u.edited_message;
    const text = msg?.text;
    if (!text) return;
    if (String(msg.chat?.id) !== String(chatId)) return; // ไม่ใช่เจ้าของ — เงียบไว้
    let reply;
    try {
      reply = handleCommand(text, getRuns());
    } catch (err) {
      reply = `อ่านสถานะไม่สำเร็จ: ${err.message}`;
    }
    await api('sendMessage', { chat_id: chatId, text: reply }).catch(() => {});
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
