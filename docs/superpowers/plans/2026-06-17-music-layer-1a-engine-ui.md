# Music Layer 1a — Visual Engine + UI (synthetic-audio driven) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `type:'audio'` compositor layer with four visualizer styles (bars/pulse/bloom/wave), a live tuner, and a source-selector UI — driven by a *synthetic* audio feed so the entire visual experience works on real keys with zero native code.

**Architecture:** The shared `th108-engine.js` gains a `state.audio` feature buffer (`{bands,level,beat,centroid}`), pure feature-smoothing + four pure renderers that write to `L.rgb` over the existing `INDICES`/`GRID` board map, dispatched from `renderLayer`. A new `th108-audio-synth.js` produces deterministic synthetic features (the brainstorm mockup math). The controller page feeds the synth into `state.audio` each frame, and `th108-layers-ui.js` gets an audio-layer card. Real capture (system audio) is deliberately deferred to Plan 1b — this plan stands alone against synthetic audio.

**Tech Stack:** Vanilla JS (no build step), UMD/IIFE modules, `node --test` for unit tests, the existing engine/compositor and layer-card patterns.

**Spec:** `docs/superpowers/specs/2026-06-16-music-layer-design.md` (§3–§5, §7; this plan = Phase 1, JS half).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `th108-engine.js` | Modify | `state.audio` init, `ensureSettings('audio')`, `audioEnvelope`, `applyAudioFeatures`, `renderAudio` + 4 style renderers, `renderLayer` dispatch, exports |
| `th108-engine.test.js` | Modify | Unit tests for the smoothing helper, feature application, and each renderer |
| `th108-audio-synth.js` | Create | Deterministic synthetic audio-feature generator (UMD), shared by page + tests |
| `th108-audio-synth.test.js` | Create | Unit tests for the synth generator |
| `th108-layers-ui.js` | Modify | `'audio'` in `TYPES`; audio branch in `buildLayerBody` (source bubbles, style selector, tuner, colors, log-values) |
| `th108-controller.html` | Modify | Load `th108-audio-synth.js`; feed the synth into `state.audio` each render tick when an audio layer is enabled |

**Feature model (the contract every task shares):**
```js
// state.audio — updated each frame by the driver, read by the renderers
{ bands: Float32Array(32),  // log-spaced magnitudes 0..1, bands[0]=bass … bands[31]=treble
  level: 0,                 // overall RMS loudness 0..1 (smoothed)
  beat:  0,                 // onset envelope 0..1 (sharp attack, decay)
  centroid: 0.5 }           // spectral "brightness" 0..1 → hue proxy
```
Board geometry the renderers use (already in `th108-engine.js`): `INDICES[k]` = LED index for the k-th key; `GRID[idx] = [col,row]` with `GW=21` columns (0..20), `GH=6` rows (0..5, row 0 = top); helpers `hsv2rgb(h,s,v)`, `hexToRgb('#rrggbb')`, `patHash(i)`.

---

## Task 1: Engine — `state.audio` buffer + audio layer settings defaults

**Files:**
- Modify: `th108-engine.js` (the `createState` return ~line 486–492; `ensureSettings` ~line 446–461; module exports ~line 545)
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**

