# Music Layer 1b — Real System-Audio Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the music layer react to **real system audio** — a WASAPI loopback capture sidecar feeds live `{bands,level,beat,centroid}` into the existing engine so the daemon drives the visualizer to whatever's actually playing (and dims on silence).

**Architecture:** A **PowerShell sidecar** (`audio-sidecar.ps1`) `Add-Type`s a C# class that captures the default render endpoint via WASAPI **loopback** (in-box .NET Framework — no SDK/NuGet/binary), runs a Hann-windowed FFT, and prints newline-delimited JSON feature frames at ~30 Hz to stdout. A Node manager (`audio-capture.js`) spawns/supervises it (mirroring `nowplaying.js`) and exposes the latest frame. The daemon's `tick()` folds that frame into `state.audio` via the already-built `E.applyAudioFeatures(...)` before `E.composeFrame(...)`, exactly as the page does with the synthetic feed. **System audio is daemon-driven** (per design §3: "whoever captures also renders"); the open page keeps the synthetic feed (real tab audio = Phase 3). No new high-rate cross-process stream.

**Tech Stack:** PowerShell + `Add-Type` C# (WASAPI COM interop + hand-rolled radix-2 FFT), Node `child_process` (spawn/supervise), the existing `th108-engine.js` audio path, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-16-music-layer-design.md` (§4 feature model, §5 engine, §6 capture, §9 perf/safety, §10 testing). This plan = Phase 1b (system source only).

## Global Constraints

- Commits authored as `Beyon <you@example.com>`, **NO Claude / Co-Authored-By trailer.** Use `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`.
- Never commit vendor bundles (`app.*.js`, `chunk-*.js`, `*.js.txt`, OpenRGB zip) — gitignored.
- After editing any HTML, syntax-check the inline `<script>` (the `new Function` check in `_HANDOFF.md` §1). After editing a `.js`, `node --check <file>`.
- American spelling. Commit per logical change.
- Windows host (PowerShell). The sidecar must use the **in-box .NET Framework** only — no NuGet, no external DLLs, no committed binary, no node-gyp. It ships as `.ps1`, like `media-sidecar.ps1`.
- **No device-protocol changes.** This adds zero HID writes and zero flash writes — it only produces a feature object the existing engine consumes. Never batch this with an ACK/handoff change.
- Feature frame contract (must match `E.applyAudioFeatures` exactly): `{ bands: number[32] (0..1), level: number (0..1), beat: number (0..1), centroid: number (0..1), t: number (ms) }`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `th108-daemon/audio-sidecar.ps1` | Create | WASAPI loopback capture + Hann FFT → 32 log bands + RMS level + spectral centroid + spectral-flux beat; prints NDJSON `{bands,level,beat,centroid,t}` to stdout at ~30 Hz. |
| `th108-daemon/audio-capture.js` | Create | Node spawn/supervise of the sidecar (mirrors `nowplaying.js`): parse NDJSON lines, keep the latest frame, anti-stasis watchdog, restart-on-exit, `windowsHide`. Exposes `start/stop/latest/health`. |
| `th108-daemon/audio-capture.test.js` | Create | `node --test` for the PURE helpers (line parsing → frame, staleness → null). |
| `th108-daemon/daemon.js` | Modify | `syncAudioCapture()` lifecycle (run only when an enabled `audio` layer exists AND `!paused`); feed `applyAudioFeatures` in `tick()` before `composeFrame`; start/stop from `rebuildState`/`resume`/`yield`. |
| `th108-layers-ui.js` | Modify | Un-grey the **All system audio** source (daemon-driven real capture is live); keep App/Tab/Mic greyed (Phase 2/3); update the source note to explain daemon-vs-page. |

**Interfaces the whole plan shares:**
- Sidecar stdout: one JSON object per line — `{"bands":[..32..],"level":0.4,"beat":0.1,"centroid":0.6,"t":1718.5}`.
- `audio-capture.js` exports: `parseLine(str) -> frame|null` (pure), `freshOr(frame, ageMs, maxAgeMs) -> frame|null` (pure), and `start({log}) -> { latest(): frame|null, stop(): void, health(): object }`.
- Daemon already has `E.applyAudioFeatures(state, raw, settings, nowMs)` and `state.audio` (from Plan 1a). `state.layers` carries the audio layer with `.settings` (gain/floor/attackMs/decayMs/beatSens).

