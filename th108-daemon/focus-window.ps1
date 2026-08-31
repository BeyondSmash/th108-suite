# focus-window.ps1 — focus a session's VSCode window BY the session's Claude PID: walk UP the process tree
# to the parent Code.exe window (claude-view's reliable method), not a fuzzy title match. Self-contained.
# Usage: focus-window.ps1 -ClaudePid <pid> [-ProjectHint <name>] [-Switch] [-FlashColor '#hex'] [-DryRun]
#   -DryRun: resolve + LOG the target window, but DON'T focus or flash (safe debugging).
# Every run appends a line to %TEMP%\th108-focuswin.log so we can see what it resolved without side effects.
# PRIVACY: window TITLES are matched in memory but never written to that log. A VSCode title contains the
# open filename - and for a Claude Code window, the prompt currently being typed - so logging it would put
# fragments of what you type on disk. The log records the window HANDLE and the candidate count instead,
# which is all the debugging actually needs. It is also capped (see Log below) rather than growing forever.
param([int]$ClaudePid, [string]$ProjectHint = '', [switch]$Switch, [string]$FlashColor = '', [switch]$DryRun)
$ErrorActionPreference = 'SilentlyContinue'
$logFile = Join-Path $env:TEMP 'th108-focuswin.log'
# Cap at 64 KB, keeping the newest ~200 lines. This log is a live debugging aid, not a history - an
# uncapped one silently accumulated ~190 KB of window-resolution records over months.
function Log($m) {
  try {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 65536)) {
      $keep = Get-Content -Path $logFile -Tail 200
      Set-Content -Path $logFile -Value $keep
    }
    Add-Content -Path $logFile -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m)
  } catch { }
}

# Walk up from the Claude PID, collecting Code.exe ancestor PIDs (borrowed from focus-vscode.ps1).
$codeAncestors = @(); $cur = $ClaudePid
for ($i = 0; $i -lt 20; $i++) {
    try {
        $wmi = Get-CimInstance Win32_Process -Filter "ProcessId = $cur" -ErrorAction Stop
        $parent = [int]$wmi.ParentProcessId
        if ($parent -eq 0 -or $parent -eq $cur) { break }
        $pp = Get-Process -Id $parent -ErrorAction Stop
        if ($pp.Name -like 'Code*') { $codeAncestors += $parent }
        $cur = $parent
    } catch { break }
}
if ($codeAncestors.Count -eq 0) { $codeAncestors = @(Get-Process -Name Code -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) }
Log("pid=$ClaudePid hint='$ProjectHint' switch=$Switch flash='$FlashColor' dryrun=$DryRun codeAncestors=[$($codeAncestors -join ',')]")
if ($codeAncestors.Count -eq 0) { Log('  -> no Code.exe found; abort'); exit 1 }

Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class WinFocus {
    public delegate bool EnumWinCb(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinCb cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
    public static List<IntPtr> FindWindows(int[] pids) {
        var set = new HashSet<uint>(); foreach (var p in pids) set.Add((uint)p);
        var res = new List<IntPtr>();
        EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; uint pid; GetWindowThreadProcessId(h, out pid);
            if (set.Contains(pid) && GetWindowTextLength(h) > 0) res.Add(h); return true; }, IntPtr.Zero);
        return res;
    }
    public static string GetTitle(IntPtr h) { int n = GetWindowTextLength(h); if (n == 0) return ""; var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
    // SAFE focus: restore-if-minimized + raise + best-effort foreground. Deliberately does NOT use
    // AttachThreadInput (can freeze the target thread's input queue → VSCode hangs, requiring a task-kill)
    // and does NOT synthesize the Alt key (accelerator risk). If Windows' foreground lock refuses
    // SetForegroundWindow, the window still comes forward via ShowWindow/BringWindowToTop — it just may
    // not steal focus. Reliability traded for never being able to hang or close the editor.
    public static void FocusWindow(IntPtr t) {
        if (IsIconic(t)) ShowWindow(t, 9); else ShowWindow(t, 5);   // SW_RESTORE / SW_SHOW — never minimizes or closes
        BringWindowToTop(t);
        SetForegroundWindow(t);
    }
}
"@
$wins = [WinFocus]::FindWindows([int[]]$codeAncestors)
if ($wins.Count -eq 0) { Log('  -> no visible VSCode windows for those ancestors; abort'); exit 1 }
$best = $null
if ($ProjectHint) { $best = $wins | Where-Object { [WinFocus]::GetTitle($_) -like "*$ProjectHint*" } | Select-Object -First 1 }
if (-not $best) { $best = $wins | Where-Object { [WinFocus]::GetTitle($_) -like '*Visual Studio Code*' } | Select-Object -First 1 }
if (-not $best) { $best = $wins[0] }
Log("  -> target hwnd=$($best.ToInt64())  (of $($wins.Count) window(s))")   # deliberately NO title - see the privacy note at the top

if ($DryRun) { Log('  -> DRY RUN: not focusing, not flashing'); exit 0 }
if ($Switch) { [WinFocus]::FocusWindow($best); Log('  -> focused') }
if ($FlashColor) {
    $flash = Join-Path (Split-Path $MyInvocation.MyCommand.Path) 'focus-flash.ps1'
    if (Test-Path $flash) { Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $flash, '-Hwnd', $best.ToInt64(), '-Color', $FlashColor); Log('  -> flash spawned') }
}
exit 0
