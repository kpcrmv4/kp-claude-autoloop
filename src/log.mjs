import { appendFileSync } from 'node:fs';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let logFilePath = null;
let fileOnly = false;

/**
 * @param {string|null} path append log lines to this file (null = off)
 * @param {{fileOnly?: boolean}} [opts] fileOnly: skip the console stream —
 *   used by detached mode where stdout is already redirected to the SAME
 *   file (writing both would duplicate every line)
 */
export function setLogFile(path, opts = {}) {
  logFilePath = path || null;
  fileOnly = Boolean(opts.fileOnly && logFilePath);
}

function stamp() {
  const d = new Date();
  // local time is friendlier when watching live in a terminal
  return d.toLocaleString('sv-SE'); // 2026-06-05 14:03:11
}

export function log(level, ...parts) {
  const body = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  const line = `[${stamp()}] [${level.toUpperCase()}] ${body}`;
  if (!fileOnly) {
    const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + '\n');
    } catch {
      // logging must never crash the watcher
    }
  }
}