---

## Task 1: Feasibility spike — minimal loopback sidecar (level only)

The riskiest unknown is whether WASAPI loopback via `Add-Type` works on this machine. Prove capture + a non-zero RMS BEFORE building FFT/features. This task's "test" is **user-run** (no automated WASAPI test is possible).

**Files:**
- Create: `th108-daemon/audio-sidecar.ps1`

- [ ] **Step 1: Write the minimal capture sidecar**

Create `th108-daemon/audio-sidecar.ps1`:
```powershell
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
  [ComImport, Guid(""BCDE0395-E52F-467C-8E3D-C4579291692E"")] class MMDeviceEnumerator { }
  [Guid(""A95664D2-9614-4F35-A746-DE8DB63617E6""), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ep); }
  [Guid(""D666063F-1587-4E43-81F1-B948E807363F""), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int clsctx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid(""1CB9AD4C-DBFA-4C32-B178-C2F568A703B2""), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long hnsBufDur, long hnsPeriod, IntPtr fmt, IntPtr session);
    int GetBufferSize(out uint frames); int GetStreamLatency(out long l); int GetCurrentPadding(out uint p);
    int IsFormatSupported(int sm, IntPtr fmt, IntPtr o); int GetMixFormat(out IntPtr fmt);
    int GetDevicePeriod(out long def, out long min); int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr h);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [Guid(""C8ADBD64-E71E-48A0-A4DE-185C395CD317""), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long devpos, out long qpos);
    int ReleaseBuffer(uint frames); int GetNextPacketSize(out uint frames);
  }

  const int LOOPBACK = 0x00020000, SHARED = 0, EVENTCALLBACK = 0x00040000;
  static Guid IID_IAudioClient = new Guid(""1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"");
  static Guid IID_IAudioCaptureClient = new Guid(""C8ADBD64-E71E-48A0-A4DE-185C395CD317"");

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
            // mix-format is 32-bit IEEE float, interleaved per channel → average to mono
            for (int ch = 0; ch < channels; ch++) {
              float v = Marshal.PtrToStructure<float>(data + (int)((f*channels+ch)*4));
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
```

