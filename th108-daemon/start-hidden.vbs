' Launches the TH108 lighting daemon with no visible console window, and SUPERVISES it:
' if the daemon crashes (non-zero exit), it restarts after 3s; a clean exit (the /quit
' button or a shutdown signal, exit code 0) ends supervision. Exit code 42 = the /restart
' button: revive fast (after the port releases) WITHOUT counting it as a crash.
' Runaway guard: 5 crashes inside 60s means something is truly broken - give up instead of loop-thrashing.
' Path-independent: resolves the daemon folder from this script's own location.
Dim sh, fso, code, crashes, windowStart
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
crashes = 0
windowStart = Timer
Do
  code = sh.Run("node daemon.js", 0, True)   ' True = wait for exit
  If code = 0 Then Exit Do                   ' clean quit - stop supervising
  If code = 42 Then                          ' intentional /restart - revive fast, don't count as a crash
    WScript.Sleep 800                        ' brief gap so the old process fully releases port 8123 before rebinding
  Else
    If Timer - windowStart > 60 Or Timer < windowStart Then   ' new 60s window (Timer wraps at midnight)
      crashes = 0
      windowStart = Timer
    End If
    crashes = crashes + 1
    If crashes >= 5 Then Exit Do             ' crash loop - don't thrash forever
    WScript.Sleep 3000
  End If
Loop
