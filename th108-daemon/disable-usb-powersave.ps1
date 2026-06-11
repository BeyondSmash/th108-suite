# disable-usb-powersave.ps1 — mute mitigation: stops Windows from power-managing the TH108.
# USB suspend = the board's MUTE state (confirmed: every sleep entry logs as a mute in
# daemon.log), and on a stock Windows install BOTH permissions are granted:
#   1. "Allow the computer to turn off this device to save power" on the TH108's USB interfaces
#   2. USB selective suspend in the active power plan
# This clears both in one shot, so it's the complete fix for new users.
#
# Run: right-click → Run with PowerShell (self-elevates).   Revert: run with -Enable
param([switch]$Enable)
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' + $(if ($Enable) { ' -Enable' } else { '' }))
  exit
}
$v = [bool]$Enable

# 1) per-interface "allow the computer to turn off this device" flags
$hits = Get-CimInstance -Namespace root\wmi -ClassName MSPower_DeviceEnable |
  Where-Object { $_.InstanceName -match 'VID_0C45&PID_8006' }
if (-not $hits) { Write-Host 'TH108 not found (unplugged?) — plug it in and re-run.' }
$hits | ForEach-Object {
  $_.Enable = $v
  Set-CimInstance -InputObject $_
  Write-Host ("set Enable=$v :: " + $_.InstanceName)
}

# 2) USB selective suspend in the active power plan (SUB_USB / USBSELECTSUSPEND)
$idx = $(if ($v) { 1 } else { 0 })
powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 $idx | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 $idx | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null
Write-Host ("USB selective suspend set to $idx (0 = off) in the active power plan")

Write-Host ''
Write-Host $(if ($v) { 'Reverted — Windows may power-manage the TH108 (and suspend USB) again.' }
             else { 'Done — Windows can no longer power off the TH108 interfaces or selectively suspend USB. Replug the keyboard once to start clean.' })
Read-Host 'Press Enter to close'
