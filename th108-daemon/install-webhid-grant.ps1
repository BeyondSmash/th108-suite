# install-webhid-grant.ps1 - OPT-IN ONLY. Pre-grants the TH108 to the controller page so the
# browser's WebHID device picker is never shown. Uses the Chromium WebHidAllowDevicesForUrls
# enterprise policy.
#
#   Remove (default for setup.cmd):  powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1 -Remove
#   Install (deliberate opt-in):     powershell -ExecutionPolicy Bypass -File install-webhid-grant.ps1 -Install
#
# ============================ WHY THIS IS NO LONGER INSTALLED ============================
# The policy grants silent HID access to an ORIGIN - "http://localhost:8123" - not to this
# program. Windows does not reserve that port for us. Any program running as the logged-in user,
# with no admin rights at all, can bind port 8123 before the daemon does, serve its own page
# there, and inherit this grant: when the user opens localhost:8123 (their normal way to reach
# the app) the squatter's page gets prompt-free read/write access to the keyboard. No picker,
# no prompt, no indication anything is wrong.
#
# Narrowing the grant from vendor-wide to this one product (0x0C45/0x8006) limited WHICH device
# is exposed. It did nothing about WHO can claim the origin - that is the actual hole, and it
# cannot be closed from inside a browser policy, because origins are the only thing the policy
# can name.
#
# The grant is also machine-wide (HKLM), applies to every user account, and persists until
# something removes it - deleting the project folder does not.
#
# What it buys: the browser never shows its device picker. What removing it costs: one click on
# the picker, once per browser profile, and once more if the board reports a different product ID
# over Bluetooth. That is the entire cost, and it is not worth a silent hardware-access path for
# any local program that wins a race for a port number.
#
# Credit where due: this was raised publicly by a critic (reddit u/sloppykrackers) after an
# earlier hardening pass had already narrowed the device scope and missed the origin problem.
# ========================================================================================
#
# Notes:
# - Writes/removes the policy for Brave, Chrome, AND Edge - each Chromium browser reads its own
#   hive; entries for browsers that aren't installed are inert.
# - List-type policies live as numbered REG_SZ values under a key named after the policy, each
#   value holding one JSON-encoded dictionary.
# - This file must stay pure ASCII: Windows PowerShell 5.1 reads UTF-8-without-BOM as ANSI, and
#   characters like check marks / em dashes decode into smart quotes that BREAK PARSING.

param([switch]$Remove, [switch]$Install)

$hives = @(
  'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave\WebHidAllowDevicesForUrls',
  'HKLM:\SOFTWARE\Policies\Google\Chrome\WebHidAllowDevicesForUrls',
  'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebHidAllowDevicesForUrls'
)

if ($Remove) {
  $found = $false
  foreach ($key in $hives) {
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host ('OK removed ' + $key); $found = $true }
  }
  if (-not $found) { Write-Host '- no WebHID pre-grant present (nothing to remove)' }
  else { Write-Host 'Removed - restart the browser. You will now get the normal device picker once.' }
  exit 0
}

if (-not $Install) {
  Write-Host 'This script is opt-in. It does nothing without a switch.'
  Write-Host ''
  Write-Host '  -Remove    take the pre-grant off this machine (what setup.cmd does)'
  Write-Host '  -Install   put it on anyway, accepting the risk described at the top of this file'
  Write-Host ''
  Write-Host 'Read the WHY THIS IS NO LONGER INSTALLED block in this file before using -Install.'
  exit 0
}

Write-Host 'WARNING: installing the WebHID pre-grant.'
Write-Host 'This gives ANY program that can bind port 8123 first a silent, prompt-free path to'
Write-Host 'your keyboard. You are trading that for skipping one browser picker click.'
Write-Host ''
$json = '{"devices": [{"vendor_id": 3141, "product_id": 32774}], "urls": ["http://localhost:8123"]}'   # 3141 = 0x0C45 SONiX, 32774 = 0x8006 TH108
foreach ($key in $hives) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '1' -Value $json
  Write-Host ('OK ' + $key)
}
Write-Host ''
Write-Host 'Installed. Fully restart the browser (all windows), then brave://policy (or'
Write-Host 'chrome://policy / edge://policy) should list WebHidAllowDevicesForUrls.'
Write-Host 'Undo at any time with:  install-webhid-grant.ps1 -Remove'
