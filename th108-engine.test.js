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
  assert.equal(L.settings.fill, 'solid');
});

test('individual subtract fill carves painted keys into a silhouette, passes the rest through', () => {
  const idxA = E.KEYMAP.KeyA, idxB = E.KEYMAP.KeyB;
  const st = E.createState([
    { name:'BG',   enabled:true, type:'background', opacity:1, blend:'normal',  fps:30,
      settings:{ color:'#ffffff', period:1, bgMin:100, bgMax:100 } },
    { name:'Keys', enabled:true, type:'individual', opacity:1, blend:'replace', fps:30,
      settings:{ keys:{ [idxA]:'#ff0000' }, current:'#ff0000', fill:'subtract' } },
  ]);
  st.bri = 1;
  const flat = E.composeFrame(st, 100);
  const oA = E.INDICES.indexOf(idxA) * 4, oB = E.INDICES.indexOf(idxB) * 4;
  assert.ok(flat[oA+1] < 60 && flat[oA+2] < 60 && flat[oA+3] < 60, 'painted A carved DARK (silhouette), not drawn red');
  assert.ok(flat[oB+1] > 200 && flat[oB+2] > 200 && flat[oB+3] > 200, 'unpainted B still reveals the white background');
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

test('renderPulse Min brightness holds a resting glow at silence', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'pulse', pulseMin:50, pulseColor:'#ffffff' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.level = 0; st.audio.beat = 0;   // silence
  E.renderAudio(La, 0, st);
  let lit=0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit++;
  assert.ok(lit > 0, 'pulseMin=50 keeps the board glowing at silence (default 0 would be dark)');
});

test('renderSparkle mono uses only the picked color', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'sparkle', sparkleMono:true, sparkleColor:'#ff0000' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.level = 1; st.audio.beat = 1; st.audio.bands.fill(0.8);
  E.renderAudio(La, 50, st);
  let g=0,b=0,lit=0; for(let k=0;k<E.NLED;k++){ const o=k*3; if(La.rgb[o]>0){lit++;} g+=La.rgb[o+1]; b+=La.rgb[o+2]; }
  assert.ok(lit > 0, 'mono starfield lights keys');
  assert.equal(g+b, 0, 'pure red picked color → no green/blue channel anywhere');
});

test('wash-style Dynamics recedes on steady sound and Transparency sets an alpha mask', () => {
  const mk=extra=>{ const L={ type:'audio', enabled:true, opacity:1, blend:'add', settings:Object.assign({ style:'pulse', pulseMin:40, pulseColor:'#ffffff' }, extra), rgb:new Uint8Array(E.NLED*3) }; E.ensureSettings(L); return L; };
  // Dynamics ON, full depth: a STEADY frame (beat 0) is dimmer than the same frame with a beat.
  const Ld=mk({ pulseDynamics:true, pulseDynamicsDepth:100 });
  let st=E.createState([Ld]); let La=st.layers[0];
  st.audio.level=0.6; st.audio.beat=0; E.renderAudio(La,0,st);
  let steady=0; for(let i=0;i<La.rgb.length;i++) steady+=La.rgb[i];
  La.rgb.fill(0); st.audio.beat=1; E.renderAudio(La,0,st);
  let onbeat=0; for(let i=0;i<La.rgb.length;i++) onbeat+=La.rgb[i];
  assert.ok(onbeat > steady, 'a beat pops brighter than a steady passage when Dynamics is on');
  // Transparency ON: renderAudio must publish a per-key alpha mask (< 1 while steady).
  const Lt=mk({ pulseDynamicsAlpha:true, pulseDynamicsDepth:100 });
  st=E.createState([Lt]); La=st.layers[0];
  st.audio.level=0.6; st.audio.beat=0; E.renderAudio(La,0,st);
  assert.ok(La._alpha && La._alpha[0] < 1, 'Transparency sets an opacity mask below 1 during steady sound');
});

