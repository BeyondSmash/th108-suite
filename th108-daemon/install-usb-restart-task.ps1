# Registers the elevated on-demand scheduled task the TH108 daemon triggers to clear a board ACK-mute/wedge
# (PnP restart of the keyboard's USB device node = software replug; payload: restart-usb.bat).
# RUN THIS ONCE AS ADMINISTRATOR. The daemon itself stays unelevated -- `schtasks /run` on a task you own
# needs no UAC prompt. Remove with:  Unregister-ScheduledTask -TaskName 'TH108 USB Restart' -Confirm:$false
$bat = Join-Path $PSScriptRoot 'restart-usb.bat'
if (-not (Test-Path $bat)) { Write-Error "restart-usb.bat not found next to this script"; exit 1 }
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`""
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'TH108 USB Restart' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Write-Host '✓ scheduled task "TH108 USB Restart" registered (on-demand, elevated).'
Write-Host '  The daemon triggers it automatically after 30s of board mute (10 min cooldown).'
Write-Host '  Manual fire:  schtasks /run /tn "TH108 USB Restart"'
