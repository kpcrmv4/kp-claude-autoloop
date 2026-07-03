#!/usr/bin/env node
// End-to-end smoke test against the mock claude:
//   limited → sleep(parsed 2s) → ok round → round that writes the stop marker → engine exits 0
// Asserts the runtime sidecar recorded the journey. No real quota is used.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dir = mkdtempSync(join(tmpdir(), 'autoloop-'));
const stateFile = join(dir, 'STATE.md');
const counterFile = join(dir, 'counter.txt');
writeFileSync(stateFile, '# test state\n- [ ] unit 1\n');
// pre-seed a stale sidecar from a "previous run" — a fresh start must clear it
writeFileSync(
  `${stateFile}.autoloop.json`,
  JSON.stringify({ status: 'error', doneReason: 'claude-error', lastError: 'stale-from-previous-run', resumeAt: '2020-01-01T00:00:00Z' }),
);

const mock = `node "${join(root, 'test', 'mock-claude.mjs')}"`;

const res = spawnSync(
  process.execPath,
  [
    join(root, 'bin', 'autoloop.mjs'),
    'run',
    '--cwd', dir,
    '--state-file', stateFile,
    '--session', 'test-session-id',
    '--prompt', 'do next round',
    '--claude-cmd', mock,
    '--max-cycles', '5',
    '--max-waits', '3',
    '--min-retry', '1',
    '--buffer', '0',
    '--fallback-wait-min', '1',
    '--no-notify', // never spam real Telegram/webhooks from tests
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, MOCK_COUNTER_FILE: counterFile, MOCK_STATE_FILE: stateFile },
    timeout: 60_000,
  },
);

const out = (res.stdout || '') + (res.stderr || '');
const sidecar = JSON.parse(readFileSync(`${stateFile}.autoloop.json`, 'utf8'));

const checks = [
  ['exit code 0', res.status === 0],
  ['detected the limit once', /โดน usage limit \(ครั้งที่ 1\//.test(out)],
  ['parsed reset & slept', /อ่านเวลา reset ได้/.test(out)],
  ['completed ≥2 ok rounds', /รอบสำเร็จ \(2\//.test(out)],
  ['finished via stop marker', /stop marker/.test(out) && /งานจบแล้ว/.test(out)],
  ['sidecar status=done', sidecar.status === 'done'],
  ['sidecar counted cycles', sidecar.cycles >= 1],
  ['sidecar recorded the limit', typeof sidecar.limitedAt === 'string'],
  ['marker really in state file', readFileSync(stateFile, 'utf8').includes('AUTOLOOP: COMPLETE')],
  // ไม่ได้ส่ง --model/--model-rules → ต้องเตือนเรื่อง default เครื่อง (กันเผาโควตาเงียบ ๆ)
  ['warned about machine-default model', /default ของเครื่อง/.test(out)],
  // sidecar เป็น merge-patch — รันใหม่ต้องล้างซากของรันก่อน ไม่ใช่ปล่อยค้าง
  ['stale lastError cleared on fresh start', sidecar.lastError === null],
  ['doneReason belongs to THIS run', ['stop-marker', 'reply-marker'].includes(sidecar.doneReason)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.log('\n--- engine output ---\n' + out);
  console.log('\n--- sidecar ---\n' + JSON.stringify(sidecar, null, 2));
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