test('Mic is a separate tuning variant with smoother defaults', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', source:'mic' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const s = L.settings;
  const micAp = E.audioParams(s);
  assert.equal(micAp.attackMs, 80, 'mic gets the smoother default attack');
  assert.equal(micAp.pauseDecayMs, 1500, 'mic gets the long graceful settle');
  s.source = 'system';
  assert.equal(E.audioParams(s).attackMs, 40, 'a playback source uses the standard attack — separate variant');
  assert.notEqual(E.audioVariantKey({ style:'bars', source:'mic' }), E.audioVariantKey({ style:'bars', source:'system' }), 'mic+bars and system+bars are distinct variants');
});

test('crop clip masks every key outside the rectangle', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'pulse', pulseMin:100, pulseColor:'#ffffff', cropOn:true, cropFit:false, cropX:0, cropY:0, cropW:0.4, cropH:1 }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.level = 1; st.audio.beat = 1; E.renderAudio(La, 0, st);   // pulseMin 100 → whole board would light without the crop
  let lit = 0;
  for (let k = 0; k < E.NLED; k++){ const o = k*3; if (La.rgb[o]||La.rgb[o+1]||La.rgb[o+2]) { lit++;
    const c = E.keyCell(E.INDICES[k]); assert.ok(c && c[0] <= 0.4 + 1e-9, 'a lit key must sit inside the crop box (x<=0.4)'); } }
  assert.ok(lit > 0, 'crop still lights keys inside the box');
});

test('Mic absolute-volume: bar height tracks input loudness (auto-gain off)', () => {
  const run=(inAbs)=>{ const L={ type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', source:'mic' }, rgb:new Uint8Array(E.NLED*3) };
    E.ensureSettings(L); const st=E.createState([L]); const frame={ level:1, live:1, inAbs, bands:new Array(32).fill(1) };
    for(let f=0;f<25;f++) E.applyAudioFeatures(st, frame, st.layers[0].settings, f*16);   // let the envelope settle
    let sum=0; for(let i=0;i<32;i++) sum+=st.audio.bands[i]; return sum; };
  const quiet=run(0.1), loud=run(0.6);
  assert.ok(loud > quiet*2, 'a louder mic input makes taller bars (absolute) instead of auto-gaining a faint tap to full');
});

test('mic noise gate mutes below-threshold input on the absolute level', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', source:'mic', micGate:30 }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  // a "fan": low absolute level but the capture's auto-gain already normalized `level` up to ~1
  const fan = { level:1, live:1, inAbs:0.1, bands:new Array(32).fill(1) };
  E.applyAudioFeatures(st, fan, La.settings, 0); E.renderAudio(La, 0, st);
  let lit=0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit++;
  assert.equal(lit, 0, 'inAbs 0.1 < gate 0.30 → board stays dark despite normalized level=1');
  // real speech/loud input above the gate lights up
  const loud = { level:1, live:1, inAbs:0.8, bands:new Array(32).fill(1) };
  E.applyAudioFeatures(st, loud, La.settings, 16); E.renderAudio(La, 16, st);
  let lit2=0; for(let i=0;i<La.rgb.length;i++) if(La.rgb[i]>0) lit2++;
  assert.ok(lit2 > 0, 'inAbs 0.8 > gate 0.30 → board lights');
});

