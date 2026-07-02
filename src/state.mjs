import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

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

/** Does the work-state file contain the stop marker? (missing file = not stopped) */
export function stopMarkerPresent(stateFile, marker) {
  if (!marker) return false;
  try {
    if (!existsSync(stateFile)) return false;
    return readFileSync(stateFile, 'utf8').includes(marker);
  } catch {
    return false; // unreadable state must never crash the watcher
  }
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
