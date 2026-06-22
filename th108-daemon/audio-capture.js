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
  const ch = a => (Array.isArray(a) && a.length === 32) ? a.map(Number) : undefined;   // optional L/R channels for the stereo layout
  const f = { bands: o.bands.map(Number), level: +o.level || 0, beat: +o.beat || 0,
              centroid: o.centroid == null ? 0.5 : +o.centroid, t: +o.t || 0 };
  const bL = ch(o.bandsL), bR = ch(o.bandsR);
  if (bL) f.bandsL = bL; if (bR) f.bandsR = bR;
  if (Array.isArray(o.wave) && o.wave.length) f.wave = o.wave.map(Number);   // time-domain PCM trace for the Waveform style (optional)
  if (o.inAbs != null) f.inAbs = +o.inAbs;                                    // absolute (pre auto-gain) level → the mic noise gate (optional)
  return f;
}
// pure: the frame if it's younger than maxAgeMs, else null (so silence/stall → engine decays to 0)
function freshOr(frame, nowMs, maxAgeMs) {
  if (!frame) return null;
  return (nowMs - frame._at) <= maxAgeMs ? frame : null;
}

const SILENT_RESTART_MS = 8000;   // no line for this long while running = the sidecar hung → recycle
const fs = require('fs');

// Decaying peak-hold: fold each new frame into a held frame that keeps max(new, held*DECAY) per band/
// level/beat. A brief transient (metronome click) lingers ~3-4 frames (~130ms) so EVERY reader catches it —
// regardless of poll rate AND of multiple readers (daemon tick + page poll). NOT reset on read: resetting
// let two readers steal each other's peak, so the slower one (the preview) kept missing ticks.
const HOLD_DECAY = 0.75;   // per sidecar frame (~33ms) → ~130ms hold; long enough for a 60ms poll to never miss
function holdPeak(acc, f, decay) {
  const d = decay == null ? HOLD_DECAY : decay;
  if (!acc) return { bands: f.bands.slice(), bandsL: f.bandsL ? f.bandsL.slice() : undefined, bandsR: f.bandsR ? f.bandsR.slice() : undefined,
                     wave: f.wave ? f.wave.slice() : undefined, level: f.level, beat: f.beat, centroid: f.centroid, inAbs: f.inAbs, t: f.t, _at: f._at, live: f.level };
  for (let i = 0; i < 32; i++) {
    acc.bands[i] = Math.max(f.bands[i], acc.bands[i] * d);
    if (f.bandsL && acc.bandsL) acc.bandsL[i] = Math.max(f.bandsL[i], acc.bandsL[i] * d);
    if (f.bandsR && acc.bandsR) acc.bandsR[i] = Math.max(f.bandsR[i], acc.bandsR[i] * d);
  }
  if (f.bandsL && !acc.bandsL) acc.bandsL = f.bandsL.slice();
  if (f.bandsR && !acc.bandsR) acc.bandsR = f.bandsR.slice();
  acc.level = Math.max(f.level, acc.level * d);
  acc.beat = Math.max(f.beat, acc.beat * d);
  acc.wave = f.wave || acc.wave;   // latest PCM trace (a live signal, not a peak) — carry forward if a frame omits it
  acc.inAbs = f.inAbs != null ? f.inAbs : acc.inAbs;   // latest absolute level (live, not a peak) for the mic gate
  acc.centroid = f.centroid; acc.t = f.t; acc._at = f._at;   // latest (not peak) for position/time
  acc.live = f.level;   // TRUE current level (not the held peak) → pause/silence detection in the engine
  return acc;
}
const APP_EXE = path.join(__dirname, 'app-capture.exe');

// One-shot: list currently-playing audio apps via `app-capture.exe --list` → [{pid,name}] (or [] on any error).
function listApps(cb) {
  if (!fs.existsSync(APP_EXE)) return cb(new Error('app-capture.exe not built (run setup.cmd)'), []);
  let out = ''; let done = false;
  const finish = (err, arr) => { if (done) return; done = true; cb(err, arr || []); };
  let p;
  try { p = spawn(APP_EXE, ['--list'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
  catch (e) { return finish(e, []); }
  p.stdout.on('data', d => { out += d.toString('utf8'); if (out.length > 65536) { try { p.kill(); } catch (_) {} } });
  p.on('error', e => finish(e, []));
  p.on('exit', () => { try { finish(null, JSON.parse(out.trim() || '[]')); } catch (e) { finish(e, []); } });
  setTimeout(() => { try { p.kill(); } catch (_) {} finish(new Error('list timed out'), []); }, 4000);
}

// opts.app = a process NAME → capture that app via app-capture.exe; falsy → system loopback via the ps1 sidecar.
function start(opts) {
  const log = (opts && opts.log) || function () {};
  const app = opts && opts.app;
  const mic = !!(opts && opts.mic);   // capture the default mic/line-in endpoint (audio-sidecar.ps1 -Mic) instead of system loopback
  let proc = null, stopped = false, carry = '';
  let frame = null, peakAcc = null, lastLineAt = 0, restarts = 0, parseErrs = 0;

  function spawnSidecar() {
    if (stopped) return;
    if (app) {
      if (!fs.existsSync(APP_EXE)) { log('✗ per-app capture: app-capture.exe not built — run setup.cmd (falling back to no audio)'); return; }
      proc = spawn(APP_EXE, [app], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } else {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'audio-sidecar.ps1')];
      if (mic) args.push('-Mic');   // default capture endpoint (mic / line-in) rather than render loopback
      proc = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    }
    proc.on('error', e => { log('✗ audio capture spawn failed: ' + e.message); });
    carry = '';
    proc.stdout.on('data', (d) => {
      carry += d.toString('utf8');
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
        if (!line) continue;
        const f = parseLine(line);
        if (f) { f._at = Date.now(); frame = f; peakAcc = holdPeak(peakAcc, f); lastLineAt = f._at; } else { parseErrs++; }
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
    latest() { return peakAcc || frame; },   // decaying peak-hold (NOT reset) → every reader, however slow or many, catches a transient
    stop() { stopped = true; clearInterval(wd); try { if (proc) proc.kill(); } catch (_) {} proc = null; frame = null; peakAcc = null; },
    health() { return { up: !!proc, restarts, parseErrs, lastLineAgoMs: lastLineAt ? Date.now() - lastLineAt : null }; },
  };
}

module.exports = { parseLine, freshOr, start, listApps, holdPeak };
