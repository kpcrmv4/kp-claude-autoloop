// Central registry of known runs (~/.autoloop/runs.json) so the localhost
// dashboard can find every run without scanning the disk. Each engine start
// registers its state file here; the dashboard reads live data from the
// per-run sidecar files themselves.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

/** AUTOLOOP_HOME override keeps tests away from the real home directory. */
export function registryPath() {
  const base = process.env.AUTOLOOP_HOME || join(homedir(), '.autoloop');
  return join(base, 'runs.json');
}

/** @returns {Array<{stateFile:string, cwd:string|null, registeredAt:string}>} */
export function readRegistry() {
  try {
    const data = JSON.parse(readFileSync(registryPath(), 'utf8'));
    return Array.isArray(data.runs) ? data.runs.filter((r) => r && r.stateFile) : [];
  } catch {
    return [];
  }
}

const MAX_ENTRIES = 50;

/** Upsert a run (newest first). Never throws — the engine must not die over bookkeeping. */
export function registerRun(stateFile, info = {}) {
  try {
    const key = resolve(stateFile); // normalize: `/` vs `\` ต้องนับเป็น run เดียวกัน
    const runs = readRegistry().filter((r) => resolve(r.stateFile) !== key);
    runs.unshift({ stateFile: key, cwd: info.cwd ? resolve(info.cwd) : null, registeredAt: new Date().toISOString() });
    writeRegistry(runs.slice(0, MAX_ENTRIES));
  } catch {
    /* best-effort */
  }
}

export function unregisterRun(stateFile) {
  try {
    const key = resolve(stateFile);
    writeRegistry(readRegistry().filter((r) => resolve(r.stateFile) !== key));
  } catch {
    /* best-effort */
  }
}

function writeRegistry(runs) {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ runs }, null, 2));
  renameSync(tmp, path);
}
