// `autoloop doctor` — check the machine has everything the loop needs
// (node / npm / claude CLI / git), summarize what's missing, ask once
// (Y+Enter) before installing, then drop a desktop shortcut that opens
// the dashboard. Windows-first; degrades to report-only elsewhere.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MIN_NODE_MAJOR = 18;

/** Does a `node --version` style string satisfy the minimum major? Pure → testable. */
export function nodeVersionOk(version, minMajor = MIN_NODE_MAJOR) {
  const m = /v?(\d+)/.exec(String(version || ''));
  return Boolean(m) && Number(m[1]) >= minMajor;
}

/** Run `<cmd> --version`; never throws. @returns {Promise<{ok:boolean, version?:string}>} */
export function probeTool(cmd, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      // shell:true so Windows .cmd shims (claude, npm) resolve like a real terminal
      child = spawn(`${cmd} --version`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolvePromise({ ok: false });
      return;
    }
    let out = '';
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(r);
      }
    };
    const timer = setTimeout(() => {
      try {
        // shell:true means child is the shell — kill the whole tree or the probed tool leaks
        if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
      done({ ok: false });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => done({ ok: false }));
    child.on('close', (code) => done(code === 0 ? { ok: true, version: out.trim().split(/\r?\n/)[0] } : { ok: false }));
  });
}

/** Turn probe results into a to-install list with the exact commands. Pure → testable.
 *  Non-Windows: winget doesn't exist → those entries become manual hints (cmd: null). */
export function buildInstallPlan(checks, platform = process.platform) {
  const win = platform === 'win32';
  const nodeInstall = win
    ? 'winget install --id OpenJS.NodeJS.LTS -e --source winget'
    : null; // manual: nodejs.org or the OS package manager
  const plan = [];
  for (const c of checks) {
    if (c.ok) continue;
    if (c.name === 'claude') plan.push({ name: 'Claude Code CLI', cmd: 'npm install -g @anthropic-ai/claude-code' });
    else if (c.name === 'git') plan.push({ name: 'Git', cmd: win ? 'winget install --id Git.Git -e --source winget' : null, hint: win ? null : 'https://git-scm.com or your package manager (apt/brew)' });
    else if (c.name === 'node') plan.push({ name: 'Node.js LTS', cmd: nodeInstall, hint: win ? null : 'https://nodejs.org or your package manager (apt/brew)' });
    else if (c.name === 'npm') plan.push({ name: 'npm (มากับ Node.js)', cmd: nodeInstall, hint: win ? null : 'https://nodejs.org or your package manager (apt/brew)' });
  }
  // one installer covers both node+npm; keep at most one manual-node hint too
  return plan.filter((p, i) => plan.findIndex((q) => q.name === p.name || (q.cmd && q.cmd === p.cmd)) === i);
}

function runInherit(cmd) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, { shell: true, stdio: 'inherit' });
    child.on('error', () => resolvePromise(1));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/** Create/overwrite the desktop shortcut → launch-ui.cmd (minimized window). */
export async function createDesktopShortcut() {
  if (process.platform !== 'win32') return { ok: false, skipped: 'not windows' };
  const target = resolve(repoRoot, 'launch-ui.cmd');
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell;",
    "$lnk = $ws.CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'KP Claude Autoloop.lnk'));",
    `$lnk.TargetPath = '${target.replace(/'/g, "''")}';`,
    `$lnk.WorkingDirectory = '${repoRoot.replace(/'/g, "''")}';`,
    '$lnk.WindowStyle = 7;',
    "$lnk.IconLocation = '%SystemRoot%\\System32\\imageres.dll, 109';",
    "$lnk.Description = 'KP Claude Autoloop dashboard';",
    '$lnk.Save();',
    "Write-Output $lnk.FullName;",
  ].join(' ');
  return new Promise((resolvePromise) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolvePromise({ ok: false, error: String(e) }));
    child.on('close', (code) => resolvePromise(code === 0 ? { ok: true, path: out.trim() } : { ok: false, error: err.trim() || `exit ${code}` }));
  });
}

export async function runDoctor({ yes = false } = {}) {
  const say = (s) => output.write(s + '\n');
  say('');
  say('🩺 autoloop doctor — ตรวจเครื่องมือที่จำเป็น / checking required tools');
  say('');

  const checks = [
    { name: 'node', label: 'Node.js (≥18)', ...(await probeTool('node')) },
    { name: 'npm', label: 'npm', ...(await probeTool('npm')) },
    { name: 'claude', label: 'Claude Code CLI', ...(await probeTool('claude')) },
    { name: 'git', label: 'Git', ...(await probeTool('git')) },
  ];
  const nodeCheck = checks.find((c) => c.name === 'node');
  if (nodeCheck.ok && !nodeVersionOk(nodeCheck.version)) {
    nodeCheck.ok = false;
    nodeCheck.outdated = true;
  }

  for (const c of checks) {
    say(`  ${c.ok ? '✅' : '❌'} ${c.label.padEnd(18)} ${c.ok ? c.version : c.outdated ? `เจอ ${c.version} — เก่าไป ต้อง ≥ v${MIN_NODE_MAJOR}` : 'ไม่พบ / not found'}`);
  }

  const plan = buildInstallPlan(checks);
  if (!plan.length) {
    say('');
    say('✅ ครบทุกอย่างแล้ว / everything installed');
  } else {
    say('');
    say('ต้องติดตั้งเพิ่ม / needs installing:');
    for (const p of plan) say(`  • ${p.name}\n      ${p.cmd || `ติดตั้งเอง / install manually: ${p.hint}`}`);
    say('');
    const runnable = plan.filter((p) => p.cmd);
    if (!runnable.length) {
      say('ติดตั้งตามลิงก์ด้านบนแล้วรัน doctor ซ้ำ / install via the links above, then re-run doctor');
      return 1;
    }
    let go = yes;
    if (!go) {
      if (!process.stdin.isTTY) {
        say('(ไม่ใช่ terminal แบบ interactive — รัน `autoloop doctor --yes` เพื่อติดตั้งอัตโนมัติ)');
        return 1;
      }
      const rl = createInterface({ input, output });
      try {
        const ans = (await rl.question('ติดตั้งเลยไหม? / install now? [Y/n] ')).trim().toLowerCase();
        go = ans === '' || ans === 'y';
      } finally {
        rl.close();
      }
    }
    if (!go) {
      say('ข้ามการติดตั้ง — รันคำสั่งด้านบนเองได้เลย / skipped, run the commands above yourself');
      return 1;
    }
    for (const p of runnable) {
      say(`\n→ ${p.cmd}`);
      const code = await runInherit(p.cmd);
      say(code === 0 ? `  ✅ ${p.name} เรียบร้อย` : `  ❌ ${p.name} ล้มเหลว (exit ${code}) — ติดตั้งเองแล้วรัน doctor ซ้ำ`);
    }
  }

  // shortcut: double-click → start dashboard + open browser (skips if already running)
  const sc = await createDesktopShortcut();
  say('');
  if (sc.ok) say(`🔗 สร้างชอร์ตคัตแล้ว: ${sc.path}\n   ดับเบิลคลิกเพื่อเปิด dashboard (ถ้า server รันค้างอยู่จะเปิดหน้าเว็บให้เลย)`);
  else if (sc.skipped) say(`(ข้ามการสร้างชอร์ตคัต — ${sc.skipped})`);
  else say(`⚠ สร้างชอร์ตคัตไม่สำเร็จ: ${sc.error}`);
  return 0;
}
