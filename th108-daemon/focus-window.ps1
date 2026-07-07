# focus-window.ps1 — find the VSCode window for a project and optionally bring it to front and/or flash a
# color edge-outline on its monitor. Self-contained (no claude-view) — borrows claude-view's window-info
# enumeration + focus-vscode focusing technique. Matches by PROJECT (window title), since the daemon has
# no per-session pid. Usage: focus-window.ps1 -Project <name> [-Switch] [-FlashColor '#f97316']
param([string]$Project = '', [switch]$Switch, [string]$FlashColor = '')
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
    public delegate bool EnumCb(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
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
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
    public static List<IntPtr> Find(HashSet<uint> pids) {
        var res = new List<IntPtr>();
        EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; uint pid; GetWindowThreadProcessId(h, out pid);
            if (pids.Contains(pid) && GetWindowTextLength(h) > 0) res.Add(h); return true; }, IntPtr.Zero);
        return res;
    }
    public static string Title(IntPtr h) { int n = GetWindowTextLength(h); if (n == 0) return ""; var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
    public static void Focus(IntPtr t) {
        if (IsIconic(t)) ShowWindow(t, 9); else ShowWindow(t, 5);
        IntPtr fg = GetForegroundWindow(); if (fg == t) return;
        uint fgT = GetWindowThreadProcessId(fg, IntPtr.Zero), my = GetCurrentThreadId();
        bool at = fgT != 0 && fgT != my && AttachThreadInput(fgT, my, true);
        BringWindowToTop(t); SetForegroundWindow(t); SwitchToThisWindow(t, true);
        if (at) AttachThreadInput(fgT, my, false);
    }
}
"@
$codePids = @(Get-Process -Name Code -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($codePids.Count -eq 0) { exit 0 }
$set = [System.Collections.Generic.HashSet[uint]]::new(); foreach ($p in $codePids) { [void]$set.Add([uint]$p) }
$wins = [Win]::Find($set)
if ($wins.Count -eq 0) { exit 0 }
$target = $null
if ($Project) { foreach ($w in $wins) { if ([Win]::Title($w) -like "*$Project*") { $target = $w; break } } }
if (-not $target) { $fg = [Win]::GetForegroundWindow(); if ($wins -contains $fg) { $target = $fg } else { $target = $wins[0] } }
if (-not $target) { exit 0 }
if ($Switch) { [Win]::Focus($target) }
if ($FlashColor) {
    $flash = Join-Path (Split-Path $MyInvocation.MyCommand.Path) 'focus-flash.ps1'
    if (Test-Path $flash) {
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-STA', '-ExecutionPolicy', 'Bypass',
            '-File', $flash, '-Hwnd', $target.ToInt64(), '-Color', $FlashColor)
    }
}
exit 0
