#!/usr/bin/env node
// autoloop — keep a long-running Claude Code session alive across usage limits,
// driving it round-by-round until a stop marker appears in your state file.
// No GUI. No daemon manager. Just node + the claude CLI you already have.

import { spawn } from 'node:child_process';
import { openSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngine } from '../src/engine.mjs';
import { setLogFile, log } from '../src/log.mjs';
import { listSessions, formatSessions } from '../src/sessions.mjs';
import { readRuntime, runtimePath } from '../src/state.mjs';
import { loadSecrets, defaultSecretsPath } from '../src/secrets.mjs';
import { resolveTargets, notifyAll } from '../src/notify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP = `
autoloop — Claude Code loop runner that survives usage limits (no GUI)

USAGE
  autoloop run    --cwd <dir> --state-file <file> [options]   run in this terminal
  autoloop start  --cwd <dir> --state-file <file> [options]   run detached (background)
  autoloop status --state-file <file>                          show runtime state + log tail
  autoloop stop   --state-file <file>                          stop a detached run
  autoloop list                                                list recent Claude sessions
  autoloop notify-setup                                        interactive Telegram setup wizard (auto chat-id)
  autoloop notify-test                                         send a test notification (Telegram/webhook)

REQUIRED
  --cwd <dir>            project folder of the target session
  --state-file <file>    the shared work-state file (agent updates it; autoloop
                         watches it for the stop marker)

OPTIONS
  --session <id>         resume a specific session (RECOMMENDED — --continue
                         grabs the newest session in cwd, which may be the wrong chat)
  --prompt <text>        round prompt sent every cycle
  --prompt-file <file>   read round prompt from a file (re-read each cycle; wins over --prompt)
  --stop-marker <text>   stop when state file (or the reply) contains this
                         (default: "AUTOLOOP: COMPLETE")
  --max-cycles <n>       max successful rounds (default 30)
  --max-waits <n>        max limit-sleeps before giving up (default 20)
  --fallback-wait-min <m> sleep this long when reset time can't be parsed (default 300 = 5h)
  --buffer <sec>         extra wait after the parsed reset time (default 90)
  --min-retry <sec>      never retry sooner than this after a limit (default 60)
  --cooldown <sec>       pause between successful rounds (default 0)
  --timeout <sec>        kill a single round after this long (default 0 = no timeout)
  --permission-mode <m>  claude --permission-mode (e.g. acceptEdits)
  --model <name>         claude --model override
  --log <file>           append logs to a file
  --secrets <file>       notify secrets json (default: <repo>/autoloop.secrets.json)
                         shape: {"telegram":{"token":"...","chatId":"..."},"webhookUrl":"..."}
                         or env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID / AUTOLOOP_WEBHOOK_URL
  --no-notify            disable notifications even if secrets exist
  --claude-cmd <cmd>     override the claude binary (testing hook)
  --help                 this help

EXAMPLE
  autoloop start --cwd "F:\\my-proj" --session 61bcda09-... ^
    --state-file "F:\\my-proj\\docs\\BUILD-STATE.md" ^
    --prompt-file "F:\\my-proj\\docs\\round-prompt.txt" ^
    --permission-mode acceptEdits --max-cycles 20 --log F:\\my-proj\\autoloop.log
