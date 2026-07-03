@echo off
rem KP Claude Autoloop — dashboard launcher (this is what the desktop shortcut points at).
rem Starts the localhost dashboard and opens the browser. If a previous server is
rem still running on the port, it skips starting a new one and just opens the page.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found - run setup.cmd first
  pause
  exit /b 1
)
node "bin\autoloop.mjs" ui --open
if errorlevel 1 pause
