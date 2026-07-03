// Per-cycle model/effort selection driven by the plan's NEXT unchecked item.
// Lets one long run use a cheap model for routine units and switch to a
// heavier model exactly on the hard ones (payroll engine, gate reviews, …).
//
// Rules file shape (JSON, hot-reloaded every cycle):
// {
//   "default": { "model": "claude-sonnet-5", "effort": "high" },
//   "rules": [
//     { "match": "P4|payroll|เงินเดือน", "model": "claude-opus-4-8", "effort": "max" },
//     { "match": "gate|review|security", "model": "claude-opus-4-8", "effort": "high" }
//   ]
// }
// `match` = case-insensitive regex, tested against the next unchecked
// checklist item in the state file. First matching rule wins.
import { readFileSync, existsSync } from 'node:fs';

/** Load + validate the rules file. Never throws; bad file → null (with reason). */
export function loadModelRules(path) {
  if (!path) return { rules: null };
  try {
    if (!existsSync(path)) return { rules: null, warn: `ไม่พบไฟล์ model-rules: ${path}` };
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const rules = Array.isArray(raw.rules) ? raw.rules.filter((r) => r && r.match) : [];
    return { rules: { default: raw.default || null, rules } };
  } catch (err) {
    return { rules: null, warn: `อ่าน model-rules ไม่ได้ (${err.message}) — ใช้ค่า --model/--effort ปกติ` };
  }
}

/**
 * Pick {model, effort, matched} for this cycle.
 * Precedence: matching rule > rules.default > CLI fallback.
 */
export function pickModelForCycle(rules, nextItem, fallback = {}) {
  const base = {
    model: rules?.default?.model ?? fallback.model ?? null,
    effort: rules?.default?.effort ?? fallback.effort ?? null,
    matched: null,
  };
  if (!rules || !nextItem) return base;
  for (const r of rules.rules) {
    let re;
    try {
      re = new RegExp(r.match, 'i');
    } catch {
      continue; // broken pattern — skip, never crash the loop
    }
    if (re.test(nextItem)) {
      return {
        model: r.model ?? base.model,
        effort: r.effort ?? base.effort,
        matched: r.match,
      };
    }
  }
  return base;
}
