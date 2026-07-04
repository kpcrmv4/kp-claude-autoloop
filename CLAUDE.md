# claude-autoloop — agent guide

Zero-dependency Node ≥18 CLI (`bin/autoloop.mjs`) that keeps a Claude Code session working
round-by-round across usage limits, plus a localhost dashboard (`autoloop ui`).

## Installing for a user (the correct sequence)

```bash
node bin/autoloop.mjs doctor --yes   # checks node/npm/claude/git, installs what's missing (winget/npm), creates the desktop shortcut
node bin/autoloop.mjs ui --open      # starts the dashboard on 127.0.0.1:4900 and opens the browser (reuses an already-running server)
```

- NEVER run `setup.cmd` or `launch-ui.cmd` from an agent shell — they are interactive
  (pause / Y-prompts) and will hang a headless shell. They exist for humans to double-click.
- `doctor` without `--yes` prompts on missing tools; with `--yes` it installs silently.
- No `npm install` needed — pure node, zero runtime dependencies.

## Ground rules

- `autoloop.secrets.json` holds a live Telegram bot token. It is gitignored — never commit,
  print, or copy it. The UI/API only ever expose a masked form.
- Tests must stay sandboxed: they rely on `AUTOLOOP_HOME` and `AUTOLOOP_SECRETS` env vars
  pointing into tmp — never let a test touch the real registry/secrets.
- Run the full suite with `npm test` (unit → ui → smoke; the smoke test uses a mock claude,
  it never spends quota). Keep it green before committing.
- The dashboard server loads `.mjs` modules at startup but serves `ui.html` fresh from disk:
  HTML/JS edits are live on refresh, server-code edits need a dashboard restart.
- UI text is bilingual: every user-facing string lives in the `L` dict in `src/ui.html`
  (en + th) or in paired `data-lang="en"` / `data-lang="th"` blocks. Add both when adding text.
- Icons are inline lucide SVG sprites in `ui.html` — no emoji in the UI, no CDN assets
  (tailwind is vendored at `src/assets/tailwind.js`).

## Key files

- `bin/autoloop.mjs` — CLI entry: run/start/stop/status/list/ui/doctor/notify-*
- `src/engine.mjs` — the loop: round → classify (ok/limited/error) → sleep-until-reset → resume;
  appends the loop-protocol block to round prompts that don't mention the stop marker
- `src/limit.mjs` — usage-limit detection + reset-time parsing (structured result first)
- `src/ui-server.mjs` + `src/ui.html` — localhost dashboard (binds 127.0.0.1 only;
  mutating POSTs require the `x-autoloop` header)
- `src/doctor.mjs` — tool checks, guided install, desktop-shortcut creation
- `src/notify.mjs` — Telegram/webhook events; every message carries plan progress
- `src/bot.mjs` — two-way Telegram: long-poll listener inside the dashboard process
  answering /status and /stop (graceful, stop-signal file) for the configured chatId only
