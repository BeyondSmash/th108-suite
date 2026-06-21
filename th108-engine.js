// th108-engine.js — DOM-free TH108 lighting engine, shared by the controller page and the daemon.
// Pure rendering/compositing logic ported VERBATIM from th108-controller.html.
// All render math/constants/easing/colour logic is unchanged; module globals are threaded through
// an explicit `state` object so the same code runs in the browser and in Node.
(function (root) {
  'use strict';

  // ===== canonical board map (verbatim from th108-daemon/th108-map.js) =====
  const KEYMAP = {"Escape":0,"F1":1,"F2":2,"F3":3,"F4":4,"F5":5,"F6":6,"F7":7,"F8":8,"F9":9,"F10":10,"F11":11,"F12":12,"PrintScreen":99,"ScrollLock":100,"Pause":102,"Backquote":16,"Digit1":17,"Digit2":18,"Digit3":19,"Digit4":20,"Digit5":21,"Digit6":22,"Digit7":23,"Digit8":24,"Digit9":25,"Digit0":26,"Minus":27,"Equal":28,"Backspace":92,"Insert":103,"Home":104,"PageUp":105,"NumLock":29,"NumpadDivide":30,"NumpadMultiply":31,"NumpadSubtract":109,"Tab":32,"KeyQ":33,"KeyW":34,"KeyE":35,"KeyR":36,"KeyT":37,"KeyY":38,"KeyU":39,"KeyI":40,"KeyO":41,"KeyP":42,"BracketLeft":43,"BracketRight":44,"Backslash":60,"Delete":106,"End":107,"PageDown":108,"Numpad7":45,"Numpad8":46,"Numpad9":47,"NumpadAdd":110,"CapsLock":48,"KeyA":49,"KeyS":50,"KeyD":51,"KeyF":52,"KeyG":53,"KeyH":54,"KeyJ":55,"KeyK":56,"KeyL":57,"Semicolon":58,"Quote":59,"Enter":76,"Numpad4":61,"Numpad5":62,"Numpad6":63,"ShiftLeft":64,"KeyZ":65,"KeyX":66,"KeyC":67,"KeyV":68,"KeyB":69,"KeyN":70,"KeyM":71,"Comma":72,"Period":73,"Slash":74,"ShiftRight":75,"ArrowUp":90,"Numpad1":77,"Numpad2":78,"Numpad3":79,"NumpadEnter":95,"ControlLeft":80,"MetaLeft":81,"AltLeft":82,"Space":83,"AltRight":84,"ContextMenu":86,"ControlRight":87,"ArrowLeft":88,"ArrowDown":89,"ArrowRight":91,"Numpad0":93,"NumpadDecimal":94};
  const INDICES = [0,1,2,3,4,5,6,7,8,9,10,11,12,99,100,102,16,17,18,19,20,21,22,23,24,25,26,27,28,92,103,104,105,29,30,31,109,32,33,34,35,36,37,38,39,40,41,42,43,44,60,106,107,108,45,46,47,110,48,49,50,51,52,53,54,55,56,57,58,59,76,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,90,77,78,79,95,80,81,82,83,84,85,86,87,88,89,91,93,94];
  const NLED = INDICES.length;

  // physical full-size layout (LED index -> [x,y,w,h] in key units) — verbatim from controller
  const BOARDW = 22.5, BOARDH = 6.5;   // full-size + numpad ≈ 3.46:1
  const LAYOUT = {"0":[0,0,1,1],"1":[2,0,1,1],"2":[3,0,1,1],"3":[4,0,1,1],"4":[5,0,1,1],"5":[6.5,0,1,1],"6":[7.5,0,1,1],"7":[8.5,0,1,1],"8":[9.5,0,1,1],"9":[11,0,1,1],"10":[12,0,1,1],"11":[13,0,1,1],"12":[14,0,1,1],"16":[0,1.5,1,1],"17":[1,1.5,1,1],"18":[2,1.5,1,1],"19":[3,1.5,1,1],"20":[4,1.5,1,1],"21":[5,1.5,1,1],"22":[6,1.5,1,1],"23":[7,1.5,1,1],"24":[8,1.5,1,1],"25":[9,1.5,1,1],"26":[10,1.5,1,1],"27":[11,1.5,1,1],"28":[12,1.5,1,1],"29":[18.5,1.5,1,1],"30":[19.5,1.5,1,1],"31":[20.5,1.5,1,1],"32":[0,2.5,1.5,1],"33":[1.5,2.5,1,1],"34":[2.5,2.5,1,1],"35":[3.5,2.5,1,1],"36":[4.5,2.5,1,1],"37":[5.5,2.5,1,1],"38":[6.5,2.5,1,1],"39":[7.5,2.5,1,1],"40":[8.5,2.5,1,1],"41":[9.5,2.5,1,1],"42":[10.5,2.5,1,1],"43":[11.5,2.5,1,1],"44":[12.5,2.5,1,1],"45":[18.5,2.5,1,1],"46":[19.5,2.5,1,1],"47":[20.5,2.5,1,1],"48":[0,3.5,1.75,1],"49":[1.75,3.5,1,1],"50":[2.75,3.5,1,1],"51":[3.75,3.5,1,1],"52":[4.75,3.5,1,1],"53":[5.75,3.5,1,1],"54":[6.75,3.5,1,1],"55":[7.75,3.5,1,1],"56":[8.75,3.5,1,1],"57":[9.75,3.5,1,1],"58":[10.75,3.5,1,1],"59":[11.75,3.5,1,1],"60":[13.5,2.5,1.5,1],"61":[18.5,3.5,1,1],"62":[19.5,3.5,1,1],"63":[20.5,3.5,1,1],"64":[0,4.5,2.25,1],"65":[2.25,4.5,1,1],"66":[3.25,4.5,1,1],"67":[4.25,4.5,1,1],"68":[5.25,4.5,1,1],"69":[6.25,4.5,1,1],"70":[7.25,4.5,1,1],"71":[8.25,4.5,1,1],"72":[9.25,4.5,1,1],"73":[10.25,4.5,1,1],"74":[11.25,4.5,1,1],"75":[12.25,4.5,2.75,1],"76":[12.75,3.5,2.25,1],"77":[18.5,4.5,1,1],"78":[19.5,4.5,1,1],"79":[20.5,4.5,1,1],"80":[0,5.5,1.5,1],"81":[1.5,5.5,1.25,1],"82":[2.75,5.5,1.25,1],"83":[4,5.5,6.25,1],"84":[10.25,5.5,1.25,1],"85":[11.5,5.5,1.25,1],"86":[12.75,5.5,1.25,1],"87":[14,5.5,1,1],"88":[15.25,5.5,1,1],"89":[16.25,5.5,1,1],"90":[16.25,4.5,1,1],"91":[17.25,5.5,1,1],"92":[13,1.5,2,1],"93":[18.5,5.5,2,1],"94":[20.5,5.5,1,1],"95":[21.5,4.5,1,2],"99":[15.25,0,1,1],"100":[16.25,0,1,1],"102":[17.25,0,1,1],"103":[15.25,1.5,1,1],"104":[16.25,1.5,1,1],"105":[17.25,1.5,1,1],"106":[15.25,2.5,1,1],"107":[16.25,2.5,1,1],"108":[17.25,2.5,1,1],"109":[21.5,1.5,1,1],"110":[21.5,2.5,1,2]};
  const GW = 21, GH = 6, GRID = {"0":[0,0],"1":[2,0],"2":[3,0],"3":[4,0],"4":[5,0],"5":[6,0],"6":[7,0],"7":[8,0],"8":[9,0],"9":[10,0],"10":[11,0],"11":[12,0],"12":[13,0],"16":[0,1],"17":[1,1],"18":[2,1],"19":[3,1],"20":[4,1],"21":[5,1],"22":[6,1],"23":[7,1],"24":[8,1],"25":[9,1],"26":[10,1],"27":[11,1],"28":[12,1],"29":[17,1],"30":[18,1],"31":[19,1],"32":[0,2],"33":[1,2],"34":[2,2],"35":[3,2],"36":[4,2],"37":[5,2],"38":[6,2],"39":[7,2],"40":[8,2],"41":[9,2],"42":[10,2],"43":[11,2],"44":[12,2],"45":[17,2],"46":[18,2],"47":[19,2],"48":[0,3],"49":[1,3],"50":[2,3],"51":[3,3],"52":[4,3],"53":[5,3],"54":[6,3],"55":[7,3],"56":[8,3],"57":[9,3],"58":[10,3],"59":[11,3],"60":[13,2],"61":[17,3],"62":[18,3],"63":[19,3],"64":[0,4],"65":[2,4],"66":[3,4],"67":[4,4],"68":[5,4],"69":[6,4],"70":[7,4],"71":[8,4],"72":[9,4],"73":[10,4],"74":[11,4],"75":[12,4],"76":[13,3],"77":[17,4],"78":[18,4],"79":[19,4],"80":[0,5],"81":[1,5],"82":[2,5],"83":[6,5],"84":[10,5],"85":[11,5],"86":[12,5],"87":[13,5],"88":[14,5],"89":[15,5],"90":[15,4],"91":[16,5],"92":[13,1],"93":[18,5],"94":[19,5],"95":[20,4],"99":[14,0],"100":[15,0],"102":[16,0],"103":[14,1],"104":[15,1],"105":[16,1],"106":[14,2],"107":[15,2],"108":[16,2],"109":[20,1],"110":[20,2]};

  // ===== geometry (verbatim; controller's grid/layout select is host-side — engine uses LAYOUT) =====
  // In the controller keyCell consulted the DOM `gifMap` select to pick GRID vs LAYOUT. The engine is
  // DOM-free; the layer renderers only ever used the LAYOUT (physical) mapping, so keyCell uses LAYOUT.
  function keyCell(idx){                                // -> [nx,ny,nw,nh] normalized center+size
    const L = LAYOUT[idx]; if (L) return [(L[0]+L[2]/2)/BOARDW, (L[1]+L[3]/2)/BOARDH, L[2]/BOARDW, L[3]/BOARDH];
    return null;   // unknown index (no physical position) → don't draw a phantom key
  }
  // per-layer key cell, optionally rotated about the board center by L.settings.rot degrees
  function layerCell(L, k){
    const c = keyCell(INDICES[k]); if (!c) return null;
    const rot = L.settings.rot | 0;
    if (!rot) return c;
    const a = rot*Math.PI/180, cs = Math.cos(a), sn = Math.sin(a);
    const dx = c[0]-0.5, dy = c[1]-0.5;
    return [0.5+dx*cs-dy*sn, 0.5+dx*sn+dy*cs, c[2], c[3]];
  }

  // ===== pure colour helpers (verbatim from controller) =====
  function hexToRgb(h){ return [parseInt(h.substr(1,2),16),parseInt(h.substr(3,2),16),parseInt(h.substr(5,2),16)]; }
  // HSV (0..1) -> RGB (0..255)
  function hsv2rgb(h,s,v){
    h=((h%1)+1)%1;                                      // wrap hue to 0..1
    const i=Math.floor(h*6), f=h*6-i, p=v*(1-s), q=v*(1-f*s), t=v*(1-(1-f)*s);
    let r,g,b;
    switch(i%6){ case 0:r=v;g=t;b=p;break; case 1:r=q;g=v;b=p;break; case 2:r=p;g=v;b=t;break;
                 case 3:r=p;g=q;b=v;break; case 4:r=t;g=p;b=v;break; default:r=v;g=p;b=q; }
    return [r*255|0, g*255|0, b*255|0];
  }
  // VU meter, DISCRETE by row-from-bottom (6-row board): rows 1-2 green, 3-4 yellow, 5-6 red. Fully
  // saturated, high-contrast (classic 3-zone meter — no lime/orange blends).
  function vuRow(fb){ return fb<=2 ? [0,255,0] : fb<=4 ? [255,255,0] : [255,0,0]; }
  // deterministic per-index hash → 0..1 (stable sparkle/column offsets)
  function patHash(i){ const x=Math.sin(i*127.1+311.7)*43758.5453; return x-Math.floor(x); }
  // one-pole smoothing toward `target`; rising uses attackMs, falling uses decayMs. dt in ms.
  // tau=0 snaps. alpha = 1 - exp(-dt/tau) is the standard exponential-smoothing coefficient.
  function audioEnvelope(prev, target, dtMs, attackMs, decayMs){
    const tau = target >= prev ? attackMs : decayMs;
    if(tau <= 0) return target;
    const a = 1 - Math.exp(-dtMs / tau);
    return prev + (target - prev) * a;
  }
  // shared coloriser: map a 0..1 color coordinate `field` + 0..1 `bright` to [r,g,b] 0..255 per colMode.
  function patColorize(mode, field, bright, C1, C2, C3){
    field=field-Math.floor(field);                 // wrap to 0..1
    bright=bright<0?0:(bright>1?1:bright);          // clamp
    if(mode==='c1'){ return [C1[0]*bright, C1[1]*bright, C1[2]*bright]; }
    if(mode==='c12'){
      const u=1-Math.abs(1-2*field);               // triangle blend → seamless C1↔C2↔C1
      return [(C1[0]+(C2[0]-C1[0])*u)*bright, (C1[1]+(C2[1]-C1[1])*u)*bright, (C1[2]+(C2[2]-C1[2])*u)*bright];
    }
    if(mode==='palette'){
      const stops=[C1,C2,C3,C1], x=field*3, i=Math.floor(x), f=x-i, a=stops[i], b=stops[i+1];
      return [(a[0]+(b[0]-a[0])*f)*bright, (a[1]+(b[1]-a[1])*f)*bright, (a[2]+(b[2]-a[2])*f)*bright];
    }
    const rgb=hsv2rgb(field,1,1);                   // 'rainbow' (default)
    return [rgb[0]*bright, rgb[1]*bright, rgb[2]*bright];
  }

  // Fold a raw feature frame into state.audio with gain, a noise-floor gate, and attack/decay
  // smoothing. `now` is ms; dt is derived from state.audio._t. s = the audio layer's settings.
  function applyAudioFeatures(state, raw, s, now){
    const A = state.audio, p = audioParams(s);   // tuner params are PER-STYLE (gain/floor/attack/decay/beatSens)
    let dt = A._t ? Math.max(1, Math.min(100, now - A._t)) : 16;   // clamp dt (tab-throttle/sleep safe)
    A._t = now;
    // Feature shaping, in order: gain → AUTO-GAIN (ONE global divisor that maps the song's recent LOUD PEAK to
    // the top) → [floor..ceil] range map → CONTRAST gamma. Auto-gain replicates the manual workflow: set things
    // so the true highs reach the ceiling and typical passages sit mid — automatically, per song. The peak RISES
    // instantly (catches a real high) and FALLS slowly (~10s) so quiet parts stay LOW instead of being pumped
    // back up to the top. Crucially it's ONE divisor for the whole spectrum, NOT per-band — the old per-band
    // AGC normalized every band to its own peak, so every active band rode ~1 and the whole board pegged the top
    // with no shape and no dynamics. Manual Gain is now a fine trim/headroom on top (×1 = peak→top).
    const gain = p.gain || 1, lo = (p.floor||0)/100, hi = Math.max(lo + 0.02, (p.ceil==null?100:p.ceil)/100);
    const gamma = 1 + ((p.contrast==null?50:p.contrast)/100)*4;   // 0→1 (linear) … 100→5 (very punchy)
    const agc = p.agc !== false;   // auto-gain ON (default): peak→top per song, no manual re-gain. OFF: Gain is a plain linear sensitivity.
    const shape = (v)=>{ v=(v-lo)/(hi-lo); v=v<=0?0:(v>=1?1:v); return gamma!==1 ? Math.pow(v,gamma) : v; };
    const TARGET = 1.0;                                           // the recent loud peak maps to the TOP (true highs hit the ceiling, like the manual-gain workflow); typical passages fall below → mid
    // Peak follower: rises instantly, falls SLOWLY (~10s) to hold the chorus peak so verses sit lower (dynamics).
    // BUT when the input sits sustained-low (>1s below 30% of the held peak) — a Spotify VOLUME turn-down, not a
    // musical dip — collapse the peak FAST (~1.5s) so absolute volume drops back out within a couple seconds.
    // This is what makes Auto-gain volume-independent quickly instead of lagging ~10-30s. (Quick musical dips
    // never reach 1s sustained, so the slow hold — and the dynamics — are preserved.)
    const SLOW = Math.exp(-dt/10000), FAST = Math.exp(-dt/1000);   // hold ~10s for dynamics; collapse ~1s once a volume turn-down is confirmed
    { let fm = 0; const _rb0 = raw.bands; if(_rb0) for(let i=0;i<32;i++){ const v=_rb0[i]||0; if(v>fm) fm=v; }
      const lm = raw.level||0;
      if(A._gpk == null) A._gpk = 0.12;
      if(A._lpk == null) A._lpk = 0.12;
      // Re-normalize LATCH per peak: once the input has sat <40% of the held peak for >1s (a volume turn-down,
      // not a brief musical dip), collapse the peak FAST until it MEETS the new input level, then resume the slow
      // hold. Latching past the (shrinking) threshold is what lets it fully re-normalize instead of stalling.
      if(A._reG){ A._gpk = Math.max(fm, A._gpk*FAST); if(A._gpk <= fm*1.2 + 0.01) A._reG = false; }
      else { A._gLoMs = (fm < 0.4*A._gpk) ? (A._gLoMs||0)+dt : 0; if(A._gLoMs>1000){ A._reG=true; A._gLoMs=0; } A._gpk = Math.max(fm, A._gpk*SLOW); }
      if(A._reL){ A._lpk = Math.max(lm, A._lpk*FAST); if(A._lpk <= lm*1.2 + 0.01) A._reL = false; }
      else { A._lLoMs = (lm < 0.4*A._lpk) ? (A._lLoMs||0)+dt : 0; if(A._lLoMs>1000){ A._reL=true; A._lLoMs=0; } A._lpk = Math.max(lm, A._lpk*SLOW); } }
    const agB = agc ? TARGET/Math.max(A._gpk, 0.05) : 1;          // 0.05 floor → near-silence noise isn't slammed to full
    const agL = agc ? TARGET/Math.max(A._lpk, 0.05) : 1;
    // Gain multiplies in BOTH modes. With AGC on it's a VOLUME-INDEPENDENT bias (v/peak·gain — the peak scales
    // with volume so it cancels): it's the "how easily the bars hit max" knob (gain>1 pushes more of the song to
    // the top, gain<1 leaves headroom). With AGC off it's a plain linear sensitivity.
    const band   = (v,i)=> shape((v||0)*gain*agB);
    const bandRO = (v,i)=> shape((v||0)*gain*agB);   // L/R reuse the global band divisor (keeps the L↔R balance)
    const lvl    = (v)  => shape((v||0)*gain*agL);
    // PAUSE DECAY: once the input has been silent a sustained moment (paused / song ended), fall to 0 with
    // pauseDecayMs (a graceful settle) instead of the per-note decayMs — brief gaps between notes still bounce.
    // Use the LIVE input level (raw.live), NOT the held/peak values: the decaying peak-hold (metronome-tick
    // fix in audio-capture.js) keeps raw.level/bands elevated for ~400ms after playback stops, which masked the
    // pause so silence was confirmed only after the normal decay had already finished → pauseDecayMs looked
    // dead. raw.live is the true current-frame level (≈0 the instant playback stops). In-tab webCap has no
    // hold, so its raw.level is already live → fall back to it.
    const liveLvl = (raw.live != null ? raw.live : (raw.level || 0));
    // Engage the graceful settle the INSTANT the input goes silent — no confirm window. A confirm let the fast
    // per-note decay (decayMs, often <100ms) drop the level most of the way before pause-decay even kicked in,
    // so the slider looked dead. Mid-song the live level basically never hits this gate (music is continuous),
    // so true silence ⇒ pause/stop. Only the FALL is affected (audioEnvelope picks decay when target<prev).
    // Detect "quieting toward a pause" RELATIVE to the recent level peak, not just near-zero: on pause the audio
    // fades over ~200ms, and during that fade the live level is still well above an absolute gate — so the fast
    // decay ate the bar before pause-decay could engage (the slider barely mattered). Engaging when the input
    // drops below a fraction of its recent peak starts the slow settle while the bar still has height.
    const silent = (liveLvl * gain < 0.02) || (liveLvl < 0.42 * (A._lpk || 0.2));   // relative pause gate — capped ~0.42; higher treats normal sub-peak playback as silent (breaks shaping, see contrast test)
    // PAUSE = a LINEAR glide to 0, not the exponential audioEnvelope. A one-pole decay drops fast then has a long
    // tail, so the tall (upper) rows cleared in ~1s while the base row rode the tail for the rest — looked like
    // "pause-decay only affects the bottom row". Linear = constant descent: every row turns off evenly and the
    // WHOLE bar takes ~pauseDecayMs to reach 0 (a full-height bar; shorter bars finish proportionally sooner).
    const pauseMs = (p.pauseDecayMs==null ? 700 : p.pauseDecayMs);
    const settle = (cur)=> Math.max(0, cur - dt/Math.max(60, pauseMs));   // full-scale (0..1) drop per pauseMs
    const tgtLevel = lvl(raw.level);
    A.level = silent ? settle(A.level) : audioEnvelope(A.level, tgtLevel, dt, p.attackMs, p.decayMs);
    A.centroid = audioEnvelope(A.centroid, (raw.centroid==null?0.5:raw.centroid), dt, p.attackMs, p.decayMs);
    // beat: instantaneous rise, decay only (so a kick pops then fades); beatSens scales sensitivity
    const beatTgt = Math.max(0, Math.min(1, (raw.beat||0) * (0.5 + (p.beatSens||50)/100)));
    A.beat = Math.max(beatTgt, audioEnvelope(A.beat, 0, dt, 0, Math.max(60, p.decayMs)));
    const rb = raw.bands, rbL = raw.bandsL, rbR = raw.bandsR;
    // L/R channels feed the 'stereo' bars layout; when the source is mono (no bandsL/R) both fall back to
    // the mono band so the stereo layout still shows something (just symmetric) instead of going dark.
    if(!A.bandsL) A.bandsL = new Float32Array(32);
    if(!A.bandsR) A.bandsR = new Float32Array(32);
    if(!A.bandsRaw) { A.bandsRaw = new Float32Array(32); A.bandsRawL = new Float32Array(32); A.bandsRawR = new Float32Array(32); }
    const rawClamp = (v)=>{ v=(v||0); return v<0?0:(v>1?1:v); };   // pre-AGC magnitude (NO peak normalize) — keeps the real bass→treble shape for Spread
    for(let i=0;i<32;i++){
      const t = rb ? band(rb[i], i) : 0; A.bands[i] = silent ? settle(A.bands[i]) : audioEnvelope(A.bands[i], t, dt, p.attackMs, p.decayMs);
      const tL = rbL ? bandRO(rbL[i], i) : t; A.bandsL[i] = silent ? settle(A.bandsL[i]) : audioEnvelope(A.bandsL[i], tL, dt, p.attackMs, p.decayMs);
      const tR = rbR ? bandRO(rbR[i], i) : t; A.bandsR[i] = silent ? settle(A.bandsR[i]) : audioEnvelope(A.bandsR[i], tR, dt, p.attackMs, p.decayMs);
      const r = rb ? rawClamp(rb[i]) : 0;
      A.bandsRaw[i]  = silent ? settle(A.bandsRaw[i])  : audioEnvelope(A.bandsRaw[i],  r, dt, p.attackMs, p.decayMs);
      A.bandsRawL[i] = silent ? settle(A.bandsRawL[i]) : audioEnvelope(A.bandsRawL[i], rbL ? rawClamp(rbL[i]) : r, dt, p.attackMs, p.decayMs);
      A.bandsRawR[i] = silent ? settle(A.bandsRawR[i]) : audioEnvelope(A.bandsRawR[i], rbR ? rawClamp(rbR[i]) : r, dt, p.attackMs, p.decayMs);
    }
  }
  // Per-STYLE tuner params (gain/floor/attack/decay/beatSens) so tuning bars doesn't leak into pulse, etc.
  // Mirrors patParams: one-time migrates the old flat values onto the current style; new styles start at defaults.
  const AUDIO_TUNE_DEFAULTS = { gain:1, floor:5, ceil:100, contrast:50, agc:true, attackMs:40, decayMs:220, pauseDecayMs:700, beatSens:50 };
  function audioParams(s){
    const style = s.style || 'bars';
    if(!s.ap){
      const seed = { gain:s.gain, floor:s.floor, attackMs:s.attackMs, decayMs:s.decayMs, beatSens:s.beatSens };
      Object.keys(seed).forEach(k=>{ if(seed[k]==null) delete seed[k]; });
      s.ap = {}; s.ap[style] = Object.assign({}, AUDIO_TUNE_DEFAULTS, seed);
    }
    if(!s.ap[style]) s.ap[style] = Object.assign({}, AUDIO_TUNE_DEFAULTS);
    else { const o = s.ap[style]; for(const k in AUDIO_TUNE_DEFAULTS) if(o[k] == null) o[k] = AUDIO_TUNE_DEFAULTS[k]; }   // backfill keys added after this layer was first saved (ceil/contrast/pauseDecayMs) IN-PLACE — must keep the SAME object reference so the panel's `ap` and the render/save path stay in sync (reassigning a fresh object orphaned slider edits → Tuning reset on refresh + live edits ignored)
    return s.ap[style];
  }

  // ===== per-pattern params (verbatim from controller) =====
  const PAT_DEFAULTS={ colMode:'rainbow', color:'#00ffff', color2:'#ff00ff', color3:'#00ff00', speed:50, scale:10, gap:150, cox:-8, coy:-10 };
  function patParams(s){
    if(!s.pp){                                              // one-time migration: existing flat values belong to the currently-selected pattern
      const seed={ colMode:s.colMode, color:s.color, color2:s.color2, color3:s.color3, speed:s.speed, scale:s.scale, gap:s.gap, cox:s.cox, coy:s.coy };
      Object.keys(seed).forEach(k=>{ if(seed[k]==null) delete seed[k]; });
      s.pp={}; s.pp[s.pattern]=Object.assign({}, PAT_DEFAULTS, seed);
    }
    if(!s.pp[s.pattern]) s.pp[s.pattern]=Object.assign({}, PAT_DEFAULTS);   // a freshly-selected pattern starts from defaults
    return s.pp[s.pattern];
  }

  // ===== per-layer renderers (verbatim; reactive buffers threaded via `state`) =====
  function renderBackground(L,now){
    const s=L.settings, [br,bg_,bb]=hexToRgb(s.color);
    const ph=now/Math.max(1,s.period)*2*Math.PI;        // pulse phase (free-running clock)
    const lo=s.bgMin/100, hi=s.bgMax/100;
    const b=lo+(hi-lo)*(0.5+0.5*Math.sin(ph));
    const r=br*b|0, g=bg_*b|0, bl=bb*b|0, out=L.rgb;
    for(let k=0;k<NLED;k++){ const o=k*3; out[o]=r; out[o+1]=g; out[o+2]=bl; }
  }
  // reactive intensity envelope: shapes a key's flash over `elapsed` ms using hold/fade. → 0..1
  function reactEnvelope(elapsed, hold, fade, style){
    if(elapsed<0) return 0;
    const dur=hold+fade;                                   // total flash lifetime for the cyclic styles
    switch(style){
      case 'double-blink': {                               // two quick full blinks, then fade out
        if(elapsed<70)  return 1;
        if(elapsed<140) return 0;
        if(elapsed<210) return 1;
        return Math.max(0, 1-(elapsed-210)/fade);
      }
      case 'blink': {                                       // square on/off ~6 Hz for hold+fade, then 0
        if(elapsed>=dur) return 0;
        return (Math.floor(elapsed/(1000/12))%2===0) ? 1 : 0;   // 12 toggles/s = 6 Hz on/off
      }
      case 'strobe': {                                      // fast on/off ~14 Hz for hold+fade, then 0
        if(elapsed>=dur) return 0;
        return (Math.floor(elapsed/(1000/28))%2===0) ? 1 : 0;
      }
      case 'pulse': {                                       // sin pulse that decays out
        const decay=Math.max(0, 1-elapsed/dur);
        return (0.5+0.5*Math.sin(elapsed/120))*decay;
      }
      case 'ramp': {                                        // fade IN then OUT
        const up=hold>0?hold:120;
        if(elapsed<up) return elapsed/up;
        return Math.max(0, 1-(elapsed-up)/fade);
      }
      case 'heartbeat': {                                   // lub-dub bumps repeating, decaying with the flash
        const decay=Math.max(0, 1-elapsed/dur);
        if(decay<=0) return 0;
        const beat=elapsed%800;                            // 800ms cardiac cycle
        const bump=(c,w)=>{ const d=beat-c; return Math.exp(-(d*d)/(2*w*w)); };
        return Math.min(1, bump(60,42)+0.7*bump(220,42))*decay;   // lub (strong) then dub (softer)
      }
      case 'fade':
      default:
        return elapsed<=hold ? 1 : Math.max(0, 1-(elapsed-hold)/fade);
    }
  }
  function renderReactive(L,now,state){
    const s=L.settings, out=L.rgb;
    const react=state.react, reactDown=react.down, reactUp=react.up, reactT=react.t;
    const A=hexToRgb(s.color), B=hexToRgb(s.colorB||'#00ffff'), C=hexToRgb(s.colorC||'#00ff00');
    const mode=s.mode||'single', style=s.style||'fade';
    const hold=Math.max(0,s.hold||0), fade=Math.max(1,s.fade);
    // shimmer rate: s.shimmer (0..100 → 0..6 Hz) if present, else fixed 3 Hz
    const shimmerHz = (s.shimmer!==undefined) ? (s.shimmer/100)*6 : 3;
    if(!L._inten || L._inten.length!==NLED) L._inten=new Float32Array(NLED);
    // random-mode per-key state: _seen = press-time the color was assigned for, _col = locked RGB
    if(!L._seen || L._seen.length!==NLED){ L._seen=new Float64Array(NLED).fill(-1e12); L._col=new Uint8Array(NLED*3); }
    if(L._lastHue===undefined) L._lastHue=-1; if(L._lastPalI===undefined) L._lastPalI=-1;
    if(L._seqI===undefined) L._seqI=0;   // round-robin pointer for sequential mode
    const palList=(Array.isArray(s.pal)?s.pal:[]).filter(h=>typeof h==='string' && h.length===7 && h[0]==='#');
    const tsec=now/1000;
    for(let k=0;k<NLED;k++){
      const o=k*3, idx=INDICES[k];
      let inten = reactDown[idx] ? 1 : reactEnvelope(now-reactUp[idx], hold, fade, style);   // full while physically held; fade/animate from release
      L._inten[k]=inten;
      if(inten<=0){ out[o]=out[o+1]=out[o+2]=0; continue; }
      let cr,cg,cb;
      if(mode==='random'){
        // new press for this slot? (press time differs from what we locked the color at) → pick a fresh color
        if(reactT[idx]!==L._seen[k]){
          let rgb;
          if(s.anyColor){
            let h=Math.random();
            for(let tries=0; tries<8 && L._lastHue>=0; tries++){
              let dh=Math.abs(h-L._lastHue); dh=Math.min(dh,1-dh);   // wrap-around hue distance
              if(dh>=0.12) break;
              h=Math.random();
            }
            L._lastHue=h; rgb=hsv2rgb(h,1,1);
          } else if(palList.length){
            let pi=Math.floor(Math.random()*palList.length);
            if(palList.length>1){ for(let tries=0; tries<6 && pi===L._lastPalI; tries++) pi=Math.floor(Math.random()*palList.length); }
            L._lastPalI=pi; rgb=hexToRgb(palList[pi]);
          } else { rgb=[255,255,255]; }
          L._col[k*3]=rgb[0]; L._col[k*3+1]=rgb[1]; L._col[k*3+2]=rgb[2];
          L._seen[k]=reactT[idx];
        }
        cr=L._col[k*3]; cg=L._col[k*3+1]; cb=L._col[k*3+2];
      }
      else if(mode==='sequential'){
        // lock the NEXT color in the chosen sequence on each new press (round-robin)
        if(reactT[idx]!==L._seen[k]){
          const seq = s.seqSrc==='palette' ? palList.map(hexToRgb) : [A,B,C];
          const rgb = seq.length ? seq[L._seqI % seq.length] : [255,255,255];
          L._seqI = (L._seqI+1) % (seq.length||1);
          L._col[k*3]=rgb[0]; L._col[k*3+1]=rgb[1]; L._col[k*3+2]=rgb[2];
          L._seen[k]=reactT[idx];
        }
        cr=L._col[k*3]; cg=L._col[k*3+1]; cb=L._col[k*3+2];
      }
      else if(mode==='single'){ cr=A[0]; cg=A[1]; cb=A[2]; }
      else {
        const phase=patHash(idx);   // per-key phase offset so keys shimmer out of phase
        if(mode==='ab'){
          const m=0.5+0.5*Math.sin(tsec*shimmerHz*2*Math.PI + phase*6.283);
          cr=A[0]+(B[0]-A[0])*m; cg=A[1]+(B[1]-A[1])*m; cb=A[2]+(B[2]-A[2])*m;
        } else {   // 'rgb' — cycle A→B→C→A
          let u=(tsec*shimmerHz/3 + phase); u=u-Math.floor(u);   // 0..1
          const stops=[A,B,C,A], pos=u*3, i0=Math.floor(pos), f=pos-i0;
          const s0=stops[i0], s1=stops[i0+1];
          cr=s0[0]+(s1[0]-s0[0])*f; cg=s0[1]+(s1[1]-s0[1])*f; cb=s0[2]+(s1[2]-s0[2])*f;
        }
      }
      out[o]=cr*inten|0; out[o+1]=cg*inten|0; out[o+2]=cb*inten|0;
    }
  }
  function renderGradient(L,now){
    const s=L.settings, [ar,ag,ab]=hexToRgb(s.colorA), [r2,g2,b2]=hexToRgb(s.colorB), out=L.rgb;
    const rad=s.angle*Math.PI/180, ux=Math.cos(rad), uy=Math.sin(rad);   // gradient axis direction
    // advance scroll phase: scroll (0..1) → up to ~0.6 full cycles/sec
    if(s.scroll>0){ const dt = s._lt ? now-s._lt : 0; s.phase=(s.phase + s.scroll*0.6*dt/1000)%1; }
    s._lt=now;
    for(let k=0;k<NLED;k++){ const c=layerCell(L,k); const o=k*3;
      if(!c){ out[o]=out[o+1]=out[o+2]=0; continue; }
      // project key center (0..1) onto the axis, recenter to 0..1, add scroll phase
      let t=(c[0]-0.5)*ux+(c[1]-0.5)*uy+0.5+s.phase;
      t=t-Math.floor(t);
      const tt=1-Math.abs(1-2*t);   // triangle (A→B→A) so the scrolling gradient loops with no hard seam
      out[o]=ar+(r2-ar)*tt|0; out[o+1]=ag+(g2-ag)*tt|0; out[o+2]=ab+(b2-ab)*tt|0; }
  }
  function renderMedia(L,now){ L.rgb.fill(0); }   // media layers are a no-op in the engine (page-only in v1)
  // individual-keys layer: paint explicit per-key colors. settings.keys = {ledIndex:'#rrggbb'};
  // unpainted keys are black, i.e. transparent under the 'replace' blend (painted keys override below).
  // fill 'subtract' (settings.fill): the painted keys CARVE the layers below dark instead of drawing their
  // color — the painted shape reads as a negative-space silhouette (same mechanism as bars 'subtract').
  function renderKeys(L){
    const s=L.settings||{}, keys=s.keys||{}, out=L.rgb;
    const subtract = s.fill === 'subtract';
    let cb=null, any=false;
    if(subtract){ cb = L._carveBuf || (L._carveBuf = new Float32Array(NLED)); cb.fill(0); }
    for(let k=0;k<NLED;k++){ const o=k*3, hex=keys[INDICES[k]];
      if(hex){
        if(subtract){ cb[k]=1; any=true; out[o]=out[o+1]=out[o+2]=0; }   // painted key carves below → dark silhouette
        else { const c=hexToRgb(hex); out[o]=c[0]; out[o+1]=c[1]; out[o+2]=c[2]; } }
      else { out[o]=out[o+1]=out[o+2]=0; } }
    L._carve = (subtract && any) ? cb : null;   // clear when solid / nothing painted (else a stale mask keeps carving)
  }

  function renderAudio(L, now, state){
    const s = L.settings, out = L.rgb, A = state.audio;
    out.fill(0);
    L._carve = null;                          // only bars 'subtract' fill sets a carve mask (cleared each frame)
    const style = s.style || 'bars';
    if(style==='bars') renderBars(s, out, A, now, L);
    else if(style==='pulse') renderPulse(s, out, A, now);
    else if(style==='bloom') renderBloom(s, out, A);
    else if(style==='wave') renderWave(s, out, A, now);
    else if(style==='plasma') renderPlasma(s, out, A, now);
    else if(style==='aurora') renderAurora(s, out, A, now);
    else if(style==='sparkle') renderSparkle(s, out, A, now);
    else if(style==='radial') renderRadial(s, out, A, now);
    else renderBars(s, out, A, now, L);
  }

  // ===== abstract / WMP-style visualizers (auto-colored from the spectrum; all fade to dark on silence) =====
  // Plasma: a flowing sine field; flow speed + brightness ride loudness, hue drifts with spectral brightness.
  function renderPlasma(s, out, A, now){
    const t = now/1000 * (0.4 + A.level*1.6);
    const energy = Math.min(1, A.level*1.5 + A.beat*0.8);            // → dark on silence
    const amp = 0.5 + A.beat*0.5;
    for(let k=0;k<NLED;k++){ const cell=GRID[INDICES[k]]; if(!cell) continue; const o=k*3;
      const x=GW>1?cell[0]/(GW-1):0, y=GH>1?cell[1]/(GH-1):0;
      const p=(Math.sin(x*3+t)+Math.sin(y*4-t*0.8)+Math.sin((x+y)*3+t*0.6)+Math.sin(Math.hypot(x-0.5,y-0.5)*8-t*1.2))/4;  // -1..1
      const v=Math.max(0,Math.min(1, amp*(0.45+0.55*(0.5+0.5*Math.sin(p*Math.PI*1.5)))*energy));
      const c=hsv2rgb(A.centroid*0.6 + p*0.2 + t*0.02, 1, v); out[o]=c[0]|0; out[o+1]=c[1]|0; out[o+2]=c[2]|0; }
  }
  // Aurora: soft vertical color curtains that sway with time and lift/brighten with each column's energy.
  function renderAurora(s, out, A, now){
    const t = now/1000;
    for(let k=0;k<NLED;k++){ const cell=GRID[INDICES[k]]; if(!cell) continue; const o=k*3;
      const x=GW>1?cell[0]/(GW-1):0, y=GH>1?cell[1]/(GH-1):0;
      const mag=A.bands[Math.min(31,Math.round(x*31))];
      const centerY = 0.5 - 0.28*Math.sin(t*0.6 + x*4) - mag*0.35;   // y=0 top
      const v=Math.max(0,Math.min(1, Math.exp(-Math.pow((y-centerY)*2.4,2)) * (0.85*A.level + A.beat*0.4)));   // no idle floor → dark on silence
      if(v<0.03){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const c=hsv2rgb(0.45 + A.centroid*0.35 + x*0.12, 0.85, v); out[o]=c[0]|0; out[o+1]=c[1]|0; out[o+2]=c[2]|0; }
  }
  // Starfield: per-key twinkle; louder = more stars lit, kicks burst a subset.
  function renderSparkle(s, out, A, now){
    const t = now/1000, energy = Math.max(0, Math.min(1, A.level*0.7 + A.beat*0.6));
    for(let k=0;k<NLED;k++){ const o=k*3, ph=patHash(INDICES[k]);
      const tw=0.5+0.5*Math.sin(t*(2.5+ph*5) + ph*6.283), thr=1-energy;
      let v = tw>thr ? (tw-thr)/Math.max(0.02,energy) : 0;
      v = Math.min(1, v*(0.6+0.4*A.level) + (A.beat>0.5 && ph>0.6 ? A.beat*0.6 : 0));
      if(v<0.03){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const c=hsv2rgb(ph + t*0.08, 0.9, v); out[o]=c[0]|0; out[o+1]=c[1]|0; out[o+2]=c[2]|0; }
  }
  // Radial spectrum: distance from board center → band (center bass, edge treble); rainbow by angle.
  function renderRadial(s, out, A, now){
    const cx=(GW-1)/2, cy=(GH-1)/2, maxd=Math.hypot(cx,cy)||1, t=now/1000;
    for(let k=0;k<NLED;k++){ const cell=GRID[INDICES[k]]; if(!cell) continue; const o=k*3;
      const dx=cell[0]-cx, dy=cell[1]-cy, d=Math.hypot(dx,dy)/maxd;
      const v=Math.max(0,Math.min(1, A.bands[Math.min(31,Math.round(d*31))]*(0.5+A.beat*0.5)));
      if(v<0.03){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const c=hsv2rgb(Math.atan2(dy,dx)/(2*Math.PI)+0.5 + t*0.1, 1, v); out[o]=c[0]|0; out[o+1]=c[1]|0; out[o+2]=c[2]|0; }
  }
  // Bars: column (GRID col 0..GW-1) → frequency band; each bar fills by that band's magnitude.
  // s.barLayout picks BOTH the horizontal frequency mapping and the vertical fill direction:
  //   standard (bass L→treble R, grow up) | reverse (treble L→bass R, up) | mirror (bass center, up)
  //   | stereo (left half = L channel, right half = R channel, up) | topdown (bass L→treble R, grow DOWN)
  //   | centerout (bass L→treble R, grow from the middle row OUTWARD).
  // The bar's TIP key (s.barTip) can take a contrasting outline; fill 'subtract' (s.barFill) carves the
  // bar BODY into the layers below (a silhouette) while the tips still draw.
  function renderBars(s, out, A, now, L){
    const bass = hexToRgb(s.barColorBass||'#ff2200'), treb = hexToRgb(s.barColorTreble||'#22aaff');
    const gradA = hexToRgb(s.barGradA||'#00ff66'), gradB = hexToRgb(s.barGradB||'#ff00aa');
    const tip = s.barTip || 'off', tipCol = hexToRgb(s.barTipColor||'#ffffff'), t = (now||0)/1000;
    const barColor = s.barColor || 'bassTreble';            // bassTreble (horizontal) | gradient (vert 2-color) | vu (green→red by height)
    const subtract = s.barFill === 'subtract';
    const layout = s.barLayout || 'standard';
    const drive = s.barDrive || 'spectrum';   // what the bar HEIGHT follows: per-column frequency | overall volume | beat
    const spread = !!s.barSpread;             // volume/beat: shape columns by the per-column spectrum/stereo (per Layout) so they rise individually instead of as one wall
    const ctr = (GW-1)/2;
    const vert = layout==='topdown' ? 'down' : layout==='centerout' ? 'center' : 'up';   // vertical fill mode
    const midRow = (GH-1)/2, halfH = GH/2;
    // Spread uses the RAW (pre-AGC) spectrum so columns actually differ; normalize to the loudest band this
    // frame so the shape spans the full range (AGC'd bands all ride ~1 → no shape → "feature does nothing").
    const useSpread = spread && drive!=='spectrum' && A.bandsRaw;
    let maxRaw = 0.05; if(useSpread){ for(let i=0;i<32;i++) if(A.bandsRaw[i]>maxRaw) maxRaw=A.bandsRaw[i]; }
    let cb = null, any = false;
    if(subtract && L){ cb = L._carveBuf || (L._carveBuf = new Float32Array(NLED)); cb.fill(0); }
    // tip color (fc = column for rainbow drift; vuFb = the fill level scaled to the 6-row VU palette)
    const tipColorAt = (fc, vuFb) => tip==='rainbow' ? hsv2rgb(fc + t*0.15, 1, 1) : tip==='vu' ? vuRow(vuFb) : tipCol;
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const col = cell[0], row = cell[1], o = k*3;
      // --- horizontal: fc (0 bass … 1 treble, also drives coloring) + which band/channel ---
      let fc, bandsArr = A.bands, rawArr = A.bandsRaw;
      if(layout==='mirror'){ fc = ctr>0 ? Math.abs(col-ctr)/ctr : 0; }                                   // bass in the center, treble at both edges
      else if(layout==='stereo'){                                                                         // left half = L channel, right half = R channel; bass meets in the middle
        if(col<=ctr){ bandsArr = A.bandsL||A.bands; rawArr = A.bandsRawL||A.bandsRaw; fc = ctr>0 ? (ctr-col)/ctr : 0; }                     // left side: center=bass → left edge=treble
        else { bandsArr = A.bandsR||A.bands; rawArr = A.bandsRawR||A.bandsRaw; fc = (GW-1-ctr)>0 ? (col-ctr)/(GW-1-ctr) : 0; }              // right side: center=bass → right edge=treble
      }
      else if(layout==='reverse'){ fc = GW>1 ? 1 - col/(GW-1) : 0; }                                      // treble left → bass right (mirror of standard)
      else { fc = GW>1 ? col/(GW-1) : 0; }                                                                // standard / topdown / centerout: bass left → treble right
      const band = Math.min(31, Math.round(fc*31));
      const colE = (bandsArr||A.bands)[band];                  // this column's spectrum value (per Layout: stereo = its L/R channel)
      let mag = drive==='volume' ? A.level : drive==='beat' ? A.beat : colE;
      if(useSpread){ const sh = (rawArr||A.bandsRaw)[band]/maxRaw; mag = mag*(0.25 + 1.45*(sh>1?1:sh)); }   // shape volume/beat by the RAW per-column spectrum/stereo → columns rise individually
      if(mag>1) mag=1;
      // --- vertical: fb = fill level from base(1) → tip(steps); litCount = how many levels this bar fills ---
      let fb, steps;
      if(vert==='center'){ steps = halfH; fb = Math.ceil(Math.abs(row - midRow)); }   // distance out from the middle row (1=innermost)
      else { steps = GH; fb = vert==='down' ? (row+1) : ((GH-1) - row + 1); }         // down: base at top; up: base at bottom
      const litCount = mag*steps;
      // Sub-row fill: with only GH=6 rows a band hovering between levels would just toggle the top row on/off
      // (reads as an "edge flicker", not motion). Light the top partial row at its FRACTIONAL fill so the bar
      // glides up/down smoothly — the classic analyzer look. partial: >1 full row, 0..1 the top row, <=0 empty.
      const partial = litCount - (fb - 1);
      if(partial <= 0){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const fillF = partial < 1 ? partial : 1;
      const h = fb/steps;                                     // brightness-ramp coord (dimmer at base … brightest at tip)
      const hc = steps>1 ? (fb-1)/(steps-1) : 0;              // COLOR coord 0 (base) … 1 (tip)
      const vuFb = vert==='center' ? fb*2 : fb;               // center has only 3 levels/side → scale to the 6-step VU palette
      const isTip = tip!=='off' && partial <= 1;              // the topmost (partial) level of this bar = its tip
      if(subtract){
        if(cb){ cb[k]=1; any=true; }                          // carve the layers below at every bar-body key
        if(isTip){ const tc = tipColorAt(fc, vuFb); out[o]=(tc[0]*fillF)|0; out[o+1]=(tc[1]*fillF)|0; out[o+2]=(tc[2]*fillF)|0; }
        else { out[o]=out[o+1]=out[o+2]=0; }                  // empty body → reads as a dark silhouette via the carve
        continue;
      }
      if(isTip){ const tc = tipColorAt(fc, vuFb); out[o]=(tc[0]*fillF)|0; out[o+1]=(tc[1]*fillF)|0; out[o+2]=(tc[2]*fillF)|0; continue; }
      let c, v;
      if(barColor==='vu'){ c = vuRow(vuFb); v = fillF; }                                      // discrete green→yellow→red by fill level
      else { v = (0.45 + 0.55*h) * fillF;                                                     // ramp only for the solid/gradient fills
        if(barColor==='gradient') c = [gradA[0]+(gradB[0]-gradA[0])*hc, gradA[1]+(gradB[1]-gradA[1])*hc, gradA[2]+(gradB[2]-gradA[2])*hc];  // base→tip
        else c = [bass[0]+(treb[0]-bass[0])*fc, bass[1]+(treb[1]-bass[1])*fc, bass[2]+(treb[2]-bass[2])*fc]; }   // bass→treble (per column)
      out[o]=(c[0]*v)|0; out[o+1]=(c[1]*v)|0; out[o+2]=(c[2]*v)|0;
    }
    if(L) L._carve = (subtract && any) ? cb : null;
  }

  // Pulse: uniform wash; hue from centroid, brightness from level+beat, faint per-key shimmer.
  function renderPulse(s, out, A, now){
    const base = hexToRgb(s.pulseColor||'#19b6ff'), base2 = hexToRgb(s.pulseColor2||'#ff00aa'), grad = !!s.pulseGrad;
    // beat-dominant so kicks PUNCH; small level term keeps a body during sustained sound. NO idle floor
    // → silence goes fully dark (so the board visibly pumps WITH the beat rather than sitting half-lit).
    const v = Math.max(0, Math.min(1, A.level*0.5 + A.beat*0.95));
    const t = now/1000;
    for(let k=0;k<NLED;k++){
      const o=k*3, sh = 0.92 + 0.08*Math.sin(t*8 + k);
      const vv = v*sh;
      let c = base;
      if(grad){ const cell=GRID[INDICES[k]], h = cell ? ((GH-1)-cell[1])/(GH-1) : 0.5;   // bottom→top
        c=[base[0]+(base2[0]-base[0])*h, base[1]+(base2[1]-base[1])*h, base[2]+(base2[2]-base[2])*h]; }
      out[o]=(c[0]*vv)|0; out[o+1]=(c[1]*vv)|0; out[o+2]=(c[2]*vv)|0;
    }
  }

  // Bloom: a ring expands from board center as beat decays, gated by audio energy so silence is dark.
  function renderBloom(s, out, A){
    const col0 = hexToRgb(s.bloomColor||'#ff5a00'), col2 = hexToRgb(s.bloomColor2||'#ffd000'), grad = !!s.bloomGrad;
    const cx = (GW-1)/2, cy = (GH-1)/2;
    // BEAT-driven: a kick (beat→1) lights the center, then the ring expands outward as beat decays.
    // energy leans hard on beat (small level body) so it reads as discrete blooms, not a brightness wash.
    const energy = Math.max(A.beat, A.level*0.3);
    const radius = (1 - A.beat) * 1.5;              // 0 at the kick → grows out
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const o = k*3;
      const dx = (cell[0]-cx)/cx, dy = (cell[1]-cy)/cy, d = Math.sqrt(dx*dx+dy*dy);
      const ring = Math.exp(-Math.pow(d - radius, 2) * 5);
      const v = Math.max(0, Math.min(1, ring*energy*1.4));
      if(v < 0.04){ out[o]=out[o+1]=out[o+2]=0; continue; }
      let c = col0;
      if(grad){ const dn = Math.min(1, d/1.41); c=[col0[0]+(col2[0]-col0[0])*dn, col0[1]+(col2[1]-col0[1])*dn, col0[2]+(col2[2]-col0[2])*dn]; }   // center→edge
      out[o]=(c[0]*v)|0; out[o+1]=(c[1]*v)|0; out[o+2]=(c[2]*v)|0;
    }
  }

  // Wave: per-column sample forms an oscilloscope line scrolling across the board; light the key
  // nearest the line, amplitude scaled by that column's band energy.
  function renderWave(s, out, A, now){
    const col0 = hexToRgb(s.waveColor||'#00e0ff'), col2 = hexToRgb(s.waveColor2||'#ff00aa'), grad = !!s.waveGrad;
    const t = now/1000, dir = s.waveReverse ? -1 : 1;   // flip the per-column phase to scroll the trace the other way
    const lvl = Math.max(0, Math.min(1, A.level));
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const col = cell[0], row = cell[1], o = k*3;
      const fc = GW>1 ? col/(GW-1) : 0;
      const band = Math.min(31, Math.round(fc*31));
      // deflection is the column's BAND energy (no constant floor) → loud bands bulge, quiet sit flat;
      // overall brightness tracks loudness so the trace fades out on silence (follows the song).
      const samp = 0.5 + 0.48*Math.sin(t*6 + dir*col*0.6) * A.bands[band];
      const line = samp*(GH-1), v = Math.max(0, 1 - Math.abs(row-line)*0.9) * (0.15 + 0.85*lvl);
      if(v < 0.05){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const c = grad ? [col0[0]+(col2[0]-col0[0])*fc, col0[1]+(col2[1]-col0[1])*fc, col0[2]+(col2[2]-col0[2])*fc] : col0;   // start→end (left→right)
      out[o]=(c[0]*v)|0; out[o+1]=(c[1]*v)|0; out[o+2]=(c[2]*v)|0;
    }
  }

  // ----- common per-layer adjust (verbatim): saturation→contrast→gamma→brightness -----
  function applyAdjust(L){
    const s=L.settings; if(!s) return;
    const sat=s.sat/100, con=s.con/100, gam=s.gam/100, bri=s.bri/100;
    if(sat===1 && con===1 && gam===1 && bri===1) return;   // all defaults → skip the work
    const out=L.rgb;
    for(let k=0;k<NLED;k++){ const o=k*3; let r=out[o], g=out[o+1], b=out[o+2];
      if(sat!==1){ const y=0.299*r+0.587*g+0.114*b; r=y+(r-y)*sat; g=y+(g-y)*sat; b=y+(b-y)*sat; }
      if(con!==1){ r=(r-128)*con+128; g=(g-128)*con+128; b=(b-128)*con+128; }
      r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
      if(gam!==1){ r=255*Math.pow(r/255,gam); g=255*Math.pow(g/255,gam); b=255*Math.pow(b/255,gam); }
      out[o]=Math.max(0,Math.min(255,r*bri))|0; out[o+1]=Math.max(0,Math.min(255,g*bri))|0; out[o+2]=Math.max(0,Math.min(255,b*bri))|0;
    }
  }
  // per-layer clock: scales by speed and freezes when static. Returns accumulated ms.
  function layerNow(L, now){
    const dt = now - (L._lastNow ?? now); L._lastNow = now;
    if(L._clk===undefined) L._clk=0;
    if(!L.settings.frozen) L._clk += dt * (L.settings.spd/100);
    return L._clk;
  }

  function renderPattern(L,now){
    const s=L.settings, out=L.rgb, t=now/1000;
    const pp=patParams(s), pat=s.pattern;
    const C1=hexToRgb(pp.color||'#00ffff'), C2=hexToRgb(pp.color2||'#ff00ff'), C3=hexToRgb(pp.color3||'#00ff00');
    const colMode=pp.colMode||'rainbow';                    // rainbow | c1 | c12 | palette
    const spd=(pp.speed||0)/100, scl=(pp.scale||0)/100;      // 0..1 normalized controls
    const speedK=spd*2;                                      // hue/phase cycles per second-ish
    const scaleK=0.5+scl*5;                                  // spatial frequency (waves/ripples/rainbow span)
    for(let k=0;k<NLED;k++){
      const c=layerCell(L,k); const o=k*3;
      if(!c){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const nx=c[0], ny=c[1];
      let R=0,G=0,B=0;
      let field=0, bright=1, done=false;
      if(pat==='rainbow'){
        field=nx*scaleK + t*speedK; bright=1;
      } else if(pat==='spectrum'){
        field=t*speedK; bright=1;
      } else if(pat==='radial-rainbow'){
        const dx=nx-0.5, dy=ny-0.5, dist=Math.sqrt(dx*dx+dy*dy);
        field=dist*scaleK + t*speedK; bright=1;
      } else if(pat==='wave'){
        bright=0.5+0.5*Math.sin((nx*scaleK - t*speedK)*2*Math.PI);
        field=nx*scaleK - t*speedK;                              // spatial/phase coordinate
      } else if(pat==='breathing'){
        const rate=0.1+spd*0.6;                                   // gentle breathe
        const bb=0.5+0.5*Math.sin(t*rate*2*Math.PI);
        bright=0.12+0.88*bb;                                      // floor so it never fully extinguishes
        field=t*rate;                                             // color drifts with the breath phase
      } else if(pat==='ripple'){
        const dx=nx-0.5, dy=ny-0.5, dist=Math.sqrt(dx*dx+dy*dy);
        bright=0.5+0.5*Math.sin((dist*scaleK*4 - t*speedK)*2*Math.PI);
        field=dist*scaleK;                                        // color by radial distance
      } else if(pat==='scan'){
        const p=(t*speedK)%1; let d=Math.abs(nx-p); d=Math.min(d,1-d); const w=0.05+(1-scl)*0.12;   // wrapped distance
        bright=Math.exp(-(d*d)/(2*w*w));
        field=nx;                                                 // color by horizontal position
      } else if(pat==='twinkle'){
        const ph=Math.sin(t*speedK + patHash(INDICES[k])*6.283);
        bright=ph>0 ? ph*ph*ph : 0;
        field=patHash(INDICES[k]);                                // per-key color offset
      } else if(pat==='rain'){
        const col=Math.round(nx*scaleK*4), colH=patHash(col*7+13);
        const dropY=(t*speedK + colH)%1; let d=Math.abs(ny-dropY); d=Math.min(d,1-d); const w=0.08;   // wrapped
        bright=Math.exp(-(d*d)/(2*w*w));
        field=colH;                                               // color by column
      } else if(pat==='fire'){
        const heat=(1-ny);                                  // hotter at the bottom
        const flick=0.55+0.45*Math.sin(t*speedK*6 + patHash(INDICES[k])*6.283 + ny*8);
        let v=Math.max(0,Math.min(1, heat*flick*1.3));
        R=255*Math.min(1,v*1.6); G=255*Math.max(0,Math.min(1,(v-0.35)*1.6)); B=0; done=true;
      } else if(pat==='comet'){
        const head=(t*speedK)%1, cy=0.5+0.32*Math.sin(t*0.5*2*Math.PI);   // head sweeps across x, drifting in y
        let beh=head-nx; beh=beh-Math.floor(beh);          // 0 at the head → grows along the tail (wrapped)
        const tail=0.12+(1-scl)*0.30, dy=Math.abs(ny-cy);
        const yfall=Math.exp(-(dy*dy)/(2*0.16*0.16));      // concentrate near the comet's row
        bright=(beh<tail ? Math.pow(1-beh/tail,2) : 0)*yfall;
        field=head;                                              // color by head position
      } else if(pat==='gradient-flow'){
        let tt=nx*scaleK*0.5 - t*speedK; tt=tt-Math.floor(tt);
        field=tt; bright=1;                                       // patColorize handles the C1↔C2 blend
      } else if(pat==='static'){
        field=0; bright=1;                                        // c1 = solid C1; rainbow = red; c12 = C1
      } else if(pat==='snowfall'){
        const col=Math.round(nx*scaleK*3), cH=patHash(col*7+3);
        const sway=Math.sin(t+cH*6)*0.04;                   // gentle horizontal drift (visual only)
        const dropY=(t*(0.15+spd*0.5)+cH)%1; let d=Math.abs(ny-dropY); d=Math.min(d,1-d);   // wrapped
        const dd=Math.sqrt(d*d+sway*sway);
        const b=Math.exp(-(dd*dd)/(2*0.09*0.09));
        const cc=patColorize(colMode, cH, 1, C1,C2,C3);          // column-hash color at full intensity
        R=(235+(cc[0]-235)*0.5)*b; G=(245+(cc[1]-245)*0.5)*b; B=(255+(cc[2]-255)*0.5)*b;   // white→color blend, dimmed by b
        done=true;
      } else if(pat==='color-fountain'){
        const cx=0.5+(pp.cox!=null?pp.cox:-8)/100, cy=0.5-(pp.coy!=null?pp.coy:-10)/100;   // centre = signed offset
        const dx=(nx-cx)*BOARDW, dy=(ny-cy)*BOARDH, dist=Math.sqrt(dx*dx+dy*dy)/13.6;   // PHYSICAL units → TRUE circular rings
        const sp2=0.2+spd*0.6, w=0.02+scl*0.20;
        const depth=(pp.ringDark!=null?pp.ringDark:70)/100;          // ring darkness slider: subtle → blackout (was tied to Scale)
        const edge=(pp.ringEdge!=null?pp.ringEdge:17)/100*0.3;       // ring falloff slider: harder → softer contrast edge (was fixed 0.05)
        const gapFrac=0.12+((pp.gap!=null?pp.gap:150)/100)*0.6, spacing=2*w+edge+gapFrac, nr=Math.max(1,Math.min(10,Math.ceil(1/spacing))); let ring=0;   // spacing = ring width + empty gap
        for(let i=0;i<nr;i++){ const r=((t*sp2)+i*spacing)%1;
          const env=Math.min(1,r/0.12)*Math.min(1,(1-r)/0.12);   // plateau: deep through its travel, soft only at birth/death
          const d=Math.abs(dist-r), band = d<=w ? 1 : (d<w+edge ? 1-(d-w)/edge : 0);   // flat-topped band
          ring=Math.max(ring, band*env); }
        bright=1-ring*depth;                                      // thicker (high Scale) also penetrates deeper black
        field=dist*0.5 + t*0.1;                                   // color coord
      } else if(pat==='colorful-interchange'){
        const N=6; field=Math.floor(((t*(0.2+spd))%1)*N)/N;   // whole board one stepped color coord, wraps cleanly
        bright=1;
      } else if(pat==='turning-peaks'){
        const peak=0.45+0.35*Math.sin(nx*scaleK + t*speedK*2*Math.PI*0.3);   // scrolling skyline
        const e=ny-(1-peak), w=0.08;                        // smoothstep soft top edge
        let b=Math.max(0,Math.min(1,e/w)); b=b*b*(3-2*b);
        bright=b; field=nx + t*0.1;
      } else if(pat==='two-birds'){
        const p=(t*(0.2+spd))%1;
        const gx=(dx)=>{ dx=Math.abs(dx); dx=Math.min(dx,1-dx);   // wrapped x distance → seamless re-entry
          return Math.exp(-(dx*dx)/(2*0.07*0.07)); };
        const gy=Math.exp(-((ny-0.5)*(ny-0.5))/(2*0.10*0.10));
        const bA=gx(nx-p)*gy, bB=gx(nx-(1-p))*gy;
        const dotA=patColorize(colMode, 0,   bA, C1,C2,C3);   // dot 0 → field 0
        const dotB=patColorize(colMode, 0.5, bB, C1,C2,C3);   // dot 1 → field 0.5
        R=dotA[0]+dotB[0]; G=dotA[1]+dotB[1]; B=dotA[2]+dotB[2]; done=true;
      } else if(pat==='layered-mountains'){
        for(let i=0;i<3;i++){
          const off=t*speedK*(i+1)*0.3;                     // parallax: nearer (higher i) scrolls faster
          const band=(2-i)/3, bandLo=band, bandHi=band+1/3; // i=0 top band … i=2 bottom band
          const peak=0.5+0.5*Math.sin((nx*scaleK*(1+i*0.5) + off)*2*Math.PI);   // sin → seamless
          if(ny>=bandLo && ny<bandHi){
            const local=(ny-bandLo)/(1/3);
            const bri=(0.4+0.3*i)*Math.max(0,Math.min(1,(local-(1-peak))/0.3+0.5));   // lower bands brighter
            const cc=patColorize(colMode, 0.55 - i*0.18 + t*0.05, bri, C1,C2,C3);
            R+=cc[0]; G+=cc[1]; B+=cc[2];
          }
        }
        done=true;
      } else if(pat==='gentle-rain'){
        const xoff=ny*0.25;                                 // slant: x shifts with depth (wind)
        const col=Math.round((nx+xoff)*scaleK*4), cH=patHash(col*7+13);
        const dropY=(t*(0.12+spd*0.35)+cH)%1; let d=Math.abs(ny-dropY); d=Math.min(d,1-d);   // wrapped vertical → seamless
        bright=Math.exp(-(d*d)/(2*0.10*0.10))*0.85;
        field=cH;                                                 // color by column
      } else if(pat==='back-forth'){
        const p=1-Math.abs(1-2*((t*(0.2+spd))%1));          // triangle ping-pong, smooth bounce
        let d=Math.abs(nx-p); const w=0.10;
        bright=Math.exp(-(d*d)/(2*w*w));
        field=nx;                                                 // color by horizontal position
      } else if(pat==='bloom'){
        for(let i=0;i<3;i++){
          const cH=patHash(i*53+7), cx=patHash(i*29+11), cy=patHash(i*97+19);
          const r=(t*(0.2+spd)+cH)%1;                       // ring radius grows 0..1, wraps
          const dx=nx-cx, dy=ny-cy, dist=Math.sqrt(dx*dx+dy*dy);
          const ring=Math.exp(-((dist-r)*(dist-r))/(2*0.07*0.07));
          const fade=Math.max(0,1-r);                       // fades to 0 before reset → clean wrap
          const b=ring*fade;
          const cc=patColorize(colMode, cH + t*0.05, b, C1,C2,C3);
          R+=cc[0]; G+=cc[1]; B+=cc[2];
        }
        done=true;
      } else if(pat==='plasma'){
        const v=(Math.sin(nx*scaleK*2+t*speedK)+Math.sin(ny*scaleK*2+t*speedK*1.3)+Math.sin((nx+ny)*scaleK+t*speedK*0.7))/3;
        field=0.5+0.5*v + t*0.05; bright=1;                       // inherently looping
      } else if(pat==='aurora'){
        bright=0.4+0.6*Math.max(0,Math.sin(nx*scaleK*1.5 + t*speedK + Math.sin(ny*3+t*0.5)));   // slow vertical curtains
        field=0.35+0.15*Math.sin(nx*2+t*0.3);                     // green→teal→purple drift
      } else {
        field=nx*scaleK + t*speedK; bright=1;                     // fallback = rainbow
      }
      if(!done){ const cc=patColorize(colMode, field, bright, C1,C2,C3); R=cc[0]; G=cc[1]; B=cc[2]; }
      out[o]=Math.max(0,Math.min(255,R))|0; out[o+1]=Math.max(0,Math.min(255,G))|0; out[o+2]=Math.max(0,Math.min(255,B))|0;
    }
  }

  function renderLayer(L,now,state){
    const tnow=layerNow(L,now);   // speed-scaled, static-freezable clock for time-based renderers
    if(L.type==='background') renderBackground(L,tnow);
    else if(L.type==='reactive') renderReactive(L,now,state);   // reactive uses REAL now (timing tied to real key-press timestamps)
    else if(L.type==='gradient') renderGradient(L,tnow);
    else if(L.type==='pattern') renderPattern(L,tnow);
    else if(L.type==='individual') renderKeys(L);
    else if(L.type==='audio') renderAudio(L,now,state);
    else renderMedia(L,now);
    applyAdjust(L);   // common color post-process (saturation→contrast→gamma→brightness)
  }

  // ----- compositor: blend enabled layers bottom→top → flat frame (verbatim; local accumulator) -----
  function composite(state){
    const acc=state._acc || (state._acc=new Float32Array(NLED*3));   // dst accumulator, normalized 0..1
    acc.fill(0);
    for(const L of state.layers){
      if(!L.enabled) continue;
      if(L.type==='audio' && !layerEmitting(L) && !L._carve) continue;   // silent/feedless audio = transparent — BUT a 'subtract' bars layer with a carve mask still carves even with no lit tips
      const a=L.opacity, src=L.rgb, bl=L.blend, df=(L._duck==null?1:L._duck);   // df = audio-duck dim factor (1 = untouched)
      // ISOLATE (punch-through): a reactive layer carves out the layers below at pressed keys
      if(L.type==='reactive' && L.settings && L.settings.isolate && L._inten){
        for(let k=0;k<NLED;k++){ const m=1-Math.max(0,Math.min(1,L._inten[k])), t=k*3;
          acc[t]*=m; acc[t+1]*=m; acc[t+2]*=m; }
      }
      // SUBTRACT (bars 'subtract' fill): carve the layers below dark at the bar-body keys → spectrum silhouette
      if(L._carve){ const cv=L._carve; for(let k=0;k<NLED;k++){ const m=1-(cv[k]>1?1:cv[k]<0?0:cv[k]), t=k*3;
        acc[t]*=m; acc[t+1]*=m; acc[t+2]*=m; } }
      // REPLACE: per-KEY overlay — where this layer has ANY colour, those keys REPLACE the layers
      // below (crossfaded by opacity); fully-black keys are transparent and pass the layers through.
      // The "this layer owns these specific keys" mode (e.g. a song-progress bar on the number row).
      if(bl==='replace'){
        for(let k=0;k<NLED;k++){ const t=k*3, sr=src[t]/255*df, sg=src[t+1]/255*df, sb=src[t+2]/255*df;
          if(sr>0||sg>0||sb>0){ acc[t]=acc[t]*(1-a)+sr*a; acc[t+1]=acc[t+1]*(1-a)+sg*a; acc[t+2]=acc[t+2]*(1-a)+sb*a; } }
        continue;
      }
      for(let i=0;i<acc.length;i++){
        const dst=acc[i], s=src[i]/255*df; let v;
        if(bl==='add')           v=Math.min(1, dst + s*a);
        else if(bl==='screen'){  const sc=1-(1-dst)*(1-s); v=dst*(1-a)+sc*a; }
        else if(bl==='multiply'){ const mu=dst*s;           v=dst*(1-a)+mu*a; }
        else if(bl==='max'){     const mx=Math.max(dst,s);  v=dst*(1-a)+mx*a; }
        else                     v=s*a + dst*(1-a);          // normal
        acc[i]=v;
      }
    }
    const flat=new Array(NLED*4);
    for(let k=0;k<NLED;k++){ const t=k*3,o=k*4;
      flat[o]=INDICES[k];
      flat[o+1]=(acc[t]*255)|0; flat[o+2]=(acc[t+1]*255)|0; flat[o+3]=(acc[t+2]*255)|0; }
    return flat;
  }

  function flatEq(a,b){ if(!b||a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

  // does this layer have ANY lit pixel this frame? (used to gate the audio duck on "actually emitting")
  function layerEmitting(L){ const r=L.rgb; if(!r) return false; for(let i=0;i<r.length;i++) if(r[i]>0) return true; return false; }
  // Audio duck: while an enabled audio layer is actually emitting light, dim its configured target layers
  // to their per-target max-brightness (so the music keys read against a quieter base). Sets a NON-destructive
  // per-layer `_duck` factor that composite() multiplies the source by — reset every frame so it can't compound.
  // settings.ducks = [{layer:<index into state.layers>, dim:<0..100 max-brightness %>}]. Daemon-safe: with no
  // audio feed the audio layer renders black → not emitting → nothing is dimmed.
  const DUCK_TAU_MS = 600;   // ponytail: fixed ~600ms ease for the dim engage/release; expose a per-duck setting if anyone wants per-layer timing
  function applyAudioDuck(state, now){
    // per-layer TARGET dim factor this frame (1 = full); then ease _duck toward it so the dim engages/releases
    // smoothly on pause/unpause instead of snapping.
    for(const L of state.layers) L._duckTgt = 1;
    const audio = state.layers.find(L => L.enabled && L.type==='audio' && layerEmitting(L));
    const ducks = audio && audio.settings && audio.settings.ducks;
    if(Array.isArray(ducks)) for(const d of ducks){
      const tgt = state.layers[d && d.layer];
      if(tgt && tgt!==audio && tgt.enabled) tgt._duckTgt = Math.max(0, Math.min(1, (d.dim==null?100:d.dim)/100));
    }
    const dt = (now!=null && state._duckT) ? Math.max(1, Math.min(200, now - state._duckT)) : 16;
    if(now!=null) state._duckT = now;
    for(const L of state.layers){ const cur = L._duck==null ? 1 : L._duck;
      L._duck = Math.abs(cur - L._duckTgt) < 0.002 ? L._duckTgt : audioEnvelope(cur, L._duckTgt, dt, DUCK_TAU_MS, DUCK_TAU_MS); }
  }

  // ===== state model =====
  // ensure a layer's settings object has the fields its current type needs (verbatim from controller)
  function ensureSettings(L){
    const s=L.settings, def={ color:'#00ffff', period:2600, bgMin:12, bgMax:55, fade:380,
      colorA:'#ff0000', colorB:'#0000ff', angle:0, scroll:0, phase:0 };
    if(L.type==='background'){ ['color','period','bgMin','bgMax'].forEach(k=>{ if(s[k]===undefined)s[k]=def[k]; }); if(s.color===undefined)s.color='#00ffff'; }
    else if(L.type==='reactive'){ const rd={ color:'#ff8c00', colorB:'#00ffff', colorC:'#00ff00', mode:'single', hold:0, fade:380, isolate:false,
        style:'fade', pal:['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff'], anyColor:false, seqSrc:'abc' };
      Object.keys(rd).forEach(k=>{ if(s[k]===undefined)s[k]=rd[k]; });
      if(!Array.isArray(s.pal)) s.pal=rd.pal.slice(); }
    else if(L.type==='gradient'){ ['colorA','colorB','angle','scroll','phase'].forEach(k=>{ if(s[k]===undefined)s[k]=def[k]; }); }
    else if(L.type==='pattern'){ const pd={ pattern:'rainbow', color:'#00ffff', color2:'#ff00ff', color3:'#00ff00', colMode:'rainbow', speed:50, scale:10, gap:150, cox:-8, coy:-10 };
      Object.keys(pd).forEach(k=>{ if(s[k]===undefined)s[k]=pd[k]; }); }
    else if(L.type==='individual'){ if(!L.settings.keys || typeof L.settings.keys!=='object') L.settings.keys={}; if(L.settings.current===undefined) L.settings.current='#ff8c00'; if(L.settings.fill===undefined) L.settings.fill='solid'; }
    else if(L.type==='audio'){
      const ad={ style:'bars', source:'system', appId:'', deviceId:'',
        gain:1, floor:5, attackMs:40, decayMs:220, beatSens:50,
        barColorBass:'#ff2200', barColorTreble:'#22aaff', barTip:'off', barTipColor:'#ffffff', barFill:'solid',
        barColor:'bassTreble', barGradA:'#00ff66', barGradB:'#ff00aa', barLayout:'standard', barDrive:'spectrum', barSpread:false,
        pulseColor:'#19b6ff', pulseColor2:'#ff00aa', pulseGrad:false,
        bloomColor:'#ff5a00', bloomColor2:'#ffd000', bloomGrad:false,
        waveColor:'#00e0ff', waveColor2:'#ff00aa', waveGrad:false, waveReverse:false };
      Object.keys(ad).forEach(k=>{ if(s[k]===undefined)s[k]=ad[k]; });
      if(!Array.isArray(s.ducks)) s.ducks=[];   // [{layer:<index>, dim:<0..100 max-brightness %>}] — dim these while the audio layer emits
    }
    // common per-layer adjust fields — backfilled for EVERY layer type
    const cd={ bri:100, sat:100, con:100, gam:100, rot:0, spd:100, frozen:false };
    Object.keys(cd).forEach(k=>{ if(s[k]===undefined)s[k]=cd[k]; });
  }

  // the 4 fixed default layers (verbatim from controller, WITHOUT rgb/lastTick — createState adds those)
  function defaultLayers(){
    return [
      { name:'Background', enabled:true,  type:'background', opacity:1, blend:'normal', fps:30,
        settings:{ color:'#00ffff', period:2600, bgMin:12, bgMax:55 } },
      { name:'Reactive',   enabled:true,  type:'reactive',   opacity:1, blend:'add',    fps:30,
        settings:{ color:'#ff8c00', colorB:'#00ffff', colorC:'#00ff00', mode:'single', hold:0, fade:380, isolate:false } },
      { name:'Gradient',   enabled:false, type:'gradient',   opacity:1, blend:'normal', fps:30,
        settings:{ colorA:'#ff0000', colorB:'#0000ff', angle:0, scroll:0, phase:0 } },
      { name:'Media',      enabled:false, type:'media',      opacity:1, blend:'normal', fps:30,
        settings:{} },
    ];
  }

  function createState(configLayers){
    const layers = configLayers.map(L => {
      const copy = Object.assign({}, L, {
        settings: Object.assign({}, L.settings),
        rgb: new Uint8Array(NLED*3), lastTick:0, _clk:0, _lastNow:undefined,
      });
      ensureSettings(copy);
      return copy;
    });
    return {
      layers,
      react: { fg:new Float32Array(256), t:new Float64Array(256).fill(-1e12),
               down:new Uint8Array(256), up:new Float64Array(256).fill(-1e12) },
      audio: { bands:new Float32Array(32), bandsL:new Float32Array(32), bandsR:new Float32Array(32),
               bandsRaw:new Float32Array(32), bandsRawL:new Float32Array(32), bandsRawR:new Float32Array(32),   // pre-AGC magnitudes → the Spread spectrum shape
               level:0, beat:0, centroid:0.5, _t:0 },
      lastFlat:null, lastSent:0,
    };
  }

  // apply a new layer config to an EXISTING state WITHOUT resetting the running animation (per-layer clocks,
  // reactive buffers, rgb) when the layer structure (count + types) is unchanged — only settings/name/
  // enabled/opacity/blend/fps change in place. A structural change falls back to a fresh createState. Lets a
  // live settings edit (e.g. painting an individual-keys layer) layer in seamlessly instead of restarting
  // every layer's animation. Returns the state to use.
  function applyConfig(state, configLayers){
    if(!state || !Array.isArray(state.layers) || state.layers.length!==configLayers.length
       || state.layers.some((L,i)=>L.type!==configLayers[i].type))
      return createState(configLayers);
    configLayers.forEach((c,i)=>{ const L=state.layers[i];
      L.name=c.name; L.enabled=!!c.enabled; L.opacity=c.opacity; L.blend=c.blend; L.fps=c.fps;
      L.settings=Object.assign({}, c.settings); ensureSettings(L); });
    return state;
  }

  // ===== orchestrators =====
  const SEND_FPS_CAP = 30;   // hard-cap layer streaming at 30fps (the board's HID pipe wedges above this sustained)
  function composeFrame(state, now){
    for(const L of state.layers){
      if(L.enabled && now - L.lastTick >= 1000 / Math.max(1, Math.min(SEND_FPS_CAP, L.fps))){
        renderLayer(L, now, state);
        L.lastTick = now;
      }
    }
    applyAudioDuck(state, now);   // audio-reactive dim: quiet the configured layers while the audio layer emits (eased on pause/unpause)
    const flat = composite(state);
    // global brightness (the header slider; daemon mirrors it via settings.brightness).
    // composite() allocates a fresh flat each call, so in-place scaling can't compound.
    const b = state.bri;
    // bri 1.0 = normal (the 50% slider tick); <1 dims toward off, >1 boosts (clamp at 255 so a
    // boost can't overflow the byte — Uint8Array.set WRAPS, it doesn't clamp).
    if (b != null && b !== 1) for (let o = 0; o < flat.length; o += 4) {
      flat[o+1]=Math.min(255,(flat[o+1]*b)|0); flat[o+2]=Math.min(255,(flat[o+2]*b)|0); flat[o+3]=Math.min(255,(flat[o+3]*b)|0);
    }
    return flat;
  }
  function stampKey(state, ledIndex){
    state.react.down[ledIndex]=1;
    state.react.t[ledIndex]=performance.now();
    state.react.up[ledIndex]=-1e12;
  }
  function releaseKey(state, ledIndex){
    state.react.down[ledIndex]=0;
    state.react.up[ledIndex]=performance.now();
  }

  const TH108Engine = {
    KEYMAP, INDICES, NLED, BOARDW, BOARDH, GRID, GW, GH,
    hexToRgb, hsv2rgb, patHash, patColorize, audioEnvelope, applyAudioFeatures, audioParams,
    keyCell, layerCell,
    PAT_DEFAULTS, patParams, ensureSettings, defaultLayers, createState, applyConfig,
    renderBackground, renderReactive, renderGradient, renderPattern, renderMedia, renderKeys, renderAudio,
    reactEnvelope, applyAdjust, layerNow, renderLayer, composite, flatEq,
    composeFrame, stampKey, releaseKey, SEND_FPS_CAP,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TH108Engine;
  else (root || this).TH108Engine = TH108Engine;
})(typeof self !== 'undefined' ? self : this);
