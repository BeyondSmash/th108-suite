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
setlocal enabledelayedexpansion
set "LOG=%~dp0restart-usb.log"
echo ==== %DATE% %TIME% ==== >> "%LOG%"
whoami /groups | findstr /C:"S-1-16-12288" >nul && (echo integrity: HIGH ^(elevated^)>> "%LOG%") || (echo integrity: NOT elevated -- restart will fail>> "%LOG%")
set "FOUND="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-PnpDevice -PresentOnly -InstanceId 'USB\VID_0C45&PID_8006\*').InstanceId"`) do (
  set "FOUND=%%i"
  echo target: %%i>> "%LOG%"
  pnputil /restart-device "%%i" >> "%LOG%" 2>&1
  echo restart exit=!ERRORLEVEL!>> "%LOG%"
)
if not defined FOUND echo no USB composite root present ^(Bluetooth mode, or device absent^)>> "%LOG%"
endlocal
