// Cool-looking live wait panel for the CLI (TTY only — detached/log mode keeps
// plain log lines). Shows: quota reset time, resume time, live countdown, and
// real plan progress parsed from the markdown checklist in the state file.
import { readFileSync, existsSync } from 'node:fs';
import { fmtDateTime } from './notify.mjs';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

/** Count `- [x]` vs `- [ ]` checklist items in the work-state file. */
export function readPlanProgress(stateFile) {
  try {
    if (!existsSync(stateFile)) return null;
    const text = readFileSync(stateFile, 'utf8');
    const done = (text.match(/^\s*[-*] \[[xX~]\]/gm) || []).length;
    const open = (text.match(/^\s*[-*] \[ \]/gm) || []).length;
    const total = done + open;
    if (!total) return null;
    const m = text.match(/^\s*[-*] \[ \]\s*(.+)$/m);
    const nextItem = m ? m[1].replace(/\*\*/g, '').trim().slice(0, 56) : null;
    return { done, total, pct: Math.round((done / total) * 100), nextItem };
  } catch {
    return null;
  }
}

export function progressBar(pct, width = 22) {
  const fill = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${C.green}${'█'.repeat(fill)}${C.dim}${'░'.repeat(width - fill)}${C.reset}`;
}

export function humanizeLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h} ชม.`);
  if (h || m) parts.push(`${m} นาที`);
  parts.push(`${String(sec).padStart(2, '0')} วิ`);
  return parts.join(' ');
}

/** Build the panel lines (pure → testable/previewable). */
export function renderWaitPanel({ project, cycles, maxCycles, waits, maxWaits, plan, resetAt, resumeAt, now = Date.now() }) {
  const L = [];
  const rule = `${C.dim}${'─'.repeat(56)}${C.reset}`;
  L.push('');
  L.push(`${C.yellow}⏳${C.reset} ${C.bold}${C.cyan}AUTOLOOP — พักรอโควตา Claude${C.reset} ${C.dim}(รอครั้งที่ ${waits}/${maxWaits})${C.reset}`);
  L.push(rule);
  L.push(`   ${C.dim}งาน${C.reset}             ${C.bold}${project}${C.reset}`);
  L.push(`   ${C.dim}รอบที่ทำสำเร็จ${C.reset}   ${cycles}/${maxCycles} รอบ`);
  if (plan) {
    L.push(`   ${C.dim}แผนคืบหน้า${C.reset}      ${progressBar(plan.pct)} ${C.bold}${plan.done}/${plan.total}${C.reset} ข้อ (${plan.pct}%)`);
    if (plan.nextItem) L.push(`   ${C.dim}ขั้นตอนถัดไป${C.reset}    ${C.magenta}${plan.nextItem}${C.reset}`);
  }
  L.push(rule);
  L.push(
    `   ${C.dim}โควตาปลดล็อก${C.reset}    ${resetAt ? fmtDateTime(resetAt) : `${C.yellow}ประเมินไม่ได้ — ใช้เวลาสำรอง${C.reset}`}`,
  );
  L.push(`   ${C.dim}เริ่มทำงานต่อ${C.reset}   ${C.green}${fmtDateTime(resumeAt)}${C.reset}`);
  L.push(`   ${C.dim}เหลืออีก${C.reset}        ${C.bold}${C.yellow}${humanizeLeft(resumeAt - now)}${C.reset}`);
  L.push(rule);
  L.push(`${C.dim}   นอนรอเอง ตื่นเอง ไม่ต้องเฝ้า · Ctrl+C = หยุดอย่างปลอดภัย${C.reset}`);
  return L;
}

/** In-place redraw helper: returns a draw() that repaints over its previous output. */
export function makePanelPainter(stream = process.stdout) {
  let prevLines = 0;
  return function draw(lines) {
    if (prevLines > 0) stream.write(`\x1b[${prevLines}A\x1b[0J`);
    stream.write(lines.join('\n') + '\n');
    prevLines = lines.length;
  };
}
