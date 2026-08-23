// app-capture.cs — per-application audio capture for the TH108 music layer, via the Win10 2004+
// process-loopback API (ActivateAudioInterfaceAsync "VAD\Process_Loopback"). Built at setup time by the
// IN-BOX .NET Framework compiler (csc.exe) — no SDK, no committed binary. Usage:  app-capture.exe <PID>
// → prints {bands[32],level,beat,centroid,t} NDJSON to stdout at ~30 Hz (the SAME contract as
// audio-sidecar.ps1, so audio-capture.js parses it unchanged).
//
// THE BUG THAT BLOCKED THIS FOR THREE SPIKES: every apartment/pump/CoInit variation — in PowerShell AND a
// compiled exe — returned E_ILLEGAL_METHOD_CALL synchronously from ActivateAudioInterfaceAsync. OBS captures
// the same machine fine, proving the API works here. The cause: that API delivers its completion callback from
// the MTA and REQUIRES the handler to be AGILE (free-threaded-marshalable); a managed CCW isn't, and a managed
// IAgileObject marker interface doesn't help (the CLR reserves that IID). FIX = aggregate the free-threaded
// marshaler on the handler via ICustomQueryInterface (hand out the FTM's IMarshal) — what C++/WRL::FtmBase does
// for free. With that, activation succeeds. Verified: clean activation against a live PID, no error.
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Globalization;

