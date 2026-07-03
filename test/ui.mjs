#!/usr/bin/env node
// Dashboard tests: registry round-trip, start-args validation, and a live
// HTTP round-trip on an ephemeral port. AUTOLOOP_HOME keeps everything in tmp.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'autoloop-ui-'));
process.env.AUTOLOOP_HOME = join(dir, 'home');

const { registerRun, unregisterRun, readRegistry, registryPath } = await import('../src/registry.mjs');
const { startArgsFromPayload, collectRuns, startUiServer } = await import('../src/ui-server.mjs');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ── registry ──
test('registry: register → read → unregister round-trip (AUTOLOOP_HOME sandboxed)', () => {
  assert.ok(registryPath().startsWith(process.env.AUTOLOOP_HOME), 'must honour AUTOLOOP_HOME');
  registerRun('F:/a/STATE.md', { cwd: 'F:/a' });
  registerRun('F:/b/STATE.md', { cwd: 'F:/b' });
  registerRun('F:\\a\\STATE.md', { cwd: 'F:/a' }); // same path, other separator → upsert not duplicate
  const runs = readRegistry();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].stateFile, resolve('F:/a/STATE.md')); // newest first, normalized
  unregisterRun('F:/a/STATE.md');
  assert.equal(readRegistry().length, 1);
  unregisterRun('F:/b/STATE.md');
});

// ── start args validation ──
test('startArgsFromPayload: missing cwd/stateFile → throws', () => {
  assert.throws(() => startArgsFromPayload({}), /cwd/);
  assert.throws(() => startArgsFromPayload({ cwd: dir, stateFile: join(dir, 'nope.md') }), /ไม่พบ state file/);
});

test('startArgsFromPayload: full payload → correct argv (unknown keys ignored)', () => {
  const stateFile = join(dir, 'STATE.md');
  writeFileSync(stateFile, '- [ ] unit 1\n');
  const args = startArgsFromPayload({
    cwd: dir,
    stateFile,
    session: 'abc',
    promptFile: 'p.txt',
    modelRules: 'rules.json',
    model: 'claude-sonnet-5',
    effort: 'high',
    maxCycles: '7',
    hacker: '--dangerously-skip-permissions', // must NOT pass through
  });
  assert.deepEqual(args, [
    'start', '--cwd', dir, '--state-file', stateFile,
    '--session', 'abc', '--prompt-file', 'p.txt', '--model-rules', 'rules.json',
    '--model', 'claude-sonnet-5', '--effort', 'high',
    '--max-cycles', '7', '--permission-mode', 'acceptEdits',
  ]);
});

// ── collectRuns enrichment ──
test('collectRuns: registered run gets sidecar + plan progress', () => {
  const stateFile = join(dir, 'RUN.md');
  writeFileSync(stateFile, '- [x] done unit\n- [ ] next unit\n');
  writeFileSync(`${stateFile}.autoloop.json`, JSON.stringify({ status: 'sleeping', pid: 999999, cycles: 3, resumeAt: '2099-01-01T00:00:00Z' }));
  registerRun(stateFile, { cwd: dir });
  const run = collectRuns().find((r) => r.stateFile === stateFile);
  assert.ok(run, 'run must appear');
  assert.equal(run.status, 'sleeping');
  assert.equal(run.alive, false); // pid 999999 doesn't exist
  assert.equal(run.cycles, 3);
  assert.equal(run.plan.done, 1);
  assert.equal(run.plan.total, 2);
  assert.equal(run.plan.nextItem, 'next unit');
  unregisterRun(stateFile);
});

// ── HTTP round-trip ──
test('http: GET / = html · GET /api/runs = json · POST w/o header = 403 · bad start = 400', async () => {
  const { server, port } = await startUiServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${port}`;
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /autoloop/);

    const runs = await fetch(base + '/api/runs');
    assert.equal(runs.status, 200);
    assert.ok(Array.isArray((await runs.json()).runs));

    const noHeader = await fetch(base + '/api/start', { method: 'POST', body: '{}' });
    assert.equal(noHeader.status, 403);

    const badStart = await fetch(base + '/api/start', {
      method: 'POST',
      headers: { 'x-autoloop': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, stateFile: join(dir, 'missing.md') }),
    });
    assert.equal(badStart.status, 400);
  } finally {
    await new Promise((r) => server.close(r)); // fully closed before exit — Windows libuv asserts otherwise
  }
});

// ── model-rules editor endpoints ──
test('model-rules api: read/write only registered rules files, JSON validated', async () => {
  const stateFile = join(dir, 'RULED.md');
  const rulesFile = join(dir, 'rules.json');
  writeFileSync(stateFile, '- [ ] x\n');
  writeFileSync(rulesFile, JSON.stringify({ default: { model: 'claude-sonnet-5' }, rules: [] }));
  writeFileSync(`${stateFile}.autoloop.json`, JSON.stringify({ status: 'running', modelRulesFile: rulesFile }));
  registerRun(stateFile, { cwd: dir });

  const { server, port } = await startUiServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${port}`;
    const post = (body) => fetch(base + '/api/model-rules', {
      method: 'POST', headers: { 'x-autoloop': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const read = await fetch(base + '/api/model-rules?path=' + encodeURIComponent(rulesFile));
    assert.equal(read.status, 200);
    assert.match((await read.json()).content, /claude-sonnet-5/);

    const strangerRead = await fetch(base + '/api/model-rules?path=' + encodeURIComponent(join(dir, 'other.json')));
    assert.equal(strangerRead.status, 403); // ไฟล์นอกรายการ run — ห้ามอ่าน/เขียน

    const badJson = await post({ path: rulesFile, content: '{broken' });
    assert.equal(badJson.status, 400);

    const noDefault = await post({ path: rulesFile, content: JSON.stringify({ rules: [] }) });
    assert.equal(noDefault.status, 200);
    assert.ok((await noDefault.json()).warn, 'saving rules without default must warn');

    const good = await post({ path: rulesFile, content: JSON.stringify({ default: { model: 'claude-haiku-4-5' }, rules: [] }) });
    assert.equal(good.status, 200);
    assert.match(readFileSync(rulesFile, 'utf8'), /claude-haiku-4-5/); // เขียนถึงดิสก์จริง
  } finally {
    await new Promise((r) => server.close(r));
    unregisterRun(stateFile);
  }
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}\n  ${err.message}`);
  }
}
rmSync(dir, { recursive: true, force: true });
// natural exit (process.exit() mid-socket-teardown trips a libuv assert on Windows);
// unref'd timer hard-exits only if undici keep-alive sockets pin the loop
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(failed ? 1 : 0), 2000).unref();