- [ ] **Step 2: Run the spike to verify capture works (user-run)**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File th108-daemon/audio-sidecar.ps1`
Expected: a stream of `{"level":0.0,"t":...}` lines; **play music and `level` rises (e.g. 0.2–0.9), pause and it returns to ~0.** Ctrl+C to stop.
If it errors on the COM interop, iterate here (this is the spike's purpose) before proceeding. Common fixes: confirm the mix format is 32-bit float (the default on Windows shared mode); if a machine reports a non-float mix format, log `[Cap]::sampleRate`/`channels` and adjust the sample read. Do not move on until `level` tracks audio.

- [ ] **Step 3: Commit**
```bash
git add th108-daemon/audio-sidecar.ps1
git commit --author="Beyon <you@example.com>" -m "feat(audio): WASAPI loopback capture spike (level-only sidecar)"
```

---

## Task 2: Full feature extraction in the sidecar (FFT → bands/level/beat/centroid)

**Files:**
- Modify: `th108-daemon/audio-sidecar.ps1`

- [ ] **Step 1: Add an FFT + feature extractor to the C# block**

In `audio-sidecar.ps1`, add these static members to the `Cap` class (inside the class, after `Read`):
```csharp
  // ---- analysis ----
  const int N = 2048;                 // FFT window
  static float[] win = new float[N];  // Hann window
  static float[] re = new float[N], im = new float[N];
  static float[] prevMag = new float[N/2];   // for spectral-flux onset
  static bool winInit = false;
  static void InitWin() { for (int i=0;i<N;i++) win[i]=(float)(0.5-0.5*Math.Cos(2*Math.PI*i/(N-1))); winInit=true; }

  // iterative radix-2 Cooley-Tukey FFT in place on re[],im[]
  static void FFT() {
    int n=N, j=0;
    for (int i=1;i<n;i++){ int bit=n>>1; for(; (j&bit)!=0; bit>>=1) j^=bit; j^=bit; if(i<j){ var tr=re[i];re[i]=re[j];re[j]=tr; var ti=im[i];im[i]=im[j];im[j]=ti; } }
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

  // Fill bands[32] (0..1, log-spaced), and out[0]=level, out[1]=beat, out[2]=centroid.
  // `mono` holds the latest >=N samples (we use the last N). Returns false if not enough samples yet.
  public static bool Features(float[] mono, int count, float[] bands, float[] outLBC) {
    if (count < N) return false;
    if (!winInit) InitWin();
    int start = count - N;
    double rms = 0;
    for (int i=0;i<N;i++){ float s=mono[start+i]; rms += s*s; re[i]=s*win[i]; im[i]=0; }
    FFT();
    int half=N/2;
    var mag = new float[half];
    double centNum=0, centDen=0, flux=0;
    for (int i=0;i<half;i++){ float m=(float)Math.Sqrt(re[i]*re[i]+im[i]*im[i]); mag[i]=m;
      centNum += (double)i*m; centDen += m;
      float d=m-prevMag[i]; if(d>0) flux+=d; prevMag[i]=m;
    }
    // 32 log-spaced bands across bins [1, half)
    double minLog=Math.Log(1), maxLog=Math.Log(half);
    for (int b=0;b<32;b++){
      int lo=(int)Math.Exp(minLog+(maxLog-minLog)*b/32.0);
      int hi=(int)Math.Exp(minLog+(maxLog-minLog)*(b+1)/32.0);
      if(hi<=lo) hi=lo+1; if(hi>half) hi=half;
      double sum=0; for(int i=lo;i<hi;i++) sum+=mag[i];
      double avg=sum/(hi-lo);
      bands[b]=(float)Math.Min(1.0, Math.Log(1+avg*8)/Math.Log(9));   // log-compress to 0..1
    }
    double level=Math.Sqrt(rms/N);
    outLBC[0]=(float)Math.Min(1.0, level*4.0);
    outLBC[1]=(float)Math.Min(1.0, flux/(half*0.5));                  // onset/beat envelope
    outLBC[2]=(float)(centDen>0 ? Math.Min(1.0,(centNum/centDen)/half*2.0) : 0.5);   // brightness 0..1
    return true;
  }
```

- [ ] **Step 2: Replace the spike's emit loop with the full feature loop**

Replace the `while ($true) { ... }` block at the bottom of `audio-sidecar.ps1` with:
```powershell
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
  } else { $count = 0 }                            # silence → let features go to 0
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
```

- [ ] **Step 2b: Remove the spike's old emit loop**

Ensure ONLY the Step 2 loop remains at the bottom (delete the Task 1 `while` loop that emitted `{"level":...}`).

- [ ] **Step 3: Verify the full feature stream (user-run)**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File th108-daemon/audio-sidecar.ps1`
Expected: lines like `{"bands":[...32...],"level":..,"beat":..,"centroid":..,"t":..}`. With **bass-heavy music**, the low `bands` indices read higher than the high ones; on **a kick/onset**, `beat` spikes; **silence** → all near 0 (centroid ~0.5). Each band in 0..1. Ctrl+C to stop.

- [ ] **Step 4: Commit**
```bash
git add th108-daemon/audio-sidecar.ps1
git commit --author="Beyon <you@example.com>" -m "feat(audio): sidecar FFT — 32 log bands + RMS level + spectral-flux beat + centroid"
```

---

## Task 3: Node capture manager (`audio-capture.js`)

**Files:**
- Create: `th108-daemon/audio-capture.js`
- Test: `th108-daemon/audio-capture.test.js`

**Interfaces:**
- Produces: `parseLine(str) -> frame|null`, `freshOr(frame, nowMs, maxAgeMs) -> frame|null`, `start({log}) -> { latest(), stop(), health() }`.

- [ ] **Step 1: Write the failing test**

