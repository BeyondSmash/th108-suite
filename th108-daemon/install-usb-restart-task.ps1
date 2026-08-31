# Registers the elevated on-demand scheduled task the TH108 daemon triggers to clear a board ACK-mute/wedge
# (PnP restart of the keyboard's USB device node = software replug; payload: restart-usb.bat).
# RUN THIS ONCE AS ADMINISTRATOR (uninstall.cmd / install-admin-extras.ps1 elevate it for you).
#
# SECURITY - why the payload is COPIED to Program Files instead of run from this folder:
# This task runs at RunLevel Highest, and the daemon fires it with NO UAC prompt (`schtasks /run` needs no
# elevation for a task you own - that is deliberate, it is how recovery stays silent). So whatever file the
# task points at is, in effect, "arbitrary code that runs as administrator on demand". If that file sat in
# the repo folder - which the logged-in user can write - then ANY program running as that ordinary user
# could overwrite restart-usb.bat, run `schtasks /run /tn "TH108 USB Restart"`, and execute its own code at
# administrator level with no prompt. That is a textbook UAC bypass / local privilege escalation.
# Deploying to C:\Program Files\TH108 Lighting fixes it: that directory is admin-write-only by inherited
# ACL, so a standard-user process cannot swap the payload. install-audio-tray.ps1 already does exactly this,
# for exactly this reason - this script now follows the same rule.
#
# Remove with: uninstall-admin-extras.ps1 (unregisters the task AND deletes the deployed copy).
# Must stay pure ASCII: Windows PowerShell 5.1 reads UTF-8-without-BOM as ANSI, so smart quotes /
# em dashes / check marks would BREAK PARSING.
$ErrorActionPreference = 'Stop'
$src  = $PSScriptRoot
$dest = Join-Path $env:ProgramFiles 'TH108 Lighting'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Error 'This must run elevated (right-click PowerShell > Run as administrator), or let setup.cmd elevate it.'; exit 1 }

foreach ($f in @('restart-usb.bat', 'run-hidden.vbs')) {
  if (-not (Test-Path (Join-Path $src $f))) { Write-Error ($f + ' not found next to this script'); exit 1 }
}

# 1) deploy the payload to the admin-only path
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
Copy-Item (Join-Path $src 'restart-usb.bat') (Join-Path $dest 'restart-usb.bat') -Force
Copy-Item (Join-Path $src 'run-hidden.vbs')  (Join-Path $dest 'run-hidden.vbs')  -Force
$vbs = Join-Path $dest 'run-hidden.vbs'

# 2) point the task at the deployed copy. Launch through run-hidden.vbs (window style 0) instead of cmd.exe
#    directly, so the batch + its inner powershell device lookup never flash a console that steals keyboard
#    focus while you're typing.
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'TH108 USB Restart' -Action $action -Principal $principal -Settings $settings -Force | Out-Null

Write-Host ('OK scheduled task "TH108 USB Restart" registered (on-demand, elevated, HIDDEN - no focus-stealing window).')
Write-Host ('   payload deployed to: ' + $dest + '  (admin-only - a standard-user process cannot tamper with it)')
Write-Host '   The daemon triggers it automatically after 30s of board mute (10 min cooldown).'
Write-Host '   Manual fire:  schtasks /run /tn "TH108 USB Restart"'
Write-Host '   NOTE: if you registered this task BEFORE the Program Files move, RE-RUN this script (as admin) to replace it.'
