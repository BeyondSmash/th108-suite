# install-webhid-grant.ps1 - pre-grant the TH108 to the controller page so the browser's WebHID
# device picker is NEVER needed (the grant also survives replugs, so post-replug recovery goes
# fully silent). Uses the Chromium WebHidAllowDevicesForUrls enterprise policy.
#
# Run ONCE as Administrator:   powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1
# Undo:                        powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1 -Remove
# Then fully restart the browser and verify at brave://policy / chrome://policy / edge://policy.
#
# Notes:
# - Grants ONE device - vendor 0x0C45 (SONiX), product 0x8006 (the TH108) - to http://localhost:8123 only.
#   This used to be vendor-wide (no product_id), which silently handed the page every SONiX HID device on
#   the machine, not just this keyboard. SONiX chips sit inside plenty of unrelated peripherals, so a
#   vendor-wide grant is a much bigger hole than the feature needs. Narrowed on purpose.
#   TRADE-OFF: if your board reports a different product ID in Bluetooth mode than over USB, the browser
#   will show its normal device picker once in that mode - you click your keyboard and it is remembered.
#   That is the whole cost. Prefer the wider grant? Delete the product_id from the line below.
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

$json = '{"devices": [{"vendor_id": 3141, "product_id": 32774}], "urls": ["http://localhost:8123"]}'   # 3141 = 0x0C45 SONiX, 32774 = 0x8006 TH108
foreach ($key in $hives) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '1' -Value $json
  Write-Host ('OK ' + $key)
}
Write-Host ''
Write-Host 'Installed. Fully restart the browser (all windows), then brave://policy (or'
Write-Host 'chrome://policy / edge://policy) should list WebHidAllowDevicesForUrls -'
Write-Host 'after that, Connect Keyboard never shows a picker.'
Write-Host ''
Write-Host 'Scope: this grants ONE device (SONiX 0x0C45 / TH108 0x8006), not every SONiX device on'
Write-Host 'the machine. If your board uses a different product ID over Bluetooth, you will get the'
Write-Host 'browser picker once in that mode - pick your keyboard and it is remembered.'
