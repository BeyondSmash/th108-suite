# install-audio-tray.ps1 - self-elevating installer for the standalone Audio tray watchdog.
# Deploys the scripts to an ADMIN-ONLY path (C:\Program Files\AudioTrayWatchdog) so the auto-elevated
# logon task can't be hijacked by a standard-user write (that's the whole reason we don't run it from the
# repo folder, which is user-writable). Then registers a logon task (RunLevel Highest -> silent elevation,
# no per-restart UAC) that launches audio-tray-launch.vbs hidden, and starts the tray now.
# Idempotent: re-running re-copies + re-registers cleanly.
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSCommandPath
$dest = Join-Path $env:ProgramFiles 'AudioTrayWatchdog'
$resultFile = Join-Path $src 'audio-tray-install-result.txt'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"')
  exit
}

try {
  # 1) deploy scripts to the protected (admin-write-only) path
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
  Copy-Item (Join-Path $src 'audio-tray.ps1')        (Join-Path $dest 'audio-tray.ps1')        -Force
  Copy-Item (Join-Path $src 'audio-tray-launch.vbs') (Join-Path $dest 'audio-tray-launch.vbs') -Force
  $vbs = Join-Path $dest 'audio-tray-launch.vbs'

  # 2) stop any tray already running from an old location (repo folder), so we don't leave a stale copy
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*audio-tray.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  # 3) register the logon task pointing at the protected path
  $taskName = 'Audio Tray Watchdog'
  $action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $princ   = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -RunLevel Highest
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $princ -Settings $set -Force | Out-Null

  # 4) start it now (elevated), from the protected path
  Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')

  ('INSTALLED-OK ' + $dest + ' ' + (Get-Date)) | Set-Content $resultFile
} catch {
  ('ERROR: ' + $_.Exception.Message) | Set-Content $resultFile
  exit 1
}
