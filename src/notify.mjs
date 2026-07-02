// Webhook notifications (Telegram / Discord / Slack / generic JSON).
// CLI-first: the engine fires these on lifecycle events — no GUI needed.
// Adapted from the original autoresume notify module.

const STATUS_ICON = {
  start: '▶️',
  limited: '⏳',
  resumed: '🔄',
  done: '✅',
  error: '⛔',
  stopped: '🛑',
  test: '🔔',
};

/** Human-readable one-message form of an event. */
export function formatEventText(event) {
  const icon = STATUS_ICON[event.status] || 'ℹ️';
  return [
    `${icon} autoloop: ${event.status}`,
    event.project ? `project: ${event.project}` : null,
    event.message ? event.message : null,
    event.cycles != null ? `cycles: ${event.cycles}` : null,
    event.resumeAt ? `จะตื่น: ${new Date(event.resumeAt).toLocaleString('sv-SE')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build the HTTP request for a webhook, picking a payload shape by provider. Pure → testable. */
export function buildWebhookRequest(url, event) {
  const text = formatEventText(event);
  const headers = { 'content-type': 'application/json' };

  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) {
    return { method: 'POST', headers, body: JSON.stringify({ content: text }) };
  }
  if (/hooks\.slack\.com/i.test(url)) {
    return { method: 'POST', headers, body: JSON.stringify({ text }) };
  }
  // Telegram: URL carries the chat_id:
  //   https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
  if (/api\.telegram\.org\/bot/i.test(url)) {
    return { method: 'POST', headers, body: JSON.stringify({ text, disable_web_page_preview: true }) };
  }
  return { method: 'POST', headers, body: JSON.stringify({ text, event }) };
}

/** Fire one webhook. Returns {ok, status?}|{ok:false, error|skipped} — never throws. */
export async function sendWebhook(url, event) {
  if (!url) return { ok: false, skipped: true };
  try {
    const { method, headers, body } = buildWebhookRequest(url, event);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      return { ok: res.ok, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Resolve notify targets from secrets + env. Supported sources (all optional):
 *   secrets.telegram = { token, chatId }   → Telegram sendMessage URL
 *   secrets.webhookUrl                     → generic/Discord/Slack webhook
 *   env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   env AUTOLOOP_WEBHOOK_URL
 */
export function resolveTargets(secrets = {}, env = process.env) {
  const targets = [];
  const tg = secrets.telegram || {};
  const tgToken = tg.token || env.TELEGRAM_BOT_TOKEN;
  const tgChat = tg.chatId || env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    targets.push({
      kind: 'telegram',
      url: `https://api.telegram.org/bot${tgToken}/sendMessage?chat_id=${encodeURIComponent(tgChat)}`,
    });
  }
  const hook = secrets.webhookUrl || env.AUTOLOOP_WEBHOOK_URL;
  if (hook) targets.push({ kind: 'webhook', url: hook });
  return targets;
}

/** Fire-and-forget to every target. Never throws, never blocks the loop on failure. */
export async function notifyAll(targets, event) {
  const results = await Promise.all(targets.map((t) => sendWebhook(t.url, event)));
  return results;
}
