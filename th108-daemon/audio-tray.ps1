# audio-tray.ps1 - standalone "Audio" system-tray watchdog. STANDALONE system fix, NOT part of the TH108
# keyboard suite. Fixes the recurring dead-audio-after-wake AND the idle-stop (Windows stops Audiosrv when
# transiently zero endpoints, with NO wake/crash event — so a wake-only task or `sc failure` can't catch it).
#
# What it does: shows a speaker tray icon; every few seconds checks Audiosrv; if it's Stopped, restarts it
# (with retries) and balloons "Audio recovered". Right-click -> "Restart Audio Now" for a manual kick, or Exit.
# Runs ELEVATED (registered as a logon task, RunLevel Highest) so Restart-Service is silent (no per-restart UAC).
#
#   -CheckOnce : run a single check-and-restart, print result, exit (no GUI). Used for testing + the manual path.
param([switch]$CheckOnce)

$ErrorActionPreference = 'Stop'

# Core (also the runnable check): return $true if audio is Running after this call. Restarts if Stopped, with a
# couple of retries because right after wake the SCM can refuse the start for a second or two (that's the exact
# failure that made the one-shot wake task exit 1).
function Ensure-Audio {
  $svc = Get-Service Audiosrv -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }
  if ($svc.Status -eq 'Running') { return $true }
  for ($i = 0; $i -lt 3; $i++) {
    try {
      # AudioEndpointBuilder is the endpoint enumerator Audiosrv depends on — make sure it's up first.
      $epb = Get-Service AudioEndpointBuilder -ErrorAction SilentlyContinue
      if ($epb -and $epb.Status -ne 'Running') { Start-Service AudioEndpointBuilder -ErrorAction SilentlyContinue }
      Restart-Service Audiosrv -Force -ErrorAction Stop
      Start-Sleep -Seconds 1
      if ((Get-Service Audiosrv).Status -eq 'Running') { return $true }
    } catch { Start-Sleep -Seconds 2 }   # SCM busy just after wake — wait and retry
  }
  return ((Get-Service Audiosrv -ErrorAction SilentlyContinue).Status -eq 'Running')
}

if ($CheckOnce) {
  $ok = Ensure-Audio
  Write-Output ("Audiosrv Running=" + $ok)
  if ($ok) { exit 0 } else { exit 1 }
}

# --- single instance (logon task + a manual launch shouldn't both run) ---
# AbandonedMutexException = the previous tray was KILLED (not clean-exit) and left the mutex abandoned;
# that means WE now own it, so treat it as acquired. Without this catch, $ErrorActionPreference='Stop'
# turns every launch-after-a-kill into an instant crash (the icon then never appears).
$mutex = New-Object System.Threading.Mutex($false, 'Global\TH108_AudioTrayWatchdog')
try { $owns = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owns = $true }
if (-not $owns) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-Ico($fallback) {
  try { return [System.Drawing.Icon]::ExtractAssociatedIcon("$env:SystemRoot\System32\SndVolSSO.dll") } catch { return $fallback }
}
$icoOk   = Get-Ico ([System.Drawing.SystemIcons]::Application)
$icoWarn = [System.Drawing.SystemIcons]::Warning

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icoOk
$ni.Text = 'Audio: checking...'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miRestart = $menu.Items.Add('Restart Audio Now')
$miStatus  = $menu.Items.Add('Status: --'); $miStatus.Enabled = $false
$menu.Items.Add('-') | Out-Null
$miExit    = $menu.Items.Add('Exit')
$ni.ContextMenuStrip = $menu

$script:lastOk = $true

function Refresh([bool]$manual) {
  $wasOk = $script:lastOk
  $ok = Ensure-Audio
  $script:lastOk = $ok
  if ($ok) {
    $ni.Icon = $icoOk
    $ni.Text = 'Audio: Running'
    $miStatus.Text = 'Status: Running'
    if (-not $wasOk) { $ni.ShowBalloonTip(3000, 'Audio recovered', 'Windows Audio was down and has been restarted.', [System.Windows.Forms.ToolTipIcon]::Info) }
    elseif ($manual) { $ni.ShowBalloonTip(2000, 'Audio', 'Already running (kicked it anyway).', [System.Windows.Forms.ToolTipIcon]::Info) }
  } else {
    $ni.Icon = $icoWarn
    $ni.Text = 'Audio: DOWN (restart failed)'
    $miStatus.Text = 'Status: DOWN'
    $ni.ShowBalloonTip(4000, 'Audio still down', 'Could not restart Windows Audio — try again or reboot.', [System.Windows.Forms.ToolTipIcon]::Warning)
  }
}

$miRestart.Add_Click({ Refresh $true })
$miExit.Add_Click({ $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh $false })
$timer.Start()

Refresh $false   # first check immediately on launch

$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
$ni.Visible = $false
$mutex.ReleaseMutex()
