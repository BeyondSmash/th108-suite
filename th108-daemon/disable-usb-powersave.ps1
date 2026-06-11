# disable-usb-powersave.ps1 — mute mitigation: clears "Allow the computer to turn off this
# device to save power" on every TH108 USB interface. USB suspend = the board's MUTE state
# (confirmed: every sleep entry logs as a mute in daemon.log), and these flags were TRUE,
# so Windows had standing permission to power-manage the keyboard mid-session.
# Pairs with: USB selective suspend disabled in the active power plan (powercfg, done 2026-06-11).
#
# Run: right-click → Run with PowerShell (self-elevates).   Revert: run with -Enable
param([switch]$Enable)
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' + $(if ($Enable) { ' -Enable' } else { '' }))
  exit
}
$v = [bool]$Enable
$hits = Get-CimInstance -Namespace root\wmi -ClassName MSPower_DeviceEnable |
  Where-Object { $_.InstanceName -match 'VID_0C45&PID_8006' }
if (-not $hits) { Write-Host 'TH108 not found (unplugged?) — plug it in and re-run.' }
$hits | ForEach-Object {
  $_.Enable = $v
  Set-CimInstance -InputObject $_
  Write-Host ("set Enable=$v :: " + $_.InstanceName)
}
Write-Host ''
Write-Host $(if ($v) { 'Reverted — Windows may power-manage the TH108 again.' }
             else { 'Done — Windows can no longer power off the TH108 USB interfaces. Replug the keyboard once to start clean.' })
Read-Host 'Press Enter to close'
