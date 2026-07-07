# focus-flash.ps1 — WPF transparent edge-glow flash on the monitor that holds a window.
# Usage: powershell.exe -STA -File focus-flash.ps1 -Hwnd <int64> [-Color '#f97316'] [-Thick 6]
# Borrowed from claude-view's focus-flash technique; parameterized color + its OWN lock file so it never
# fights claude-view's flash. Best-effort: any failure exits quietly.
param([Int64]$Hwnd, [string]$Color = '#f97316', [int]$Thick = 6)
$ErrorActionPreference = 'SilentlyContinue'

# Singleton: kill any previous th108 flash before starting (separate lock from claude-view's)
$lockFile = "$env:TEMP\focus-flash-th108.lock"
if (Test-Path $lockFile) {
    try { $oldPid = [int](Get-Content $lockFile -Raw).Trim(); if ($oldPid -ne $PID) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue } } catch { }
}
$PID | Set-Content $lockFile -Force -NoNewline

try {
    Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FlashWin32 {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insert, int x, int y, int cx, int cy, uint flags);
}
"@
    [FlashWin32]::SetProcessDPIAware() | Out-Null

    # parse -Color (#rrggbb) → media Color, fall back to orange
    $r = 249; $g = 115; $b = 22
    try { $h = $Color.TrimStart('#'); $r = [Convert]::ToInt32($h.Substring(0,2),16); $g = [Convert]::ToInt32($h.Substring(2,2),16); $b = [Convert]::ToInt32($h.Substring(4,2),16) } catch { }
    if ($Thick -lt 1) { $Thick = 1 }; if ($Thick -gt 40) { $Thick = 40 }

    $hPtr   = [IntPtr][Int64]$Hwnd
    $screen = [System.Windows.Forms.Screen]::FromHandle($hPtr)
    $bX = $screen.Bounds.X; $bY = $screen.Bounds.Y; $bW = $screen.Bounds.Width; $bH = $screen.Bounds.Height

    $col = [System.Windows.Media.Color]::FromArgb(255, $r, $g, $b)
    $script:brush = New-Object System.Windows.Media.SolidColorBrush($col); $script:brush.Freeze()

    $script:win = New-Object System.Windows.Window
    $script:win.WindowStyle = [System.Windows.WindowStyle]::None
    $script:win.AllowsTransparency = $true
    $script:win.Background = [System.Windows.Media.Brushes]::Transparent
    $script:win.Topmost = $true; $script:win.ShowInTaskbar = $false
    $script:win.Left = 0; $script:win.Top = 0; $script:win.Width = 200; $script:win.Height = 200
    $script:win.Opacity = 0.0; $script:win.IsHitTestVisible = $false

    $grid = New-Object System.Windows.Controls.Grid
    foreach ($edge in @('Top','Bottom','Left','Right')) {
        $rect = New-Object System.Windows.Shapes.Rectangle; $rect.Fill = $script:brush
        if ($edge -eq 'Top' -or $edge -eq 'Bottom') { $rect.Height = $Thick; $rect.HorizontalAlignment = 'Stretch'; $rect.VerticalAlignment = $edge }
        else { $rect.Width = $Thick; $rect.VerticalAlignment = 'Stretch'; $rect.HorizontalAlignment = $edge }
        [void]$grid.Children.Add($rect)
    }
    $script:win.Content = $grid

    $script:tick = 0; $script:inT = 3; $script:holdT = 8; $script:outT = 20; $script:peak = 0.92
    $script:timer = New-Object System.Windows.Threading.DispatcherTimer
    $script:timer.Interval = [TimeSpan]::FromMilliseconds(16)
    $script:timer.Add_Tick({
        $t = ++$script:tick
        $op = if ($t -le $script:inT) { $script:peak * ($t / $script:inT) }
              elseif ($t -le ($script:inT + $script:holdT)) { $script:peak }
              else { $e = $t - $script:inT - $script:holdT; [Math]::Max(0.0, $script:peak * (1.0 - $e / $script:outT)) }
        $script:win.Opacity = $op
        if ($t -gt ($script:inT + $script:holdT + $script:outT)) { $script:timer.Stop(); $script:win.Close() }
    })
    $script:win.Add_Loaded({
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:win)
        [FlashWin32]::SetWindowPos($helper.Handle, [IntPtr]::new(-1), $bX, $bY, $bW, $bH, 0x0010) | Out-Null   # HWND_TOPMOST, SWP_NOACTIVATE
        $script:timer.Start()
    })
    [void]$script:win.ShowDialog()
} finally {
    try { if ((Get-Content $lockFile -Raw).Trim() -eq [string]$PID) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } } catch { }
}
