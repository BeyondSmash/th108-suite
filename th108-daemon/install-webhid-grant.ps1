# install-webhid-grant.ps1 — pre-grant the TH108 to the controller page so Chrome's WebHID device
# picker is NEVER needed (the grant also survives replugs, so post-replug recovery goes fully
# silent). Uses the WebHidAllowDevicesForUrls enterprise policy.
#
# Run ONCE as Administrator:   powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1
# Undo:                        powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1 -Remove
# Then fully restart Chrome and verify at chrome://policy (search "WebHid").
#
# Notes:
# - Grants vendor 0x0C45 (SONiX / Epomaker TH108) to http://localhost:8123 only.
#   Vendor-wide (no product_id) so wired/wireless PID variants are all covered.
# - Chrome only. For Edge, the same value goes under HKLM:\SOFTWARE\Policies\Microsoft\Edge\....
# - List-type policies live as numbered REG_SZ values under a key named after the policy,
#   each value holding one JSON-encoded dictionary.

param([switch]$Remove)

$key = 'HKLM:\SOFTWARE\Policies\Google\Chrome\WebHidAllowDevicesForUrls'

if ($Remove) {
  if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host '✓ policy removed — restart Chrome' }
  else { Write-Host 'nothing to remove' }
  exit 0
}

New-Item -Path $key -Force | Out-Null
$json = '{"devices": [{"vendor_id": 3141}], "urls": ["http://localhost:8123"]}'   # 3141 = 0x0C45
Set-ItemProperty -Path $key -Name '1' -Value $json
Write-Host '✓ installed. Fully restart Chrome (all windows), then chrome://policy should list'
Write-Host '  WebHidAllowDevicesForUrls — after that, Connect Keyboard never shows a picker.'
