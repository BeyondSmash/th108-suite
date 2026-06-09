# Registers the TH108 lighting daemon to start (hidden) at every logon.
# Per-user HKCU Run key — no admin needed, and the daemon itself can toggle it
# (the controller page's "auto-start on login" checkbox uses the same key).
# Run once:  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
$vbs = Join-Path $PSScriptRoot "start-hidden.vbs"
if (-not (Test-Path $vbs)) { Write-Error "start-hidden.vbs not found at $vbs"; exit 1 }

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "TH108LightingDaemon" -Value ('wscript.exe "{0}"' -f $vbs)

Write-Host "[+] Installed (per-user Run key). The daemon starts hidden at next logon."
Write-Host "    Start it now without rebooting:  wscript `"$vbs`""
Write-Host "    Remove it later:                 .\uninstall-autostart.ps1  (or untick auto-start in the controller page)"
