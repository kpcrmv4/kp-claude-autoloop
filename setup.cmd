@echo off
rem KP Claude Autoloop — one-time setup. Double-click me.
rem 1) makes sure Node.js exists (offers winget install, asks Y first)
rem 2) runs `autoloop doctor` for the rest (claude CLI / git) — asks Y before installing
rem 3) doctor drops a desktop shortcut that opens the dashboard on double-click
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   KP Claude Autoloop - setup
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel%==0 goto havenode

echo [!] Node.js not found on this machine.
set "ANS="
set /p ANS="Install Node.js LTS via winget now? [Y/n] "
if /i "%ANS%"=="n" (
  echo Skipped. Install Node.js from https://nodejs.org then run setup.cmd again.
  pause
  exit /b 1
)
winget install --id OpenJS.NodeJS.LTS -e --source winget
if errorlevel 1 (
  echo [!] winget install failed - install Node.js manually from https://nodejs.org
  pause
  exit /b 1
)
echo.
echo [i] Node.js installed. Close this window and run setup.cmd again
echo     (a fresh window is needed so PATH picks up node).
pause
exit /b 0

:havenode
node "bin\autoloop.mjs" doctor
if errorlevel 1 (
  echo.
  echo [!] Some tools are still missing or were skipped. Fix the items above,
  echo     then run setup.cmd again in a NEW window ^(installs need a fresh PATH^).
  pause
  exit /b 1
)
echo.
set "GO="
set /p GO="Open the dashboard now? [Y/n] "
if /i not "%GO%"=="n" node "bin\autoloop.mjs" ui --open
pause
