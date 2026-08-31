# Reverses the two ADMIN-only helpers that install-admin-extras.ps1 set up, in ONE elevation:
#   1. Unregister the "TH108 USB Restart" recovery scheduled task (+ the legacy "TH108 Lighting
#      Daemon" task from older installs, if present).
#   2. Delete the admin-only payload folder the task ran from (C:\Program Files\TH108 Lighting).
#   3. Remove the WebHID pre-grant enterprise policy (install-webhid-grant.ps1 -Remove).
# Idempotent (safe to re-run; missing pieces are skipped). uninstall.cmd elevates this for you; you
# can also run it directly from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File uninstall-admin-extras.ps1
# Must stay pure ASCII: Windows PowerShell 5.1 reads UTF-8-without-BOM as ANSI, so smart quotes /
# em dashes / check marks would BREAK PARSING.
$here = $PSScriptRoot
Write-Host '== TH108 admin extras: uninstall =='
foreach ($t in @('TH108 USB Restart', 'TH108 Lighting Daemon')) {
  $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host ('OK removed task: ' + $t) }
  else       { Write-Host ('- task not present: ' + $t) }
}
Write-Host ''
$deploy = Join-Path $env:ProgramFiles 'TH108 Lighting'
if (Test-Path $deploy) {
  try { Remove-Item -LiteralPath $deploy -Recurse -Force; Write-Host ('OK removed payload folder: ' + $deploy) }
  catch { Write-Warning ('could not remove ' + $deploy + ': ' + $_.Exception.Message) }
} else { Write-Host ('- payload folder not present: ' + $deploy) }

Write-Host ''
$grant = Join-Path $here 'install-webhid-grant.ps1'
if (Test-Path $grant) { try { & $grant -Remove } catch { Write-Warning ('WebHID grant remove: ' + $_.Exception.Message) } }
else { Write-Host '- install-webhid-grant.ps1 not found; skipping WebHID grant' }
Write-Host ''
Write-Host 'Done. This window closes in a few seconds.'
Start-Sleep -Seconds 3
