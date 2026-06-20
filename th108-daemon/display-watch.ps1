# display-watch.ps1 — emits the Windows console display state so the daemon can blank the board when the
# monitor turns OFF on the idle timeout (distinct from sleep). Registers for GUID_CONSOLE_DISPLAY_STATE and
# prints "on" / "off" / "dim" to stdout on each change. In-box .NET only (no SDK), like the other sidecars.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class DispWatch : NativeWindow {
  [DllImport("user32.dll")] static extern IntPtr RegisterPowerSettingNotification(IntPtr h, ref Guid g, int flags);
  static Guid GUID_CONSOLE_DISPLAY_STATE = new Guid("6fe69556-704a-47a0-8f24-c28d936fda47");
  const int WM_POWERBROADCAST = 0x0218, PBT_POWERSETTINGCHANGE = 0x8013;
  [StructLayout(LayoutKind.Sequential)] struct PBSetting { public Guid PowerSetting; public uint DataLength; public byte Data; }
  public DispWatch() { this.CreateHandle(new CreateParams()); RegisterPowerSettingNotification(this.Handle, ref GUID_CONSOLE_DISPLAY_STATE, 0); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_POWERBROADCAST && (int)m.WParam == PBT_POWERSETTINGCHANGE) {
      var s = (PBSetting)Marshal.PtrToStructure(m.LParam, typeof(PBSetting));
      if (s.PowerSetting == GUID_CONSOLE_DISPLAY_STATE) {
        Console.Out.WriteLine(s.Data == 0 ? "off" : s.Data == 1 ? "on" : "dim"); Console.Out.Flush();
      }
    }
    base.WndProc(ref m);
  }
}
"@
$w = New-Object DispWatch
[System.Windows.Forms.Application]::Run()   # message pump (power events arrive on this thread)
