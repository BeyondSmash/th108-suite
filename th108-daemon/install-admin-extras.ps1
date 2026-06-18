# Runs the two ADMIN-only one-time helpers together, so setup.cmd needs just ONE elevation prompt:
#   1. install-usb-restart-task.ps1 - the hidden USB-restart recovery task behind the
#      "Auto-Fix Lighting Wedge (USB Restart)" toggle (clears a board mute/wedge automatically).
#   2. install-webhid-grant.ps1 - OPTIONAL: pre-grants WebHID so the browser's keyboard picker
#      never appears (and post-replug recovery goes fully silent).
# Both are idempotent (safe to re-run). setup.cmd elevates this for you; you can also run it directly
# from an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File install-admin-extras.ps1
$here = $PSScriptRoot
Write-Host '== TH108 admin extras =='
try { & (Join-Path $here 'install-usb-restart-task.ps1') } catch { Write-Warning ('USB-restart task: ' + $_.Exception.Message) }
Write-Host ''
try { & (Join-Path $here 'install-webhid-grant.ps1') }    catch { Write-Warning ('WebHID grant: '     + $_.Exception.Message) }
Write-Host ''
Write-Host 'Done. This window closes in a few seconds.'
Start-Sleep -Seconds 4