test('renderWave plots the live PCM trace (A.wave steers it)', () => {
  const litKeys=(L,st)=>{ st.audio.level=1; E.renderAudio(L,0,st); const out=[]; for(let k=0;k<E.NLED;k++){ const o=k*3; if(L.rgb[o]||L.rgb[o+1]||L.rgb[o+2]) out.push(k); } return out; };
  const mk=()=>{ const L={ type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'wave', waveAmp:100, waveThick:20 }, rgb:new Uint8Array(E.NLED*3) }; E.ensureSettings(L); return L; };
  const up=mk(); let st=E.createState([up]); st.layers[0].__t=0;
  st.audio.wave=new Float32Array(64).fill(1);   // +1 everywhere → trace pinned at the TOP row
  const topLit=litKeys(st.layers[0], st);
  const dn=mk(); st=E.createState([dn]);
  st.audio.wave=new Float32Array(64).fill(-1);  // -1 everywhere → trace at the BOTTOM row
  const botLit=litKeys(st.layers[0], st);
  assert.ok(topLit.length>0 && botLit.length>0, 'both traces light keys');
  assert.notDeepEqual(topLit, botLit, 'a +1 trace (top) lights different keys than a -1 trace (bottom)');
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
  // emitting: bass band on → audio layer lights → BG (layer 0) ducks toward dim 0 (eased ~600ms, so settle it)
  const st1=mk(); st1.bri=1; st1.audio.bands.fill(0); st1.audio.bands[0]=1;
  let ducked; for(let i=0;i<200;i++) ducked=sum(E.composeFrame(st1, 100+i*16));
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

test('audio tuner params are per-style (gain on bars does not leak to pulse)', () => {
  const L = { type:'audio', settings:{ style:'bars' } }; E.ensureSettings(L);
  E.audioParams(L.settings).gain = 2.5;                 // tune bars
  L.settings.style = 'pulse';
  assert.equal(E.audioParams(L.settings).gain, 1, 'pulse starts at the default gain, not the bars value');
  L.settings.style = 'bars';
  assert.equal(E.audioParams(L.settings).gain, 2.5, 'bars keeps its own gain');
});

test('renderBars subtract fill carves the layers below into a silhouette (tip still draws)', () => {
  const st=E.createState([
    {name:'BG',type:'background',enabled:true,opacity:1,blend:'normal',fps:30,settings:{color:'#ffffff',period:1,bgMin:100,bgMax:100}},
    {name:'Audio',type:'audio',enabled:true,opacity:1,blend:'add',fps:30,settings:{style:'bars',barFill:'subtract',barTip:'color',barTipColor:'#00ff00'}},
  ]);
  st.bri=1; st.audio.bands.fill(0); st.audio.bands[0]=0.5;   // column 0 bar ~3 rows tall
  const flat=E.composeFrame(st,100);
  const at=idx=>E.INDICES.indexOf(idx)*4;
  const ob=at(80);  assert.ok(flat[ob+1]<60 && flat[ob+2]<60 && flat[ob+3]<60, 'bar-body key carved dark');
  const ow=at(84);  assert.ok(flat[ow+1]>200 && flat[ow+2]>200 && flat[ow+3]>200, 'a key outside the bar keeps the white background');
  const otp=at(48); assert.ok(flat[otp+2]>200 && flat[otp+1]<90, 'tip key lit green over the carve');
});

test('renderBars vu fill colors low keys green and high keys red', () => {
  const L={type:'audio',enabled:true,opacity:1,blend:'add',settings:{style:'bars',barColor:'vu'},rgb:new Uint8Array(E.NLED*3)};
  E.ensureSettings(L); const st=E.createState([L]); const La=st.layers[0];
  st.audio.bands.fill(0); st.audio.bands[0]=1;   // column 0 full height
  E.renderAudio(La,0,st);
  const at=idx=>E.INDICES.indexOf(idx)*3;
  const ob=at(80), ot=at(0);   // col0 bottom (row5) vs top (row0)
  assert.ok(La.rgb[ob+1] > La.rgb[ob], 'bottom key green-ish (g>r)');
  assert.ok(La.rgb[ot] > La.rgb[ot+1], 'top key red-ish (r>g)');
});

test('renderPulse gradient colors bottom vs top differently', () => {
  const L={type:'audio',enabled:true,opacity:1,blend:'add',settings:{style:'pulse',pulseGrad:true,pulseColor:'#ff0000',pulseColor2:'#0000ff'},rgb:new Uint8Array(E.NLED*3)};
  E.ensureSettings(L); const st=E.createState([L]); const La=st.layers[0];
  st.audio.level=1; st.audio.beat=1;
  E.renderAudio(La,0,st);
  const at=idx=>E.INDICES.indexOf(idx)*3;
  const ob=at(80), ot=at(0);
  assert.ok(La.rgb[ob] > La.rgb[ob+2], 'bottom red-dominant (pulseColor)');
  assert.ok(La.rgb[ot+2] > La.rgb[ot], 'top blue-dominant (pulseColor2)');
});

// ---- spectrum-bars layouts (standard / mirror / stereo) + L/R band plumbing ----
const findK = pred => { for (let k = 0; k < E.NLED; k++) { const c = E.GRID[E.INDICES[k]]; if (c && pred(c)) return k; } return -1; };
const litSum = (La, k) => La.rgb[k*3] + La.rgb[k*3+1] + La.rgb[k*3+2];

test('bars stereo layout: L channel lights the left half, R channel the right half', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barLayout:'stereo' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(0); st.audio.bandsL.fill(1); st.audio.bandsR.fill(0);   // hard left
  E.renderAudio(La, 0, st);
  const kL = findK(c => c[0] <= 3), kR = findK(c => c[0] >= 17);
  assert.ok(kL >= 0 && kR >= 0, 'found a left + right key');
  assert.ok(litSum(La, kL) > 0, 'left-half key lit by the L channel');
  assert.equal(litSum(La, kR), 0, 'right-half key dark (R channel silent)');
});

