# Registers the TH108 lighting daemon to start (hidden) at every logon.
# Run once:  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
$daemonDir = "path\to\th108-suite\th108-daemon"
$vbs = Join-Path $daemonDir "start-hidden.vbs"

if (-not (Test-Path $vbs)) { Write-Error "start-hidden.vbs not found at $vbs"; exit 1 }

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"{0}"' -f $vbs)
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "TH108 Lighting Daemon" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Always-on host lighting for Epomaker TH108 V2 PRO" -Force | Out-Null

Write-Host "[+] Installed. It will start hidden at next logon."
Write-Host "    Start it now without rebooting:  wscript `"$vbs`""
Write-Host "    Remove it later:                 .\uninstall-autostart.ps1"
