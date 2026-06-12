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

echo [1/5] Installing daemon dependencies...
pushd th108-daemon
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [!] npm install failed - see the output above.
  popd
  pause
  exit /b 1
)
popd

echo [2/5] Enabling auto-start at login (per-user Run key, no admin)...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v TH108LightingDaemon /t REG_SZ /d "wscript.exe \"%~dp0th108-daemon\start-tray.vbs\"" /f >nul

echo [3/5] Adding the Start-menu shortcut (TH108 Lighting)...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $l = $ws.CreateShortcut([Environment]::GetFolderPath('Programs') + '\TH108 Lighting.lnk'); $l.TargetPath = 'wscript.exe'; $l.Arguments = '\"%~dp0th108-daemon\start-tray.vbs\"'; $l.Description = 'TH108 lighting tray + daemon'; $l.Save()" >nul

echo [4/5] Starting the tray (it starts and watches the daemon)...
wscript "%~dp0th108-daemon\start-tray.vbs"

echo [5/5] Opening the controller...
timeout /t 3 /nobreak >nul
start http://localhost:8123/

echo.
echo Done. Look for the salmon keyboard icon in your system tray - that is
echo the suite's home: it starts at login, watches the daemon, and reopens
echo the controller (double-click). Closed it? Start menu ^> TH108 Lighting.
echo.
echo One manual step remains: click "Connect Keyboard" and pick your
echo keyboard once - the browser requires that click (WebHID permission).
echo OPTIONAL (skips that picker forever, needs admin once):
echo   powershell -ExecutionPolicy Bypass -File th108-daemon\install-webhid-grant.ps1
echo The daemon keeps your lighting running even with the page closed.
pause
