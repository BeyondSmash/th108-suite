# Runs the ADMIN-only one-time setup steps together, so setup.cmd needs just ONE elevation prompt:
#   1. install-usb-restart-task.ps1 - the hidden USB-restart recovery task behind the
#      "Auto-Fix Lighting Wedge (USB Restart)" toggle (clears a board mute/wedge automatically).
#   2. install-webhid-grant.ps1 -Remove - REMOVES the WebHID pre-grant if an older install left
#      one behind. This used to install it. It no longer does, and it actively cleans up.
#
# Why step 2 reversed: the pre-grant gave silent keyboard access to the ADDRESS localhost:8123,
# not to this program. Any unprivileged program that binds that port first inherits the grant and
# gets prompt-free access to the board when you open the page. The cost of not having it is one
# click on the browser's device picker. See the long note in install-webhid-grant.ps1.
#
# Both steps are idempotent (safe to re-run). setup.cmd elevates this for you; you can also run it
# directly from an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File install-admin-extras.ps1
$here = $PSScriptRoot
Write-Host '== TH108 admin extras =='
try { & (Join-Path $here 'install-usb-restart-task.ps1') } catch { Write-Warning ('USB-restart task: ' + $_.Exception.Message) }
Write-Host ''
Write-Host '-- WebHID pre-grant: removing if present (no longer installed by default) --'
try { & (Join-Path $here 'install-webhid-grant.ps1') -Remove } catch { Write-Warning ('WebHID grant remove: ' + $_.Exception.Message) }
Write-Host ''
Write-Host 'Done. This window closes in a few seconds.'
Start-Sleep -Seconds 4
