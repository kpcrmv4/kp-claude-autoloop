#!/usr/bin/env node
// Unit tests for per-cycle model selection — the quota safety net.
// Pure in-process (no subprocess, no quota). Run before the smoke test.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModelRules, pickModelForCycle } from '../src/model-rules.mjs';
import { setLogFile, log } from '../src/log.mjs';
import { replyAnnouncesMarker, requestStop, stopSignalPresent, clearStopSignal } from '../src/state.mjs';
import { classifyResult } from '../src/limit.mjs';
import { withLoopProtocol } from '../src/engine.mjs';
import { formatEventText } from '../src/notify.mjs';

const dir = mkdtempSync(join(tmpdir(), 'autoloop-unit-'));
const writeRules = (name, obj) => {
  const p = join(dir, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('no rules file → CLI fallback wins', () => {
  const { rules, warn } = loadModelRules(null);
  assert.equal(warn, undefined);
  const p = pickModelForCycle(rules, 'อะไรก็ได้', { model: 'claude-sonnet-5', effort: 'high' });
  assert.equal(p.model, 'claude-sonnet-5');
  assert.equal(p.effort, 'high');
  assert.equal(p.matched, null);
});

test('no rules + no CLI model → null (= default เครื่อง, จุดที่ engine ต้องเตือน)', () => {
  const p = pickModelForCycle(null, 'x', {});
  assert.equal(p.model, null);
  assert.equal(p.effort, null);
});

test('matching rule beats default (first match wins, case-insensitive)', () => {
  const path = writeRules('full.json', {
    default: { model: 'claude-sonnet-5', effort: 'high' },
    rules: [
      { match: 'payroll|เงินเดือน', model: 'claude-opus-4-8', effort: 'max' },
      { match: 'payroll', model: 'never-reached' },
    ],
  });
  const { rules, warn } = loadModelRules(path);
  assert.equal(warn, undefined);
  const p = pickModelForCycle(rules, 'P4 Payroll engine', { model: 'cli-model' });
  assert.equal(p.model, 'claude-opus-4-8');
  assert.equal(p.effort, 'max');
  assert.equal(p.matched, 'payroll|เงินเดือน');
});

test('non-matching item falls to rules.default (not CLI)', () => {
  const path = writeRules('def.json', {
    default: { model: 'claude-sonnet-5', effort: 'high' },
    rules: [{ match: 'payroll', model: 'claude-opus-4-8' }],
  });
  const { rules } = loadModelRules(path);
  const p = pickModelForCycle(rules, 'แก้ docs หน้า about', { model: 'cli-model' });
  assert.equal(p.model, 'claude-sonnet-5');
  assert.equal(p.matched, null);
});

test('rules file without "default" → warn + falls through to CLI model', () => {
  const path = writeRules('nodefault.json', { rules: [{ match: 'payroll', model: 'claude-opus-4-8' }] });
  const { rules, warn } = loadModelRules(path);
  assert.ok(warn && warn.includes('ไม่มี "default"'), `expected missing-default warn, got: ${warn}`);
  const p = pickModelForCycle(rules, 'งานทั่วไป', { model: 'claude-sonnet-5' });
  assert.equal(p.model, 'claude-sonnet-5');
});

test('empty default {} counts as missing (ตาข่ายขาด)', () => {
  const path = writeRules('emptydefault.json', { default: {}, rules: [] });
  const { rules, warn } = loadModelRules(path);
  assert.ok(warn, 'expected warn for empty default');
  assert.equal(rules.default, null);
});

test('no nextItem → rules skipped, default still applies', () => {
  const path = writeRules('next.json', {
    default: { model: 'claude-sonnet-5' },
    rules: [{ match: '.*', model: 'claude-opus-4-8' }],
  });
  const { rules } = loadModelRules(path);
  const p = pickModelForCycle(rules, null, { model: 'cli-model' });
  assert.equal(p.model, 'claude-sonnet-5');
  assert.equal(p.matched, null);
});

test('broken regex rule is skipped, never crashes the loop', () => {
  const path = writeRules('broken.json', {
    default: { model: 'claude-sonnet-5' },
    rules: [
      { match: '([', model: 'boom' },
      { match: 'docs', model: 'claude-haiku-4-5', effort: 'low' },
    ],
  });
  const { rules } = loadModelRules(path);
  const p = pickModelForCycle(rules, 'อัปเดต docs', {});
  assert.equal(p.model, 'claude-haiku-4-5');
  assert.equal(p.effort, 'low');
});

test('unreadable rules file → warn + CLI fallback', () => {
  const path = writeRules('bad.json', '{not json');
  const { rules, warn } = loadModelRules(path);
  assert.equal(rules, null);
  assert.ok(warn, 'expected parse warn');
  const p = pickModelForCycle(rules, 'x', { model: 'claude-sonnet-5' });
  assert.equal(p.model, 'claude-sonnet-5');
});

// ── strict stop-marker: บรรทัดสุดท้ายของคำตอบต้องเป็น marker เป๊ะ ๆ ──
const M = 'AUTOLOOP: COMPLETE';

test('stop signal: request → present → clear roundtrip (cooperative stop on Windows)', () => {
  const sf = join(dir, 'SIG-STATE.md');
  writeFileSync(sf, '- [ ] x\n');
  assert.equal(stopSignalPresent(sf), false);
  requestStop(sf);
  assert.equal(stopSignalPresent(sf), true);
  clearStopSignal(sf);
  assert.equal(stopSignalPresent(sf), false);
  clearStopSignal(sf); // clearing twice must not throw
});

test('formatEventText: plan progress + next item ride along on every notification', () => {
  const text = formatEventText({
    status: 'limited',
    project: 'my-proj',
    message: 'พักรอครั้งที่ 1',
    plan: { done: 24, total: 44, pct: 55, nextItem: 'P3.5 วันหยุดชดเชย' },
    cycles: 3,
  });
  assert.ok(text.includes('24/44 ข้อ (55%)'));
  assert.ok(text.includes('▰'), 'progress bar in every notification');
  assert.ok(text.includes('ข้อถัดไป: P3.5 วันหยุดชดเชย'));
  // no plan (state file unreadable) → lines simply absent, message still sends
  const bare = formatEventText({ status: 'done', project: 'x', plan: null });
  assert.ok(!bare.includes('ข้อ ('));
});

test('stopMarkerPresent: standalone line = done · mere mention in a sentence must NOT stop the loop', async () => {
  const { stopMarkerPresent } = await import('../src/state.mjs');
  const f = join(dir, 'MARKER-STATE.md');
  // the real false-done case: a round-log line that TALKS ABOUT the marker
  writeFileSync(f, '- [ ] งานเหลือ\n- 2026-07-04 · Round 97: … → ไม่เติม AUTOLOOP: COMPLETE เพราะยังมี blocker\n');
  assert.equal(stopMarkerPresent(f, M), false, 'mention inside a sentence must not read as done');
  writeFileSync(f, '- [x] ครบ\n\nAUTOLOOP: COMPLETE\n');
  assert.equal(stopMarkerPresent(f, M), true, 'marker as its own line = done');
  writeFileSync(f, '- [x] ครบ\n\n**AUTOLOOP: COMPLETE**\n');
  assert.equal(stopMarkerPresent(f, M), true, 'markdown-bold marker line still counts');
  writeFileSync(f, '- [x] ครบ\n');
  assert.equal(stopMarkerPresent(f, M), false);
});

test('withLoopProtocol: appended when prompt lacks the marker, skipped when it covers it', () => {
  const bare = 'อ่าน state แล้วทำต่อ';
  const out = withLoopProtocol(bare, M);
  assert.ok(out.includes(M), 'protocol with marker must be appended');
  assert.ok(out.includes('ห้าม push'), 'no-push rule included');
  assert.ok(out.startsWith(bare), 'original prompt kept first');
  const aware = `ทำต่อ ครบแล้วเติม ${M} ท้ายไฟล์`;
  assert.equal(withLoopProtocol(aware, M), aware); // project wrote its own protocol → untouched
  assert.equal(withLoopProtocol(bare, M, false), bare); // --no-protocol
  assert.equal(withLoopProtocol(bare, ''), bare); // no marker configured → nothing to enforce
});

test('replyAnnouncesMarker: exact reply / marker as last line → true', () => {
  assert.equal(replyAnnouncesMarker(M, M), true);
  assert.equal(replyAnnouncesMarker(`สรุปงานรอบนี้...\n\n${M}\n`, M), true);
});

test('replyAnnouncesMarker: mere mention must NOT stop the loop (false-done bug)', () => {
  assert.equal(replyAnnouncesMarker(`ยังไม่ครบทุกข้อ จึงยังไม่เติม ${M} ท้ายไฟล์`, M), false);
  assert.equal(replyAnnouncesMarker(`${M} คือ marker ที่จะใช้\nทำงานต่อรอบหน้า`, M), false);
  assert.equal(replyAnnouncesMarker('', M), false);
  assert.equal(replyAnnouncesMarker(M, ''), false);
});

test('classifyResult: replyText = structured result only, not the raw stream', () => {
  const stream =
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `เงื่อนไขจบคือ ${M}` }] } }) +
    '\n' +
    JSON.stringify({ type: 'result', is_error: false, result: 'ทำ 3 unit เสร็จ ยังไม่ครบแผน' }) +
    '\n';
  const v = classifyResult({ code: 0, stdout: stream });
  assert.equal(v.ok, true);
  assert.equal(v.replyText, 'ทำ 3 unit เสร็จ ยังไม่ครบแผน');
  assert.equal(replyAnnouncesMarker(v.replyText, M), false); // stream พูดถึง marker แต่คำตอบจริงไม่ได้ประกาศจบ
});

