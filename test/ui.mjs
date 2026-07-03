#!/usr/bin/env node
// Dashboard tests: registry round-trip, start-args validation, and a live
// HTTP round-trip on an ephemeral port. AUTOLOOP_HOME keeps everything in tmp.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'autoloop-ui-'));
process.env.AUTOLOOP_HOME = join(dir, 'home');
process.env.AUTOLOOP_SECRETS = join(dir, 'secrets.json'); // never touch the real secrets file

const { registerRun, unregisterRun, readRegistry, registryPath } = await import('../src/registry.mjs');
const { startArgsFromPayload, collectRuns, startUiServer, telegramStatus, mergeTelegramSecrets } = await import('../src/ui-server.mjs');
const { nodeVersionOk, buildInstallPlan } = await import('../src/doctor.mjs');

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

test('startArgsFromPayload: notify=false → --no-notify · remoteControl=true → --remote-control', () => {
  const stateFile = join(dir, 'STATE.md');
  writeFileSync(stateFile, '- [ ] unit 1\n');
  const base = { cwd: dir, stateFile };
  assert.ok(startArgsFromPayload({ ...base, notify: false }).includes('--no-notify'));
  assert.ok(startArgsFromPayload({ ...base, notify: 'false' }).includes('--no-notify'));
  assert.ok(!startArgsFromPayload({ ...base, notify: true }).includes('--no-notify'));
  assert.ok(!startArgsFromPayload(base).includes('--no-notify')); // absent = engine default (on if secrets)
  assert.ok(startArgsFromPayload({ ...base, remoteControl: true }).includes('--remote-control'));
  assert.ok(!startArgsFromPayload(base).includes('--remote-control'));
});

// ── telegram helpers (pure — no network) ──
test('telegramStatus: masks the token, never returns it raw', () => {
  const s = telegramStatus({ telegram: { token: '123456789:AAlongsecrettokenvalue', chatId: '42', botUsername: 'kp_bot' } });
  assert.equal(s.configured, true);
  assert.equal(s.chatId, '42');
  assert.equal(s.botUsername, 'kp_bot');
  assert.ok(!s.maskedToken.includes('longsecret'), 'token must be masked');
  assert.deepEqual(telegramStatus({}), { configured: false, chatId: null, maskedToken: null, botUsername: null });
});

test('mergeTelegramSecrets: keeps other keys, replaces telegram', () => {
  const next = mergeTelegramSecrets({ webhookUrl: 'https://x', telegram: { token: 'old', chatId: '1' } }, { token: 'new', chatId: '2', botUsername: 'b' });
  assert.equal(next.webhookUrl, 'https://x');
  assert.deepEqual(next.telegram, { token: 'new', chatId: '2', botUsername: 'b' });
});

// ── doctor helpers (pure) ──
test('doctor: nodeVersionOk + buildInstallPlan dedupes the node/npm installer', () => {
  assert.ok(nodeVersionOk('v20.11.0'));
  assert.ok(!nodeVersionOk('v16.4.0'));
  assert.ok(!nodeVersionOk(''));
  const checks = [
    { name: 'node', ok: false },
    { name: 'npm', ok: false },
    { name: 'claude', ok: false },
    { name: 'git', ok: true },
  ];
  const plan = buildInstallPlan(checks, 'win32');
  assert.equal(plan.length, 2); // node+npm share one winget install; claude via npm
  assert.ok(plan.some((p) => p.cmd.includes('OpenJS.NodeJS')));
  assert.ok(plan.some((p) => p.cmd.includes('@anthropic-ai/claude-code')));
  const mac = buildInstallPlan(checks, 'darwin');
  assert.ok(mac.every((p) => !p.cmd || !p.cmd.includes('winget')), 'no winget commands off-Windows');
  assert.ok(mac.some((p) => p.hint), 'manual hint offered instead');
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

    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).app, 'autoloop');

    const tg = await fetch(base + '/api/telegram');
    assert.equal(tg.status, 200);
    assert.equal((await tg.json()).configured, false); // sandboxed secrets file — not set up

    // validation-only paths (no Telegram network call)
    const noToken = await fetch(base + '/api/telegram/validate', {
      method: 'POST', headers: { 'x-autoloop': '1', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noToken.status, 400);
    const saveNoChat = await fetch(base + '/api/telegram/save', {
      method: 'POST', headers: { 'x-autoloop': '1', 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x' }),
    });
    assert.equal(saveNoChat.status, 400);

    const tw = await fetch(base + '/assets/tailwind.js');
    assert.equal(tw.status, 200); // vendored asset must be served (UI depends on it)
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
