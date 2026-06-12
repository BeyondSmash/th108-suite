' Launches the TH108 tray app (tray.ps1) with no visible window. The tray starts the
' daemon if it is down, so this is the one thing to run (or auto-start at login).
Dim sh, fso, here
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\tray.ps1""", 0, False
