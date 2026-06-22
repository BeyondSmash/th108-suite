// th108-audio-webcapture.js — IN-TAB real audio for the music layer (Phase 3, brought forward so the
// tuner sliders react to actual sound). Captures audio via Web Audio: 'tab' = getDisplayMedia (share a
// tab/screen WITH audio), 'mic' = getUserMedia, runs an AnalyserNode, and produces the SAME feature
// contract the sidecar emits: {bands[32],level,beat,centroid,t}. Page-driven only (the page owns the
// device); system-wide ambient audio is the daemon's job. No device writes — pure analysis.
(function (root) {
  'use strict';
  const NB = 32;
  function createWebCapture(log) {
    log = log || function () {};
    let ctx = null, analyser = null, stream = null, srcNode = null, active = false, kind = null;
    let freq = null, time = null, prevMag = null, peakLvl = 1e-4, avgFlux = 1e-6;
    let splitter = null, analyserL = null, analyserR = null, freqL = null, freqR = null, stereo = false;   // L/R split for the 'stereo' bars layout

    // log-spaced 32-band map shared by mono + L + R (byte data is already perceptual → light linear boost)
    function bandsFrom(f){
      const bins = f.length, out = new Array(NB), minLog = Math.log(1), maxLog = Math.log(bins);
      for (let b = 0; b < NB; b++) {
        let lo = Math.floor(Math.exp(minLog + (maxLog - minLog) * b / NB));
        let hi = Math.floor(Math.exp(minLog + (maxLog - minLog) * (b + 1) / NB));
        if (hi <= lo) hi = lo + 1; if (hi > bins) hi = bins;
        let sum = 0; for (let i = lo; i < hi; i++) sum += f[i] / 255;
        out[b] = Math.min(1, (sum / (hi - lo)) * 1.6);
      }
      return out;
    }

    async function start(sourceKind) {
      await stop();
      try {
        if (sourceKind === 'mic') stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        else stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });   // Chrome needs video requested; we use only the audio track
      } catch (e) { log('audio capture cancelled / denied: ' + (e && e.message || e), 'dim'); return false; }
      const at = stream.getAudioTracks();
      if (!at.length) { await stop(); log('no audio track — when sharing, tick "Share tab audio" / "Share system audio"', 'err'); return false; }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      srcNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.3;   // window must overlap the feed hop so impulses aren't missed; low smoothing keeps transients snappy. Peak-level (below) catches click loudness.
      srcNode.connect(analyser);   // analyser is a sink — do NOT connect to ctx.destination (would echo the audio)
      const bins = analyser.frequencyBinCount;
      freq = new Uint8Array(bins); time = new Float32Array(analyser.fftSize); prevMag = new Float32Array(bins);
      // stereo split for the 'stereo' bars layout: a ChannelSplitter feeds one analyser per channel. A mono
      // source (channelCount 1, e.g. most mics) skips this — applyAudioFeatures then mirrors mono into both.
      const chCount = (at[0].getSettings && at[0].getSettings().channelCount) || srcNode.channelCount || 2;
      stereo = chCount >= 2;
      if (stereo) {
        splitter = ctx.createChannelSplitter(2);
        analyserL = ctx.createAnalyser(); analyserR = ctx.createAnalyser();
        analyserL.fftSize = analyserR.fftSize = 2048;
        analyserL.smoothingTimeConstant = analyserR.smoothingTimeConstant = 0.3;
        srcNode.connect(splitter);
        splitter.connect(analyserL, 0); splitter.connect(analyserR, 1);
        freqL = new Uint8Array(analyserL.frequencyBinCount); freqR = new Uint8Array(analyserR.frequencyBinCount);
      }
      peakLvl = 1e-4; avgFlux = 1e-6; active = true; kind = sourceKind;
      at[0].addEventListener('ended', () => { stop(); });   // user clicked "Stop sharing"
      log('in-tab audio capture started (' + sourceKind + ')', 'ok');
      return true;
    }

    // Produce one feature frame from the live analyser (same shape/curves as audio-sidecar.ps1).
    function sample() {
      if (!active || !analyser) return null;
      analyser.getByteFrequencyData(freq);          // 0..255, already dB-scaled by the AnalyserNode
      analyser.getFloatTimeDomainData(time);        // -1..1 PCM, for RMS loudness
      const bins = freq.length;
      // RMS gives body; PEAK catches short transients (a metronome click / hat is ~10-30ms — RMS over the
      // ~46ms window averages it away, so identical ticks read as different loudness and some don't light up).
      let rms = 0, pk = 0; for (let i = 0; i < time.length; i++) { const s = time[i]; rms += s * s; const a = s < 0 ? -s : s; if (a > pk) pk = a; }
      rms = Math.sqrt(rms / time.length);
      const inst = Math.max(rms, pk * 0.6);         // blend: transients ride the peak, sustained tone the RMS
      peakLvl = Math.max(inst, peakLvl * 0.999);    // auto-gain: normalize to the loudest recent
      const level = Math.min(1, inst / Math.max(peakLvl, 1e-4));
      const bands = new Array(NB);
      let centNum = 0, centDen = 0, flux = 0;
      // BROADBAND spectral flux (all bins, positive change). Bass-only flux misses mid/high transients — a
      // metronome woodblock or hi-hat has almost no sub-3kHz energy, so a bass-only detector never fired on it
      // ("not detecting every tick"). Full-spectrum flux catches clicks AND kicks; avgFlux makes it relative
      // (volume-independent), so it still gates steady noise.
      for (let i = 0; i < bins; i++) { const m = freq[i] / 255; centNum += i * m; centDen += m;
        const d = m - prevMag[i]; if (d > 0) flux += d; prevMag[i] = m; }
      const monoBands = bandsFrom(freq);
      for (let b = 0; b < NB; b++) bands[b] = monoBands[b];
      let bandsL = null, bandsR = null;
      if (stereo && analyserL && analyserR) {
        analyserL.getByteFrequencyData(freqL); analyserR.getByteFrequencyData(freqR);
        bandsL = bandsFrom(freqL); bandsR = bandsFrom(freqR);
      }
      avgFlux = avgFlux * 0.93 + flux * 0.07;
      const onset = (flux - avgFlux * 1.3) / (avgFlux + 1e-4);   // 1.3 (was 1.4): a touch more sensitive so quieter onsets still register
      const beat = Math.max(0, Math.min(1, onset));
      const centroid = centDen > 0 ? Math.min(1, (centNum / centDen) / bins * 2) : 0.5;
      // Downsample the time-domain PCM to a 64-point oscilloscope trace (last ~1024 samples ≈ 23ms) for the
      // Waveform style. `time` is -1..1 float PCM (getFloatTimeDomainData, captured above).
      const WN = 64, span = Math.min(time.length, 1024), start = time.length - span, wave = new Array(WN);
      for (let i = 0; i < WN; i++) wave[i] = time[start + ((i * (span - 1) / (WN - 1)) | 0)];
      return { bands, bandsL, bandsR, level, beat, centroid, wave, t: ctx ? ctx.currentTime * 1000 : 0 };
    }

    async function stop() {
      active = false; kind = null; stereo = false;
      try { if (srcNode) srcNode.disconnect(); } catch (_) {}
      try { if (splitter) splitter.disconnect(); } catch (_) {}
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
      ctx = analyser = stream = srcNode = splitter = analyserL = analyserR = null;
      freqL = freqR = null;
    }

    // human label for the current capture — for a shared tab this is the tab/window TITLE (what's playing); for mic, the device name
    function label(){ if(!stream) return null;
      const vt=(stream.getVideoTracks&&stream.getVideoTracks()[0]), at=(stream.getAudioTracks&&stream.getAudioTracks()[0]);
      return (vt&&vt.label)||(at&&at.label)||(kind==='mic'?'microphone':'shared tab'); }
    return { start, stop, sample, active: () => active, kind: () => kind, label };
  }
  const api = { createWebCapture };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TH108WebCapture = api;
})(typeof window !== 'undefined' ? window : globalThis);
