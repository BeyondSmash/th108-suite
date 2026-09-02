@echo off
rem TH108 USB recovery: PnP-restart the keyboard's composite USB device node = a software replug.
rem A FIFO-wedged board stays muted until its USB node is re-enumerated; this is the daemon's escalation.
rem Needs elevation -- runs as the on-demand scheduled task "TH108 USB Restart" (install-usb-restart-task.ps1).
rem
rem 2026-06-14 FIX -- the recovery had NEVER actually fired. The old device lookup
rem     findstr /c:"USB\VID_0C45&PID_8006\"
rem matched NOTHING: findstr's C-runtime parses the trailing \" as an escaped quote, so the composite
rem root was never found and the recovery silently no-oped on every wedge (proven via restart-usb.log:
rem "no USB composite root found" while the device was plainly enumerated on USB). Replaced with a
rem Get-PnpDevice lookup whose wildcard 'USB\VID_0C45&PID_8006\*' selects ONLY the composite root (the
rem &MI_xx child interfaces have '&' after PID_8006, not '\', so they don't match). Logs to restart-usb.log.
rem
rem 2026-09-02 SECURITY FIX -- PSModulePath is pinned below, and that is load-bearing. This file runs
rem ELEVATED (scheduled task, RunLevel Highest, fired with no UAC prompt), which is why it was moved to
rem admin-only Program Files: a standard-user process must not be able to choose what runs here. But moving
rem the file was not enough. PowerShell resolves a cmdlet like Get-PnpDevice by searching PSModulePath, and
rem the FIRST folder on it is user-writable (...\Documents\WindowsPowerShell\Modules). So any program running
rem as the logged-in user could drop a module exporting its own Get-PnpDevice, run `schtasks /run /tn "TH108
rem USB Restart"` (no prompt needed for a task you own), and have its code execute as administrator - the same
rem privilege escalation the Program Files move was supposed to close, just one level further in. Proven with a
rem planted probe module: the fake Get-PnpDevice won the lookup. Pinning PSModulePath to the system modules
rem folder removes the user-writable folder from the search, so only Windows' own PnpDevice module can answer.
setlocal enabledelayedexpansion
set "LOG=%~dp0restart-usb.log"
echo ==== %DATE% %TIME% ==== >> "%LOG%"
whoami /groups | findstr /C:"S-1-16-12288" >nul && (echo integrity: HIGH ^(elevated^)>> "%LOG%") || (echo integrity: NOT elevated -- restart will fail>> "%LOG%")
set "FOUND="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$env:PSModulePath='%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules'; (Get-PnpDevice -PresentOnly -InstanceId 'USB\VID_0C45&PID_8006\*').InstanceId"`) do (
  set "FOUND=%%i"
  echo target: %%i>> "%LOG%"
  pnputil /restart-device "%%i" >> "%LOG%" 2>&1
  echo restart exit=!ERRORLEVEL!>> "%LOG%"
)
if not defined FOUND echo no USB composite root present ^(Bluetooth mode, or device absent^)>> "%LOG%"
endlocal
