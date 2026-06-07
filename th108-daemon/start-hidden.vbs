' Launches the TH108 lighting daemon with no visible console window.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "path\to\th108-suite\th108-daemon"
sh.Run "node daemon.js", 0, False