`;

function parseArgs(argv) {
  const cfg = {
    cmd: null,
    cwd: null,
    stateFile: null,
    sessionId: null,
    prompt: 'อ่าน state file แล้วทำงานรอบถัดไปตามแผน จบรอบแล้วอัปเดต state และจบเทิร์น',
    promptFile: null,
    stopMarker: 'AUTOLOOP: COMPLETE',
    maxCycles: 30,
    maxWaits: 20,
    fallbackWaitMin: 300,
    bufferSec: 90,
    minRetrySec: 60,
    cooldownSec: 0,
    attemptTimeoutSec: 0,
    permissionMode: null,
    model: null,
    logFile: null,
    secretsFile: null,
    noNotify: false,
    claudeCmd: 'claude',
    help: false,
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('--')) cfg.cmd = args.shift();

  const take = () => {
    const v = args.shift();
    if (v === undefined) throw new Error('missing value for flag');
    return v;
  };

  while (args.length) {
    const a = args.shift();
    switch (a) {
      case '--cwd': cfg.cwd = resolve(take()); break;
      case '--state-file': cfg.stateFile = resolve(take()); break;
      case '--session': cfg.sessionId = take(); break;
      case '--prompt': cfg.prompt = take(); break;
      case '--prompt-file': cfg.promptFile = resolve(take()); break;
      case '--stop-marker': cfg.stopMarker = take(); break;
      case '--max-cycles': cfg.maxCycles = Number(take()); break;
      case '--max-waits': cfg.maxWaits = Number(take()); break;
      case '--fallback-wait-min': cfg.fallbackWaitMin = Number(take()); break;
      case '--buffer': cfg.bufferSec = Number(take()); break;
      case '--min-retry': cfg.minRetrySec = Number(take()); break;
      case '--cooldown': cfg.cooldownSec = Number(take()); break;
      case '--timeout': cfg.attemptTimeoutSec = Number(take()); break;
      case '--permission-mode': cfg.permissionMode = take(); break;
      case '--model': cfg.model = take(); break;
      case '--log': cfg.logFile = resolve(take()); break;
      case '--secrets': cfg.secretsFile = resolve(take()); break;
      case '--no-notify': cfg.noNotify = true; break;
      case '--claude-cmd': cfg.claudeCmd = take(); break;
      case '--help': case '-h': cfg.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  return cfg;
}

function requireRunConfig(cfg) {
  const missing = [];
  if (!cfg.cwd) missing.push('--cwd');
  if (!cfg.stateFile) missing.push('--state-file');
  if (missing.length) throw new Error(`ต้องระบุ ${missing.join(', ')} (ดู --help)`);
  if (!existsSync(cfg.stateFile)) {
    throw new Error(`ไม่พบ state file: ${cfg.stateFile} — สร้างไฟล์แผน/checklist ก่อน แล้วค่อยรัน`);
  }
  if (!Number.isFinite(cfg.maxCycles) || cfg.maxCycles < 1) throw new Error('--max-cycles ต้อง ≥ 1');
  if (!Number.isFinite(cfg.fallbackWaitMin) || cfg.fallbackWaitMin < 1) throw new Error('--fallback-wait-min ต้อง ≥ 1');
}

/** Re-build the argv for a detached `run`, preserving every user flag. */
function toRunArgv(cfg) {
  const out = ['run', '--cwd', cfg.cwd, '--state-file', cfg.stateFile];
  if (cfg.sessionId) out.push('--session', cfg.sessionId);
  if (cfg.promptFile) out.push('--prompt-file', cfg.promptFile);
  else out.push('--prompt', cfg.prompt);
  out.push('--stop-marker', cfg.stopMarker);
  out.push('--max-cycles', String(cfg.maxCycles));
  out.push('--max-waits', String(cfg.maxWaits));
  out.push('--fallback-wait-min', String(cfg.fallbackWaitMin));
  out.push('--buffer', String(cfg.bufferSec));
  out.push('--min-retry', String(cfg.minRetrySec));
  if (cfg.cooldownSec) out.push('--cooldown', String(cfg.cooldownSec));
  if (cfg.attemptTimeoutSec) out.push('--timeout', String(cfg.attemptTimeoutSec));
  if (cfg.permissionMode) out.push('--permission-mode', cfg.permissionMode);
  if (cfg.model) out.push('--model', cfg.model);
  if (cfg.logFile) out.push('--log', cfg.logFile);
  if (cfg.secretsFile) out.push('--secrets', cfg.secretsFile);
  if (cfg.noNotify) out.push('--no-notify');
  if (cfg.claudeCmd !== 'claude') out.push('--claude-cmd', cfg.claudeCmd);
  return out;
}

function buildNotifyTargets(cfg) {
  if (cfg.noNotify) return [];
  return resolveTargets(loadSecrets(cfg.secretsFile));
}

async function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[autoloop] ${err.message}\n`);
    return 2;
  }
  if (cfg.help || !cfg.cmd) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cfg.cmd) {
    case 'list': {
      const sessions = await listSessions();
      process.stdout.write(formatSessions(sessions) + '\n');
      return 0;
    }

    case 'notify-setup': {
      if (!process.stdin.isTTY) {
        process.stderr.write('[autoloop] notify-setup ต้องรันในเทอร์มินัลจริง (interactive)\n');
        return 2;
      }
      const { runNotifySetup } = await import('../src/notify-setup.mjs');
      return await runNotifySetup({ secretsFile: cfg.secretsFile || defaultSecretsPath });
    }

    case 'notify-test': {
      const targets = buildNotifyTargets(cfg);
      if (!targets.length) {
        process.stdout.write(
          `[autoloop] ไม่พบช่องทางแจ้งเตือน — สร้าง ${cfg.secretsFile || defaultSecretsPath}\n` +
            `  {"telegram":{"token":"<bot token>","chatId":"<chat id>"}}\n` +
            `  หรือ set env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID / AUTOLOOP_WEBHOOK_URL\n`,
        );
        return 1;
      }
      const { fmtDateTime } = await import('../src/notify.mjs');
      const results = await notifyAll(targets, {
        status: 'test',
        message: `ถ้าเห็นข้อความนี้ = ระบบแจ้งเตือนใช้งานได้ ✅\nรูปแบบวันเวลาที่จะใช้: ${fmtDateTime(Date.now())}`,
      });
      results.forEach((r, i) =>
        process.stdout.write(`[autoloop] ${targets[i].kind}: ${r.ok ? `OK (${r.status})` : `FAILED ${JSON.stringify(r)}`}\n`),
      );
      return results.every((r) => r.ok) ? 0 : 1;
    }

    case 'run': {
      try {
        requireRunConfig(cfg);
      } catch (err) {
        process.stderr.write(`[autoloop] ${err.message}\n`);
        return 2;
      }
      if (cfg.logFile) setLogFile(cfg.logFile);
      const notifyTargets = buildNotifyTargets(cfg);
      log('info', `autoloop run · cwd=${cfg.cwd} · state=${cfg.stateFile} · marker="${cfg.stopMarker}" · notify=${notifyTargets.map((t) => t.kind).join('+') || 'off'}`);
      if (!cfg.sessionId) {
        log('warn', 'ไม่ได้ระบุ --session → จะ --continue แชทล่าสุดใน cwd ซึ่งอาจไม่ใช่ตัวที่ตั้งใจ (แนะนำ: autoloop list แล้วระบุ --session)');
      }
      return await runEngine({ ...cfg, notifyTargets });
    }

    case 'start': {
      try {
        requireRunConfig(cfg);
      } catch (err) {
        process.stderr.write(`[autoloop] ${err.message}\n`);
        return 2;
      }
      const existing = readRuntime(cfg.stateFile);
      if (existing && existing.status && ['running', 'sleeping'].includes(existing.status) && existing.pid) {
        try {
          process.kill(existing.pid, 0); // probe: is it actually alive?
          process.stderr.write(
            `[autoloop] มีตัวเก่ารันอยู่แล้ว (pid ${existing.pid}, status=${existing.status}) — ใช้ 'autoloop stop' ก่อนถ้าจะเริ่มใหม่\n`,
          );
          return 1;
        } catch {
          /* stale pid → fine to start */
        }
      }
      const logFile = cfg.logFile || `${cfg.stateFile}.autoloop.log`;
      const out = openSync(logFile, 'a');
      const child = spawn(
        process.execPath,
        [resolve(__dirname, 'autoloop.mjs'), ...toRunArgv({ ...cfg, logFile })],
        { detached: true, stdio: ['ignore', out, out] },
      );
      child.unref();
      process.stdout.write(
        `[autoloop] started (pid ${child.pid})\n` +
          `  log:    ${logFile}\n` +
          `  state:  ${cfg.stateFile}\n` +
          `  status: node ${resolve(__dirname, 'autoloop.mjs')} status --state-file "${cfg.stateFile}"\n`,
      );
      return 0;
    }

    case 'status': {
      if (!cfg.stateFile) {
        process.stderr.write('[autoloop] ต้องระบุ --state-file\n');
        return 2;
      }
      cfg.stateFile = resolve(cfg.stateFile);
      const rt = readRuntime(cfg.stateFile);
      if (!rt) {
        process.stdout.write(`[autoloop] ยังไม่มี runtime state (${runtimePath(cfg.stateFile)})\n`);
        return 1;
      }
      let alive = false;
      if (rt.pid) {
        try {
          process.kill(rt.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      process.stdout.write(JSON.stringify({ ...rt, processAlive: alive }, null, 2) + '\n');
      const logFile = `${cfg.stateFile}.autoloop.log`;
      if (existsSync(logFile)) {
        const tail = readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8);
        process.stdout.write('\n--- log tail ---\n' + tail.join('\n') + '\n');
      }
      return 0;
    }

    case 'stop': {
      if (!cfg.stateFile) {
        process.stderr.write('[autoloop] ต้องระบุ --state-file\n');
        return 2;
      }
      cfg.stateFile = resolve(cfg.stateFile);
      const rt = readRuntime(cfg.stateFile);
      if (!rt || !rt.pid) {
        process.stdout.write('[autoloop] ไม่พบ process ที่รันอยู่\n');
        return 1;
      }
      try {
        process.kill(rt.pid);
        process.stdout.write(`[autoloop] ส่งสัญญาณหยุดไปที่ pid ${rt.pid} แล้ว (จะหยุดหลังจบรอบ/การรอปัจจุบัน)\n`);
        return 0;
      } catch (err) {
        process.stdout.write(`[autoloop] pid ${rt.pid} ไม่อยู่แล้ว (${err.code || err.message})\n`);
        return 1;
      }
    }

    default:
      process.stderr.write(`[autoloop] unknown command: ${cfg.cmd}\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[autoloop] unexpected: ${err?.stack || err}\n`);
    process.exit(1);
  });
