# focus-detect.ps1 — LOOP: every ~2s print one JSON line for the foreground window IF it's a VSCode
# (Code.exe) window: {"code":true,"title":"...","pid":N}; else {"code":false}. The daemon spawns this ONLY
# while an Agent layer is in Follow-focus mode and reads the lines to track the focused session. Borrowed
# from claude-view's window-info technique (pure Win32: GetForegroundWindow + GetWindowText) so it needs NO
# external app — just Windows. Self-recycles like the media sidecar so it can never balloon. Pure ASCII.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
    public static string Title(IntPtr h) {
        int len = GetWindowTextLength(h); if (len == 0) return "";
        var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString();
    }
}
"@
$self = [System.Diagnostics.Process]::GetCurrentProcess()
$iter = 0
while ($true) {
    $h = [FgWin]::GetForegroundWindow()
    $procId = [int][FgWin]::Pid($h)
    $exe = ''
    $isCode = $false
    try { $p = Get-Process -Id $procId -ErrorAction Stop; $exe = $p.Name; if ($p.Name -like 'Code*') { $isCode = $true } } catch { }
    # Always emit exe+title so BOTH consumers work: agent-follow keys off `code`+`title` (VSCode only);
    # app-specific profiles key off `exe` (any app, the ProcessName the /open-apps picker also reports).
    [Console]::Out.WriteLine((@{ code = $isCode; exe = $exe; title = [FgWin]::Title($h); pid = $procId } | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds 2000
    # self-recycle before any GDI/handle creep can accumulate (same guard as the media sidecar); the daemon respawns
    $iter++
    $self.Refresh()
    if ($self.WorkingSet64 -gt 200MB -or $self.Threads.Count -gt 300 -or $iter -gt 5400) { break }
}
