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

  // ---- analysis ----
  const int N = 2048;                 // FFT window
  static float[] win = new float[N];  // Hann window
  static float[] re = new float[N], im = new float[N];
  static float[] prevMag = new float[N/2];   // for spectral-flux onset
  static float peakLvl = 1e-4f;              // slow-decaying loudness peak → auto-gain (volume-independent level)
  static float avgFlux = 1e-6f;              // moving average of bass flux → onset/beat threshold
  static bool winInit = false;
  static void InitWin() { for (int i=0;i<N;i++) win[i]=(float)(0.5-0.5*Math.Cos(2*Math.PI*i/(N-1))); winInit=true; }

  // iterative radix-2 Cooley-Tukey FFT in place on re[],im[]
  static void FFT() {
    int n=N, j=0;
    for (int i=1;i<n;i++){ int bit=n>>1; for(; (j&bit)!=0; bit>>=1) j^=bit; j^=bit; if(i<j){ float tr=re[i];re[i]=re[j];re[j]=tr; float ti=im[i];im[i]=im[j];im[j]=ti; } }
    for (int len=2; len<=n; len<<=1) {
      double ang=-2*Math.PI/len; float wr=(float)Math.Cos(ang), wi=(float)Math.Sin(ang);
      for (int i=0;i<n;i+=len){ float cr=1,ci=0;
        for (int k=0;k<len/2;k++){ int a=i+k,b=i+k+len/2;
          float xr=re[b]*cr-im[b]*ci, xi=re[b]*ci+im[b]*cr;
          re[b]=re[a]-xr; im[b]=im[a]-xi; re[a]+=xr; im[a]+=xi;
          float ncr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=ncr;
        }
      }
    }
  }

  // Fill bands[32] (0..1, log-spaced), and outLBC[0]=level, outLBC[1]=beat, outLBC[2]=centroid.
  // mono holds the latest samples; we analyze the last N. Returns false if not enough samples yet.
  public static bool Features(float[] mono, int count, float[] bands, float[] outLBC) {
    if (count < N) return false;
    if (!winInit) InitWin();
    int start = count - N;
    double rms = 0;
    for (int i=0;i<N;i++){ float s=mono[start+i]; rms += s*s; re[i]=s*win[i]; im[i]=0; }
    FFT();
    int half=N/2;
    float[] mag = new float[half];
    double centNum=0, centDen=0, bassFlux=0; int bassBins=Math.Max(4, half/8);   // kicks live in the low bins
    for (int i=0;i<half;i++){ float m=(float)Math.Sqrt(re[i]*re[i]+im[i]*im[i]); mag[i]=m;
      centNum += (double)i*m; centDen += m;
      float d=m-prevMag[i]; if(d>0 && i<bassBins) bassFlux+=d; prevMag[i]=m;   // positive bass flux = onset energy
    }
    double minLog=Math.Log(1), maxLog=Math.Log(half);
    for (int b=0;b<32;b++){
      int lo=(int)Math.Exp(minLog+(maxLog-minLog)*b/32.0);
      int hi=(int)Math.Exp(minLog+(maxLog-minLog)*(b+1)/32.0);
      if(hi<=lo) hi=lo+1; if(hi>half) hi=half;
      double sum=0; for(int i=lo;i<hi;i++) sum+=mag[i];
      double avg=sum/(hi-lo);
      bands[b]=(float)Math.Min(1.0, Math.Log(1+avg*8)/Math.Log(9));   // log-compress to 0..1
    }
    double rawLvl=Math.Sqrt(rms/N);
    peakLvl = Math.Max((float)rawLvl, peakLvl*0.999f);               // auto-gain: track the loudest recent level (slow decay)
    outLBC[0]=(float)Math.Min(1.0, rawLvl/Math.Max(peakLvl,1e-4));   // level normalized to that peak → full 0..1 at any volume
    avgFlux = avgFlux*0.93f + (float)bassFlux*0.07f;                 // moving average of bass flux
    double onset=(bassFlux - avgFlux*1.4)/(avgFlux + 1e-4);          // spikes when a kick exceeds ~1.4x the running average
    outLBC[1]=(float)Math.Max(0, Math.Min(1.0, onset));             // beat 0..1 (sharp on kicks, ~0 between)
    outLBC[2]=(float)(centDen>0 ? Math.Min(1.0,(centNum/centDen)/half*2.0) : 0.5);   // brightness 0..1
    return true;
  }
}
"@

[Cap]::Open()
$N = 2048
$mono  = New-Object 'float[]' ($N * 4)   # rolling buffer
$bands = New-Object 'float[]' 32
$lbc   = New-Object 'float[]' 3
$chunk = New-Object 'float[]' 8192
$count = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $n = [Cap]::Read($chunk)
  if ($n -gt 0) {
    if ($count + $n -gt $mono.Length) {            # keep only the last (mono.Length) samples
      $keep = $mono.Length - $n
      [Array]::Copy($mono, $count - $keep, $mono, 0, $keep); $count = $keep
    }
    [Array]::Copy($chunk, 0, $mono, $count, $n); $count += $n
  } else { $count = 0 }                            # silence -> let features go to 0
  if ([Cap]::Features($mono, $count, $bands, $lbc)) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('{"bands":[')
    for ($i=0; $i -lt 32; $i++){ if($i){[void]$sb.Append(',')}; [void]$sb.Append([Math]::Round($bands[$i],4)) }
    [void]$sb.Append('],"level":'); [void]$sb.Append([Math]::Round($lbc[0],4))
    [void]$sb.Append(',"beat":');   [void]$sb.Append([Math]::Round($lbc[1],4))
    [void]$sb.Append(',"centroid":'); [void]$sb.Append([Math]::Round($lbc[2],4))
    [void]$sb.Append(',"t":'); [void]$sb.Append([Math]::Round($sw.Elapsed.TotalMilliseconds,1)); [void]$sb.Append('}')
    [Console]::Out.WriteLine($sb.ToString()); [Console]::Out.Flush()
  } else {
    [Console]::Out.WriteLine('{"bands":[' + (("0,"*31)+"0") + '],"level":0,"beat":0,"centroid":0.5,"t":' + [Math]::Round($sw.Elapsed.TotalMilliseconds,1) + '}')
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 33
}
