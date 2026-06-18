const test = require('node:test');
const assert = require('node:assert');
const E = require('./th108-engine.js');

// ===== Task 1: board map + colour helpers =====
test('exposes the canonical board map', () => {
  assert.equal(E.NLED, E.INDICES.length);
  assert.equal(E.INDICES.length, 104);
  assert.equal(E.KEYMAP.Escape, 0);
  assert.equal(E.KEYMAP.Space, 83);
});

test('hexToRgb parses #RRGGBB', () => {
  assert.deepEqual(E.hexToRgb('#ff8f33'), [255, 143, 51]);
  assert.deepEqual(E.hexToRgb('#000000'), [0, 0, 0]);
});

test('hsv2rgb wraps hue and clamps', () => {
  const [r, g, b] = E.hsv2rgb(0, 1, 1);   // pure red
  assert.deepEqual([r, g, b], [255, 0, 0]);
});

test('patColorize c1 mode scales colour 1 by brightness', () => {
  const c1 = [200, 100, 50];
  assert.deepEqual(E.patColorize('c1', 0, 0.5, c1, [0,0,0], [0,0,0]), [100, 50, 25]);
});

// ===== Task 2: geometry + state model =====
test('createState builds per-layer rgb buffers + reactive buffers', () => {
  const st = E.createState(E.defaultLayers());
  assert.ok(Array.isArray(st.layers) && st.layers.length >= 1);
  assert.equal(st.layers[0].rgb.length, E.NLED * 3);
  assert.equal(st.react.fg.length, 256);   // per-LED-index reactive buffers
  assert.equal(st.react.t.length, 256);
});

test('ensureSettings backfills missing pattern fields', () => {
  const L = { type:'pattern', settings:{} };
  E.ensureSettings(L);
  assert.equal(L.settings.pattern, 'rainbow');
  assert.equal(L.settings.scale, 10);
});

test('patParams namespaces per pattern and migrates flat values once', () => {
  const s = { pattern:'wave', speed:80 };
  const p = E.patParams(s);
  assert.equal(p.speed, 80);                 // migrated into the active pattern
  s.pattern = 'rainbow';
  assert.equal(E.patParams(s).speed, 50);    // fresh pattern → default (PAT_DEFAULTS.speed), not 80
});

// ===== Task 3: renderers + compositor + orchestrators =====
test('flatEq compares frames', () => {
  assert.equal(E.flatEq([0,1,2], [0,1,2]), true);
  assert.equal(E.flatEq([0,1,2], [0,1,3]), false);
  assert.equal(E.flatEq([0,1,2], null), false);
});

test('composeFrame returns a flat [idx,r,g,b,…] frame for all LEDs', () => {
  // background fields are color/period/bgMin/bgMax (confirmed from th108-controller.html)
  const st = E.createState([{ name:'BG', enabled:true, type:'background', opacity:1, blend:'normal', fps:30,
                              settings:{ color:'#00ff00', period:2600, bgMin:50, bgMax:100 } }]);
  const flat = E.composeFrame(st, 1000);
  assert.equal(flat.length, E.NLED * 4);
  assert.equal(flat[0], E.INDICES[0]);            // first entry is an LED index
  // a solid green background → some channel non-zero somewhere
  assert.ok(flat.some((v, i) => i % 4 !== 0 && v > 0));
});

test('stampKey lights its LED in a reactive layer; releaseKey lets it fade', () => {
  // reactive fields are color/fade/mode (NOT fadeMs) — confirmed from th108-controller.html
  const st = E.createState([{ name:'RX', enabled:true, type:'reactive', opacity:1, blend:'normal', fps:60,
                             settings:{ color:'#ff0000', fade:300, mode:'single' } }]);
  E.stampKey(st, E.KEYMAP.KeyA);
  // pass a non-zero `now` so the per-layer fps interval gate fires (it never fires at now===lastTick===0,
  // exactly as in the controller). The key is held (down) so intensity is full regardless of `now`.
  const lit = E.composeFrame(st, 100);
  const o = E.INDICES.indexOf(E.KEYMAP.KeyA) * 4;
  assert.ok(lit[o+1] > 0, 'A key red channel should be lit right after press');
});

