# Removes the daemon's auto-start: the per-user logon task and Run key (both written by
# install-autostart.ps1), plus the legacy Task Scheduler entry from much older installs (that one
# was created elevated, so it needs an admin shell to go).
#   powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "TH108LightingDaemon" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "TH108 Lighting Tray" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "TH108 Lighting Daemon" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[-] TH108 daemon auto-start removed."