test('bars mirror layout: bass in the center, treble at the edges', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barLayout:'mirror' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(0); st.audio.bands[0] = 1;   // pure bass
  E.renderAudio(La, 0, st);
  const kC = findK(c => c[0] === 10), kE = findK(c => c[0] <= 1);
  assert.ok(kC >= 0 && kE >= 0, 'found a center + edge key');
  assert.ok(litSum(La, kC) > 0, 'center key lit (bass at center)');
  assert.equal(litSum(La, kE), 0, 'edge key dark (treble there, silent)');
});

test('applyAudioFeatures mirrors mono into both channels when no L/R provided', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]);
  const raw = { bands:new Float32Array(32).fill(0.8), level:0.5, beat:0, centroid:0.5 };   // no bandsL/R
  for (let t = 16; t <= 300; t += 16) E.applyAudioFeatures(st, raw, L.settings, t);
  assert.ok(st.audio.bandsL[10] > 0.1 && st.audio.bandsR[10] > 0.1, 'mono fed into both channels');
  assert.ok(Math.abs(st.audio.bandsL[10] - st.audio.bandsR[10]) < 1e-6, 'L and R identical for a mono source');
});

test('applyAudioFeatures keeps L and R separate when the source is stereo', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]);
  const raw = { bands:new Float32Array(32).fill(0.4), bandsL:new Float32Array(32).fill(0.9), bandsR:new Float32Array(32).fill(0), level:0.5, beat:0, centroid:0.5 };
  for (let t = 16; t <= 400; t += 16) E.applyAudioFeatures(st, raw, L.settings, t);
  assert.ok(st.audio.bandsL[5] > 0.3, 'L channel rose');
  assert.ok(st.audio.bandsR[5] < 0.05, 'R channel stays ~0');
});

test('bars reverse layout: a bass-only signal lights the right, not the left (mirror of standard)', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  const kLeft = findK(c => c[0] === 0);   // far-left column
  st.audio.bands.fill(0); st.audio.bands[0] = 1;   // pure bass
  La.settings.barLayout = 'standard'; E.renderAudio(La, 0, st);
  assert.ok(litSum(La, kLeft) > 0, 'standard: bass lights the LEFT');
  La.settings.barLayout = 'reverse'; E.renderAudio(La, 0, st);
  assert.equal(litSum(La, kLeft), 0, 'reverse: bass no longer lights the left (it moved to the right)');
});

test('bars top-down layout: a short bar lights the TOP row, not the bottom', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barLayout:'topdown' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(0); st.audio.bands[0] = 0.2;   // tiny bar in column 0 (bass, left)
  E.renderAudio(La, 0, st);
  const colMin = c => c[0] === 0;
  const kTop = findK(c => colMin(c) && c[1] === 0), kBot = findK(c => colMin(c) && c[1] === E.GH-1);
  assert.ok(kTop >= 0 && kBot >= 0, 'found top + bottom of column 0');
  assert.ok(litSum(La, kTop) > 0, 'top row lit (bar hangs from the top)');
  assert.equal(litSum(La, kBot), 0, 'bottom row dark');
});

