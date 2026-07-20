' Launches the TH108 lighting daemon with no visible console window, and SUPERVISES it:
' if the daemon crashes (non-zero exit), it restarts after 3s; a clean exit (the /quit
' button or a shutdown signal, exit code 0) ends supervision. Exit code 42 = the /restart
' button: revive fast (after the port releases) WITHOUT counting it as a crash.
' Runaway guard: 5 crashes inside 60s means something is truly broken - give up instead of loop-thrashing.
' Path-independent: resolves the daemon folder from this script's own location.
Dim sh, fso, code, crashes, windowStart, log, ts, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
log = "daemon-crash.log"
crashes = 0
windowStart = Timer
Do
  ' Capture stderr so a native-addon hard-crash (node-hid / uiohook) leaves a trace — daemon.log is stdout
  ' only, so those crashes were invisible. cmd /c preserves node's exit code; a timestamp header per launch
  ' marks where each run's stderr begins. Run hidden (0) so no console flashes. Close the header handle before
  ' the run so it can't collide with the 2>> redirect opening the same file.
  ts = Year(Now) & "-" & Right("0" & Month(Now),2) & "-" & Right("0" & Day(Now),2) & " " & Right("0" & Hour(Now),2) & ":" & Right("0" & Minute(Now),2) & ":" & Right("0" & Second(Now),2)
  Set f = fso.OpenTextFile(log, 8, True) : f.WriteLine "===== launch " & ts & " =====" : f.Close
  code = sh.Run("cmd /c node daemon.js 2>> " & log, 0, True)   ' True = wait for exit
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
