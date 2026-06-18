# audio-sidecar.ps1 — WASAPI loopback capture for the music layer. Uses ONLY the in-box .NET
# Framework via Add-Type (no NuGet/SDK/binary), mirroring media-sidecar.ps1's "PowerShell sidecar"
# pattern. Prints newline-delimited JSON feature frames to stdout; the daemon (audio-capture.js)
# spawns + supervises it. SPIKE STAGE: emits {level,t} only — Task 2 adds bands/beat/centroid.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;

public static class Cap {
  // ---- COM interop for WASAPI loopback on the default render endpoint ----
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ep); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int clsctx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long hnsBufDur, long hnsPeriod, IntPtr fmt, IntPtr session);
    int GetBufferSize(out uint frames); int GetStreamLatency(out long l); int GetCurrentPadding(out uint p);
    int IsFormatSupported(int sm, IntPtr fmt, IntPtr o); int GetMixFormat(out IntPtr fmt);
    int GetDevicePeriod(out long def, out long min); int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr h);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long devpos, out long qpos);
    int ReleaseBuffer(uint frames); int GetNextPacketSize(out uint frames);
  }

  const int LOOPBACK = 0x00020000, SHARED = 0;
  static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
  static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

  public static int channels, sampleRate;
  static IAudioClient client; static IAudioCaptureClient capture;

  public static void Open() {
    var enumr = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; enumr.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out dev);
    object o; dev.Activate(ref IID_IAudioClient, 1 /*INPROC*/, IntPtr.Zero, out o); client = (IAudioClient)o;
    IntPtr fmt; client.GetMixFormat(out fmt);
    // WAVEFORMATEX: wFormatTag(2) nChannels(2) nSamplesPerSec(4) nAvgBytes(4) nBlockAlign(2) wBitsPerSample(2)
    channels   = Marshal.ReadInt16(fmt, 2);
    sampleRate = Marshal.ReadInt32(fmt, 4);
    client.Initialize(SHARED, LOOPBACK, 2000000 /*200ms*/, 0, fmt, IntPtr.Zero);
    object c; client.GetService(ref IID_IAudioCaptureClient, out c); capture = (IAudioCaptureClient)c;
    client.Start();
  }

  // Drain all queued packets into a mono float buffer; returns the count written (0 = silence/no data).
  public static int Read(float[] outBuf) {
    int n = 0; uint avail;
    capture.GetNextPacketSize(out avail);
    while (avail > 0 && n < outBuf.Length) {
      IntPtr data; uint frames, flags; long dp, qp;
      capture.GetBuffer(out data, out frames, out flags, out dp, out qp);
      if (frames > 0) {
        bool silent = (flags & 0x2) != 0;   // AUDCLNT_BUFFERFLAGS_SILENT
        for (uint f = 0; f < frames && n < outBuf.Length; f++) {
          float s = 0f;
          if (!silent && data != IntPtr.Zero) {
            // mix-format is 32-bit IEEE float, interleaved per channel -> average to mono
            for (int ch = 0; ch < channels; ch++) {
              float v = (float)Marshal.PtrToStructure(data + (int)((f*channels+ch)*4), typeof(float));
              s += v;
            }
            s /= channels;
          }
          outBuf[n++] = s;
        }
      }
      capture.ReleaseBuffer(frames);
      capture.GetNextPacketSize(out avail);
    }
    return n;
  }
}
"@

[Cap]::Open()
$buf = New-Object 'float[]' 8192
$sw  = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $n = [Cap]::Read($buf)
  $sum = 0.0
  for ($i = 0; $i -lt $n; $i++) { $sum += $buf[$i] * $buf[$i] }
  $rms = if ($n -gt 0) { [Math]::Sqrt($sum / $n) } else { 0.0 }
  $level = [Math]::Min(1.0, $rms * 4.0)   # rough gain so typical music lands mid-range
  $t = [Math]::Round($sw.Elapsed.TotalMilliseconds, 1)
  [Console]::Out.WriteLine('{"level":' + [Math]::Round($level,4) + ',"t":' + $t + '}')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 33   # ~30 Hz
}
