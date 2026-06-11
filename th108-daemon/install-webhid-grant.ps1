# install-webhid-grant.ps1 - pre-grant the TH108 to the controller page so the browser's WebHID
# device picker is NEVER needed (the grant also survives replugs, so post-replug recovery goes
# fully silent). Uses the Chromium WebHidAllowDevicesForUrls enterprise policy.
#
# Run ONCE as Administrator:   powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1
# Undo:                        powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1 -Remove
# Then fully restart the browser and verify at brave://policy / chrome://policy / edge://policy.
#
# Notes:
# - Grants vendor 0x0C45 (SONiX / Epomaker TH108) to http://localhost:8123 only.
#   Vendor-wide (no product_id) so wired/wireless PID variants are all covered.
# - Writes the policy for Brave, Chrome, AND Edge - each Chromium browser reads its own hive;
#   entries for browsers that aren't installed are inert.
# - List-type policies live as numbered REG_SZ values under a key named after the policy,
#   each value holding one JSON-encoded dictionary.
# - This file must stay pure ASCII: Windows PowerShell 5.1 reads UTF-8-without-BOM as ANSI,
#   and characters like check marks / em dashes decode into smart quotes that BREAK PARSING.

param([switch]$Remove)

$hives = @(
  'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave\WebHidAllowDevicesForUrls',
  'HKLM:\SOFTWARE\Policies\Google\Chrome\WebHidAllowDevicesForUrls',
  'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebHidAllowDevicesForUrls'
)

if ($Remove) {
  foreach ($key in $hives) {
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host ('OK removed ' + $key) }
  }
  Write-Host 'done - restart the browser'
  exit 0
}

$json = '{"devices": [{"vendor_id": 3141}], "urls": ["http://localhost:8123"]}'   # 3141 = 0x0C45
foreach ($key in $hives) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '1' -Value $json
  Write-Host ('OK ' + $key)
}
Write-Host ''
Write-Host 'Installed. Fully restart the browser (all windows), then brave://policy (or'
Write-Host 'chrome://policy / edge://policy) should list WebHidAllowDevicesForUrls -'
Write-Host 'after that, Connect Keyboard never shows a picker.'
