import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';

/**
 * Two kinds of state, deliberately separated:
 *
 * 1. WORK STATE  (`--state-file`, e.g. STATE.md) — owned by the agent/user.
 *    The Claude session updates it every round (checklists, log lines).
 *    autoloop only *reads* it, looking for the stop marker.
 *
 * 2. RUNTIME STATE (`<state-file>.autoloop.json`) — owned by autoloop.
 *    Machine-written heartbeat: pid, cycles, limit hits, next wake time.
 *    Safe to delete anytime; never contains secrets.
 */

export function runtimePath(stateFile) {
  return `${stateFile}.autoloop.json`;
}

/**
 * Cooperative stop signal (`<state-file>.autoloop.stop`). Windows has no real
 * signals — process.kill() there is TerminateProcess (instant death mid-round),
 * so "stop gracefully" is a file the engine polls at round boundaries instead.
 */
export function stopSignalPath(stateFile) {
  return `${stateFile}.autoloop.stop`;
}

export function requestStop(stateFile) {
  writeFileSync(stopSignalPath(stateFile), new Date().toISOString());
}

export function stopSignalPresent(stateFile) {
  try {
    return existsSync(stopSignalPath(stateFile));
  } catch {
    return false;
  }
}

export function clearStopSignal(stateFile) {
  try {
    unlinkSync(stopSignalPath(stateFile));
  } catch {
    /* already gone */
  }
}

/**
 * Does the work-state file DECLARE the stop marker? The contract is "เติมบรรทัด
 * <marker> ท้ายไฟล์" — so the marker must BE a line of its own (markdown bold
 * tolerated). A sentence that merely mentions it (e.g. a round-log line saying
 * "ไม่เติม AUTOLOOP: COMPLETE เพราะ…") must NEVER stop the loop — a substring
 * check here false-done'd a real 26-round run.
 * (missing file = not stopped)
 */
export function stopMarkerPresent(stateFile, marker) {
  if (!marker) return false;
  try {
    if (!existsSync(stateFile)) return false;
    return readFileSync(stateFile, 'utf8')
      .split(/\r?\n/)
      .some((line) => {
        const t = line.trim().replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();
        return t === marker;
      });
  } catch {
    return false; // unreadable state must never crash the watcher
  }
}

/**
 * Strict completion claim from the agent's reply: the LAST non-empty line must
 * BE the marker. A mere mention ("ยังไม่ถึงเงื่อนไข AUTOLOOP: COMPLETE …")
 * anywhere in the reply must never stop the loop — the round prompt's contract
 * is "ตอบแค่ <marker>".
 */
export function replyAnnouncesMarker(replyText, marker) {
  if (!marker || !replyText) return false;
  const lines = String(replyText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === marker;
}

export function readRuntime(stateFile) {
  try {
    return JSON.parse(readFileSync(runtimePath(stateFile), 'utf8'));
  } catch {
    return null;
  }
}

/** Merge-patch the runtime sidecar (atomic-ish: write temp then rename). */
export function updateRuntime(stateFile, patch) {
  const path = runtimePath(stateFile);
  const current = readRuntime(stateFile) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
  } catch {
    /* heartbeat must never crash the watcher */
  }
  return next;
}
