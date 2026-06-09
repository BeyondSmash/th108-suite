# Removes the daemon's auto-start: the per-user Run key, plus the legacy
# Task Scheduler entry from older installs (that one needs an admin shell).
#   powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "TH108LightingDaemon" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "TH108 Lighting Daemon" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[-] TH108 daemon auto-start removed."
