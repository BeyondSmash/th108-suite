' Launches the TH108 lighting daemon with no visible console window.
' Path-independent: resolves the daemon folder from this script's own location.
Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node daemon.js", 0, False
