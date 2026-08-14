# install-audio-tray.ps1 - self-elevating installer for the standalone Audio tray watchdog.
# Registers a logon task (RunLevel Highest -> silent elevation, no per-restart UAC) that launches
# audio-tray-launch.vbs (hidden), then starts the tray now. Idempotent: re-running re-registers cleanly.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSCommandPath
$vbs = Join-Path $dir 'audio-tray-launch.vbs'
$resultFile = Join-Path $dir 'audio-tray-install-result.txt'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"')
  exit
}

try {
  $taskName = 'Audio Tray Watchdog'
  $action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $princ   = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -RunLevel Highest
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $princ -Settings $set -Force | Out-Null

  # start it now (elevated), so the tray icon appears this session too
  Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')

  ('INSTALLED-OK ' + (Get-Date)) | Set-Content $resultFile
} catch {
  ('ERROR: ' + $_.Exception.Message) | Set-Content $resultFile
  exit 1
}
