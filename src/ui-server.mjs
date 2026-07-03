// Localhost dashboard for autoloop — zero dependency (node:http only).
// Read-mostly: run data comes from each run's sidecar + state file; the only
// mutations are start (spawns `autoloop start`), stop (signal pid), forget.
//
// Security model: binds 127.0.0.1 only. Mutating POSTs additionally require
// the custom `x-autoloop` header — a cross-origin page can't set it without
// a CORS preflight, which this server never grants.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, unregisterRun } from './registry.mjs';
import { readRuntime } from './state.mjs';
import { readPlanProgress } from './tui.mjs';
import { listSessions } from './sessions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '..', 'bin', 'autoloop.mjs');
const HTML_PATH = join(__dirname, 'ui.html');

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
  if (!existsSync(p.stateFile)) throw new Error(`ไม่พบ state file: ${p.stateFile} — สร้างไฟล์แผน/checklist ก่อน`);
  const args = ['start', '--cwd', p.cwd, '--state-file', p.stateFile];
  if (p.session) args.push('--session', p.session);
  if (p.promptFile) args.push('--prompt-file', p.promptFile);
  else if (p.prompt) args.push('--prompt', p.prompt);
  if (p.modelRules) args.push('--model-rules', p.modelRules);
  if (p.model) args.push('--model', p.model);
  if (p.effort) args.push('--effort', p.effort);
  if (p.maxCycles) args.push('--max-cycles', String(Number(p.maxCycles) || 30));
  args.push('--permission-mode', p.permissionMode || 'acceptEdits');
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

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML_PATH, 'utf8'));
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
    handle(req, res).catch((err) => json(res, 500, { error: String(err && err.message) }));
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise({ server, port: server.address().port }));
  });
}