Add to `th108-engine.test.js`:
```js
test('createState seeds an empty state.audio feature buffer', () => {
  const st = E.createState([{ name:'A', type:'audio', enabled:true, opacity:1, blend:'add', settings:{} }]);
  assert.equal(st.audio.bands.length, 32);
  assert.equal(st.audio.level, 0);
  assert.equal(st.audio.beat, 0);
  assert.equal(st.audio.centroid, 0.5);
});

test('ensureSettings fills audio-layer defaults (bars default, source system)', () => {
  const L = { type:'audio', settings:{} };
  E.ensureSettings(L);
  assert.equal(L.settings.style, 'bars');
  assert.equal(L.settings.source, 'system');
  assert.equal(L.settings.gain, 1);
  assert.equal(L.settings.floor, 5);          // % noise gate
  assert.equal(L.settings.attackMs, 40);
  assert.equal(L.settings.decayMs, 220);
  assert.equal(L.settings.beatSens, 50);      // %
  assert.equal(L.settings.barColorBass, '#ff2200');
  assert.equal(L.settings.barColorTreble, '#22aaff');
});
```
(If `E.ensureSettings` is not exported yet, this test also forces Step 3's export.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `st.audio` is undefined / `E.ensureSettings is not a function`.

- [ ] **Step 3: Add the state buffer, defaults, and exports**

In `th108-engine.js` `createState`, add an `audio` field to the returned state object (alongside `react`):
```js
      react: { fg:new Float32Array(256), t:new Float64Array(256).fill(-1e12),
               down:new Uint8Array(256), up:new Float64Array(256).fill(-1e12) },
      audio: { bands:new Float32Array(32), level:0, beat:0, centroid:0.5, _t:0 },
      lastFlat:null, lastSent:0,
```

In `ensureSettings`, add an `audio` branch (after the `individual` branch, before the common-adjust backfill):
```js
    else if(L.type==='audio'){
      const ad={ style:'bars', source:'system', appId:'', deviceId:'',
        gain:1, floor:5, attackMs:40, decayMs:220, beatSens:50,
        barColorBass:'#ff2200', barColorTreble:'#22aaff',
        pulseColor:'#19b6ff', bloomColor:'#ff5a00', waveColor:'#00e0ff' };
      Object.keys(ad).forEach(k=>{ if(s[k]===undefined)s[k]=ad[k]; });
    }
```

In the module `exports` object (~line 545), add `ensureSettings` and `createState` if not already present, plus the new functions added in later tasks:
```js
    createState, ensureSettings, applyConfig, applyAudioFeatures, audioEnvelope, renderAudio,
```
(Keep the existing exported names; just append the missing ones.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS (the two new tests; existing tests still green).

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): state.audio buffer + audio-layer setting defaults"
```

---

## Task 2: Engine — `audioEnvelope` attack/decay smoothing helper

**Files:**
- Modify: `th108-engine.js` (add helper near the other pure helpers, ~after `patHash`)
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('audioEnvelope rises fast on attack, falls slow on decay', () => {
  // target above prev → use attack; below → use decay. dt=16ms.
  const up = E.audioEnvelope(0, 1, 16, 40, 220);     // attacking toward 1
  const down = E.audioEnvelope(1, 0, 16, 40, 220);   // decaying toward 0
  assert.ok(up > 0 && up < 1, 'partial rise');
  assert.ok(down > 0 && down < 1, 'partial fall');
  assert.ok(up > 1 - down, 'attack (40ms) moves more per frame than decay (220ms)');
  // a zero time-constant snaps instantly
  assert.equal(E.audioEnvelope(0.2, 0.9, 16, 0, 0), 0.9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `E.audioEnvelope is not a function`.

- [ ] **Step 3: Implement the helper**

Add to `th108-engine.js` (and it is exported via Task 1's export edit):
```js
  // one-pole smoothing toward `target`; rising uses attackMs, falling uses decayMs. dt in ms.
  // tau=0 snaps. alpha = 1 - exp(-dt/tau) is the standard exponential-smoothing coefficient.
  function audioEnvelope(prev, target, dtMs, attackMs, decayMs){
    const tau = target >= prev ? attackMs : decayMs;
    if(tau <= 0) return target;
    const a = 1 - Math.exp(-dtMs / tau);
    return prev + (target - prev) * a;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): audioEnvelope attack/decay smoothing helper"
```

---

## Task 3: Engine — `applyAudioFeatures` (gain, noise floor, smoothing into state.audio)

**Files:**
- Modify: `th108-engine.js`
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('applyAudioFeatures gates below floor, applies gain, and smooths into state.audio', () => {
  const st = E.createState([{ name:'A', type:'audio', enabled:true, opacity:1, blend:'add', settings:{} }]);
  const s = st.layers[0].settings;            // ensureSettings already ran in createState
  const raw = { bands:new Float32Array(32).fill(0.5), level:0.5, beat:1, centroid:0.7 };
  // first call: dt defaults from state.audio._t=0 → treat as one frame
  E.applyAudioFeatures(st, raw, s, 16);
  assert.ok(st.audio.level > 0, 'level moved toward target');
  assert.ok(st.audio.bands[0] > 0, 'bands moved toward target');
  // a below-floor band is gated to 0 (floor=5% → 0.05)
  const quiet = { bands:new Float32Array(32).fill(0.02), level:0.02, beat:0, centroid:0.5 };
  for(let i=0;i<60;i++) E.applyAudioFeatures(st, quiet, s, 16);   // let it decay
  assert.ok(st.audio.level < 0.05, 'quiet level decays below floor');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `E.applyAudioFeatures is not a function`.

- [ ] **Step 3: Implement**

Add to `th108-engine.js`:
```js
  // Fold a raw feature frame into state.audio with gain, a noise-floor gate, and attack/decay
  // smoothing. `now` is ms; dt is derived from state.audio._t. s = the audio layer's settings.
  function applyAudioFeatures(state, raw, s, now){
    const A = state.audio;
    let dt = A._t ? Math.max(1, Math.min(100, now - A._t)) : 16;   // clamp dt (tab-throttle/sleep safe)
    A._t = now;
    const gain = s.gain || 1, floor = (s.floor||0)/100;
    const gate = (v)=>{ v = Math.max(0, Math.min(1, v*gain)); return v < floor ? 0 : v; };
    const tgtLevel = gate(raw.level||0);
    A.level = audioEnvelope(A.level, tgtLevel, dt, s.attackMs, s.decayMs);
    A.centroid = audioEnvelope(A.centroid, (raw.centroid==null?0.5:raw.centroid), dt, s.attackMs, s.decayMs);
    // beat: instantaneous rise, decay only (so a kick pops then fades); beatSens scales sensitivity
    const beatTgt = Math.max(0, Math.min(1, (raw.beat||0) * (0.5 + (s.beatSens||50)/100)));
    A.beat = Math.max(beatTgt, audioEnvelope(A.beat, 0, dt, 0, Math.max(60, s.decayMs)));
    const rb = raw.bands;
    for(let i=0;i<32;i++){ const t = rb ? gate(rb[i]||0) : 0; A.bands[i] = audioEnvelope(A.bands[i], t, dt, s.attackMs, s.decayMs); }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): applyAudioFeatures — gain/floor/smoothing into state.audio"
```

---

## Task 4: Synth — `th108-audio-synth.js` deterministic feature generator

**Files:**
- Create: `th108-audio-synth.js`
- Test: `th108-audio-synth.test.js`

- [ ] **Step 1: Write the failing test**

Create `th108-audio-synth.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const Synth = require('./th108-audio-synth.js');

test('sample returns a well-formed, bounded feature frame', () => {
  const syn = Synth.createSynth();
  const f = syn.sample(1.5);
  assert.equal(f.bands.length, 32);
  for(const b of f.bands) assert.ok(b >= 0 && b <= 1, 'band in 0..1');
  assert.ok(f.level >= 0 && f.level <= 1);
  assert.ok(f.beat >= 0 && f.beat <= 1);
  assert.ok(f.centroid >= 0 && f.centroid <= 1);
});

test('sample is deterministic for a given time and bass-weighted', () => {
  const syn = Synth.createSynth();
  const a = syn.sample(2.0), b = syn.sample(2.0);
  assert.deepEqual(Array.from(a.bands), Array.from(b.bands));
  let bass=0, treble=0; for(let i=0;i<8;i++) bass+=a.bands[i]; for(let i=24;i<32;i++) treble+=a.bands[i];
  assert.ok(bass >= treble, 'synth is bass-weighted like real music');
});

test('beat peaks periodically (a kick every ~0.5s)', () => {
  const syn = Synth.createSynth();
  const onBeat = syn.sample(0.0).beat;     // phase 0 = kick attack
  const offBeat = syn.sample(0.25).beat;   // mid-period
  assert.ok(onBeat > offBeat, 'beat envelope is higher right on the kick');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-audio-synth.test.js`
Expected: FAIL — cannot find module `./th108-audio-synth.js`.

- [ ] **Step 3: Implement the synth (UMD)**

Create `th108-audio-synth.js`:
```js
// th108-audio-synth.js — deterministic synthetic audio features for the music layer.
// Stand-in for the real capture sidecar (Plan 1b): same {bands,level,beat,centroid} contract,
// so the visualizer can be built + tuned + hardware-glanced with zero native code. Pure: sample(t)
// depends only on t, so renders are reproducible and unit-testable.
(function(root){
  'use strict';
  const NB = 32, BEAT_PERIOD = 0.5;   // ~120 bpm kick
  function createSynth(){
    return {
      sample(t){
        const bands = new Float32Array(NB);
        for(let i=0;i<NB;i++){
          const f = i/(NB-1);                                   // 0 bass … 1 treble
          const slow = 0.5 + 0.5*Math.sin(t*1.3 - i*0.5);
          const fast = 0.5 + 0.5*Math.sin(t*5.0 + i*1.7);
          let m = (1-f)*0.9*slow + 0.35*fast*(0.3+0.7*f);        // bass louder
          bands[i] = Math.max(0, Math.min(1, m));
        }
        const ph = (t % BEAT_PERIOD)/BEAT_PERIOD;
        const beat = Math.exp(-ph*7);                            // sharp attack, decay
        let level=0; for(let i=0;i<NB;i++) level+=bands[i]; level/=NB;
        const centroid = 0.5 + 0.5*Math.sin(t*0.4);
        return { bands, level, beat, centroid };
      },
    };
  }
  const api = { createSynth };
  if(typeof module!=='undefined' && module.exports) module.exports = api;
  else root.TH108AudioSynth = api;
})(typeof window!=='undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-audio-synth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add th108-audio-synth.js th108-audio-synth.test.js
git commit --author="Beyon <you@example.com>" -m "feat: th108-audio-synth.js — deterministic synthetic audio features"
```

---

## Task 5: Engine — `renderBars` (default style) + `renderAudio` dispatch + `renderLayer` wiring

**Files:**
- Modify: `th108-engine.js` (add `renderAudio` near the other renderers; add a branch in `renderLayer` ~line 394–403)
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('renderBars lights bass columns bottom-up from state.audio.bands', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{}, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L);
  const st = E.createState([L]);
  const La = st.layers[0];
  st.audio.bands.fill(0); st.audio.bands[0] = 1;  // full bass
  E.renderAudio(La, 0, st);
  // some key in the left/bottom region must be lit (bass column 0, bottom row)
  let lit = 0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit++;
  assert.ok(lit > 0, 'bars lit at least one bass key');
  // silence → nothing lit
  st.audio.bands.fill(0); La.rgb.fill(0); E.renderAudio(La, 0, st);
  let lit2 = 0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit2++;
  assert.equal(lit2, 0, 'silence paints black');
});

test('renderLayer dispatches type audio to renderAudio', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{}, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L);
  const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(1);
  E.renderLayer(La, 0, st);   // must not throw and must light keys
  let lit=0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit++;
  assert.ok(lit > 0);
});
```
(Requires `E.NLED` exported — add it to the exports object if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `E.renderAudio is not a function` (and/or `E.NLED` undefined).

- [ ] **Step 3: Implement renderBars + renderAudio + dispatch**

Add to `th108-engine.js` near the other renderers:
```js
  function renderAudio(L, now, state){
    const s = L.settings, out = L.rgb, A = state.audio;
    out.fill(0);
    const style = s.style || 'bars';
    if(style==='bars') renderBars(s, out, A);
    else if(style==='pulse') renderPulse(s, out, A, now);
    else if(style==='bloom') renderBloom(s, out, A);
    else if(style==='wave') renderWave(s, out, A, now);
    else renderBars(s, out, A);
  }
  // Bars: column (GRID col 0..GW-1) → frequency band; key lights bottom-up by that band's magnitude.
  function renderBars(s, out, A){
    const bass = hexToRgb(s.barColorBass||'#ff2200'), treb = hexToRgb(s.barColorTreble||'#22aaff');
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const col = cell[0], row = cell[1], o = k*3;
      const fc = GW>1 ? col/(GW-1) : 0;                       // 0 bass … 1 treble
      const band = Math.min(31, Math.round(fc*31));
      const mag = A.bands[band];                              // 0..1 (already smoothed/gated)
      const litRows = mag*GH;                                 // how many rows up this column fills
      const fromBottom = (GH-1) - row + 1;                    // bottom row = 1 … top row = GH
      if(fromBottom > litRows){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const v = 0.45 + 0.55*(fromBottom/GH);                 // brighter toward the tip
      out[o]   = ((bass[0]+(treb[0]-bass[0])*fc)*v)|0;
      out[o+1] = ((bass[1]+(treb[1]-bass[1])*fc)*v)|0;
      out[o+2] = ((bass[2]+(treb[2]-bass[2])*fc)*v)|0;
    }
  }
```

In `renderLayer`, add the dispatch branch (before the `else renderMedia` fallback):
```js
    else if(L.type==='individual') renderKeys(L);
    else if(L.type==='audio') renderAudio(L,now,state);
    else renderMedia(L,now);
```

Ensure `NLED`, `renderAudio` are in the exports object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): renderBars + renderAudio dispatch wired into renderLayer"
```

---

## Task 6: Engine — `renderPulse` style

**Files:**
- Modify: `th108-engine.js`
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('renderPulse brightens the whole board with level+beat and dims on silence', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'pulse' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.level = 1; st.audio.beat = 1; st.audio.centroid = 0.5;
  E.renderAudio(La, 0, st);
  let loud=0; for(let i=0;i<La.rgb.length;i++) loud+=La.rgb[i];
  st.audio.level = 0; st.audio.beat = 0; La.rgb.fill(0);
  E.renderAudio(La, 0, st);
  let quiet=0; for(let i=0;i<La.rgb.length;i++) quiet+=La.rgb[i];
  assert.ok(loud > quiet, 'louder audio = brighter board');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `renderPulse` not defined (ReferenceError inside renderAudio when style==='pulse').

- [ ] **Step 3: Implement**
```js
  // Pulse: uniform wash; hue from centroid, brightness from level+beat, faint per-key shimmer.
  function renderPulse(s, out, A, now){
    const base = hexToRgb(s.pulseColor||'#19b6ff');
    const useHue = s.pulseColor ? null : 0.55;   // (color picker drives it; centroid only if unset)
    const v = Math.max(0, Math.min(1, A.level*0.7 + A.beat*0.7));
    const t = now/1000;
    for(let k=0;k<NLED;k++){
      const o=k*3, sh = 0.9 + 0.1*Math.sin(t*8 + k);
      let rgb;
      if(useHue!=null){ rgb = hsv2rgb(0.55 + 0.25*A.centroid, 0.85, Math.max(0.04, v*sh)); }
      else { const vv = Math.max(0.04, v*sh); rgb = [base[0]*vv, base[1]*vv, base[2]*vv]; }
      out[o]=rgb[0]|0; out[o+1]=rgb[1]|0; out[o+2]=rgb[2]|0;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): renderPulse style (level+beat wash)"
```

---

## Task 7: Engine — `renderBloom` style

**Files:**
- Modify: `th108-engine.js`
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('renderBloom lights center keys on a beat and is dark with no beat', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bloom' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.beat = 1; st.audio.level = 0.5;
  E.renderAudio(La, 0, st);
  let onBeat=0; for(let i=0;i<La.rgb.length;i++) onBeat+=La.rgb[i];
  st.audio.beat = 0; st.audio.level = 0; La.rgb.fill(0);
  E.renderAudio(La, 0, st);
  let noBeat=0; for(let i=0;i<La.rgb.length;i++) noBeat+=La.rgb[i];
  assert.ok(onBeat > noBeat, 'a beat blooms; silence is dark');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `renderBloom` not defined.

- [ ] **Step 3: Implement**
```js
  // Bloom: a ring expands from board center as beat decays; hue warms with energy.
  function renderBloom(s, out, A){
    const col0 = hexToRgb(s.bloomColor||'#ff5a00');
    const cx = (GW-1)/2, cy = (GH-1)/2;
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const o = k*3;
      const dx = (cell[0]-cx)/cx, dy = (cell[1]-cy)/cy, d = Math.sqrt(dx*dx+dy*dy);
      const ring = Math.exp(-Math.pow(d - (1-A.beat)*1.3, 2) * 6);
      const v = Math.max(0, Math.min(1, ring*(0.4 + A.level)));
      if(v < 0.04){ out[o]=out[o+1]=out[o+2]=0; continue; }
      out[o]=(col0[0]*v)|0; out[o+1]=(col0[1]*v)|0; out[o+2]=(col0[2]*v)|0;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): renderBloom style (beat-driven radial rings)"
```

---

## Task 8: Engine — `renderWave` style

**Files:**
- Modify: `th108-engine.js`
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('renderWave lights a scrolling line and reacts to band energy', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'wave' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(1);
  E.renderAudio(La, 0, st);
  let lit=0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit++;
  assert.ok(lit > 0, 'wave lights keys near the trace');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `renderWave` not defined.

- [ ] **Step 3: Implement**
```js
  // Wave: per-column sample forms an oscilloscope line scrolling across the board; light the key
  // nearest the line, amplitude scaled by that column's band energy.
  function renderWave(s, out, A, now){
    const col0 = hexToRgb(s.waveColor||'#00e0ff');
    const t = now/1000;
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const col = cell[0], row = cell[1], o = k*3;
      const band = Math.min(31, Math.round((GW>1?col/(GW-1):0)*31));
      const samp = 0.5 + 0.45*Math.sin(t*6 + col*0.6) * (0.4 + 0.6*A.bands[band]);
      const line = samp*(GH-1), v = Math.max(0, 1 - Math.abs(row-line)*0.9);
      if(v < 0.05){ out[o]=out[o+1]=out[o+2]=0; continue; }
      out[o]=(col0[0]*v)|0; out[o+1]=(col0[1]*v)|0; out[o+2]=(col0[2]*v)|0;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS. Then run the full engine + daemon suites to confirm no regressions:
`node --test th108-engine.test.js th108-audio-synth.test.js` and `cd th108-daemon && node --test`.

- [ ] **Step 5: Commit**
```bash
git add th108-engine.js th108-engine.test.js
git commit --author="Beyon <you@example.com>" -m "feat(engine): renderWave style (scrolling oscilloscope trace)"
```

---

## Task 9: UI + page wiring — audio-layer card and synthetic feed

**Files:**
- Modify: `th108-layers-ui.js` (`TYPES` ~line 16; add an `audio` branch in `buildLayerBody` after the `individual` branch ~line 300)
- Modify: `th108-controller.html` (add `<script src="th108-audio-synth.js"></script>` near the other engine scripts; hook the synth into the render tick)

- [ ] **Step 1: Add `'audio'` to the type list**

In `th108-layers-ui.js` line 16:
```js
  const TYPES=['background','reactive','gradient','pattern','individual','audio','media'], BLENDS=['normal','add','screen','multiply','max','replace'];
```

- [ ] **Step 2: Add the audio branch in `buildLayerBody`**

Immediately after the `} else if(L.type==='individual'){ … }` block closes (before the line `attachHex(body);` ~line 301), add:
```js
      } else if(L.type==='audio'){
        const style=s.style||'bars';
        const sources=[['system','All system audio'],['app','Specific app'],['tab','This tab'],['mic','Mic / line-in']];
        const srcBubbles=sources.map(o=>'<label class="sl" style="margin:0 8px 0 0"><input type="radio" name="aud-src-'+L.id+'" class="s-source" value="'+o[0]+'"'+(o[0]===(s.source||'system')?' checked':'')+'> '+o[1]+'</label>').join('');
        const styles=[['bars','Spectrum bars'],['pulse','Beat pulse'],['bloom','Radial bloom'],['wave','Waveform']];
        const sopt=styles.map(m=>'<option value="'+m[0]+'"'+(m[0]===style?' selected':'')+'>'+m[1]+'</option>').join('');
        let html='<div class="ctl">'+
          row('Source','<span style="display:flex;flex-wrap:wrap;align-items:center">'+srcBubbles+'</span><span></span>')+
          row('Source note','<span class="val" style="opacity:.7">Phase 1: driven by a synthetic test signal — real capture lands next.</span><span></span>')+
          row('Style','<select class="s-style">'+sopt+'</select><span></span>');
        if(style==='bars') html+=
          row('Bass color','<input type="color" class="s-barColorBass" value="'+s.barColorBass+'"><span></span>')+
          row('Treble color','<input type="color" class="s-barColorTreble" value="'+s.barColorTreble+'"><span></span>');
        else if(style==='pulse') html+=row('Color','<input type="color" class="s-pulseColor" value="'+s.pulseColor+'"><span></span>');
        else if(style==='bloom') html+=row('Color','<input type="color" class="s-bloomColor" value="'+s.bloomColor+'"><span></span>');
        else if(style==='wave')  html+=row('Color','<input type="color" class="s-waveColor" value="'+s.waveColor+'"><span></span>');
        html+=
          row('Gain','<input type="range" class="s-gain" min="50" max="300" value="'+Math.round((s.gain||1)*100)+'" title="Boost/cut input sensitivity before it drives the keys"><span class="val s-gainV"></span>')+
          row('Noise floor','<input type="range" class="s-floor" min="0" max="40" value="'+s.floor+'" title="Gate out quiet hiss below this level so idle keys stay dark"><span class="val s-floorV"></span>')+
          row('Attack','<input type="range" class="s-attackMs" min="0" max="300" step="5" value="'+s.attackMs+'" title="How fast keys brighten on a rise (ms). Lower = snappier"><span class="val s-attackV"></span>')+
          row('Decay','<input type="range" class="s-decayMs" min="40" max="800" step="10" value="'+s.decayMs+'" title="How slowly keys fade after a peak (ms). Higher = smoother"><span class="val s-decayV"></span>')+
          row('Beat sensitivity','<input type="range" class="s-beatSens" min="0" max="100" value="'+s.beatSens+'" title="How strongly kicks/onsets pop in pulse and bloom"><span class="val s-beatSensV"></span>')+
          row('','<button type="button" class="s-logVals">Log current values</button><span></span>')+
        '</div>';
        body.innerHTML=html;
        const c=q=>body.querySelector(q);
        body.querySelectorAll('.s-source').forEach(r=>r.addEventListener('change',e=>{ s.source=e.target.value; }));
        c('.s-style').addEventListener('change',e=>{ s.style=e.target.value; buildLayerBody(card,L); });
        ['barColorBass','barColorTreble','pulseColor','bloomColor','waveColor'].forEach(key=>{ const el=c('.s-'+key); if(el) el.addEventListener('input',e=>s[key]=e.target.value); });
        const slider=(cls,key,fmt,xform)=>{ const el=c('.s-'+cls), v=c('.s-'+cls+'V'); if(!el) return; const up=()=>v.textContent=fmt(s[key]); el.addEventListener('input',e=>{ s[key]=xform(+e.target.value); up(); }); up(); };
        slider('gain','gain',x=>Math.round(x*100)+'%',v=>v/100);
        slider('floor','floor',x=>x+'%',v=>v);
        slider('attackMs','attackMs',x=>x+'ms',v=>v);
        slider('decayMs','decayMs',x=>x+'ms',v=>v);
        slider('beatSens','beatSens',x=>x+'%',v=>v);
        c('.s-logVals').addEventListener('click',()=>console.log('[audio layer "'+L.name+'"]', JSON.parse(JSON.stringify(s))));
```
(`L.id` is the per-layer id already used elsewhere for unique control names; if the codebase uses a different unique key for a layer, reuse that one for the radio `name`.)

- [ ] **Step 3: Load the synth + feed it into the render tick**

In `th108-controller.html`, add near the other engine `<script src>` tags:
```html
<script src="th108-audio-synth.js"></script>
```
Find the master render tick (where `composeFrame`/`composite` is called each frame — search the inline script for `composeFrame(`). Immediately **before** that call, add the synthetic feed so any enabled audio layer has fresh features:
```js
        // Music layer (Phase 1): drive state.audio from the synthetic generator. Real capture replaces
        // this in Phase 1b; until then the visualizer runs on a deterministic test signal.
        if (state.layers.some(L => L.enabled && L.type === 'audio')) {
          if (!window._audSynth) window._audSynth = TH108AudioSynth.createSynth();
          const aL = state.layers.find(L => L.type === 'audio');
          TH108Engine.applyAudioFeatures(state, window._audSynth.sample(now/1000), aL.settings, now);
        }
```
(Use whatever the loop's current-time variable is named — match the `now` already passed to `composeFrame`.)

- [ ] **Step 4: Syntax-check + smoke test**

Run the HTML inline-script check:
```
node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"
```
Run: `node --check th108-layers-ui.js` and `node --check th108-audio-synth.js`. Expected: all OK.
Then serve the page (`node _serve.js`, daemon stopped) and in the browser: add a layer, set type → **Audio**, confirm the card shows source bubbles + style selector + tuner; switch styles and watch the on-screen preview animate; drag Gain/Decay and see the response. Expected: 0 console errors, the preview animates per style.

- [ ] **Step 5: Commit**
```bash
git add th108-layers-ui.js th108-controller.html
git commit --author="Beyon <you@example.com>" -m "feat(ui): audio-layer card (source bubbles, styles, tuner) + synthetic feed"
```

---

## Task 10: Hardware glance (user-run)

**Files:** none (verification only).

- [ ] **Step 1:** With the page connected to the keyboard (page owns the device), add an Audio layer over a Background layer.
- [ ] **Step 2:** Cycle the four styles; confirm on the real keys: **bars** fill columns bottom-up, **pulse** breathes/flashes the whole board, **bloom** rings out from center, **wave** scrolls a line. The synthetic signal makes this deterministic (no audio needed yet).
- [ ] **Step 3:** Confirm the Audio layer composites over Background (`add` blend) without wedging — this adds no new device writer, so no handoff risk.
- [ ] **Step 4:** Note any look/tuning adjustments for follow-up; Plan 1b swaps the synthetic feed for real system audio.

---

## Self-Review

**Spec coverage (design §3–§5, §7, Phase-1 JS half):**
- §3 data flow (whoever captures renders) → Task 9 wires the page driver; daemon driver + real capture = Plan 1b (out of scope here, by design). ✓
- §4 feature model `{bands,level,beat,centroid}` → Tasks 1, 3, 4 (synth + state.audio + applyAudioFeatures). ✓
- §5 engine `type:'audio'`, `state.audio`, `renderLayer` dispatch, `ensureSettings`, default blend add → Tasks 1, 5; renderers 5–8. ✓
- §5 four styles, **bars default** → Tasks 5–8; default asserted in Task 1. ✓
- §7 UI: source bubbles, style selector, live tuner (gain/smoothing/floor/beat) + per-style colors + log-values, with *why* tooltips → Task 9. ✓
- §9 no new device writer / no flash → Task 10 step 3 confirms; nothing in this plan opens a second writer. ✓
- Source capture (system/app/tab/mic real audio) → deliberately **Plan 1b**; Task 9 stubs the bubbles + labels the synthetic stand-in. ✓ (no silent gap)

**Placeholder scan:** no TBD/TODO; every code step has complete code. ✓

**Type consistency:** `state.audio={bands,level,beat,centroid,_t}`, settings keys (`style/source/gain/floor/attackMs/decayMs/beatSens/barColorBass/barColorTreble/pulseColor/bloomColor/waveColor`), and functions (`audioEnvelope`, `applyAudioFeatures`, `renderAudio`, `renderBars/Pulse/Bloom/Wave`, `createSynth().sample`) are named identically across Tasks 1–9. ✓

**Note for the implementer:** all commits author as `Beyon <you@example.com>`, NO Claude/Co-Authored-By trailer. After any `th108-controller.html` edit, run the inline-script `new Function` check.
