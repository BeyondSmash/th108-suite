' th108:// custom-protocol dispatcher. The controller page links to th108://start (or th108://restart);
' Windows hands the FULL url to this script as arg 0 and we map the action to a hidden launch / HTTP call,
' so the page can start or restart the background daemon without the user running a command. Only the
' fixed words "start"/"restart" are honored — the url is never executed, so a stray link can't inject.
Option Explicit
Dim sh, fso, here, raw, action
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
raw = ""
If WScript.Arguments.Count > 0 Then raw = LCase(WScript.Arguments(0))
action = Replace(Replace(raw, "th108:", ""), "/", "")   ' strip scheme + slashes → bare action word

If action = "restart" Then
  ' ask a running daemon to restart itself (exits 42 → start-hidden.vbs supervisor revives it). If it's
  ' not answering, fall through to a plain start.
  On Error Resume Next
  Dim http : Set http = CreateObject("MSXML2.XMLHTTP")
  http.open "POST", "http://127.0.0.1:8123/restart", False
  http.send ""
  Dim ok : ok = (Err.Number = 0)
  On Error GoTo 0
  If ok Then WScript.Quit
End If

' start (default): bring up the tray, which starts + supervises the daemon (idempotent if already up).
sh.Run "wscript.exe """ & here & "\start-tray.vbs""", 0, False
