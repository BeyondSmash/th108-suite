# tray.ps1 - system-tray face for the TH108 lighting daemon (no AI, no terminal needed).
# Tray icon + menu: Open Controller / Start Daemon / Quit Daemon / Exit Tray.
# On launch it starts the daemon if the port is dead; it polls /status every 5s and shows a
# balloon if the daemon dies. Launch hidden via start-tray.vbs.
# This file must stay pure ASCII (PS 5.1 reads UTF-8-without-BOM as ANSI).

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-DaemonStatus {
  try { return Invoke-RestMethod -Uri 'http://localhost:8123/status' -TimeoutSec 2 } catch { return $null }
}
function Start-Daemon {
  if (-not (Get-DaemonStatus)) { Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $here 'start-hidden.vbs') + '"') }
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
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
$miQuit.Add_Click({ try { Invoke-RestMethod -Uri 'http://localhost:8123/quit' -Method Post -TimeoutSec 2 } catch {} })
$miExit.Add_Click({ $script:icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$icon.Add_DoubleClick({ Start-Process 'http://localhost:8123/' })

$script:wasUp = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  $s = Get-DaemonStatus
  if ($s) {
    $script:wasUp = $true
    if ($s.paused) { $icon.Text = 'TH108: running - page holds the keyboard' }
    elseif ($s.deviceConnected) { $icon.Text = 'TH108: running - driving the keyboard' }
    else { $icon.Text = 'TH108: running - waiting for the keyboard' }
  } else {
    $icon.Text = 'TH108: daemon NOT running (right-click > Start Daemon)'
    if ($script:wasUp) {
      $script:wasUp = $false
      $icon.ShowBalloonTip(4000, 'TH108 Lighting', 'The daemon stopped. Right-click the tray icon and pick Start Daemon.', [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  }
})
$timer.Start()

Start-Daemon   # launching the tray means "I want my lighting" - bring the daemon up if it is down
[System.Windows.Forms.Application]::Run()
