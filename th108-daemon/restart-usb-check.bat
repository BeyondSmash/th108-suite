@echo off
rem restart-usb-check.bat - the one check restart-usb.bat has. Run it (no admin needed) after ANY edit to that file.
rem
rem It mirrors restart-usb.bat's lookup lines VERBATIM and prints what they resolve to, without touching pnputil.
rem Why this exists: that lookup has silently no-op'd twice (a findstr escape in June 2026; a stripped quote in
rem Sept 2026). Both times the script "ran fine" and simply found nothing, so the USB recovery never fired.
rem A pass prints the keyboard's instance ID (USB\VID_0C45&PID_8006\...) while the board is on the cable.
rem NOT FOUND while the board is on USB means the lookup line is broken again. NOT FOUND on Bluetooth is normal.
rem
rem If you change lines 31-36 of restart-usb.bat, change the matching lines here the same way.
setlocal enabledelayedexpansion
set "SYS32=%SystemRoot%\System32"
"%SYS32%\whoami.exe" /groups | "%SYS32%\findstr.exe" /C:"S-1-16-12288" >nul && (echo integrity: HIGH) || (echo integrity: NOT elevated ^(fine for this check^))
set "FOUND="
for /f "usebackq delims=" %%i in (`%SYS32%\WindowsPowerShell\v1.0\powershell.exe -NoProfile -Command "$env:PSModulePath='%SYS32%\WindowsPowerShell\v1.0\Modules'; (Get-PnpDevice -PresentOnly -InstanceId 'USB\VID_0C45&PID_8006\*').InstanceId"`) do (
  set "FOUND=%%i"
  echo FOUND: %%i
  echo would run: "%SYS32%\pnputil.exe" /restart-device "%%i"
)
if not defined FOUND echo NOT FOUND ^(Bluetooth mode, device absent, or the lookup line is broken^)
endlocal
