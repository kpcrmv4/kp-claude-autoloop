// Interactive Telegram setup wizard (CLI, no GUI):
//   token → validate via getMe → auto-detect chat id via getUpdates
//   (user just messages the bot) → write gitignored secrets → send test.
// The token is never echoed back in full — only a masked form.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { sendWebhook } from './notify.mjs';

export function maskToken(token) {
  if (!token) return '(none)';
  const s = String(token);
  return s.length <= 10 ? '***' : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function tg(token, method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.telegram.org/bot${token}/${method}${qs ? '?' + qs : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } catch (err) {
    return { ok: false, description: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate a bot token; returns {ok, username} — pure API, testable. */
export async function validateBotToken(token) {
  const me = await tg(token, 'getMe');
  return me?.ok ? { ok: true, username: me.result?.username } : { ok: false, error: me?.description };
}

/** Find the most recent chat that messaged the bot. */
export async function detectChatId(token) {
  const upd = await tg(token, 'getUpdates', { limit: 20 });
  if (!upd?.ok || !Array.isArray(upd.result) || upd.result.length === 0) return null;
  for (const u of [...upd.result].reverse()) {
    const chat = u.message?.chat || u.edited_message?.chat || u.channel_post?.chat;
    if (chat?.id) {
      return { chatId: String(chat.id), label: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '' };
    }
  }
  return null;
}

export async function runNotifySetup({ secretsFile }) {
  const rl = createInterface({ input, output });
  const say = (s) => output.write(s + '\n');
  try {
    say('');
    say('🔧 ตั้งค่าแจ้งเตือน Telegram (ตัวช่วยใน CLI — ไม่ต้องแก้ไฟล์เอง)');
    say('   ยังไม่มีบอท? เปิด Telegram คุยกับ @BotFather → /newbot → ได้ token มา');
    say('');

    let existing = {};
    try {
      if (existsSync(secretsFile)) existing = JSON.parse(readFileSync(secretsFile, 'utf8')) || {};
    } catch {
      /* start fresh */
    }
    if (existing.telegram?.token) {
      say(`พบการตั้งค่าเดิม: token ${maskToken(existing.telegram.token)} · chatId ${existing.telegram.chatId || '-'}`);
      const re = (await rl.question('ตั้งค่าใหม่ทับของเดิม? (y/N): ')).trim().toLowerCase();
      if (re !== 'y') {
        say('คงค่าเดิมไว้ — ทดสอบได้ด้วย: autoloop notify-test');
        return 0;
      }
    }

    // 1) token
    let token = '';
    let botName = '';
    while (true) {
      token = (await rl.question('วาง bot token: ')).trim();
      if (!token) {
        say('ยกเลิก — ไม่มีการเปลี่ยนแปลง');
        return 1;
      }
      output.write('  กำลังตรวจ token กับ Telegram… ');
      const v = await validateBotToken(token);
      if (v.ok) {
        botName = v.username;
        say(`ใช้ได้ ✅ (บอท: @${botName})`);
        break;
      }
      say(`ไม่ผ่าน ❌ (${v.error || 'unknown'}) — ลองใหม่ หรือ Enter เปล่าเพื่อยกเลิก`);
    }

    // 2) chat id — auto-detect first, manual fallback
    let chatId = '';
    say('');
    say(`ขั้นต่อไป: เปิด Telegram แล้ว "ส่งข้อความอะไรก็ได้" หาบอท @${botName} (กด Start ก่อนถ้ายังไม่เคยคุย)`);
    await rl.question('ส่งแล้วกด Enter เพื่อให้ระบบหา chat id ให้เอง… ');
    for (let attempt = 1; attempt <= 3 && !chatId; attempt++) {
      const found = await detectChatId(token);
      if (found) {
        const okAns = (await rl.question(`เจอแชท: ${found.label || '(ไม่มีชื่อ)'} · chat id = ${found.chatId} — ใช้ตัวนี้? (Y/n): `))
          .trim()
          .toLowerCase();
        if (okAns !== 'n') chatId = found.chatId;
      } else if (attempt < 3) {
        await rl.question('ยังไม่เจอข้อความเข้าบอท — ส่งอีกครั้งแล้วกด Enter… ');
      }
    }
    if (!chatId) {
      chatId = (await rl.question('หาอัตโนมัติไม่เจอ — พิมพ์ chat id เอง (หรือ Enter เพื่อยกเลิก): ')).trim();
      if (!chatId) {
        say('ยกเลิก — ไม่มีการเปลี่ยนแปลง');
        return 1;
      }
    }

    // 3) save (merge — keep webhookUrl etc.)
    const next = { ...existing, telegram: { token, chatId } };
    writeFileSync(secretsFile, JSON.stringify(next, null, 2));
    say(`บันทึกแล้ว → ${secretsFile} (gitignored — ไม่ติดขึ้น GitHub)`);

    // 4) live test
    output.write('ส่งข้อความทดสอบ… ');
    const res = await sendWebhook(
      `https://api.telegram.org/bot${token}/sendMessage?chat_id=${encodeURIComponent(chatId)}`,
      { status: 'test', message: 'ตั้งค่าเสร็จแล้ว — autoloop จะรายงานเข้าห้องนี้ ✅' },
    );
    say(res.ok ? 'สำเร็จ ✅ เช็ค Telegram ได้เลย' : `ล้มเหลว ❌ ${JSON.stringify(res)}`);
    return res.ok ? 0 : 1;
  } finally {
    rl.close();
  }
}