test('bars center-out layout: a short bar lights the middle rows, not the edges', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barLayout:'centerout' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  st.audio.bands.fill(0); st.audio.bands[0] = 0.5;   // bar fills the innermost level (mag ≥ 1/3), not the outer edges
  E.renderAudio(La, 0, st);
  const colMin = c => c[0] === 0;
  const kMid = findK(c => colMin(c) && (c[1] === 2 || c[1] === 3)), kEdge = findK(c => colMin(c) && c[1] === 0);
  assert.ok(kMid >= 0 && kEdge >= 0, 'found middle + edge of column 0');
  assert.ok(litSum(La, kMid) > 0, 'middle row lit (grows from the center)');
  assert.equal(litSum(La, kEdge), 0, 'top edge dark');
});

test('bars sub-row fill: the top partial row brightens continuously with magnitude (smooth, no edge flicker)', () => {
  const k = findK(c => c[0] === 0 && c[1] === 3);   // column 0, the fb=3 row (lit only as the bar passes ~2..3 of 6)
  assert.ok(k >= 0, 'found column-0 row-3 key');
  const sample = (mag) => {
    const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars' }, rgb:new Uint8Array(E.NLED*3) };
    E.ensureSettings(L); const st = E.createState([L]);
    st.audio.bands.fill(0); st.audio.bands[0] = mag; E.renderAudio(st.layers[0], 0, st);
    return litSum(st.layers[0], k);
  };
  const lo = sample(0.35), hi = sample(0.4833);   // litCount 2.1 vs 2.9 → same row, fractional fill 0.1 vs 0.9
  assert.ok(lo > 0, 'partial row is lit, not toggled off');
  assert.ok(hi > lo, 'same row gets brighter as the bar fills further into it (continuous, not binary)');
});

test('contrast deepens the dips: a sub-peak band reads lower at high contrast', () => {
  const run = (contrast) => {
    const st = E.createState([{ type:'audio', enabled:true, opacity:1, blend:'add', fps:30, settings:{ style:'bars' } }]);
    const ap = E.audioParams(st.layers[0].settings);
    ap.floor = 0; ap.ceil = 100; ap.gain = 1; ap.contrast = contrast; ap.attackMs = 1; ap.decayMs = 1;
    let raw = { bands:new Float32Array(32).fill(1), level:1, beat:0, centroid:0.5 };   // establish a high per-band peak
    for (let t = 16; t <= 200; t += 16) E.applyAudioFeatures(st, raw, st.layers[0].settings, t);
    raw = { bands:new Float32Array(32).fill(0.5), level:0.5, beat:0, centroid:0.5 };   // then sit at ~half the peak
    let v = 0; for (let t = 216; t <= 420; t += 16){ E.applyAudioFeatures(st, raw, st.layers[0].settings, t); v = st.audio.bands[5]; }
    return v;
  };
  const linear = run(0), punchy = run(100);
  assert.ok(punchy < linear, 'high contrast pulls a sub-peak band much lower (deeper dips → bottom→top travel)');
});

test('abstract styles light on sound and go fully dark on silence', () => {
  for (const style of ['aurora','sparkle']) {
    const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style }, rgb:new Uint8Array(E.NLED*3) };
    E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
    st.audio.level = 1; st.audio.beat = 1; st.audio.centroid = 0.6; st.audio.bands.fill(0.8);
    E.renderAudio(La, 100, st);
    let lit = 0; for (let i = 0; i < La.rgb.length; i++) if (La.rgb[i] > 0) lit++;
    assert.ok(lit > 0, style + ' lights on sound');
    st.audio.level = 0; st.audio.beat = 0; st.audio.bands.fill(0);
    E.renderAudio(La, 200, st);
    let sum = 0; for (let i = 0; i < La.rgb.length; i++) sum += La.rgb[i];
    assert.equal(sum, 0, style + ' dark on silence');
  }
});

