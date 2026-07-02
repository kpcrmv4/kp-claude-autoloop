/**
 * Sleep until an absolute epoch-ms target, in small ticks so the wait is
 * interruptible and can emit a heartbeat. Returns early if shouldStop() is set.
 *
 * @param {number} targetMs absolute wake time (epoch ms)
 * @param {object} [opts]
 * @param {(remainingMs:number)=>void} [opts.onTick] called once per tick while waiting
 * @param {()=>boolean} [opts.shouldStop] abort check
 * @param {number} [opts.tickMs] heartbeat interval (default 60s)
 */
export async function sleepUntil(targetMs, { onTick, shouldStop, tickMs = 60_000 } = {}) {
  while (Date.now() < targetMs) {
    if (shouldStop && shouldStop()) return;
    const remaining = targetMs - Date.now();
    if (onTick && remaining > tickMs) onTick(remaining);
    await delay(Math.min(tickMs, remaining));
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