Create `th108-daemon/audio-capture.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const AC = require('./audio-capture.js');

test('parseLine accepts a well-formed frame and rejects junk', () => {
  const f = AC.parseLine('{"bands":[' + (('0.5,').repeat(31)) + '0.5],"level":0.4,"beat":0.1,"centroid":0.6,"t":12.3}');
  assert.equal(f.bands.length, 32);
  assert.equal(f.level, 0.4); assert.equal(f.beat, 0.1); assert.equal(f.centroid, 0.6);
  assert.equal(AC.parseLine('not json'), null);
  assert.equal(AC.parseLine('{"level":1}'), null);          // missing/!32 bands → reject
  assert.equal(AC.parseLine('{"bands":[1,2,3]}'), null);
});

test('freshOr returns the frame while fresh and null once stale', () => {
  const f = { bands: new Array(32).fill(0), level: 0, beat: 0, centroid: 0.5, t: 0, _at: 1000 };
  assert.equal(AC.freshOr(f, 1100, 500), f);     // 100ms old < 500ms → fresh
  assert.equal(AC.freshOr(f, 2000, 500), null);  // 1000ms old > 500ms → stale
  assert.equal(AC.freshOr(null, 2000, 500), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd th108-daemon && node --test audio-capture.test.js`
Expected: FAIL — cannot find module `./audio-capture.js`.

- [ ] **Step 3: Implement `audio-capture.js`**

Create `th108-daemon/audio-capture.js`:
```js
// audio-capture.js — spawns + supervises audio-sidecar.ps1 (WASAPI loopback) and exposes the latest
// {bands,level,beat,centroid} frame for the daemon to fold into state.audio. Mirrors nowplaying.js:
// NDJSON line parse, restart-on-exit, anti-stasis watchdog, windowsHide. Carries the leak-fix lesson
// (f78d66b): no unbounded buffers; the carry string is bounded by line breaks.
const { spawn } = require('child_process');
const path = require('path');

// pure: parse one stdout line → a validated frame (or null)
function parseLine(line) {
  if (!line) return null;
  let o; try { o = JSON.parse(line); } catch (_) { return null; }
  if (!o || !Array.isArray(o.bands) || o.bands.length !== 32) return null;
  return { bands: o.bands.map(Number), level: +o.level || 0, beat: +o.beat || 0,
           centroid: o.centroid == null ? 0.5 : +o.centroid, t: +o.t || 0 };
}
// pure: the frame if it's younger than maxAgeMs, else null (so silence/stall → engine decays to 0)
function freshOr(frame, nowMs, maxAgeMs) {
  if (!frame) return null;
  return (nowMs - frame._at) <= maxAgeMs ? frame : null;
}

const SILENT_RESTART_MS = 8000;   // no line for this long while running = the sidecar hung → recycle

function start(opts) {
  const log = opts.log || function () {};
  let proc = null, stopped = false, carry = '';
  let frame = null, lastLineAt = 0, restarts = 0, parseErrs = 0;

  function spawnSidecar() {
    if (stopped) return;
    proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'audio-sidecar.ps1')],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    carry = '';
    proc.stdout.on('data', (d) => {
      carry += d.toString('utf8');
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
        if (!line) continue;
        const f = parseLine(line);
        if (f) { f._at = Date.now(); frame = f; lastLineAt = f._at; } else { parseErrs++; }
      }
      if (carry.length > 65536) carry = '';   // safety: a never-newline stream can't grow unbounded
    });
    proc.on('exit', () => { proc = null; if (!stopped) { restarts++; log('… audio sidecar exited — restarting in 3s'); setTimeout(spawnSidecar, 3000); } });
  }

  const wd = setInterval(() => {
    if (stopped || !proc) return;
    if (lastLineAt && Date.now() - lastLineAt > SILENT_RESTART_MS) {
      log('⚠ audio sidecar silent — recycling'); lastLineAt = 0;
      try { proc.kill(); } catch (_) {}   // exit handler respawns
    }
  }, 2000);

  spawnSidecar();
  return {
    latest() { return frame; },
    stop() { stopped = true; clearInterval(wd); try { if (proc) proc.kill(); } catch (_) {} proc = null; frame = null; },
    health() { return { up: !!proc, restarts, parseErrs, lastLineAgoMs: lastLineAt ? Date.now() - lastLineAt : null }; },
  };
}

module.exports = { parseLine, freshOr, start };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd th108-daemon && node --test audio-capture.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**
```bash
git add th108-daemon/audio-capture.js th108-daemon/audio-capture.test.js
git commit --author="Beyon <you@example.com>" -m "feat(audio): audio-capture.js — spawn/supervise the loopback sidecar, expose latest frame"
```

---

## Task 4: Daemon wiring — lifecycle + feed into `state.audio`

**Files:**
- Modify: `th108-daemon/daemon.js`

**Interfaces:**
- Consumes: `AC.start({log})`, `acHandle.latest()`, `AC.freshOr(frame, now, maxAge)`, `E.applyAudioFeatures(state, raw, settings, nowMs)`.

- [ ] **Step 1: Require the module + handle (top of daemon.js, near the `NP` require ~line 357)**

Add after `const NP = require('./nowplaying.js');`:
```js
const AC = require('./audio-capture.js');
let acHandle = null;
// the audio sidecar is wanted only when an enabled audio layer exists AND we're driving (not yielded)
function audioWanted() { return !paused && !!state && state.layers.some(L => L.enabled && L.type === 'audio'); }
function syncAudioCapture() {
  const want = audioWanted();
  if (want && !acHandle) { acHandle = AC.start({ log }); log('♪ audio capture started (system loopback)'); }
  else if (!want && acHandle) { acHandle.stop(); acHandle = null; log('♪ audio capture stopped'); }
}
```

- [ ] **Step 2: Drive the lifecycle from the existing state transitions**

In `rebuildState()` (the function near line 85 that reloads config → rebuilds `state`), add `syncAudioCapture();` as its last line.
In the control object's `resume()` (line ~419: `resume() { rebuildState(); paused = false; unpausedAt = Date.now(); }`) — change to also sync after unpausing:
```js
  resume() { rebuildState(); paused = false; unpausedAt = Date.now(); syncAudioCapture(); },
