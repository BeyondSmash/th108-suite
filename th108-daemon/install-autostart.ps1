# Registers the TH108 tray (which starts + supervises the daemon) to start hidden at every logon.
# TWO per-user entries, neither needs admin, and the daemon can toggle both itself (the controller
# page's "auto-start on login" checkbox runs this script / uninstall-autostart.ps1):
#   1. a Task Scheduler LOGON task - fires within seconds of logon. This is the one that matters.
#   2. the HKCU Run key - the classic entry, kept as a fallback and as the "is autostart on?" flag
#      the page reads.
# Why the task: Windows queues Run-key apps behind everything else at logon, and on a busy machine
# that was measured at 2.5-3.5 minutes after the desktop appeared (2026-09-02: every Run-key app on
# the machine came up late together), which reads as "it didn't start". A logon task is not held
# back that way (the same machine's other logon task fired in the same second the desktop did).
# Both launching is harmless: the tray is a singleton (named mutex), the second one just exits.
# The task has TWO actions: the tray, then the daemon launcher directly. Measured 2026-09-02: the
# tray alone took ~30s on a cold boot (PowerShell + WinForms + the port-owner check under startup
# disk load) before it got round to starting the daemon, so lights came ~40s after the desktop.
# Launched directly, node binds 8123 within a few seconds; the tray then finds it healthy and
# leaves it alone. Order matters: start-tray.vbs returns at once, start-hidden.vbs SUPERVISES the
# daemon (blocks for its lifetime), and Task Scheduler runs actions one after another.
# Run once:  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
$vbs = Join-Path $PSScriptRoot "start-tray.vbs"   # the tray starts + watches the daemon
$daemon = Join-Path $PSScriptRoot "start-hidden.vbs"   # the daemon's own hidden launcher/supervisor
foreach ($f in @($vbs, $daemon)) { if (-not (Test-Path $f)) { Write-Error "$f not found"; exit 1 } }

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "TH108LightingDaemon" -Value ('wscript.exe "{0}"' -f $vbs)

try {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action    = @((New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $vbs)),
                 (New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $daemon)))
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  # Battery flags: the defaults refuse to start (and stop) tasks on battery - a laptop would lose its lighting unplugged.
  # ExecutionTimeLimit 0 = no limit: the default (3 days) would have Task Scheduler kill the supervising
  # daemon action, and with it the lighting, after 72h of uptime.
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName "TH108 Lighting Tray" -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  Write-Host "[+] Installed: per-user logon task + Run key. The tray starts hidden seconds after next logon."
} catch {
  Write-Warning ("Logon task not registered ({0}). The Run key alone still auto-starts it, just possibly minutes after logon." -f $_.Exception.Message)
}
Write-Host "    Start it now without rebooting:  wscript `"$vbs`""
Write-Host "    Remove it later:                 .\uninstall-autostart.ps1  (or untick auto-start in the controller page)"
