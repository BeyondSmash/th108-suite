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
  echo [!] Node.js is required but was not found - it is a free, one-time install
  echo     ^(the daemon runs on it^). Opening the download page now...
  start "" https://nodejs.org/en/download
  echo     Install the LTS, then double-click setup.cmd again.
  pause
  exit /b 1
)

echo [1/7] Installing daemon dependencies...
pushd th108-daemon
call npm ci --no-audit --no-fund
if errorlevel 1 (
  echo [!] npm ci failed - see the output above.
  popd
  pause
  exit /b 1
)
popd

echo [2/7] Building the per-app audio capture helper (in-box .NET compiler, no SDK)...
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if exist "%CSC%" (
  "%CSC%" -nologo -optimize -out:"%~dp0th108-daemon\app-capture.exe" "%~dp0th108-daemon\app-capture.cs"
  if errorlevel 1 (
    echo     [!] app-capture.exe build failed - "Specific app" audio source will be unavailable ^(the rest works^).
  ) else (
    echo     Built app-capture.exe ^(enables the "Specific app" music-layer source^).
  )
) else (
  echo     [!] In-box C# compiler not found - skipping the per-app helper ^("Specific app" source unavailable^).
)

echo [3/7] Enabling auto-start at login (per-user Run key, no admin)...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v TH108LightingDaemon /t REG_SZ /d "wscript.exe \"%~dp0th108-daemon\start-tray.vbs\"" /f >nul

echo [4/7] Adding the Start-menu shortcut (TH108 Lighting)...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $l = $ws.CreateShortcut([Environment]::GetFolderPath('Programs') + '\TH108 Lighting.lnk'); $l.TargetPath = 'wscript.exe'; $l.Arguments = '\"%~dp0th108-daemon\start-tray.vbs\"'; $l.Description = 'TH108 lighting tray + daemon'; $l.Save()" >nul

echo [5/7] Installing recovery + permission helpers (ONE admin prompt - click No to skip)...
echo       - Auto-Fix Lighting Wedge: hidden USB-restart recovery task
echo       - WebHID pre-grant: skips the keyboard picker forever
echo       Both are OPTIONAL - the suite works fine without them.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0th108-daemon\install-admin-extras.ps1\"'" 2>nul

echo [6/7] Starting the tray (it starts and watches the daemon)...
wscript "%~dp0th108-daemon\start-tray.vbs"

echo [7/7] Opening the controller...
timeout /t 3 /nobreak >nul
start http://localhost:8123/

echo.
echo Done. Look for the salmon keyboard icon in your system tray - that is
echo the suite's home: it starts at login, watches the daemon, and reopens
echo the controller (double-click). Closed it? Start menu ^> TH108 Lighting.
echo.
echo One manual step remains: click "Connect Keyboard" and pick your
echo keyboard once - the browser requires that click (WebHID permission).
echo (If you accepted the admin prompt above, restart the browser once and
echo  even that picker is skipped from then on.)
echo The daemon keeps your lighting running even with the page closed.
echo.
echo Skipped the admin prompt and want the helpers later? Run as admin:
echo   powershell -ExecutionPolicy Bypass -File th108-daemon\install-admin-extras.ps1
echo.
echo To remove everything later, run uninstall.cmd (keeps your saved layers).
pause
