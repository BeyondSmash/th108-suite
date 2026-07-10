# focus-vscode.ps1 — Focus a VSCode window and flash an edge-glow outline.
# Usage: focus-vscode.ps1 -Hwnd <int64> [-Color '#f97316']                       (direct window handle — the window picker)
#        focus-vscode.ps1 -ClaudePid <pid> [-ProjectHint <name>] [-Color '#f97316']  (walk a Claude PID → its VSCode window)
#
# Bundled, self-contained copy of the proven claude-view focus method (AttachThreadInput + SwitchToThisWindow
# to steal foreground past the Win11 lock). -Hwnd focuses an exact window (from list-vscode-windows.ps1);
# -ClaudePid walks the process tree up to the session's parent Code.exe window. -Color is passed to our OWN
# focus-flash.ps1 (same folder) so the glow matches the user's outline color. No dependency on claude-view.
param(
    [int]$ClaudePid,
    [string]$ProjectHint = "",
    [string]$Color = "",
    [Int64]$Hwnd = 0
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
    public delegate bool EnumWinCb(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinCb cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);

    public static List<IntPtr> FindWindows(int[] pids) {
        var pidSet = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in pids) pidSet.Add((uint)p);
        var result = new List<IntPtr>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pidSet.Contains(pid) && GetWindowTextLength(h) > 0) result.Add(h);
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static string GetTitle(IntPtr h) {
        int len = GetWindowTextLength(h); if (len == 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static bool FocusWindow(IntPtr target) {
        const byte VK_MENU = 0x12;

        // Only restore if minimized; SW_SHOW on an already-visible window avoids unmaximizing.
        if (IsIconic(target)) ShowWindow(target, 9); // SW_RESTORE
        else ShowWindow(target, 5);                   // SW_SHOW

        IntPtr fg = GetForegroundWindow();
        if (fg == target) return true; // already in front — nothing to do

        // Attach our thread to the foreground window's input queue.
        // This grants permission to call SetForegroundWindow regardless of which
        // app is currently in front (works even when switching between two VSCode windows).
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != myThread &&
                        AttachThreadInput(fgThread, myThread, true);

        // Alt-key pulse — additional bypass for Windows 11 foreground lock.
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);

        BringWindowToTop(target);
        SetForegroundWindow(target);
        SwitchToThisWindow(target, true); // most aggressive — designed for exactly this case

        keybd_event(VK_MENU, 0, 0x0002, UIntPtr.Zero); // Alt up

        if (attached) AttachThreadInput(fgThread, myThread, false);
        return true;
    }
}
"@

if ($Hwnd -ne 0) {
    # Direct-by-handle path (window picker): focus the exact window — no PID walk / enumeration needed.
    $best = [IntPtr][Int64]$Hwnd
} else {
    # Walk up from the Claude PID, collecting Code.exe ancestor PIDs → the session's parent VSCode window.
    $codeAncestorPids = @()
    $current = $ClaudePid
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $wmi = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction Stop
            $parentId = [int]$wmi.ParentProcessId
            if ($parentId -eq 0 -or $parentId -eq $current) { break }
            $parent = Get-Process -Id $parentId -ErrorAction Stop
            if ($parent.Name -like "Code*") { $codeAncestorPids += $parentId }
            $current = $parentId
        } catch { break }
    }
    if ($codeAncestorPids.Count -eq 0) {
        $codeAncestorPids = @(Get-Process -Name Code -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Id)
    }
    if ($codeAncestorPids.Count -eq 0) { Write-Error "No Code.exe found"; exit 1 }

    $pidArray = [int[]]$codeAncestorPids
    $windows = [WinFocus]::FindWindows($pidArray)
    if ($windows.Count -eq 0) { Write-Error "No visible VSCode windows found"; exit 1 }

    # Pick the window matching the project hint, fall back to first VSCode window.
    $best = $null
    if ($ProjectHint) {
        $best = $windows |
            Where-Object { [WinFocus]::GetTitle($_) -like "*$ProjectHint*" } |
            Select-Object -First 1
    }
    if (-not $best) {
        $best = $windows |
            Where-Object { [WinFocus]::GetTitle($_) -like "*Visual Studio Code*" } |
            Select-Object -First 1
    }
    if (-not $best) { $best = $windows[0] }
}

$r = [WinFocus]::FocusWindow($best)

# Launch edge-glow flash on the monitor that contains the focused window.
# Pass the HWND so focus-flash.ps1 resolves monitor bounds in its own DPI-aware process, and the chosen
# -Color so the glow matches the user's outline color (omit → focus-flash.ps1's own default).
try {
    $flashScript = Join-Path (Split-Path $MyInvocation.MyCommand.Path) "focus-flash.ps1"
    if (Test-Path $flashScript) {
        $flashArgs = @(
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
            "-STA", "-ExecutionPolicy", "Bypass", "-File", ('"' + $flashScript + '"'),   # QUOTE the path — it lives under "…\Epomaker Project\…" (spaces); Start-Process -ArgumentList won't auto-quote it, so an unquoted path splits and the child can't find the script
            "-Hwnd", $best.ToInt64()
        )
        if ($Color) { $flashArgs += @("-Color", $Color) }
        Start-Process powershell.exe -ArgumentList $flashArgs -WindowStyle Hidden
    }
} catch { <# flash is best-effort, never fail the focus #> }

exit 0
