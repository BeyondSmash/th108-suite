# Removes the auto-start task.
#   powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
Unregister-ScheduledTask -TaskName "TH108 Lighting Daemon" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[-] TH108 Lighting Daemon auto-start removed."
