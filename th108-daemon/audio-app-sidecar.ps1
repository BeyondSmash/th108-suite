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
  [DllImport("user32.dll")] static extern bool PeekMessage(out NativeMsg m, IntPtr h, uint a, uint b, uint c);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref NativeMsg m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref NativeMsg m);
  [StructLayout(LayoutKind.Sequential)] struct NativeMsg { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
  // pump the STA message queue while waiting for the async completion callback (it's delivered via the pump)
  static bool PumpWait(System.Threading.WaitHandle ev, int ms){
    var sw=System.Diagnostics.Stopwatch.StartNew();
    while(sw.ElapsedMilliseconds<ms){ if(ev.WaitOne(0)) return true; NativeMsg m; while(PeekMessage(out m, IntPtr.Zero, 0,0,1)){ TranslateMessage(ref m); DispatchMessage(ref m); } System.Threading.Thread.Sleep(5); }
    return ev.WaitOne(0);
  }

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

  public static volatile float Level = 0f;
  static volatile bool running = false;
  static Exception startErr = null;
  static System.Threading.ManualResetEvent ready = new System.Threading.ManualResetEvent(false);

  // Run the whole COM lifecycle (activate + capture) on a dedicated MTA thread — ActivateAudioInterfaceAsync
  // wants MTA, and PowerShell's apartment is unreliable. The capture loop updates Level; PS just polls it.
  public static void StartMta(uint pid) {
    var t = new System.Threading.Thread(delegate() {
      try { Open(pid); } catch (Exception e) { startErr = e; ready.Set(); return; }
      running = true; ready.Set();
      var buf = new float[8192];
      while (running) {
        int n = Read(buf);
        if (n > 0) { double s = 0; for (int i=0;i<n;i++) s += buf[i]*buf[i]; Level = (float)Math.Min(1.0, Math.Sqrt(s/n)*4.0); }
        System.Threading.Thread.Sleep(20);
      }
    });
    t.IsBackground = true;
    t.SetApartmentState(System.Threading.ApartmentState.MTA);
    t.Start();
    ready.WaitOne(6000);
    if (startErr != null) throw startErr;
  }

  // STA variant: a FRESH dedicated STA thread with its own message pump (the PS host thread is busy
  // pumping its own loop → re-entrant E_ILLEGAL_METHOD_CALL; a clean STA+pump may activate cleanly).
  public static void StartSta(uint pid) {
    var t = new System.Threading.Thread(delegate() {
      try { Open(pid); } catch (Exception e) { startErr = e; ready.Set(); return; }
      running = true; ready.Set();
      var buf = new float[8192];
      while (running) {
        int n = Read(buf);
        if (n > 0) { double s = 0; for (int i=0;i<n;i++) s += buf[i]*buf[i]; Level = (float)Math.Min(1.0, Math.Sqrt(s/n)*4.0); }
        System.Threading.Thread.Sleep(20);
      }
    });
    t.IsBackground = true;
    t.SetApartmentState(System.Threading.ApartmentState.STA);
    t.Start();
    ready.WaitOne(8000);
    if (startErr != null) throw startErr;
  }

  public static void Open(uint pid) {
    Console.Error.WriteLine("[spike] apartment=" + System.Threading.Thread.CurrentThread.GetApartmentState());
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
    if (!PumpWait(h.done, 5000)) throw new Exception("activation timed out");
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

[AppCap]::StartSta([uint32]$ProcId)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
  [Console]::Out.WriteLine('{"level":' + [Math]::Round([AppCap]::Level,4) + ',"t":' + [Math]::Round($sw.Elapsed.TotalMilliseconds,1) + '}')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 33
}
