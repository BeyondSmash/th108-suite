' Runs restart-usb.bat with NO visible window. The USB-restart scheduled task launches THIS
' (instead of cmd.exe directly) so the recovery batch — and the powershell device lookup inside
' it — never flash a console that steals keyboard focus mid-typing. sh.Run style 0 = hidden;
' True = wait for it to finish. Path-independent: resolves the batch next to this script.
Dim sh, fso, here
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & here & "\restart-usb.bat""", 0, True