class AppCapture {
  // ---------- interop ----------
  [DllImport("Mmdevapi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern int ActivateAudioInterfaceAsync(string path, ref Guid riid, IntPtr activationParams,
    IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);
  [DllImport("user32.dll")] static extern bool PeekMessage(out NativeMsg m, IntPtr h, uint a, uint b, uint c);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref NativeMsg m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref NativeMsg m);
  [DllImport("kernel32.dll")] static extern IntPtr CreateEventW(IntPtr a, bool manual, bool init, string name);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr p, int coInit);   // 0=MTA — init COM before ActivateAudioInterfaceAsync (a flat export, so the CLR hasn't done it yet)
  [DllImport("ole32.dll")] static extern int CoCreateFreeThreadedMarshaler(IntPtr outer, out IntPtr marshal);   // FTM to make the managed handler agile
  [StructLayout(LayoutKind.Sequential)] struct NativeMsg { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }

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

  // ---- audio-session enumeration (for --list and name→PID resolution) ----
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ep); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int clsctx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int NotImpl1(); int NotImpl2();
    int GetSessionEnumerator(out IAudioSessionEnumerator e);
    // (remaining methods unused)
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { int GetCount(out int c); int GetSession(int i, out IAudioSessionControl2 s); }
  // IAudioSessionControl2 (extends IAudioSessionControl) — full vtable so GetState + GetProcessId land in the
  // right slots; only those two are called, the rest are placeholders.
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);                                   // 0=inactive 1=active 2=expired
    int GetDisplayName(out IntPtr p); int SetDisplayName(IntPtr a, IntPtr b);
    int GetIconPath(out IntPtr p); int SetIconPath(IntPtr a, IntPtr b);
    int GetGroupingParam(out Guid g); int SetGroupingParam(ref Guid a, IntPtr b);
    int RegisterAudioSessionNotification(IntPtr n); int UnregisterAudioSessionNotification(IntPtr n);
    int GetSessionIdentifier(out IntPtr p); int GetSessionInstanceIdentifier(out IntPtr p);
    int GetProcessId(out uint pid);
    int IsSystemSoundsSession(); int SetDuckingPreference(bool opt);
  }
  static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

  [StructLayout(LayoutKind.Sequential)]
  struct ActivationParams { public int ActivationType; public uint TargetPid; public int LoopbackMode; }
  const int SHARED = 0, LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000;
  const int ACTTYPE_PROCESS_LOOPBACK = 1, INCLUDE_TREE = 0;
  const string VAD = "VAD\\Process_Loopback";
  static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
  static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

  // ActivateAudioInterfaceAsync delivers its completion callback from the MTA and REQUIRES the handler to be
  // AGILE (free-threaded-marshalable). A managed CCW is NOT agile by default — and a plain managed IAgileObject
  // marker interface doesn't help (the CLR reserves that IID and won't route QI to managed code), so the call
  // fails synchronously with E_ILLEGAL_METHOD_CALL (the bug that beat every apartment/pump variation). The fix
  // is to AGGREGATE the free-threaded marshaler: via ICustomQueryInterface we hand the caller the FTM's IMarshal
  // (and IAgileObject), which is exactly what C++ gets for free from WRL::FtmBase.
  static Guid IID_IMarshal = new Guid("00000003-0000-0000-C000-000000000046");
  static Guid IID_IAgileObject = new Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90");
  class Handler : IActivateAudioInterfaceCompletionHandler, ICustomQueryInterface {
    public ManualResetEvent done = new ManualResetEvent(false);
    IntPtr ftm;
    public Handler() {
      IntPtr punk = Marshal.GetIUnknownForObject(this);   // the CCW's IUnknown = the aggregation outer
      CoCreateFreeThreadedMarshaler(punk, out ftm);
      Marshal.Release(punk);
    }
    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { done.Set(); }
    public CustomQueryInterfaceResult GetInterface(ref Guid iid, out IntPtr ppv) {
      ppv = IntPtr.Zero;
      if (iid == IID_IMarshal && ftm != IntPtr.Zero) {
        Guid im = IID_IMarshal;
        return Marshal.QueryInterface(ftm, ref im, out ppv) == 0 ? CustomQueryInterfaceResult.Handled : CustomQueryInterfaceResult.Failed;
      }
      if (iid == IID_IAgileObject) { ppv = Marshal.GetIUnknownForObject(this); return CustomQueryInterfaceResult.Handled; }
      return CustomQueryInterfaceResult.NotHandled;
    }
  }

  static IAudioClient client; static IAudioCaptureClient capture; static IntPtr hEvent;
  const int channels = 2, sampleRate = 48000;

  static bool PumpWait(WaitHandle ev, int ms) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < ms) { if (ev.WaitOne(0)) return true;
      NativeMsg m; while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }
      Thread.Sleep(5); }
    return ev.WaitOne(0);
  }

  static void Open(uint pid) {
    CoInitializeEx(IntPtr.Zero, 0);   // STA — ensure COM is up on this thread before the activation call
    var ap = new ActivationParams { ActivationType = ACTTYPE_PROCESS_LOOPBACK, TargetPid = pid, LoopbackMode = INCLUDE_TREE };
    int apSize = Marshal.SizeOf(typeof(ActivationParams));
    IntPtr apPtr = Marshal.AllocHGlobal(apSize); Marshal.StructureToPtr(ap, apPtr, false);
    IntPtr pv = Marshal.AllocHGlobal(24); for (int i=0;i<24;i++) Marshal.WriteByte(pv,i,0);
    Marshal.WriteInt16(pv, 0, 0x0041);          // VT_BLOB
    Marshal.WriteInt32(pv, 8, apSize);          // BLOB.cbSize
    Marshal.WriteIntPtr(pv, 16, apPtr);         // BLOB.pBlobData (x64)

    { NativeMsg tmp; PeekMessage(out tmp, IntPtr.Zero, 0, 0, 0); }   // force-create this thread's message queue before the activation call
    var h = new Handler();
    IActivateAudioInterfaceAsyncOperation op;
    int hr = ActivateAudioInterfaceAsync(VAD, ref IID_IAudioClient, pv, h, out op);
    if (hr != 0) throw new Exception("ActivateAudioInterfaceAsync hr=0x" + hr.ToString("x"));
    if (!PumpWait(h.done, 5000)) throw new Exception("activation timed out");
    int actHr; object iface; op.GetActivateResult(out actHr, out iface);
    if (actHr != 0) throw new Exception("GetActivateResult hr=0x" + actHr.ToString("x"));
    client = (IAudioClient)iface;

    IntPtr fmt = Marshal.AllocHGlobal(18);
    Marshal.WriteInt16(fmt, 0, 3);              // WAVE_FORMAT_IEEE_FLOAT
    Marshal.WriteInt16(fmt, 2, (short)channels);
    Marshal.WriteInt32(fmt, 4, sampleRate);
    Marshal.WriteInt32(fmt, 8, sampleRate*channels*4);
    Marshal.WriteInt16(fmt, 12, (short)(channels*4));
    Marshal.WriteInt16(fmt, 14, 32);
    Marshal.WriteInt16(fmt, 16, 0);
    int ihr = client.Initialize(SHARED, LOOPBACK | EVENTCALLBACK, 2000000, 0, fmt, IntPtr.Zero);
    if (ihr != 0) throw new Exception("Initialize hr=0x" + ihr.ToString("x"));
    hEvent = CreateEventW(IntPtr.Zero, false, false, null);
    client.SetEventHandle(hEvent);
    object c; client.GetService(ref IID_IAudioCaptureClient, out c); capture = (IAudioCaptureClient)c;
    client.Start();
  }

  // Drain all queued packets into mono + per-channel (left/right) buffers; returns the count written.
  // left/right feed the 'stereo' bars layout; a mono source mirrors L into R (so it isn't half-dark).
  static int Read(float[] mono, float[] left, float[] right) {
    int n = 0; uint avail; capture.GetNextPacketSize(out avail);
    while (avail > 0 && n < mono.Length) {
      IntPtr data; uint frames, flags; long dp, qp; capture.GetBuffer(out data, out frames, out flags, out dp, out qp);
      if (frames > 0) { bool silent = (flags & 0x2) != 0;
        for (uint f = 0; f < frames && n < mono.Length; f++) { float s = 0f, l = 0f, r = 0f;
          if (!silent && data != IntPtr.Zero) {
            for (int ch=0; ch<channels; ch++) { float v = (float)Marshal.PtrToStructure(data + (int)((f*channels+ch)*4), typeof(float)); s += v; if (ch==0) l = v; if (ch==1) r = v; }
            s /= channels; if (channels < 2) r = l; }
          mono[n] = s; left[n] = l; right[n] = r; n++; } }
      capture.ReleaseBuffer(frames); capture.GetNextPacketSize(out avail);
    }
    return n;
  }

  // ---------- analysis (mirrors audio-sidecar.ps1 so app/system/tab look identical) ----------
  const int N = 2048;   // FFT window must stay > the sample hop so windows overlap (no gap impulses fall into); matches audio-sidecar.ps1
  static float[] win = new float[N], re = new float[N], im = new float[N], prevMag = new float[N/2];
  static bool winInit = false; static float peakLvl = 1e-4f, avgFlux = 1e-6f, bandPeak = 1e-4f, bandPeak2 = 1e-4f, levelAvg = 1e-4f;
  const double BAND_DB_RANGE = 55.0;   // how many dB below the running spectrum peak maps to 0 (tune: smaller = fuller bars). Mirror in audio-sidecar.ps1.
  static void InitWin() { for (int i=0;i<N;i++) win[i]=(float)(0.5-0.5*Math.Cos(2*Math.PI*i/(N-1))); winInit=true; }
  static void FFT() {
    int n=N, j=0;
    for (int i=1;i<n;i++){ int bit=n>>1; for(; (j&bit)!=0; bit>>=1) j^=bit; j^=bit; if(i<j){ float tr=re[i];re[i]=re[j];re[j]=tr; float ti=im[i];im[i]=im[j];im[j]=ti; } }
    for (int len=2; len<=n; len<<=1) { double ang=-2*Math.PI/len; float wr=(float)Math.Cos(ang), wi=(float)Math.Sin(ang);
      for (int i=0;i<n;i+=len){ float cr=1,ci=0;
        for (int k=0;k<len/2;k++){ int a=i+k,b=i+k+len/2;
          float xr=re[b]*cr-im[b]*ci, xi=re[b]*ci+im[b]*cr; re[b]=re[a]-xr; im[b]=im[a]-xi; re[a]+=xr; im[a]+=xi;
          float ncr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=ncr; } } }
  }
  static bool Features(float[] mono, int count, float[] bands, float[] lbc) {
    if (count < N) return false; if (!winInit) InitWin();
    int start = count - N; double rms = 0; float pk = 0f;   // pk = peak amplitude (catches short transients RMS averages away)
    for (int i=0;i<N;i++){ float s=mono[start+i]; rms += s*s; float a=(s<0?-s:s); if(a>pk)pk=a; re[i]=s*win[i]; im[i]=0; }
    FFT(); int half=N/2; float[] mag = new float[half];
    double centNum=0, centDen=0, flux=0;
    for (int i=0;i<half;i++){ float m=(float)Math.Sqrt(re[i]*re[i]+im[i]*im[i]); mag[i]=m;
      centNum += (double)i*m; centDen += m; float d=m-prevMag[i]; if(d>0) flux+=d; prevMag[i]=m; }   // BROADBAND positive spectral flux: bass-only missed mid/high transients (metronome woodblock / hi-hat)
    double minLog=Math.Log(1), maxLog=Math.Log(half);
    // bands = per-band magnitude in dB RELATIVE to a running spectrum peak → VOLUME-INDEPENDENT (mirrors how lbc[0] uses peakLvl).
    // Absolute dB (old: (dbv+100)/70 *1.6) pegged loud bands at high volume and collapsed the shape at low volume — that was the leak.
    double frameMax=1e-9; double[] bn=new double[32];
    for (int b=0;b<32;b++){ int lo=(int)Math.Exp(minLog+(maxLog-minLog)*b/32.0); int hi=(int)Math.Exp(minLog+(maxLog-minLog)*(b+1)/32.0);
      if(hi<=lo) hi=lo+1; if(hi>half) hi=half; double sum=0; for(int i=lo;i<hi;i++) sum+=mag[i]; double avg=sum/(hi-lo);
      double magNorm=avg/(N*0.5); bn[b]=magNorm; if(magNorm>frameMax) frameMax=magNorm; }
    bandPeak=Math.Max((float)frameMax, bandPeak*0.999f);   // running spectrum peak: the dB reference tracks volume, so band shape stays put
    for (int b=0;b<32;b++){ double dbRel=20.0*Math.Log10(bn[b]/bandPeak + 1e-9); double nb=(dbRel+BAND_DB_RANGE)/BAND_DB_RANGE;
      bands[b]=(float)Math.Min(1.0, Math.Max(0.0,nb)); }
    double inst=Math.Max(Math.Sqrt(rms/N), pk*0.6); peakLvl=Math.Max((float)inst, peakLvl*0.999f);   // RMS=body, PEAK=transients
    lbc[0]=(float)Math.Min(1.0, inst/Math.Max(peakLvl,1e-4));
    avgFlux=avgFlux*0.93f+(float)flux*0.07f; double fluxOnset=(flux-avgFlux*1.3)/(avgFlux+1e-4);   // broadband flux, 1.3 threshold
    levelAvg=levelAvg*0.9f+(float)inst*0.1f; double lvlOnset=(inst-levelAvg*1.6)/(levelAvg+1e-4);  // ALSO fire on a loudness spike (a click) — redundancy for the rare tick the flux misses
    double onset=Math.Max(fluxOnset, lvlOnset);
    lbc[1]=(float)Math.Max(0, Math.Min(1.0, onset));
    lbc[2]=(float)(centDen>0 ? Math.Min(1.0,(centNum/centDen)/half*2.0) : 0.5);
    return true;
  }

  // Bands-only FFT for one channel (left/right) — no flux/peak/centroid state so it can't disturb Features().
  // Reuses re[]/im[]/win[] scratch (calls are sequential, single-threaded; run AFTER Features consumes them).
  // bandPeak2 is SHARED across the L and R calls each frame, so the louder channel sets the reference and the
  // L/R balance is preserved (a quiet channel reads quieter) while both stay volume-independent. Mirrors audio-sidecar.ps1.
  static void Bands(float[] buf, int count, float[] bands) {
    if (count < N) { for (int b=0;b<32;b++) bands[b]=0; return; }
    if (!winInit) InitWin();
    int start = count - N;
    for (int i=0;i<N;i++){ float s=buf[start+i]; re[i]=s*win[i]; im[i]=0; }
    FFT(); int half=N/2;
    double minLog=Math.Log(1), maxLog=Math.Log(half);
    double frameMax=1e-9; double[] bn=new double[32];
    for (int b=0;b<32;b++){ int lo=(int)Math.Exp(minLog+(maxLog-minLog)*b/32.0); int hi=(int)Math.Exp(minLog+(maxLog-minLog)*(b+1)/32.0);
      if(hi<=lo) hi=lo+1; if(hi>half) hi=half; double sum=0; for(int i=lo;i<hi;i++){ float m=(float)Math.Sqrt(re[i]*re[i]+im[i]*im[i]); sum+=m; }
      double avg=sum/(hi-lo); double magNorm=avg/(N*0.5); bn[b]=magNorm; if(magNorm>frameMax) frameMax=magNorm; }
    bandPeak2=Math.Max((float)frameMax, bandPeak2*0.9995f);   // *0.9995 (vs .999): called twice/frame for L+R, so halve the per-call decay
    for (int b=0;b<32;b++){ double dbRel=20.0*Math.Log10(bn[b]/bandPeak2 + 1e-9); double nb=(dbRel+BAND_DB_RANGE)/BAND_DB_RANGE;
      bands[b]=(float)Math.Min(1.0, Math.Max(0.0, nb)); }
  }

  // 64-point AMPLITUDE ENVELOPE of the last min(count,1024) samples: each point = peak |sample| in its slice
  // (the recognizable DAW waveform; a raw scope line aliases into noise on 21 columns). Mirrors audio-sidecar.ps1.
  static void Wave(float[] mono, int count, float[] wave) {
    int WN=wave.Length;
    if (count < WN) { for(int i=0;i<WN;i++) wave[i]=0; return; }
    int span = Math.Min(count, 1024), start = count - span, half = Math.Max(1, span/WN);
    for (int i=0;i<WN;i++){ int ctr = start + (int)((long)i*(span-1)/(WN-1)); float pk=0;
      for (int j=ctr-half;j<=ctr+half;j++){ if(j>=0 && j<count){ float a=mono[j]<0?-mono[j]:mono[j]; if(a>pk)pk=a; } }
      wave[i]=pk; }
  }

  // ---------- audio-session enumeration (--list and name→PID resolution) ----------
  struct AppSession { public uint pid; public string name; }
  static System.Collections.Generic.List<AppSession> Sessions(bool activeOnly) {
    var list = new System.Collections.Generic.List<AppSession>();
    var seen = new System.Collections.Generic.HashSet<uint>();
    try {
      var enumr = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev; if (enumr.GetDefaultAudioEndpoint(0, 0, out dev) != 0 || dev == null) return list;   // 0=eRender, 0=eConsole
      object mgrO; if (dev.Activate(ref IID_IAudioSessionManager2, 1, IntPtr.Zero, out mgrO) != 0) return list;
      var mgr = (IAudioSessionManager2)mgrO;
      IAudioSessionEnumerator se; if (mgr.GetSessionEnumerator(out se) != 0) return list;
      int count; if (se.GetCount(out count) != 0) return list;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 ctl; if (se.GetSession(i, out ctl) != 0 || ctl == null) continue;
        int state; if (ctl.GetState(out state) != 0) continue;
        if (activeOnly && state != 1) continue;            // 1 = AudioSessionStateActive (currently producing audio)
        uint p; if (ctl.GetProcessId(out p) != 0 || p == 0 || seen.Contains(p)) continue;
        string nm = null; try { nm = System.Diagnostics.Process.GetProcessById((int)p).ProcessName; } catch { }
        if (string.IsNullOrEmpty(nm)) continue;
        seen.Add(p); list.Add(new AppSession { pid = p, name = nm });
      }
    } catch { }
    return list;
  }
  static string JsonEsc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
  static int DoList() {
    var sb = new StringBuilder("["); var sessions = Sessions(true);
    for (int i = 0; i < sessions.Count; i++) { if (i > 0) sb.Append(',');
      sb.Append("{\"pid\":").Append(sessions[i].pid).Append(",\"name\":\"").Append(JsonEsc(sessions[i].name)).Append("\"}"); }
    Console.Out.WriteLine(sb.Append(']').ToString()); Console.Out.Flush(); return 0;
  }
  // resolve a process NAME (case-insensitive, .exe optional) to a PID with an audio session.
  // PREFER a session that's actively playing: apps like Spotify run several processes with multiple sessions
  // (idle/expired children), so grabbing the first match often lands on a SILENT one — the whole "detects the
  // song but the bars stay dead" bug. Fall back to any-state so a paused / not-yet-started app still resolves
  // (we emit silence and the caller re-resolves until it plays).
  static uint ResolvePid(string name) {
    string want = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
    foreach (var s in Sessions(true))  if (string.Equals(s.name, want, StringComparison.OrdinalIgnoreCase)) return s.pid;   // active first
    foreach (var s in Sessions(false)) if (string.Equals(s.name, want, StringComparison.OrdinalIgnoreCase)) return s.pid;   // else any
    return 0;
  }
  static void EmitSilence(System.Diagnostics.Stopwatch sw, StringBuilder sb, CultureInfo ci) {
    sb.Length = 0; sb.Append("{\"bands\":["); for (int i=0;i<32;i++){ if(i>0)sb.Append(','); sb.Append('0'); }
    sb.Append("],\"level\":0,\"beat\":0,\"centroid\":0.5,\"t\":").Append(Math.Round(sw.Elapsed.TotalMilliseconds,1).ToString(ci)).Append('}');
    Console.Out.WriteLine(sb.ToString()); Console.Out.Flush();
  }

  [MTAThread]
  static int Main(string[] args) {
    CoInitializeEx(IntPtr.Zero, 0);   // MTA — needed for both session enumeration and the activation call
    if (args.Length < 1) { Console.Error.WriteLine("usage: app-capture.exe <PID|process-name|--list>"); return 1; }
    if (args[0] == "--list") return DoList();
    var sw = System.Diagnostics.Stopwatch.StartNew(); var sb = new StringBuilder();
    var ci = CultureInfo.InvariantCulture;
    // arg is a numeric PID, or a process name we resolve to a live audio-session PID (survives app restarts /
    // picking an app that isn't playing yet — we emit silence and keep re-resolving until its session appears).
    uint pid;
    if (!uint.TryParse(args[0], out pid)) {
      pid = ResolvePid(args[0]);
      int waited = 0;
      while (pid == 0) { EmitSilence(sw, sb, ci); Thread.Sleep(500); pid = ResolvePid(args[0]);
        if (++waited == 1) Console.Error.WriteLine("app-capture: waiting for an audio session named '" + args[0] + "'"); }
    }
    try { Open(pid); } catch (Exception e) { Console.Error.WriteLine("app-capture: " + e.Message); return 2; }
    var mono = new float[N*4]; var left = new float[N*4]; var right = new float[N*4];
    var bands = new float[32]; var bandsL = new float[32]; var bandsR = new float[32]; var wave = new float[64];
    var lbc = new float[3]; var chunk = new float[8192]; var chunkL = new float[8192]; var chunkR = new float[8192];
    int countF = 0;
    while (true) {
      WaitForSingleObject(hEvent, 100);
      int n = Read(chunk, chunkL, chunkR);
      if (n > 0) { if (countF + n > mono.Length) { int keep = mono.Length - n;
          Array.Copy(mono, countF-keep, mono, 0, keep); Array.Copy(left, countF-keep, left, 0, keep); Array.Copy(right, countF-keep, right, 0, keep); countF = keep; }
        Array.Copy(chunk, 0, mono, countF, n); Array.Copy(chunkL, 0, left, countF, n); Array.Copy(chunkR, 0, right, countF, n); countF += n; }
      else countF = 0;
      sb.Length = 0; sb.Append("{\"bands\":[");
      if (Features(mono, countF, bands, lbc)) { for (int i=0;i<32;i++){ if(i>0)sb.Append(','); sb.Append(Math.Round(bands[i],4).ToString(ci)); }
        sb.Append(']');
        // per-channel bands are best-effort: a failure here must never kill the sidecar (host falls back to mono → symmetric)
        bool haveStereo = false; try { Bands(left, countF, bandsL); Bands(right, countF, bandsR); haveStereo = true; } catch { haveStereo = false; }
        if (haveStereo) {
          sb.Append(",\"bandsL\":["); for (int i=0;i<32;i++){ if(i>0)sb.Append(','); sb.Append(Math.Round(bandsL[i],4).ToString(ci)); }
          sb.Append("],\"bandsR\":["); for (int i=0;i<32;i++){ if(i>0)sb.Append(','); sb.Append(Math.Round(bandsR[i],4).ToString(ci)); } sb.Append(']'); }
        Wave(mono, countF, wave);
        sb.Append(",\"wave\":["); for (int i=0;i<64;i++){ if(i>0)sb.Append(','); sb.Append(Math.Round(wave[i],4).ToString(ci)); } sb.Append(']');
        sb.Append(",\"level\":").Append(Math.Round(lbc[0],4).ToString(ci)).Append(",\"beat\":").Append(Math.Round(lbc[1],4).ToString(ci)).Append(",\"centroid\":").Append(Math.Round(lbc[2],4).ToString(ci)); }
      else { for (int i=0;i<32;i++){ if(i>0)sb.Append(','); sb.Append('0'); } sb.Append("],\"level\":0,\"beat\":0,\"centroid\":0.5"); }
      sb.Append(",\"t\":").Append(Math.Round(sw.Elapsed.TotalMilliseconds,1).ToString(ci)).Append('}');
      Console.Out.WriteLine(sb.ToString()); Console.Out.Flush();
    }
  }
}
