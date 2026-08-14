' Launches audio-tray.ps1 with NO console window (window style 0). Used by the logon task and manual start.
Set sh = CreateObject("WScript.Shell")
base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & base & "audio-tray.ps1""", 0, False