test('composeFrame applies global brightness (state.bri) without compounding', () => {
  const E = require('./th108-engine.js');
  // a pre-rendered layer with lastTick in the future skips renderLayer — composite reads L.rgb as-is
  const L = { enabled: true, type: 'pattern', opacity: 1, blend: 'normal', fps: 30, lastTick: 1e15,
              rgb: new Uint8Array(E.NLED * 3).fill(200), settings: {} };
  const state = { layers: [L] };
  const f1 = E.composeFrame(state, 0);
  assert.equal(f1[1], 200, 'no bri → untouched');
  state.bri = 0.5;
  const f2 = E.composeFrame(state, 0);
  assert.equal(f2[1], 100, 'bri 0.5 halves the output');
  const f3 = E.composeFrame(state, 0);
  assert.equal(f3[1], 100, 'second frame identical — no compounding');
  state.bri = 1;
  assert.equal(E.composeFrame(state, 0)[1], 200, 'bri 1 = untouched');
});

// ===== Individual-keys layer =====
test('individual layer paints chosen keys; replace blend keeps unpainted transparent', () => {
  const idxA = E.KEYMAP.KeyA, idxB = E.KEYMAP.KeyB;
  const st = E.createState([
    { name:'BG',   enabled:true, type:'background', opacity:1, blend:'normal',  fps:30,
      settings:{ color:'#00ff00', period:2600, bgMin:100, bgMax:100 } },
    { name:'Keys', enabled:true, type:'individual', opacity:1, blend:'replace', fps:30,
      settings:{ keys:{ [idxA]:'#ff0000' }, current:'#ff0000' } },
  ]);
  const flat = E.composeFrame(st, 100);
  const oA = E.INDICES.indexOf(idxA) * 4, oB = E.INDICES.indexOf(idxB) * 4;
  assert.ok(flat[oA+1] > 200 && flat[oA+2] < 60 && flat[oA+3] < 60, 'painted A is red over the background');
  assert.ok(flat[oB+2] > 0, 'unpainted B reveals the green background');
});

test('ensureSettings backfills individual fields', () => {
  const L = { type:'individual', settings:{} };
  E.ensureSettings(L);
  assert.deepEqual(L.settings.keys, {});
  assert.equal(L.settings.current, '#ff8c00');
});

test('applyConfig updates settings in place (preserves running animation), rebuilds on structure change', () => {
  const st = E.createState(E.defaultLayers());
  st.layers[0]._clk = 12345; st.layers[0].lastTick = 999;          // a running animation
  const cfg = E.defaultLayers(); cfg[0].settings.color = '#123456';
  const st2 = E.applyConfig(st, cfg);
  assert.equal(st2, st, 'settings-only edit reuses the same state');
  assert.equal(st.layers[0]._clk, 12345, 'animation clock preserved');
  assert.equal(st.layers[0].settings.color, '#123456', 'new settings applied');
  const st3 = E.applyConfig(st, E.defaultLayers().slice(0, 2));
  assert.notEqual(st3, st, 'structure change rebuilds');
  assert.equal(st3.layers.length, 2);
});

// ===== Music layer (audio) =====
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

test('applyAudioFeatures gates below floor, applies gain, and smooths into state.audio', () => {
  const st = E.createState([{ name:'A', type:'audio', enabled:true, opacity:1, blend:'add', settings:{} }]);
  const s = st.layers[0].settings;            // ensureSettings already ran in createState
  const raw = { bands:new Float32Array(32).fill(0.5), level:0.5, beat:1, centroid:0.7 };
  // first call: dt defaults from state.audio._t=0 → treat as one frame
  E.applyAudioFeatures(st, raw, s, 16);
  assert.ok(st.audio.level > 0, 'level moved toward target');
  assert.ok(st.audio.bands[0] > 0, 'bands moved toward target');
  // a below-floor band is gated to 0 (floor=5% → 0.05); advance time so the decay actually elapses
  const quiet = { bands:new Float32Array(32).fill(0.02), level:0.02, beat:0, centroid:0.5 };
  for(let i=0;i<60;i++) E.applyAudioFeatures(st, quiet, s, 16 + (i+1)*16);   // ~16ms/frame, let it decay
  assert.ok(st.audio.level < 0.05, 'quiet level decays below floor');
});

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

test('renderWave lights a scrolling line and reacts to band energy', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'wave' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(1);
  E.renderAudio(La, 0, st);
  let lit=0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit++;
  assert.ok(lit > 0, 'wave lights keys near the trace');
});