```
In the control object's `yield()` (the function that sets `paused = true` ~line 406), add `syncAudioCapture();` after `paused = true;` so capture stops while the page drives.
In `saveConfig(cfg)` (line ~422), after the `applyConfig`/`bri` block, add `syncAudioCapture();` (an edit that enables/disables the audio layer starts/stops capture live).

- [ ] **Step 3: Feed the frame in `tick()` before `composeFrame`**

In `tick()`, immediately BEFORE `const flat = E.composeFrame(state, now);` (line ~209), add:
```js
    if (acHandle) {
      const raw = E.applyAudioFeatures && AC.freshOr(acHandle.latest(), Date.now(), 250);   // >250ms stale → null → engine decays to silence
      const aL = state.layers.find(L => L.enabled && L.type === 'audio');
      if (raw && aL) E.applyAudioFeatures(state, raw, aL.settings, now);
    }
```

- [ ] **Step 4: Stop capture on shutdown**

In `shutdown(code)` (line ~527), add alongside the other `.stop()` cleanups:
```js
  try { if (acHandle) acHandle.stop(); } catch {}
```

- [ ] **Step 5: Verify the daemon still loads + tests stay green**

Run: `node --check th108-daemon/daemon.js`
Run: `cd th108-daemon && node --test`
Expected: daemon parses; all existing daemon tests pass (this task adds no new daemon unit test — the pure logic is covered by `audio-capture.test.js`; behavior is hardware-verified in Task 6).

- [ ] **Step 6: Commit**
```bash
git add th108-daemon/daemon.js
git commit --author="Beyon <you@example.com>" -m "feat(daemon): drive the audio layer from real loopback capture (lifecycle + state.audio feed)"
```

---

## Task 5: UI — un-grey System source + clarify daemon-vs-page

**Files:**
- Modify: `th108-layers-ui.js` (the audio branch's `sources` array + source note, added in Plan 1a)

- [ ] **Step 1: Enable the System source bubble**

In the audio branch, the `sources` array currently marks every entry's availability. Change **System** to available and keep App/Tab/Mic disabled:
```js
        const sources=[['system','All system audio',true],['app','Specific app',false],['tab','This tab',false],['mic','Mic / line-in',false]];
```
(If 1a already set `system` to `true`, leave it.)

- [ ] **Step 2: Update the source note to set expectations**

Replace the Plan-1a "synthetic test signal" note row with:
```js
          row('Source note','<span class="val" style="opacity:.7">Real system audio plays through the background daemon (close/blur this tab). While this tab is connected and driving, it falls back to a test signal — per-tab capture is coming.</span><span></span>')+
