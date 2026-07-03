// Localhost dashboard for autoloop — zero dependency (node:http only).
// Read-mostly: run data comes from each run's sidecar + state file; the only
// mutations are start (spawns `autoloop start`), stop (signal pid), forget.
//
// Security model: binds 127.0.0.1 only. Mutating POSTs additionally require
// the custom `x-autoloop` header — a cross-origin page can't set it without
// a CORS preflight, which this server never grants.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, unregisterRun } from './registry.mjs';
import { readRuntime } from './state.mjs';
import { readPlanProgress } from './tui.mjs';
import { listSessions } from './sessions.mjs';
import { loadSecrets, defaultSecretsPath } from './secrets.mjs';
import { validateBotToken, detectChatId, maskToken } from './notify-setup.mjs';
import { sendWebhook } from './notify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '..', 'bin', 'autoloop.mjs');
const HTML_PATH = join(__dirname, 'ui.html');
const TAILWIND_PATH = join(__dirname, 'assets', 'tailwind.js');

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logTail(stateFile, lines) {
  try {
    return readFileSync(`${stateFile}.autoloop.log`, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/** Snapshot every registered run, enriched with live sidecar + plan progress. */
export function collectRuns() {
  return readRegistry().map((r) => {
    const rt = readRuntime(r.stateFile) || {};
    return {
      stateFile: r.stateFile,
      cwd: r.cwd || rt.cwd || null,
      status: rt.status || 'unknown',
      alive: pidAlive(rt.pid),
      pid: rt.pid || null,
      cycles: rt.cycles ?? null,
      waits: rt.waits ?? null,
      sessionId: rt.sessionId || null,
      startedAt: rt.startedAt || null,
      updatedAt: rt.updatedAt || null,
      resumeAt: rt.resumeAt || null,
      doneReason: rt.doneReason || null,
      lastError: rt.lastError ? String(rt.lastError).slice(-300) : null,
      model: rt.model || null,
      effort: rt.effort || null,
      modelRule: rt.modelRule || null,
      modelRulesFile: rt.modelRulesFile || null,
      plan: readPlanProgress(r.stateFile),
    };
  });
}

/** Folder browser for the cwd picker — read-only, directory names only. */
export function browseDirs(path) {
  if (!path) {
    // top level: drives on Windows, / elsewhere
    if (process.platform === 'win32') {
      const drives = [];
      for (let i = 65; i <= 90; i += 1) {
        const d = `${String.fromCharCode(i)}:\\`;
        try {
          if (existsSync(d)) drives.push(d);
        } catch {
          /* skip unreadable drive */
        }
      }
      return { path: null, parent: null, dirs: drives };
    }
    return browseDirs('/');
  }
  const abs = resolve(path);
  if (!statSync(abs).isDirectory()) throw new Error('ไม่ใช่โฟลเดอร์');
  const dirs = readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const up = dirname(abs);
  return { path: abs, parent: up === abs ? null : up, dirs };
}

/** Find workflow files in a project folder so the start form can auto-fill.
 *  Scans cwd, cwd/docs, and one level of docs subfolders (e.g. docs/hr/). Read-only. */
export function scanWorkflow(cwd) {
  const root = resolve(cwd);
  if (!statSync(root).isDirectory()) throw new Error('not a folder');
  const dirs = [root, join(root, 'docs')];
  try {
    for (const e of readdirSync(join(root, 'docs'), { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(join(root, 'docs', e.name));
    }
  } catch { /* no docs dir */ }

  const files = [];
  for (const d of dirs) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isFile()) files.push(join(d, e.name));
        if (files.length > 500) break; // huge folder — enough candidates already
      }
    } catch { /* unreadable dir */ }
  }
  const base = (p) => p.split(/[\\/]/).pop().toLowerCase();
  // prefer the conventional names from the setup prompt, then any name-based match
  const pick = (exact, loose) =>
    files.find((p) => base(p) === exact) || files.find((p) => loose.test(base(p))) || null;

  const stateFile = pick('build-state.md', /state.*\.md$/);
  const promptFile = pick('round-prompt.txt', /prompt.*\.txt$/);
  const modelRules = pick('model-rules.json', /(model-)?rules.*\.json$/);
  let stateHasChecklist = false;
  if (stateFile) {
    try {
      stateHasChecklist = /^\s*[-*] \[[ xX~]\]/m.test(readFileSync(stateFile, 'utf8'));
    } catch { /* unreadable → treat as no checklist */ }
  }
  return { stateFile, stateHasChecklist, promptFile, modelRules };
}

/** Public (masked) view of the saved Telegram config — the token never leaves the server. */
export function telegramStatus(secrets = loadSecrets()) {
  const tg = secrets.telegram || {};
  const configured = Boolean(tg.token && tg.chatId);
  return {
    configured,
    chatId: configured ? tg.chatId : null,
    maskedToken: tg.token ? maskToken(tg.token) : null,
    botUsername: tg.botUsername || null,
  };
}

/** Merge a new telegram config into existing secrets without dropping other keys. */
export function mergeTelegramSecrets(existing, { token, chatId, botUsername }) {
  return { ...existing, telegram: { token, chatId, ...(botUsername ? { botUsername } : {}) } };
}

const tgSendUrl = (token, chatId) =>
  `https://api.telegram.org/bot${token}/sendMessage?chat_id=${encodeURIComponent(chatId)}`;

/** Editable-from-UI files are ONLY the model-rules paths of registered runs. */
function isKnownRulesFile(path) {
  if (!path) return false;
  const key = resolve(path);
  return collectRuns().some((r) => r.modelRulesFile && resolve(r.modelRulesFile) === key);
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function serveFile(res, filePath, type, extraHeaders = {}) {
  let body;
  try {
    body = readFileSync(filePath);
  } catch (err) {
    json(res, 500, { error: `cannot read ${filePath}: ${err.message}` });
    return;
  }
  res.writeHead(200, { 'content-type': type, ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/** Build `autoloop start` argv from a UI form payload (only known flags pass through). */
export function startArgsFromPayload(p) {
  if (!p || !p.cwd || !p.stateFile) throw new Error('ต้องระบุ cwd และ stateFile');
  if (!existsSync(p.cwd)) throw new Error(`ไม่พบโฟลเดอร์: ${p.cwd}`);
  if (!existsSync(p.stateFile)) {
    throw new Error(`ไม่พบ state file: ${p.stateFile} — ต้องสั่งให้ Claude สร้าง workflow ก่อน (กดปุ่ม 💡 ด้านบน มี prompt สำเร็จรูปให้ copy)`);
  }
  // ไม่มี checklist = ยังไม่ได้เตรียม workflow → loop จะวิ่งแบบตาบอด ไม่มี progress/เงื่อนไขจบที่ไว้ใจได้
  if (!/^\s*[-*] \[[ xX~]\]/m.test(readFileSync(p.stateFile, 'utf8'))) {
    throw new Error('state file ยังไม่มี checklist "- [ ]" — สั่งให้ Claude สร้าง workflow ก่อน (กดปุ่ม 💡 ด้านบน มี prompt สำเร็จรูปให้ copy) แล้วค่อยกลับมา start');
  }
  const args = ['start', '--cwd', p.cwd, '--state-file', p.stateFile];
  if (p.session) args.push('--session', p.session);
  if (p.promptFile) args.push('--prompt-file', p.promptFile);
  else if (p.prompt) args.push('--prompt', p.prompt);
  if (p.modelRules) args.push('--model-rules', p.modelRules);
  if (p.model) args.push('--model', p.model);
  if (p.effort) args.push('--effort', p.effort);
  if (p.maxCycles) args.push('--max-cycles', String(Number(p.maxCycles) || 30));
  args.push('--permission-mode', p.permissionMode || 'acceptEdits');
  // notify default = on when secrets exist (engine behavior) — only explicit opt-out disables
  if (p.notify === false || p.notify === 'false' || p.notify === 'off') args.push('--no-notify');
  if (p.remoteControl === true || p.remoteControl === 'true' || p.remoteControl === 'on') args.push('--remote-control');
  return args;
}

function runStart(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, output: out.trim() }));
    child.on('error', (err) => resolvePromise({ code: -1, output: String(err) }));
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // read BEFORE writeHead — a throw after headers are sent would crash the
  // process when the error handler tries to write a second status line
  if (req.method === 'GET' && path === '/') {
    serveFile(res, HTML_PATH, 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && path === '/assets/tailwind.js') {
    serveFile(res, TAILWIND_PATH, 'text/javascript; charset=utf-8', { 'cache-control': 'max-age=86400' });
    return;
  }
  if (req.method === 'GET' && path === '/assets/logo.png') {
    serveFile(res, join(__dirname, 'assets', 'kpwebappstudio.png'), 'image/png', { 'cache-control': 'max-age=86400' });
    return;
  }
  // identify this server as autoloop (the launcher probes this before reusing a busy port)
  if (req.method === 'GET' && path === '/api/health') {
    json(res, 200, { app: 'autoloop', ok: true });
    return;
  }
  if (req.method === 'GET' && path === '/api/telegram') {
    json(res, 200, telegramStatus());
    return;
  }
  if (req.method === 'GET' && path === '/api/runs') {
    json(res, 200, { runs: collectRuns() });
    return;
  }
  if (req.method === 'GET' && path === '/api/log') {
    const stateFile = url.searchParams.get('state') || '';
    const lines = Math.min(500, Number(url.searchParams.get('lines')) || 60);
    json(res, 200, { lines: logTail(stateFile, lines) });
    return;
  }
  if (req.method === 'GET' && path === '/api/scan') {
    try {
      json(res, 200, scanWorkflow(url.searchParams.get('cwd') || ''));
    } catch (err) {
      json(res, 404, { error: err.message });
    }
    return;
  }
  if (req.method === 'GET' && path === '/api/browse') {
    try {
      json(res, 200, browseDirs(url.searchParams.get('path') || ''));
    } catch (err) {
      json(res, 404, { error: err.message });
    }
    return;
  }
  if (req.method === 'GET' && path === '/api/model-rules') {
    const p = url.searchParams.get('path') || '';
    if (!isKnownRulesFile(p)) {
      json(res, 403, { error: 'path นี้ไม่ใช่ model-rules ของ run ที่ลงทะเบียนไว้' });
      return;
    }
    try {
      json(res, 200, { content: readFileSync(p, 'utf8') });
    } catch (err) {
      json(res, 404, { error: err.message });
    }
    return;
  }
  if (req.method === 'GET' && path === '/api/sessions') {
    const sessions = await listSessions(25);
    json(res, 200, {
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        when: new Date(s.mtimeMs).toISOString(),
        preview: s.lastUser || s.firstUser || '',
      })),
    });
    return;
  }

  if (req.method === 'POST') {
    if (!req.headers['x-autoloop']) {
      json(res, 403, { error: 'missing x-autoloop header' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: err.message });
      return;
    }

    if (path === '/api/start') {
      let args;
      try {
        args = startArgsFromPayload(body);
      } catch (err) {
        json(res, 400, { error: err.message });
        return;
      }
      const result = await runStart(args);
      json(res, result.code === 0 ? 200 : 500, result);
      return;
    }
    if (path === '/api/stop') {
      const rt = readRuntime(body.stateFile || '');
      if (!rt || !rt.pid) {
        json(res, 404, { error: 'ไม่พบ process ที่รันอยู่' });
        return;
      }
      try {
        process.kill(rt.pid);
        json(res, 200, { ok: true, pid: rt.pid });
      } catch (err) {
        json(res, 410, { error: `pid ${rt.pid} ไม่อยู่แล้ว (${err.code || err.message})` });
      }
      return;
    }
    if (path === '/api/forget') {
      unregisterRun(body.stateFile || '');
      json(res, 200, { ok: true });
      return;
    }
    // ── Telegram setup (GUI twin of `autoloop notify-setup`) ──
    if (path === '/api/telegram/validate') {
      const token = String(body.token || '').trim();
      if (!token) {
        json(res, 400, { error: 'missing token' });
        return;
      }
      const v = await validateBotToken(token);
      json(res, v.ok ? 200 : 400, v);
      return;
    }
    if (path === '/api/telegram/detect') {
      const token = String(body.token || '').trim() || loadSecrets().telegram?.token;
      if (!token) {
        json(res, 400, { error: 'missing token' });
        return;
      }
      const found = await detectChatId(token);
      if (found) json(res, 200, found);
      else json(res, 404, { error: 'no message found yet' });
      return;
    }
    if (path === '/api/telegram/save') {
      const existing = loadSecrets();
      const token = String(body.token || '').trim() || existing.telegram?.token;
      const chatId = String(body.chatId || '').trim();
      if (!token || !chatId) {
        json(res, 400, { error: 'missing token/chatId' });
        return;
      }
      const v = await validateBotToken(token);
      if (!v.ok) {
        json(res, 400, { error: `invalid token: ${v.error || 'unknown'}` });
        return;
      }
      try {
        writeFileSync(defaultSecretsPath, JSON.stringify(mergeTelegramSecrets(existing, { token, chatId, botUsername: v.username }), null, 2));
      } catch (err) {
        json(res, 500, { error: err.message });
        return;
      }
      const test = await sendWebhook(tgSendUrl(token, chatId), {
        status: 'test',
        message: 'ตั้งค่าเสร็จแล้ว — autoloop จะรายงานเข้าห้องนี้ ✅ / Setup complete — autoloop will report here.',
      });
      json(res, 200, { ok: true, botUsername: v.username, test });
      return;
    }
    if (path === '/api/telegram/test') {
      const tg = loadSecrets().telegram || {};
      if (!tg.token || !tg.chatId) {
        json(res, 400, { error: 'not configured' });
        return;
      }
      const r = await sendWebhook(tgSendUrl(tg.token, tg.chatId), {
        status: 'test',
        message: 'ทดสอบจากหน้า dashboard ✅ / Test from the dashboard.',
      });
      json(res, r.ok ? 200 : 502, r);
      return;
    }
    if (path === '/api/model-rules') {
      // engine hot-reloads the file every cycle → saving here takes effect next round
      if (!isKnownRulesFile(body.path)) {
        json(res, 403, { error: 'path นี้ไม่ใช่ model-rules ของ run ที่ลงทะเบียนไว้' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body.content);
      } catch (err) {
        json(res, 400, { error: `JSON ไม่ถูกต้อง: ${err.message}` });
        return;
      }
      try {
        writeFileSync(body.path, JSON.stringify(parsed, null, 2) + '\n');
        const hasDefault = parsed.default && (parsed.default.model || parsed.default.effort);
        json(res, 200, { ok: true, warn: hasDefault ? null : 'ไม่มี "default" — งานที่ไม่ match rule จะตกไป default เครื่อง (อาจแพง)' });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }
  }

  json(res, 404, { error: 'not found' });
}

/** @returns {Promise<{server: import('node:http').Server, port: number}>} */
export function startUiServer({ port = 4900, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy(); // can't send a second status line — just drop the socket
        return;
      }
      json(res, 500, { error: String(err && err.message) });
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise({ server, port: server.address().port }));
  });
}
