@echo off
rem ============================================================
rem  TH108 Suite - uninstall
rem  Fully reverses setup.cmd: stops the daemon, removes auto-start,
rem  the Start-menu shortcut, and the built helper exe, then (behind
rem  ONE admin prompt) removes the recovery task + WebHID pre-grant.
rem  KEEPS your saved layers (browser localStorage) and media library.
rem ============================================================
setlocal
cd /d "%~dp0"

echo [1/6] Asking a running daemon to quit...
curl -s -X POST http://localhost:8123/quit >nul 2>nul

echo [2/6] Removing auto-start (per-user logon task + Run key)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0th108-daemon\uninstall-autostart.ps1" >nul 2>nul

echo [3/6] Removing the Start-menu shortcut...
powershell -NoProfile -Command "Remove-Item ([Environment]::GetFolderPath('Programs') + '\TH108 Lighting.lnk') -ErrorAction SilentlyContinue" >nul 2>nul

echo [4/6] Removing the built audio-capture helper...
if exist "%~dp0th108-daemon\app-capture.exe" del /f /q "%~dp0th108-daemon\app-capture.exe" >nul 2>nul

rem The th108:// handler and the window-focus debug log live OUTSIDE this folder, so "just delete the
rem folder" would leave them behind. Clear both here so an uninstall really is complete.
echo [5/6] Removing the th108:// link handler and the debug log...
reg delete "HKCU\Software\Classes\th108" /f >nul 2>nul
if exist "%TEMP%\th108-focuswin.log" del /f /q "%TEMP%\th108-focuswin.log" >nul 2>nul

echo [6/6] Removing the admin helpers (recovery task + WebHID grant) - ONE admin prompt...
echo       Never installed them? Click No - there's nothing to remove.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0th108-daemon\uninstall-admin-extras.ps1\"'" 2>nul

echo.
echo Done. Auto-start, the Start-menu shortcut, and the background pieces are removed.
echo Your saved layers and media library are UNTOUCHED (they live in the browser).
echo   - To finish removing the suite, just delete this folder.
echo   - To reinstall later, run setup.cmd.
echo   - The WebHID browser grant clears after a full browser restart.
pause