```

- [ ] **Step 3: Syntax-check + smoke test**

Run: `node --check th108-layers-ui.js`
Then serve the page (daemon stopped: `node _serve.js`) and confirm the audio card shows **All system audio** selectable and App/Tab/Mic greyed; the note reads as above; no console errors.

- [ ] **Step 4: Commit**
```bash
git add th108-layers-ui.js
git commit --author="Beyon <you@example.com>" -m "feat(ui): enable the System audio source (daemon real capture) + clarify daemon-vs-page note"
```

---

## Task 6: Hardware glance (user-run)

**Files:** none (verification only).

- [ ] **Step 1:** Restart the daemon (tray → Restart Daemon, or the page ↻) so it loads `audio-capture.js` + the wiring.
- [ ] **Step 2:** With an **Audio layer enabled** over a Background layer and the **page closed or blurred** (so the daemon drives), play music. Confirm: the keyboard reacts to the audio — **bars** track the spectrum, **pulse/bloom** hit on beats, **wave** moves with the sound.
- [ ] **Step 3:** Pause the music → the visualizer **decays to silence** (the non-emitting audio layer becomes transparent — board returns to the other layers).
- [ ] **Step 4:** Confirm CPU is reasonable (the FFT runs in the separate PowerShell process; check Task Manager — the `powershell` sidecar should be a few % at most).
- [ ] **Step 5:** Disable the audio layer (or remove it) → confirm `daemon.log` shows `♪ audio capture stopped` (the sidecar isn't running when not needed).
- [ ] **Step 6:** Note any latency/tuning (gain/floor/attack/decay/beatSens on the card adjust the feel live — they apply to the real feed exactly as they did to the synthetic one).

---

## Self-Review

**Spec coverage (design §4–§6, §9, §10; Phase 1b = system source):**
- §4 feature model `{bands(32),level,beat,centroid,t}` → Task 2 emits it; Task 3 validates it; the contract matches `E.applyAudioFeatures` (Plan 1a). ✓
- §5 engine `type:'audio'`, `state.audio`, renderers → already built (Plan 1a); 1b only supplies a real feed. ✓
- §6 "All system audio (Phase 1): native sidecar — WASAPI loopback → Hann FFT (2048) → log bands + RMS + onset → stdout JSON ~60 Hz; daemon spawns/supervises like media-sidecar" → Tasks 1–4. (Runtime decision resolved: PowerShell + in-box .NET via Add-Type, not NAudio/NuGet, to keep zero-build distribution — supersedes the spec §11 "default assumption .NET/NAudio".) Rate is ~30 Hz (33 ms sleep) which matches the 30 fps engine cap; raise to ~60 Hz only if a glance shows it's needed. ✓
- §3 "whoever captures also renders" / "no new high-rate cross-process stream" → system audio is daemon-captured AND daemon-rendered; the page keeps the synthetic feed when it drives (real tab audio = Phase 3). Task 5's note states this so there's no silent gap. ✓
- §9 perf/safety: FFT in the sidecar process (Task 4 step 4 / Task 6 step 4); **no device-handoff change, no flash writes** (this plan adds neither). ✓
- §10 testing: pure helpers unit-tested (Task 3); sidecar feature-shape verified by running it (Tasks 1–2 user-run); hardware glance (Task 6). A known-WAV contract test is skipped (loopback needs live playback — not unit-testable headlessly); called out here, not a silent omission. ✓
- App / Mic (Phase 2) and Tab (Phase 3) → deliberately OUT of scope; Task 5 keeps them greyed. ✓

**Placeholder scan:** every code step contains complete code (full C# interop + FFT, full sidecar loop, full `audio-capture.js`, exact daemon edits with line anchors). No TBD/TODO. The only deliberate iteration point is Task 1's spike (WASAPI interop may need machine-specific tweaks — flagged with what to check). ✓

**Type consistency:** the frame shape `{bands[32],level,beat,centroid,t}` is identical across the sidecar emit (Task 2), `parseLine` (Task 3), and the daemon feed (Task 4); `audioWanted/syncAudioCapture/acHandle` names match across Task 4 steps; `freshOr/latest/start/stop/health` match between `audio-capture.js` and its test and the daemon. ✓

**Note for the implementer:** all commits author as `Beyon <you@example.com>`, NO Claude/Co-Authored-By. The sidecar (Tasks 1–2) can only be verified by running it with audio playing; do that before wiring the daemon. Never batch this with an ACK/handoff change.