test('bars Drive: volume lights a treble column that the spectrum drive leaves dark', () => {
  const kHi = findK(c => c[0] >= 12 && c[1] === E.GH-1);   // a high-column, bottom-row key (treble band)
  assert.ok(kHi >= 0, 'found a high-column bottom key');
  const render = (drive) => {
    const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barDrive:drive }, rgb:new Uint8Array(E.NLED*3) };
    E.ensureSettings(L); const st = E.createState([L]);
    st.audio.bands.fill(0); st.audio.bands[0] = 1;   // ONLY the bass band has energy
    st.audio.level = 0.9;
    E.renderAudio(st.layers[0], 0, st);
    return litSum(st.layers[0], kHi);
  };
  assert.equal(render('spectrum'), 0, 'spectrum: a treble column with no treble energy is dark');
  assert.ok(render('volume') > 0, 'volume: same column lit because every bar tracks overall loudness');
});

test('auto-gain off makes Gain a linear sensitivity (loud input no longer pegs full)', () => {
  const run = (agc, gain) => {
    const st = E.createState([{ type:'audio', enabled:true, opacity:1, blend:'add', fps:30, settings:{ style:'bars' } }]);
    const ap = E.audioParams(st.layers[0].settings); ap.floor=0; ap.ceil=100; ap.contrast=0; ap.agc=agc; ap.gain=gain; ap.attackMs=1; ap.decayMs=1;
    const raw = { bands:new Float32Array(32).fill(0.5), level:0.5, beat:0, centroid:0.5 };
    for (let t=16;t<=400;t+=16) E.applyAudioFeatures(st, raw, st.layers[0].settings, t);
    return st.audio.bands[5];
  };
  assert.ok(run(true, 1) > 0.95, 'auto-gain on: a steady input rides near full (normalized to its peak)');
  assert.ok(run(false, 0.5) < 0.6, 'auto-gain off + gain 0.5: same input sits lower (linear sensitivity)');
});

test('bars Spread shapes volume by the per-column spectrum (column heights differ); off = uniform wall', () => {
  const loCol = 0, hiCol = (findK(c => c[0] >= 12) >= 0) ? E.GRID[E.INDICES[findK(c => c[0] >= 12)]][0] : 14;
  const colHeight = (La, col) => { let n=0; for(let k=0;k<E.NLED;k++){ const c=E.GRID[E.INDICES[k]]; if(c && c[0]===col && (La.rgb[k*3]+La.rgb[k*3+1]+La.rgb[k*3+2])>0) n++; } return n; };
  const render = (spread) => {
    const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', barDrive:'volume', barSpread:spread }, rgb:new Uint8Array(E.NLED*3) };
    E.ensureSettings(L); const st = E.createState([L]);
    st.audio.bands.fill(0); st.audio.bands[0] = 1; st.audio.bandsRaw.fill(0); st.audio.bandsRaw[0] = 1; st.audio.level = 0.9;   // bass-only spectrum, loud
    E.renderAudio(st.layers[0], 0, st);
    return [colHeight(st.layers[0], loCol), colHeight(st.layers[0], hiCol)];
  };
  const off = render(false), on = render(true);
  // compare each column to ITSELF across off/on (avoids physical grid-gap differences between columns):
  assert.ok(on[1] < off[1], 'spread on lowers the silent treble column (no energy there)');
  assert.ok(on[0] >= off[0], 'spread on keeps the bass column (full energy) at least as tall');
});

test('audio duck eases in instead of snapping (pause/unpause lerp)', () => {
  const st = E.createState([
    { name:'BG', type:'background', enabled:true, opacity:1, blend:'normal', fps:30, settings:{ color:'#ffffff', period:1, bgMin:100, bgMax:100 } },
    { name:'Audio', type:'audio', enabled:true, opacity:1, blend:'add', fps:30, settings:{ style:'bars', ducks:[{ layer:0, dim:0 }] } },
  ]);
  st.bri = 1; st.audio.bands.fill(0); st.audio.bands[0] = 1;   // audio emitting → BG should duck toward 0
  const sum = f => { let s=0; for(let o=0;o<f.length;o+=4) s+=f[o+1]+f[o+2]+f[o+3]; return s; };
  const frames = []; for(let i=0;i<200;i++) frames.push(sum(E.composeFrame(st, 100 + i*40)));   // 40ms steps so every frame renders
  const early = frames[0], settled = frames[199];               // first ducked frame vs fully settled
  assert.ok(early > settled*2, 'early ducked frame is much brighter than the settled dim → it eased, did not snap');
});

