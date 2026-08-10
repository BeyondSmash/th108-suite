# restart-audio-now.ps1 - one-click Windows Audio restart (the manual escape-hatch behind the
# "Restart Audio" desktop shortcut). STANDALONE system fix, NOT part of the TH108 keyboard suite.
# Fixes the "No playback devices" / dead-DAC state when the auto wake-task didn't catch it (a rare
# mid-session Audiosrv stop with no wake/crash event). Restart-Service starts Audiosrv if it's stopped.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {                                    # self-elevate: one UAC prompt, then re-run this file
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"')
  exit
}
try {
  Restart-Service Audiosrv -Force -ErrorAction Stop    # -Force restarts dependents; starts it if stopped
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show('Windows Audio restarted. Your playback device should be back.','Restart Audio') | Out-Null
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(('Could not restart audio: ' + $_.Exception.Message),'Restart Audio') | Out-Null
}
