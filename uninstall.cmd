@echo off
rem ============================================================
rem  TH108 Suite - uninstall the background pieces
rem  Removes auto-start and stops a running daemon.
rem  Keeps your settings (browser localStorage) and media library.
rem ============================================================
setlocal
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v TH108LightingDaemon /f >nul 2>nul
schtasks /Delete /TN "TH108 Lighting Daemon" /F >nul 2>nul
curl -s -X POST http://localhost:8123/quit >nul 2>nul
echo [-] Auto-start removed. A running daemon has been asked to quit.
echo     (Settings and media library are untouched. Re-run setup.cmd to reinstall.)
pause