test('classifyResult: no structured result → replyText falls back to raw text', () => {
  const v = classifyResult({ code: 0, stdout: `plain output\n${M}\n` });
  assert.equal(replyAnnouncesMarker(v.replyText, M), true);
});

const captureConsole = (fn) => {
  let writes = 0;
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => { writes += 1; return true; };
  process.stderr.write = () => { writes += 1; return true; };
  try {
    fn();
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    setLogFile(null);
  }
  return writes;
};

test('detached (fileOnly) logging → file once, console silent (no duplicate lines)', () => {
  const p = join(dir, 'detached.log');
  const writes = captureConsole(() => {
    setLogFile(p, { fileOnly: true });
    log('info', 'hello-detached');
    log('warn', 'warn-detached');
  });
  const content = readFileSync(p, 'utf8');
  assert.equal(writes, 0, 'console must stay silent in fileOnly mode');
  assert.equal((content.match(/hello-detached/g) || []).length, 1);
  assert.equal((content.match(/warn-detached/g) || []).length, 1);
});

test('normal --log logging → console AND file', () => {
  const p = join(dir, 'normal.log');
  const writes = captureConsole(() => {
    setLogFile(p);
    log('info', 'hello-normal');
  });
  assert.equal(writes, 1);
  assert.equal((readFileSync(p, 'utf8').match(/hello-normal/g) || []).length, 1);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}\n  ${err.message}`);
  }
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
