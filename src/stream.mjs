// Parse `claude -p --output-format stream-json` events into short, human
// activity lines for the live split-screen view. Pure functions → testable.

const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m' };

/** One-line summary of a tool call's most meaningful argument. */
export function summarizeToolInput(name, input = {}) {
  const clip = (s, n = 64) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  switch (name) {
    case 'Bash': case 'PowerShell': return clip(input.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return clip(input.file_path);
    case 'Glob': case 'Grep': return clip(input.pattern);
    case 'Task': case 'Agent': return clip(input.description || input.prompt, 48);
    case 'WebFetch': case 'WebSearch': return clip(input.url || input.query);
    case 'TodoWrite': return `${(input.todos || []).length} รายการ`;
    default: {
      const first = Object.values(input)[0];
      return typeof first === 'string' ? clip(first, 40) : '';
    }
  }
}

const TOOL_ICON = (name) =>
  /bash|shell/i.test(name) ? '⌨' :
  /edit|write|notebook/i.test(name) ? '✎' :
  /read|glob|grep/i.test(name) ? '🔍' :
  /task|agent/i.test(name) ? '🤖' :
  /web/i.test(name) ? '🌐' : '⚒';

/**
 * Convert one stream-json event object into zero-or-more display lines.
 * Returns { lines: string[], activity?: string } — activity is a plain-text
 * "current activity" summary used in the pinned header.
 */
export function formatStreamEvent(obj) {
  if (!obj || typeof obj !== 'object') return { lines: [] };

  if (obj.type === 'system' && obj.subtype === 'init') {
    return { lines: [`${C.dim}⚙ เริ่ม session (model: ${obj.model || '?'})${C.reset}`] };
  }

  if (obj.type === 'assistant' && obj.message?.content) {
    const lines = [];
    let activity;
    for (const block of obj.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        for (const ln of block.text.trim().split(/\r?\n/).slice(0, 6)) {
          lines.push(`${C.dim}💬 ${ln.slice(0, 100)}${C.reset}`);
        }
      } else if (block.type === 'tool_use') {
        const summary = summarizeToolInput(block.name, block.input);
        lines.push(`${C.cyan}${TOOL_ICON(block.name)} ${block.name}${C.reset}${summary ? ` ${C.dim}· ${summary}${C.reset}` : ''}`);
        activity = `${block.name}${summary ? `: ${summary}` : ''}`;
      }
    }
    return { lines, activity };
  }

  // tool results: stay quiet unless it's an error worth seeing
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    const lines = [];
    for (const block of obj.message.content) {
      if (block.type === 'tool_result' && block.is_error) {
        const text = typeof block.content === 'string'
          ? block.content
          : (block.content || []).map((c) => c.text || '').join(' ');
        lines.push(`${C.red}⛔ tool error:${C.reset} ${C.dim}${String(text).replace(/\s+/g, ' ').slice(0, 90)}${C.reset}`);
      }
    }
    return { lines };
  }

  if (obj.type === 'result') {
    return { lines: [obj.is_error ? `${C.yellow}◼ รอบจบแบบมีปัญหา${C.reset}` : `${C.green}◼ จบรอบ${C.reset}`] };
  }

  return { lines: [] };
}

/** Feed raw stdout chunks; calls onEvent(obj) per complete JSONL line. */
export function makeJsonlSplitter(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* partial/garbled line — skip */
      }
    }
  };
}
