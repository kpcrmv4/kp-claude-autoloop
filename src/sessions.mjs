import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_META_SCAN_LINES = 250; // session metadata always appears early in the file
const MAX_HEAD_BYTES = 1024 * 1024; // …and within the first ~1MB — never read a whole 50MB log
const TAIL_BYTES = 256 * 1024; // read only the last 256KB to find the most recent user message
const SNIPPET_LEN = 70;

export function projectsRoot() {
  return join(homedir(), '.claude', 'projects');
}

/** Pull readable text from a session "user" message, skipping tool results / system reminders. */
export function extractUserText(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((part) => part && part.type === 'tool_result')) return '';
    text = content.map((part) => (part && part.text) || '').join(' ');
  }
  text = text.trim();
  if (!text || text.startsWith('<') || text.startsWith('[')) return '';
  if (/AUTORESPUME_(?:QUOTA_PROBE|GUI_TEST)_OK/.test(text)) return '';
  if (/^(continue|continue from where you left off\.?)$/i.test(text)) return '';
  return text;
}

/** Reduce raw JSONL lines into {cwd, gitBranch, firstUser}. Pure → unit-testable. */
export function parseMetaFromLines(lines) {
  const meta = { cwd: null, gitBranch: null, firstUser: null, lastUser: null };
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    applySessionObject(meta, obj);
  }
  return meta;
}

function applySessionObject(meta, obj, { allowMetadata = true } = {}) {
  if (!obj || typeof obj !== 'object') return;
  if (allowMetadata && !meta.cwd && obj.cwd) meta.cwd = obj.cwd;
  if (allowMetadata && !meta.gitBranch && obj.gitBranch) meta.gitBranch = obj.gitBranch;
  if (obj.type === 'user' && obj.message) {
    const t = extractUserText(obj.message.content);
    if (t) {
      const snippet = t.slice(0, SNIPPET_LEN);
      if (!meta.firstUser) meta.firstUser = snippet;
      meta.lastUser = snippet;
    }
  }
}

// Bounded reader: cwd/branch/firstUser come from the head, lastUser from a small
// tail read. Session logs can be tens of MB, so we never read the whole file.
function readSessionMeta(file) {
  const meta = parseMetaFromLines(readHeadLinesSync(file, MAX_META_SCAN_LINES, MAX_HEAD_BYTES));
  const tailUser = lastUserFromTail(file);
  if (tailUser) meta.lastUser = tailUser;
  return meta;
}

function readHeadLinesSync(file, maxLines, maxBytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const lines = [];
    const buf = Buffer.alloc(65536);
    let leftover = '';
    let pos = 0;
    while (lines.length <= maxLines && pos < maxBytes) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) {
        if (leftover) lines.push(leftover);
        break;
      }
      pos += n;
      const parts = (leftover + buf.toString('utf8', 0, n)).split(/\r?\n/);
      leftover = parts.pop() ?? '';
      for (const p of parts) {
        lines.push(p);
        if (lines.length > maxLines) break;
      }
    }
    return lines.slice(0, maxLines);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function lastUserFromTail(file) {
  let lines;
  try {
    lines = readTailLinesSync(file, TAIL_BYTES);
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (obj && obj.type === 'user' && obj.message) {
      const t = extractUserText(obj.message.content);
      if (t) return t.slice(0, SNIPPET_LEN);
    }
  }
  return null;
}

function readTailLinesSync(file, maxBytes) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1); // drop the partial first line
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

/**
 * List recent top-level Claude Code sessions across all projects, newest first.
 * Skips nested subagent/workflow logs.
 * @returns {Promise<Array<{sessionId,file,mtimeMs,cwd,gitBranch,firstUser,lastUser}>>}
 */
export async function listSessions(limit = 15) {
  const root = projectsRoot();
  if (!existsSync(root)) return [];

  const files = [];
  for (const dir of safeReadDir(root)) {
    if (!dir.isDirectory()) continue;
    const projDir = join(root, dir.name);
    for (const entry of safeReadDir(projDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(projDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      files.push({ sessionId: entry.name.replace(/\.jsonl$/, ''), file, mtimeMs });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out = [];
  for (const f of files.slice(0, limit)) {
    out.push({ ...f, ...readSessionMeta(f.file) });
  }
  return out;
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function formatSessions(sessions, { showCommands = true } = {}) {
  if (!sessions.length) {
    return 'ไม่พบ session ใน ~/.claude/projects (ยังไม่เคยรัน Claude Code ในเครื่องนี้?)';
  }
  const rows = sessions.map((s, i) => {
    const when = new Date(s.mtimeMs).toLocaleString('sv-SE');
    const branch = s.gitBranch ? ` (${s.gitBranch})` : '';
    const head = `${String(i + 1).padStart(2)}. ${when}${branch}  ${s.cwd || '(unknown cwd)'}`;
    const preview = s.lastUser || s.firstUser;
    const sub = `    id: ${s.sessionId}${preview ? `  · "${preview}"` : ''}`;
    return `${head}\n${sub}`;
  });
  const lines = [
    'Session ล่าสุด (เรียงตามเวลาแก้ไขล่าสุด):',
    '',
    ...rows,
  ];

  if (showCommands) {
    lines.push(
      '',
      'สั่ง resume ตัวที่ต้องการ:',
      '  node src/autoresume.mjs --cwd "<cwd ด้านบน>"            # ต่อแชทล่าสุดในโปรเจกต์นั้น',
      '  node src/autoresume.mjs --session <id> --cwd "<cwd>"    # เจาะจง session',
    );
  }

  return lines.join('\n');
}

export function resolveSessionChoice(sessions, choice) {
  const text = String(choice ?? '').trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    return sessions[index] || null;
  }

  const lowered = text.toLowerCase();
  const exact = sessions.find((s) => s.sessionId.toLowerCase() === lowered);
  if (exact) return exact;

  if (lowered.length >= 8) {
    const prefixMatches = sessions.filter((s) => s.sessionId.toLowerCase().startsWith(lowered));
    if (prefixMatches.length === 1) return prefixMatches[0];
  }

  return null;
}