test('audio duck dims a target layer only while the audio layer is emitting light', () => {
  const mk=()=>E.createState([
    {name:'BG',type:'background',enabled:true,opacity:1,blend:'normal',fps:30,settings:{color:'#ffffff',period:1,bgMin:100,bgMax:100}},
    {name:'Audio',type:'audio',enabled:true,opacity:1,blend:'add',fps:30,settings:{style:'bars',ducks:[{layer:0,dim:0}]}},
  ]);
  const sum=f=>{let s=0;for(let o=0;o<f.length;o+=4)s+=f[o+1]+f[o+2]+f[o+3];return s;};
  // emitting: bass band on → audio layer lights → BG (layer 0) ducked to dim 0
  const st1=mk(); st1.bri=1; st1.audio.bands.fill(0); st1.audio.bands[0]=1;
  const ducked=sum(E.composeFrame(st1,100));
  // silent: no bands → audio layer paints black → NOT emitting → BG must NOT be ducked (full white)
  const st2=mk(); st2.bri=1; st2.audio.bands.fill(0);
  const full=sum(E.composeFrame(st2,100));
  assert.ok(full > ducked*3, 'audio-silent frame is far brighter than the ducked (audio-emitting) frame');
  // no duck config → emitting audio must leave the target untouched
  const st3=mk(); st3.bri=1; st3.layers[1].settings.ducks=[]; st3.audio.bands.fill(0); st3.audio.bands[0]=1;
  const noDuck=sum(E.composeFrame(st3,100));
  assert.ok(noDuck > ducked*3, 'with no duck config the target stays full even while audio emits');
});

test('a non-emitting audio layer is transparent (multiply-black must not dim the board)', () => {
  const mk=()=>E.createState([
    {name:'BG',type:'background',enabled:true,opacity:1,blend:'normal',fps:30,settings:{color:'#ffffff',period:1,bgMin:100,bgMax:100}},
    {name:'Audio',type:'audio',enabled:true,opacity:0.85,blend:'multiply',fps:30,settings:{style:'bars'}},
  ]);
  // silent → audio layer renders black → must be skipped, board stays full white
  const st1=mk(); st1.bri=1; st1.audio.bands.fill(0);
  const f1=E.composeFrame(st1,100);
  let minV=255; for(let o=0;o<f1.length;o+=4) minV=Math.min(minV,f1[o+1]);
  assert.ok(minV>200, 'silent audio layer is transparent (board stays bright), got '+minV);
  // emitting → multiply actually applies (board no longer uniformly white)
  const st2=mk(); st2.bri=1; st2.audio.bands.fill(1);
  const f2=E.composeFrame(st2,100);
  let anyDim=false; for(let o=0;o<f2.length;o+=4) if(f2[o+1]<250||f2[o+3]<250){ anyDim=true; break; }
  assert.ok(anyDim, 'emitting audio layer composites (multiply changes the board)');
});

test('renderWave reverse flips the scroll direction (different frame, same instant)', () => {
  const mkL=rev=>{ const L={type:'audio',enabled:true,opacity:1,blend:'add',settings:{style:'wave',waveReverse:rev},rgb:new Uint8Array(E.NLED*3)}; E.ensureSettings(L); return L; };
  const Lf=mkL(false), Lr=mkL(true);
  const st=E.createState([Lf]); st.audio.bands.fill(0.7);
  E.renderAudio(Lf, 500, st); E.renderAudio(Lr, 500, st);
  let diff=false; for(let i=0;i<Lf.rgb.length;i++) if(Lf.rgb[i]!==Lr.rgb[i]){ diff=true; break; }
  assert.ok(diff, 'reverse produces a different waveform than forward at the same instant');
});

test('renderBars tip outlines the topmost lit key of a column with the tip color', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barTip:'color', barTipColor:'#00ff00' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st=E.createState([L]); const La=st.layers[0];
  st.audio.bands.fill(0); st.audio.bands[0]=0.5;   // column 0 (band 0) ~half height → tip is the topmost lit row
  E.renderAudio(La, 0, st);
  const col0 = [0,16,32,48,64,80].map(idx=>E.INDICES.indexOf(idx));   // column-0 LED indices, bottom→top
  let greenTip=false, redBelow=false;
  for(const k of col0){ if(k<0) continue; const o=k*3, r=La.rgb[o], g=La.rgb[o+1], b=La.rgb[o+2];
    if(g>200 && r<60 && b<60) greenTip=true;   // tip = pure green
    if(r>60 && g<80) redBelow=true;            // a non-tip lit key shows the bass (red-ish) gradient
  }
  assert.ok(greenTip, 'the topmost lit key uses the tip color');
  assert.ok(redBelow, 'lower lit keys keep the bar gradient');
});
