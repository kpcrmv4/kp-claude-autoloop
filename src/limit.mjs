// Detect a Claude Code usage/rate limit in a run's output, and extract the
// reset time. Source of truth (confirmed from the claude.exe binary strings):
//   - display:  "… · resets 3pm",  "resets in 2h 30m"
//   - headers:  anthropic-ratelimit-unified-reset (unix seconds),
//               retry-after (seconds), 429 status
// We parse whatever surfaces in stdout/stderr, most-precise format first.

const LIMIT_RE =
  /(usage limit reached|rate limit reached|rate[_-]?limited|exceeded your[^.]*limit|too many requests|\b429\b|anthropic-ratelimit-unified-status["'\s:=]+rejected)/i;

const SECONDS_10 = /\b(\d{10})\b/;
const MS_13 = /\b(\d{13})\b/;

/**
 * Parse the moment the limit resets, in epoch milliseconds.
 * @param {string} text combined stdout+stderr
 * @param {number} nowMs current time (injectable for tests)
 * @returns {number|null} epoch ms, or null when no reset hint is present
 */
export function parseResetMs(text, nowMs) {
  if (!text) return null;

  // 1) Unified-reset header → unix seconds (or ms)
  const unified = text.match(/anthropic-ratelimit-unified-reset["'\s:=]+(\d{10,13})/i);
  if (unified) return toEpochMs(unified[1]);

  // 2) Pipe form some surfaces use: "...usage limit reached|1780000000"
  const pipe = text.match(/reached\s*\|\s*(\d{10,13})/i);
  if (pipe) return toEpochMs(pipe[1]);

  // 3) retry-after: <seconds>
  const retry = text.match(/retry[-_]?after["'\s:=]+(\d{1,7})/i);
  if (retry) return nowMs + Number(retry[1]) * 1000;

  // 4) "resets <epoch>" inline
  const resetsEpoch = text.match(/resets?\s+(?:at\s+)?(\d{10,13})\b/i);
  if (resetsEpoch) return toEpochMs(resetsEpoch[1]);

  // 5) "resets in 2h 30m" / "resets in 45m" / "resets in 2 hours"
  const dur = text.match(
    /resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i,
  );
  if (dur && (dur[1] || dur[2])) {
    const h = Number(dur[1] || 0);
    const m = Number(dur[2] || 0);
    if (h || m) return nowMs + (h * 60 + m) * 60_000;
  }

  // 6) clock time: "resets at 3pm" / "resets 3:30pm" / "resets at 15:00"
  const clock = parseClock(text, nowMs);
  if (clock != null) return clock;

  return null;
}

function toEpochMs(digits) {
  const n = Number(digits);
  return digits.length >= 13 ? n : n * 1000;
}

function parseClock(text, nowMs) {
  let h;
  let min;

  const twelve = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
  if (twelve) {
    h = Number(twelve[1]) % 12;
    if (/p/i.test(twelve[3])) h += 12;
    min = Number(twelve[2] || 0);
  } else {
    const twentyFour = text.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\b/);
    if (!twentyFour) return null;
    h = Number(twentyFour[1]);
    min = Number(twentyFour[2]);
  }

  if (h > 23 || min > 59) return null;

  // next occurrence of that local wall-clock time
  const target = new Date(nowMs);
  target.setHours(h, min, 0, 0);
  if (target.getTime() <= nowMs) {
    target.setTime(target.getTime() + 24 * 3600 * 1000);
  }
  return target.getTime();
}

/**
 * Try to read the structured `{type:"result"}` object Claude Code prints with
 * `--output-format json`. Tolerates extra log lines around it.
 */
function tryParseJsonResult(stdout) {
  if (!stdout) return null;
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()];
  for (const raw of candidates) {
    const s = raw.trim();
    if (!s.startsWith('{')) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && obj.type === 'result') return obj;
    } catch {
      // not JSON; keep scanning
    }
  }
  return null;
}

/**
 * Classify a finished claude run.
 * @returns {{limited:boolean, ok:boolean, otherError:boolean, text:string}}
 */
export function classifyResult({ code, stdout = '', stderr = '' }) {
  const text = `${stdout}\n${stderr}`;
  const json = tryParseJsonResult(stdout);

  const jsonIsError = json ? json.is_error === true : false;
  const jsonText = json ? String(json.result ?? json.error ?? '') : '';

  const limited = LIMIT_RE.test(text) || (jsonIsError && LIMIT_RE.test(jsonText));
  const ok = !limited && code === 0 && jsonIsError !== true;
  const otherError = !limited && !ok;

  return { limited, ok, otherError, text };
}
