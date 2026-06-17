# tray.ps1 - system-tray face for the TH108 lighting daemon (no AI, no terminal needed).
# Tray icon (a tiny salmon keyboard, matching the site favicon; gray + red dot when the daemon
# is down) + menu: Open Controller / Start Daemon / Quit Daemon / Exit Tray.
# On launch it starts the daemon if the port is dead; it polls /status every 5s and shows a
# balloon if the daemon dies. Launch hidden via start-tray.vbs.
# NOTES: pure ASCII (PS 5.1 reads UTF-8-without-BOM as ANSI). HTTP goes through raw WebRequest
# with Proxy = $null - Invoke-RestMethod uses the system proxy by default, and a configured
# proxy silently eats localhost (real false-"daemon down" incident, 2026-06-11).

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Daemon([string]$path, [string]$method) {
  try {
    $req = [System.Net.WebRequest]::Create('http://127.0.0.1:8123' + $path)
    $req.Method = $method
    $req.Proxy = $null
    $req.Timeout = 2000
    if ($method -eq 'POST') { $req.ContentLength = 0 }
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader ($resp.GetResponseStream())
    $body = $sr.ReadToEnd()
    $resp.Close()
    return ($body | ConvertFrom-Json)
  } catch { return $null }
}
function Get-DaemonStatus { return Invoke-Daemon '/status' 'GET' }
# If /status is silent but something still holds 8123, it is a HUNG daemon (real incident 2026-06-16:
# a corpse from the day before squatted the port, so every Start silently failed to bind). Force-free
# the port first - but ONLY if the owner is genuinely our node daemon.js, never a random port holder.
function Clear-HungDaemon {
  $owner = (Get-NetTCPConnection -LocalPort 8123 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  if (-not $owner) { return }
  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner) -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'daemon\.js') {
    Stop-Process -Id $owner -Force
    Start-Sleep -Milliseconds 800
  }
}
function Start-Daemon {
  if (Get-DaemonStatus) { return }   # already healthy - leave it alone
  Clear-HungDaemon                    # status silent: kill a hung daemon that is squatting the port
  Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $here 'start-hidden.vbs') + '"')
}

# tiny keyboard icon, favicon-style: salmon body, white/yellow/blue keys, mint space bar.
# Down-state: gray body + red dot. Exactly two icons are created (GetHicon leaks if spammed).
function New-TrayIcon([bool]$up) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bodyColor = if ($up) { [System.Drawing.Color]::FromArgb(250, 128, 114) } else { [System.Drawing.Color]::FromArgb(120, 120, 120) }
  $body = New-Object System.Drawing.SolidBrush ($bodyColor)
  $g.FillRectangle($body, 1, 6, 30, 20)
  $keyW = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $keyY = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 140))
  $keyB = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(152, 208, 255))
  $bar  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, 210, 183))
  $g.FillRectangle($keyW, 4, 9, 7, 6)
  $g.FillRectangle($keyY, 13, 9, 7, 6)
  $g.FillRectangle($keyB, 22, 9, 7, 6)
  $g.FillRectangle($bar, 4, 17, 25, 6)
  if (-not $up) {
    $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(225, 60, 60))
    $g.FillEllipse($dot, 19, 16, 12, 12)
  }
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconUp = New-TrayIcon $true
$iconDown = New-TrayIcon $false

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = $iconDown
$icon.Text = 'TH108 Lighting'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen  = $menu.Items.Add('Open Controller')
$miStart = $menu.Items.Add('Start Daemon')
$miQuit  = $menu.Items.Add('Quit Daemon')
[void]$menu.Items.Add('-')
$miExit  = $menu.Items.Add('Exit Tray')
$icon.ContextMenuStrip = $menu

$miOpen.Add_Click({ Start-Process 'http://localhost:8123/' })
$miStart.Add_Click({ Start-Daemon })
$miQuit.Add_Click({ [void](Invoke-Daemon '/quit' 'POST') })
$miExit.Add_Click({ $script:icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$icon.Add_DoubleClick({ Start-Process 'http://localhost:8123/' })

$script:wasUp = $false
$script:misses = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  $s = Get-DaemonStatus
  if ($s) {
    $script:wasUp = $true
    $script:misses = 0
    $icon.Icon = $iconUp
    if ($s.paused) { $icon.Text = 'TH108: running - page holds the keyboard' }
    elseif ($s.deviceConnected) { $icon.Text = 'TH108: running - driving the keyboard' }
    else { $icon.Text = 'TH108: running - waiting for the keyboard' }
  } else {
    # tolerate brief gaps: deliberate restarts take ~10s and the supervisor revives crashes in 3s -
    # the old single-miss balloon cried wolf on every planned restart (2026-06-12, twice)
    $script:misses++
    if ($script:misses -ge 2) { $icon.Icon = $iconDown; $icon.Text = 'TH108: daemon not answering...' }
    if ($script:misses -ge 3 -and $script:wasUp) {
      $script:wasUp = $false
      $icon.Text = 'TH108: daemon NOT running (right-click > Start Daemon)'
      $icon.ShowBalloonTip(4000, 'TH108 Lighting', 'The daemon stopped and did not come back. Right-click the tray icon and pick Start Daemon.', [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  }
})
$timer.Start()

Start-Daemon   # launching the tray means "I want my lighting" - bring the daemon up if it is down
[System.Windows.Forms.Application]::Run()
