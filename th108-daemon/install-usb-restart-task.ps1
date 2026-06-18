# Registers the elevated on-demand scheduled task the TH108 daemon triggers to clear a board ACK-mute/wedge
# (PnP restart of the keyboard's USB device node = software replug; payload: restart-usb.bat).
# RUN THIS ONCE AS ADMINISTRATOR. The daemon itself stays unelevated -- `schtasks /run` on a task you own
# needs no UAC prompt. Remove with:  Unregister-ScheduledTask -TaskName 'TH108 USB Restart' -Confirm:$false
$bat = Join-Path $PSScriptRoot 'restart-usb.bat'
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path $bat)) { Write-Error "restart-usb.bat not found next to this script"; exit 1 }
if (-not (Test-Path $vbs)) { Write-Error "run-hidden.vbs not found next to this script"; exit 1 }
# Launch the recovery through run-hidden.vbs (window style 0) instead of cmd.exe directly, so the batch
# + its inner powershell device lookup never flash a console that steals keyboard focus while you're typing.
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'TH108 USB Restart' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Write-Host '✓ scheduled task "TH108 USB Restart" registered (on-demand, elevated, HIDDEN — no focus-stealing window).'
Write-Host '  The daemon triggers it automatically after 30s of board mute (10 min cooldown).'
Write-Host '  Manual fire:  schtasks /run /tn "TH108 USB Restart"'
Write-Host '  NOTE: if you registered this task before the hidden-window fix, RE-RUN this script (as admin) to replace it.'
