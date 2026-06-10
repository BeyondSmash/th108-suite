@echo off
rem TH108 USB recovery: PnP-restart the keyboard's composite USB device node = a software replug.
rem Clears the board ACK-mute/wedge (proven 2026-06-09: cleared a wedge a fresh HID handle-open could not).
rem Needs elevation -- runs as the on-demand scheduled task "TH108 USB Restart" (install-usb-restart-task.ps1).
rem The instance-ID suffix is port-specific, so look it up live; the trailing backslash in the match string
rem selects ONLY the composite root (USB\VID_0C45&PID_8006\...), not the per-interface MI_xx child nodes.
for /f "tokens=3" %%i in ('pnputil /enum-devices /connected ^| findstr /c:"USB\VID_0C45&PID_8006\"') do (
  pnputil /restart-device "%%i"
)
