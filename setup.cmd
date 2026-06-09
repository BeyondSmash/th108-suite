@echo off
rem ============================================================
rem  TH108 Suite - one-time setup
rem  Installs daemon dependencies, enables auto-start at login
rem  (per-user, no admin), starts the daemon, opens the controller.
rem  Requires: Node.js LTS (https://nodejs.org)
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is required but was not found.
  echo     Install the LTS from https://nodejs.org and re-run setup.cmd
  pause
  exit /b 1
)

echo [1/4] Installing daemon dependencies...
pushd th108-daemon
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [!] npm install failed - see the output above.
  popd
  pause
  exit /b 1
)
popd

echo [2/4] Enabling auto-start at login (per-user Run key, no admin)...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v TH108LightingDaemon /t REG_SZ /d "wscript.exe \"%~dp0th108-daemon\start-hidden.vbs\"" /f >nul

echo [3/4] Starting the daemon (hidden)...
wscript "%~dp0th108-daemon\start-hidden.vbs"

echo [4/4] Opening the controller...
timeout /t 2 /nobreak >nul
start http://localhost:8123/

echo.
echo Done. The controller lives at http://localhost:8123
echo One manual step remains: click "1 - Connect keyboard" and pick your
echo keyboard once - the browser requires that click (WebHID permission).
echo The daemon keeps your lighting running even with the page closed.
pause