test('pause decay: bars settle slower after sustained silence than the per-note decay', () => {
  const run = (pauseDecayMs) => {
    const st = E.createState([{ type:'audio', enabled:true, opacity:1, blend:'add', fps:30, settings:{ style:'bars' } }]);
    const ap = E.audioParams(st.layers[0].settings); ap.floor=0; ap.ceil=100; ap.contrast=0; ap.agc=false; ap.gain=1; ap.attackMs=1; ap.decayMs=60; ap.pauseDecayMs=pauseDecayMs;
    const s = st.layers[0].settings;
    const loud = { bands:new Float32Array(32).fill(0.9), level:0.9, beat:0, centroid:0.5 };
    const silent = { bands:new Float32Array(32), level:0, beat:0, centroid:0.5 };
    let t = 0;
    for (; t <= 300; t += 16) E.applyAudioFeatures(st, loud, s, t);   // ramp up + load
    for (let i = 0; i < 20; i++) { t += 16; E.applyAudioFeatures(st, silent, s, t); }   // ~320ms of silence (past the 200ms pause gate)
    return st.audio.bands[5];
  };
  const fast = run(150), slow = run(2500);
  assert.ok(slow > fast, 'a longer Pause decay leaves the bars higher after the same silence (settles more gradually)');
});

test('twinkle pause: freezes the last frame, then sparkles every key out over the PER-STYLE pauseDecayMs', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', settings:{ style:'bars', pauseStyle:'twinkle' }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0];
  const dur = 3000; E.audioParams(La.settings).pauseDecayMs = dur;   // a non-default, long window (the per-style param the slider writes)
  const sum = ()=>{ let s=0; for(let i=0;i<La.rgb.length;i++) s+=La.rgb[i]; return s; };
  st.audio.bands.fill(1); st.audio.level = 1;              // a loud live frame so the peak-gated snapshot captures the FULL lit frame (not a faded tail)
  E.renderAudio(La, 0, st);
  const live = sum(); assert.ok(live > 0, 'live frame lights keys');
  E.applyAudioFeatures(st, { bands:new Float32Array(32), level:0, live:0 }, La.settings, 1000);   // sustained silence
  assert.ok(st.audio._twk, 'silence + twinkle style engages the freeze');
  E.renderAudio(La, 1000, st);
  assert.equal(sum(), live, 'the WHOLE frame is frozen at pause onset (full bars, not just the bottom row)');
  E.renderAudio(La, 1000 + 700 + 50, st);
  assert.ok(sum() > 0, 'still twinkling well past the old hardcoded 700ms — it honors the 3000ms setting, not a fixed default');
  E.renderAudio(La, 1000 + dur + 50, st);
  assert.equal(sum(), 0, 'fully dissipated only after the set pauseDecayMs → board dark');
});

test('settle pause: a sub-peak bar still takes the FULL pauseDecayMs to glide to 0 (height-independent)', () => {
  const st = E.createState([{ type:'audio', enabled:true, opacity:1, blend:'add', fps:30, settings:{ style:'bars', pauseStyle:'linear' } }]);
  const s = st.layers[0].settings; const ap = E.audioParams(s);
  ap.floor=0; ap.ceil=100; ap.contrast=0; ap.agc=false; ap.gain=1; ap.attackMs=1; ap.decayMs=60; ap.pauseDecayMs=2000;
  const mid = { bands:new Float32Array(32).fill(0.4), level:0.4, beat:0, centroid:0.5 };   // a SUB-PEAK bar
  let t=0; for(; t<=200; t+=16) E.applyAudioFeatures(st, mid, s, t);
  const start = st.audio.bands[5]; assert.ok(start>0.2 && start<0.6, 'sub-peak bar loaded ('+start.toFixed(2)+')');
  const silent = { bands:new Float32Array(32), level:0, beat:0, centroid:0.5 };
  t+=16; E.applyAudioFeatures(st, silent, s, t); const t0=t;   // silence onset → snapshot
  E.applyAudioFeatures(st, silent, s, t0 + 800);    // 40% of the 2000ms window — old proportional settle would have finished a 0.4 bar by ~800ms
  assert.ok(st.audio.bands[5] > 0.4*start, 'still well-lit at 40% of the window (~0.6× start), i.e. NOT finished early');
  E.applyAudioFeatures(st, silent, s, t0 + 2000 + 60);   // past the full window
  assert.ok(st.audio.bands[5] < 0.02, 'reaches ~0 only after the full pauseDecayMs');
});

