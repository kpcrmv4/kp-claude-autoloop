import { spawn } from 'node:child_process';

/**
 * Build the claude CLI argv (no prompt — that goes via stdin). Pure → testable.
 * Adapted from the original `autoresume` runner.
 */
export function buildClaudeArgs({ sessionId, permissionMode, model, effort, extraArgs, streamJson }) {
  const args = ['-p', '--output-format', streamJson ? 'stream-json' : 'json'];
  if (streamJson) args.push('--verbose'); // claude requires --verbose with -p stream-json

  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    args.push('--continue');
  }
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);

  return args;
}

/**
 * Quote a single argument so cmd.exe + the npm `.cmd` shim forward it intact.
 * Algorithm from https://qntm.org/cmd (same one cross-spawn uses).
 */
export function escapeCmdArg(arg) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(/[ <>&|^!()%]/g, '^$&');
  return s;
}

/** Single shell command string for Windows (`claude` is a .cmd shim → needs a shell). */
export function buildWinCommand(claudeCmd, args) {
  // claudeCmd may itself contain spaces (e.g. "node F:\\x\\mock.mjs" for tests)
  return [claudeCmd, ...args.map(escapeCmdArg)].join(' ');
}

/**
 * Spawn one headless `claude` turn. The prompt is fed through stdin so we never
 * have to escape it for the shell.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string, spawnError?:boolean, timedOut?:boolean}>}
 */
export function runClaudeOnce({
  cwd,
  prompt,
  sessionId,
  permissionMode,
  model,
  effort,
  attemptTimeoutSec = 0,
  extraArgs,
  claudeCmd = 'claude', // test hook: point at a mock script
  streamJson = false,
  onStdout, // optional live chunk callback (used by the split-screen view)
}) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs({ sessionId, permissionMode, model, effort, extraArgs, streamJson });
    const isWin = process.platform === 'win32';

    let child;
    try {
      // windowsHide: a detached (console-less) engine would otherwise pop a black
      // console window for every round's claude spawn
      child = isWin
        ? spawn(buildWinCommand(claudeCmd, args), { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        : spawn(claudeCmd, args, { cwd, shell: claudeCmd.includes(' '), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), spawnError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    const timer =
      attemptTimeoutSec > 0
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
            done({ code: -1, stdout, stderr: stderr + '\n[autoloop] attempt timed out', timedOut: true });
          }, attemptTimeoutSec * 1000)
        : null;

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) {
        try {
          onStdout(s);
        } catch {
          /* live view must never crash the run */
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => done({ code: -1, stdout, stderr: `${stderr}\n${String(err)}`, spawnError: true }));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));

    try {
      child.stdin.write(prompt + '\n');
      child.stdin.end();
    } catch {
      /* close handler will fire */
    }
  });
}
