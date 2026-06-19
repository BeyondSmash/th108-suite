# audio-app-sidecar.ps1 — PROCESS-LOOPBACK capture spike: grab the audio of ONE process (and its tree)
# via the Win10 2004+ ActivateAudioInterfaceAsync(VAD\Process_Loopback) path. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File audio-app-sidecar.ps1 <PID>
# Prints {level,t} NDJSON like the other sidecars. SPIKE: proves per-app capture works before we wire a
# picker + the full feature pipeline. Uses only in-box .NET via Add-Type (no NuGet/binary).
param([int]$ProcId = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($ProcId -le 0) { [Console]::Error.WriteLine('pass a PID: audio-app-sidecar.ps1 <PID>'); exit 1 }

Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class AppCap {
  // ---- WASAPI process-loopback interop ----
  [DllImport("Mmdevapi.dll", CharSet=CharSet.Unicode)]
  static extern int ActivateAudioInterfaceAsync(string path, ref Guid riid, IntPtr activationParams,
    IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

  [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateAudioInterfaceAsyncOperation { int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
  [Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateAudioInterfaceCompletionHandler { void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op); }

  [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long hnsBufDur, long hnsPeriod, IntPtr fmt, IntPtr session);
    int GetBufferSize(out uint f); int GetStreamLatency(out long l); int GetCurrentPadding(out uint p);
    int IsFormatSupported(int sm, IntPtr f, IntPtr o); int GetMixFormat(out IntPtr f);
    int GetDevicePeriod(out long d, out long m); int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr h);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient { int GetBuffer(out IntPtr d, out uint f, out uint fl, out long dp, out long qp); int ReleaseBuffer(uint f); int GetNextPacketSize(out uint f); }

  // AUDIOCLIENT_ACTIVATION_PARAMS (process-loopback variant), laid out for a VT_BLOB PROPVARIANT.
  [StructLayout(LayoutKind.Sequential)]
  struct ActivationParams { public int ActivationType; public uint TargetPid; public int LoopbackMode; }
  const int AUDCLNT_SHAREMODE_SHARED = 0, LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000;
  const int ACTTYPE_PROCESS_LOOPBACK = 1, INCLUDE_TREE = 0;
  static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
  static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
  const string VAD_PROCESS_LOOPBACK = "VAD\\Process_Loopback";

  class Handler : IActivateAudioInterfaceCompletionHandler {
    public ManualResetEvent done = new ManualResetEvent(false);
    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { done.Set(); }
  }

  public static int channels = 2, sampleRate = 48000;
  static IAudioClient client; static IAudioCaptureClient capture;

  public static void Open(uint pid) {
    // PROPVARIANT holding the activation BLOB
    var ap = new ActivationParams { ActivationType = ACTTYPE_PROCESS_LOOPBACK, TargetPid = pid, LoopbackMode = INCLUDE_TREE };
    int apSize = Marshal.SizeOf(typeof(ActivationParams));
    IntPtr apPtr = Marshal.AllocHGlobal(apSize); Marshal.StructureToPtr(ap, apPtr, false);
    // PROPVARIANT: WORD vt(=VT_BLOB 0x0041) + 3 WORD pad + (on x64) BLOB{ ULONG cbSize; void* pBlobData }
    IntPtr pv = Marshal.AllocHGlobal(24); for (int i=0;i<24;i++) Marshal.WriteByte(pv,i,0);
    Marshal.WriteInt16(pv, 0, 0x0041);                 // vt = VT_BLOB
    Marshal.WriteInt32(pv, 8, apSize);                 // BLOB.cbSize
    Marshal.WriteIntPtr(pv, 16, apPtr);                // BLOB.pBlobData

    var h = new Handler();
    IActivateAudioInterfaceAsyncOperation op;
    int hr = ActivateAudioInterfaceAsync(VAD_PROCESS_LOOPBACK, ref IID_IAudioClient, pv, h, out op);
    if (hr != 0) throw new Exception("ActivateAudioInterfaceAsync hr=0x" + hr.ToString("x"));
    if (!h.done.WaitOne(3000)) throw new Exception("activation timed out");
    int actHr; object iface; op.GetActivateResult(out actHr, out iface);
    if (actHr != 0) throw new Exception("GetActivateResult hr=0x" + actHr.ToString("x"));
    client = (IAudioClient)iface;

    // process-loopback requires a caller-supplied format (no GetMixFormat). 48k/float32/stereo.
    IntPtr fmt = Marshal.AllocHGlobal(18);
    Marshal.WriteInt16(fmt, 0, 3);                     // wFormatTag = WAVE_FORMAT_IEEE_FLOAT
    Marshal.WriteInt16(fmt, 2, (short)channels);
    Marshal.WriteInt32(fmt, 4, sampleRate);
    Marshal.WriteInt32(fmt, 8, sampleRate*channels*4);// nAvgBytesPerSec
    Marshal.WriteInt16(fmt, 12, (short)(channels*4)); // nBlockAlign
    Marshal.WriteInt16(fmt, 14, 32);                  // wBitsPerSample
    Marshal.WriteInt16(fmt, 16, 0);                   // cbSize
    client.Initialize(AUDCLNT_SHAREMODE_SHARED, LOOPBACK | EVENTCALLBACK, 2000000, 0, fmt, IntPtr.Zero);
    object c; client.GetService(ref IID_IAudioCaptureClient, out c); capture = (IAudioCaptureClient)c;
    client.Start();
  }

  public static int Read(float[] outBuf) {
    int n=0; uint avail; capture.GetNextPacketSize(out avail);
    while (avail>0 && n<outBuf.Length) {
      IntPtr data; uint frames, flags; long dp, qp; capture.GetBuffer(out data, out frames, out flags, out dp, out qp);
      if (frames>0) { bool silent=(flags&0x2)!=0;
        for (uint f=0; f<frames && n<outBuf.Length; f++) { float s=0f;
          if (!silent && data!=IntPtr.Zero) { for (int ch=0; ch<channels; ch++) s += (float)Marshal.PtrToStructure(data+(int)((f*channels+ch)*4), typeof(float)); s/=channels; }
          outBuf[n++]=s; } }
      capture.ReleaseBuffer(frames); capture.GetNextPacketSize(out avail);
    }
    return n;
  }
}
"@

[AppCap]::Open([uint32]$ProcId)
$buf = New-Object 'float[]' 8192
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $n = [AppCap]::Read($buf); $sum = 0.0
  for ($i=0; $i -lt $n; $i++) { $sum += $buf[$i]*$buf[$i] }
  $rms = if ($n -gt 0) { [Math]::Sqrt($sum/$n) } else { 0.0 }
  [Console]::Out.WriteLine('{"level":' + [Math]::Round([Math]::Min(1.0,$rms*4.0),4) + ',"t":' + [Math]::Round($sw.Elapsed.TotalMilliseconds,1) + '}')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 33
}