test('dynamics depth: a steady bar recedes, a change pops it bright (novelty → hit → brightness)', () => {
  const L = { type:'audio', enabled:true, opacity:1, blend:'add', fps:30, settings:{ style:'bars', barDynamics:true, barDynamicsDepth:100 }, rgb:new Uint8Array(E.NLED*3) };
  E.ensureSettings(L); const st = E.createState([L]); const La = st.layers[0]; const s = La.settings;
  const ap = E.audioParams(s); ap.floor=0; ap.ceil=100; ap.contrast=0; ap.agc=false; ap.gain=1; ap.attackMs=1; ap.decayMs=1;
  const kBase = findK(c => c[0]===0 && c[1]===E.GH-1); assert.ok(kBase>=0, 'found column-0 bottom key');
  const up = { bands:new Float32Array(32), level:0.9, beat:0, centroid:0.5 }; up.bands[0]=1;
  let t=0; for(; t<=1200; t+=16) E.applyAudioFeatures(st, up, s, t);   // hold band 0 high & STEADY → hit decays → recede
  E.renderAudio(La, t, st); const steady = litSum(La, kBase);
  // a change: band 0 dips then jumps back (level stays high → NOT a pause) → novelty spike → hit pops
  const dip = { bands:new Float32Array(32), level:0.9, beat:0, centroid:0.5 }; dip.bands[0]=0.2;
  t+=16; E.applyAudioFeatures(st, dip, s, t);
  t+=16; E.applyAudioFeatures(st, up, s, t);
  E.renderAudio(La, t, st); const popped = litSum(La, kBase);
  assert.ok(popped > 0, 'the popped bar is lit');
  assert.ok(steady < popped*0.35, 'a steady bar recedes well below a fresh change ('+steady+' vs '+popped+')');
  // toggle OFF → no reced­e (depth ignored): same steady input renders full
  s.barDynamics = false; E.renderAudio(La, t+16, st);
  assert.ok(litSum(La, kBase) > popped*0.8, 'with Dynamics off the bar renders full regardless of hit');
});

test('alpha recede: a steady bar fades see-through (layer below shows), a hit makes it opaque', () => {
  const mk = () => E.createState([
    { name:'BG', type:'background', enabled:true, opacity:1, blend:'normal', fps:30, settings:{ color:'#ffffff', period:1, bgMin:100, bgMax:100 } },
    { name:'Audio', type:'audio', enabled:true, opacity:1, blend:'normal', fps:30, settings:{ style:'bars', barDynamicsAlpha:true, barDynamicsDepth:100, barColor:'gradient', barGradA:'#ff0000', barGradB:'#ff0000' } },
  ]);
  const kBase = findK(c => c[0]===0 && c[1]===E.GH-1); assert.ok(kBase>=0, 'found column-0 bottom key'); const o = kBase*4;
  // STEADY (hit=0) at depth 100 → bar fully see-through → the white background shows through
  const st1 = mk(); st1.bri=1; st1.audio.bands.fill(0); st1.audio.bands[0]=1; st1.audio.hit=new Float32Array(32);
  const f1 = E.composeFrame(st1, 100);
  assert.ok(f1[o+2] > 200, 'steady bar is see-through → white background shows (green='+f1[o+2]+')');
  // a HIT (hit=1) → bar opaque → red shows, NOT the background
  const st2 = mk(); st2.bri=1; st2.audio.bands.fill(0); st2.audio.bands[0]=1; st2.audio.hit=new Float32Array(32); st2.audio.hit[0]=1;
  const f2 = E.composeFrame(st2, 100);
  assert.ok(f2[o+1] > 100 && f2[o+2] < 60, 'a hit makes the bar opaque → red shows, not white (r='+f2[o+1]+' g='+f2[o+2]+')');
});
