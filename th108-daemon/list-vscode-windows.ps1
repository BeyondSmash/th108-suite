# list-vscode-windows.ps1 — enumerate every OPEN VSCode window (independent of Claude sessions).
# Emits JSON: [{ hwnd, title }, …]. Uses EnumWindows (NOT Get-Process|MainWindowHandle) because multiple
# VSCode windows share one main Code.exe process, so MainWindowHandle only reports one of them.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class WinList {
    public delegate bool EnumWinCb(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinCb cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    public static List<object[]> All() {
        var res = new List<object[]>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h); if (len == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
            res.Add(new object[] { h.ToInt64(), (long)pid, sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return res;
    }
}
"@
$codePids = @{}
Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object { $codePids[[int]$_.Id] = $true }
$out = [WinList]::All() |
    Where-Object { $codePids.ContainsKey([int]$_[1]) -and $_[2] -like '*Visual Studio Code*' } |
    ForEach-Object { [pscustomobject]@{ hwnd = $_[0]; title = $_[2] } }
# ConvertTo-Json collapses a single object to a non-array — force an array so the daemon always parses a list.
@($out) | ConvertTo-Json -Compress
