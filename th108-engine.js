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
  const WAVE_N = 64;   // length of the time-domain PCM trace (A.wave) the Waveform style plots — captures downsample to this

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
  // VU palette: one distinct color PER ROW (6-step green→red) — green, yellow-green, yellow, orange, red-orange, red.
  const VU_PALETTE = [[0,255,0],[150,255,0],[255,255,0],[255,150,0],[255,60,0],[255,0,0]];
  function vuRow(fb){ let i=Math.round(fb)-1; if(i<0)i=0; else if(i>5)i=5; return VU_PALETTE[i]; }
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
    A.inAbs = (raw && raw.inAbs!=null) ? raw.inAbs : (A.inAbs||0)*0.9;   // absolute input level (pre-gate) → the Mic sensitivity meter
    // Mic input conditioning (mic source only): a hard NOISE GATE on the ABSOLUTE input level — kills steady
    // room tone / a distant fan that the auto-gain would otherwise pump up to full — plus an input GAIN. The gate
    // must use raw.inAbs (pre auto-gain); raw.level is already peak-normalized so a fan reads ~1 there.
    if(s.source==='mic' && raw && raw.inAbs!=null){   // inAbs present = a REAL capture frame (the synth Sample preview has none → left unconditioned)
      const gate=(s.micGate==null?0:s.micGate)/100;
      if(gate>0 && raw.inAbs < gate) raw = { level:0, live:0 };   // below the gate → silence (idle keys stay dark). Mic Gain is applied as micAbs below (NOT here — the capture's bands are already ~1 so scaling+clamping them is a no-op).
    }
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
    // MIC absolute-volume drive: a mic is a VU — bar HEIGHT must track the true input loudness (a faint tap =
    // short bars, a shout = tall). The capture pre-normalizes bands/level (volume-INDEPENDENCE, great for music,
    // wrong for a mic), so we scale by the absolute input A.inAbs (RMS) here. ALWAYS on for mic (not tied to the
    // auto-gain toggle) so a stale agc:true saved setting can't make a faint tap peg the board. Mic gain trims it.
    const micAbs = (s.source==='mic') ? Math.min(1, (A.inAbs||0)*((s.micGain==null?100:s.micGain)/100)*3) : null;   // Mic Gain IS the sensitivity dial: inAbs × micGain × 3 (×3 base so 100% is usable; 800% ≈ ×24 for a quiet mic)
    const shape = (v)=>{ v=(v-lo)/(hi-lo); v=v<=0?0:(v>=1?1:v); return gamma!==1 ? Math.pow(v,gamma) : v; };
    const TARGET = 1.0;                                           // the recent loud peak maps to the TOP (true highs hit the ceiling, like the manual-gain workflow); typical passages fall below → mid
    // Peak follower: rises instantly, falls SLOWLY (~10s) to hold the chorus peak so verses sit lower (dynamics).
    // BUT volume-independence needs it to re-normalize fast when you change Spotify's volume. Detect that with a
    // SMOOTHED level (sm, ~0.8s) — robust to per-beat jitter, unlike the instantaneous level which bounces and
    // kept resetting the old detector. When the smoothed level sits well below the held peak (a turn-down or a
    // sustained-quiet section, not a beat gap), collapse the peak FAST toward the RECENT peak (rp) — so absolute
    // volume drops out in ~1-2s while real musical dynamics (frequent peaks hold the peak up) are preserved.
    const SLOW = Math.exp(-dt/10000), FAST = Math.exp(-dt/450), RP = Math.exp(-dt/700);   // FAST/RP only run while re-normalizing a volume change → fast tracking here shrinks the sag during a continuous drag without touching normal-music dynamics (which use SLOW)
    const sm = (cur, x)=> cur==null ? x : cur + (x-cur)*(1 - Math.exp(-dt/450));
    { let fm = 0; const _rb0 = raw.bands; if(_rb0) for(let i=0;i<32;i++){ const v=_rb0[i]||0; if(v>fm) fm=v; }
      const lm = raw.level||0;
      if(A._gpk == null) A._gpk = 0.12;
      if(A._lpk == null) A._lpk = 0.12;
      A._sL = sm(A._sL, lm); A._rL = Math.max(lm, (A._rL==null?lm:A._rL)*RP);   // smoothed level + recent peak
      A._sG = sm(A._sG, fm); A._rG = Math.max(fm, (A._rG==null?fm:A._rG)*RP);
      if(A._reL || A._sL < 0.5*A._lpk){ A._reL = true; A._lpk = Math.max(lm, A._lpk*FAST); if(A._lpk <= A._rL*1.3 + 0.01) A._reL = false; }
      else A._lpk = Math.max(lm, A._lpk*SLOW);
      if(A._reG || A._sG < 0.5*A._gpk){ A._reG = true; A._gpk = Math.max(fm, A._gpk*FAST); if(A._gpk <= A._rG*1.3 + 0.01) A._reG = false; }
      else A._gpk = Math.max(fm, A._gpk*SLOW); }
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
    // TWINKLE pause style: on sustained silence, FREEZE the last rendered frame and let renderAudio sparkle the
    // keys out one-by-one (handled per-LED there). Skip the band/level decay entirely so the frame holds; resume
    // is instant (A.bands are still at their last live values). _twkSeq bumps once per pause so the renderer rolls
    // a fresh per-key death schedule. Default style ('linear') falls through to the graceful settle below.
    if(silent && s.pauseStyle==='twinkle'){
      if(!A._twk){ A._twk=true; A._twkT0=now; A._twkSeq=(A._twkSeq||0)+1; }
      return;
    }
    A._twk=false;
    // SETTLE = a fixed-duration LINEAR glide to 0 over pauseMs, INDEPENDENT of bar height. We lerp a snapshot of
    // the last LOUD frame down to 0 over pauseMs. The snapshot is PEAK-GATED (refreshed below only while the audio
    // is near its running peak), NOT taken at silence-onset: a pause fades the input over ~200ms before silence is
    // confirmed, so an onset snapshot grabs the already-collapsed bars → the glide is invisible and it reads as a
    // ~200ms drop. Peak-gating settles from the FULL bars (same fix + gate as the twinkle freeze). The old
    // `cur - dt/pauseMs` also decremented at a full-scale rate, so low bars finished proportionally sooner.
    const pauseMs = (p.pauseDecayMs==null ? 700 : p.pauseDecayMs);
    const rb = raw.bands, rbL = raw.bandsL, rbR = raw.bandsR;
    // L/R channels feed the 'stereo' bars layout; when the source is mono (no bandsL/R) both fall back to
    // the mono band so the stereo layout still shows something (just symmetric) instead of going dark.
    if(!A.bandsL) A.bandsL = new Float32Array(32);
    if(!A.bandsR) A.bandsR = new Float32Array(32);
    if(!A.bandsRaw) { A.bandsRaw = new Float32Array(32); A.bandsRawL = new Float32Array(32); A.bandsRawR = new Float32Array(32); }
    const sn = A._snap || (A._snap = { L:0, b:new Float32Array(32), bL:new Float32Array(32), bR:new Float32Array(32), rb:new Float32Array(32), rbL:new Float32Array(32), rbR:new Float32Array(32) });
    let settleF = 0;
    if(silent){
      if(!A._settling){ A._settling = true; A._settleT0 = now; }   // begin the glide from the held (last-loud) snapshot
      settleF = Math.max(0, 1 - (now - A._settleT0)/Math.max(60, pauseMs));   // 1 at onset → 0 after pauseMs (height-independent)
    } else A._settling = false;
    const tgtLevel = micAbs!=null ? micAbs : lvl(raw.level);   // mic absolute-volume: level = true loudness, not peak-normalized
    A.level = silent ? sn.L*settleF : audioEnvelope(A.level, tgtLevel, dt, p.attackMs, p.decayMs);
    A.centroid = audioEnvelope(A.centroid, (raw.centroid==null?0.5:raw.centroid), dt, p.attackMs, p.decayMs);
    // beat: instantaneous rise, decay only (so a kick pops then fades); beatSens scales sensitivity
    const beatTgt = Math.max(0, Math.min(1, (raw.beat||0) * (0.5 + (p.beatSens||50)/100)));
    A.beat = Math.max(beatTgt, audioEnvelope(A.beat, 0, dt, 0, Math.max(60, p.decayMs)));
    // Time-domain PCM trace for the Waveform style (oscilloscope). Latest frame, not peak-held — it's a live
    // signal. When a frame carries no PCM (stale/silent feed) relax toward flat so the trace settles to a line.
    if(raw.wave && raw.wave.length){ if(!A.wave) A.wave = new Float32Array(WAVE_N);
      // temporal smoothing: blend toward the new frame instead of replacing — consecutive capture windows are
      // ~16ms apart, so a hard swap makes the trace JUMP (reads as scramble); blending makes it flow like a wave.
      const w = raw.wave, n = Math.min(WAVE_N, w.length); for(let i=0;i<n;i++) A.wave[i] = A.wave[i]*0.45 + w[i]*0.55; }
    else if(A.wave){ for(let i=0;i<WAVE_N;i++) A.wave[i] *= 0.8; }
    const rawClamp = (v)=>{ v=(v||0); return v<0?0:(v>1?1:v); };   // pre-AGC magnitude (NO peak normalize) — keeps the real bass→treble shape for Spread
    for(let i=0;i<32;i++){
      // mic absolute: band height = the per-band spectral SHAPE × absolute loudness (so quiet input = short bars).
      const t = rb ? (micAbs!=null ? rawClamp(rb[i])*micAbs : band(rb[i], i)) : 0; A.bands[i] = silent ? sn.b[i]*settleF : audioEnvelope(A.bands[i], t, dt, p.attackMs, p.decayMs);
      const tL = rbL ? (micAbs!=null ? rawClamp(rbL[i])*micAbs : bandRO(rbL[i], i)) : t; A.bandsL[i] = silent ? sn.bL[i]*settleF : audioEnvelope(A.bandsL[i], tL, dt, p.attackMs, p.decayMs);
      const tR = rbR ? (micAbs!=null ? rawClamp(rbR[i])*micAbs : bandRO(rbR[i], i)) : t; A.bandsR[i] = silent ? sn.bR[i]*settleF : audioEnvelope(A.bandsR[i], tR, dt, p.attackMs, p.decayMs);
      const r = rb ? rawClamp(rb[i]) : 0;
      A.bandsRaw[i]  = silent ? sn.rb[i]*settleF  : audioEnvelope(A.bandsRaw[i],  r, dt, p.attackMs, p.decayMs);
      A.bandsRawL[i] = silent ? sn.rbL[i]*settleF : audioEnvelope(A.bandsRawL[i], rbL ? rawClamp(rbL[i]) : r, dt, p.attackMs, p.decayMs);
      A.bandsRawR[i] = silent ? sn.rbR[i]*settleF : audioEnvelope(A.bandsRawR[i], rbR ? rawClamp(rbR[i]) : r, dt, p.attackMs, p.decayMs);
    }
    // refresh the snapshot from THIS frame while the audio is near its running peak → a later pause settles from
    // the full bars, not the faded tail (gate mirrors the twinkle freeze in renderAudio)
    if(!silent && A.level >= 0.6*Math.max(A._lpk||0, 0.05)){
      sn.L = A.level; sn.b.set(A.bands); sn.bL.set(A.bandsL); sn.bR.set(A.bandsR); sn.rb.set(A.bandsRaw); sn.rbL.set(A.bandsRawL); sn.rbR.set(A.bandsRawR);
    }
    // DYNAMICS DEPTH: per-band novelty (positive rise) + the global beat drive a fast-attack/slow-decay "hit"
    // envelope. A band that's been steady → hit decays to 0 → renderBars recedes it; a change/beat pops hit → a
    // bright rebound. This is what gives a sustained-loud wall depth instead of a flat meter. (Spectrum-bars only,
    // gated by s.barDynamics in renderBars; cheap to keep always-updated here.)
    if(!A.hit){ A.hit = new Float32Array(32); A._novPrev = new Float32Array(32); }
    const hitDecay = Math.exp(-dt/300);   // rebound fades over ~300ms
    for(let i=0;i<32;i++){
      const nov = A.bands[i] - A._novPrev[i]; A._novPrev[i] = A.bands[i];   // positive frame-to-frame rise = novelty
      const tgt = Math.min(1, Math.max(0, nov)*5 + A.beat*0.6);            // a band jump OR a kick pops the rebound
      A.hit[i] = tgt > A.hit[i] ? tgt : A.hit[i]*hitDecay;                 // instant attack, slow decay
    }
  }
  // Per-VARIANT tuner params (gain/floor/attack/decay/beatSens) so tuning one variant doesn't leak into another.
  // A "variant" is the style, EXCEPT Mic gets its own namespace ('mic\0'+style) — a microphone's input character
  // (ambient, continuous, jittery) differs from playback, so it keeps separate tuning with smoother defaults.
  const AUDIO_TUNE_DEFAULTS = { gain:1, floor:5, ceil:100, contrast:50, agc:true, attackMs:40, decayMs:220, pauseDecayMs:700, beatSens:50 };
  const MIC_TUNE_DEFAULTS = { attackMs:80, decayMs:300, pauseDecayMs:1500, agc:false };   // smoother attack + a long graceful settle; AGC OFF so bar HEIGHT tracks absolute loudness (a tap = short, a shout = tall)
  function audioVariantKey(s){ return s.style || 'bars'; }   // per-STYLE within a source; full per-SOURCE isolation is host-side (s.bySource). Mic keeps its own defaults via the source check below.
  function audioParams(s){
    const key = audioVariantKey(s), defs = s.source==='mic' ? Object.assign({}, AUDIO_TUNE_DEFAULTS, MIC_TUNE_DEFAULTS) : AUDIO_TUNE_DEFAULTS;
    if(!s.ap){
      // one-time migration of pre-`ap` flat values — but ONLY onto a non-mic variant. Those flat values are the
      // legacy playback defaults; seeding them onto Mic would clobber Mic's smoother defaults (attack 80, etc).
      const seed = s.source==='mic' ? {} : { gain:s.gain, floor:s.floor, attackMs:s.attackMs, decayMs:s.decayMs, beatSens:s.beatSens };
      Object.keys(seed).forEach(k=>{ if(seed[k]==null) delete seed[k]; });
      s.ap = {}; s.ap[key] = Object.assign({}, defs, seed);
    }
    if(!s.ap[key]) s.ap[key] = Object.assign({}, defs);
    else { const o = s.ap[key]; for(const k in defs) if(o[k] == null) o[k] = defs[k]; }   // backfill keys added after this layer was first saved IN-PLACE — must keep the SAME object reference so the panel's `ap` and the render/save path stay in sync
    return s.ap[key];
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

  // Per-key physical center [cx,cy] in 0..1 board space (same space the card's preview paints + the crop overlay
  // uses), computed once from keyCell so the crop rect matches what the user draws on the preview.
  let _centers=null;
  function keyCenters(){ if(_centers) return _centers; _centers=new Array(NLED);
    for(let k=0;k<NLED;k++){ const c=keyCell(INDICES[k]); _centers[k]=c?[c[0],c[1]]:null; } return _centers; }
  // Crop the rendered audio frame to a rectangle. CLIP = keys outside the box go dark/transparent; the visual is
  // a window onto the full-board render. FIT = the WHOLE board's render is spatially remapped (nearest-key) so it
  // squeezes inside the box. Outside keys are also made fully transparent (alpha 0) so non-additive blends don't
  // paint a black box where the crop excludes.
  function cropFrame(out, L, s){
    const C=keyCenters();
    const x0=s.cropX==null?0:s.cropX, y0=s.cropY==null?0:s.cropY, w=s.cropW==null?1:s.cropW, h=s.cropH==null?1:s.cropH;
    const x1=x0+w, y1=y0+h, fit=!!s.cropFit;
    const inside=(c)=> !!c && c[0]>=x0 && c[0]<=x1 && c[1]>=y0 && c[1]<=y1;
    let ab=L._alpha; if(!ab){ ab=L._alpha=(L._alphaBuf||(L._alphaBuf=new Float32Array(NLED))); ab.fill(1); }   // preserve any transparency mask inside; force 0 outside
    if(!fit){
      for(let k=0;k<NLED;k++){ if(!inside(C[k])){ const o=k*3; out[o]=out[o+1]=out[o+2]=0; ab[k]=0; } }
      return;
    }
    const src=L._cropBuf||(L._cropBuf=new Float32Array(NLED*3)); src.set(out);
    for(let k=0;k<NLED;k++){ const o=k*3, c=C[k];
      if(!inside(c)){ out[o]=out[o+1]=out[o+2]=0; ab[k]=0; continue; }
      const lx=w>1e-4?(c[0]-x0)/w:0.5, ly=h>1e-4?(c[1]-y0)/h:0.5;   // local 0..1 in the box → the full-board position to sample
      let best=-1, bd=1e9; for(let j=0;j<NLED;j++){ const sc=C[j]; if(!sc) continue; const dx=sc[0]-lx, dy=sc[1]-ly, d=dx*dx+dy*dy; if(d<bd){ bd=d; best=j; } }
      if(best>=0){ const so=best*3; out[o]=src[so]; out[o+1]=src[so+1]; out[o+2]=src[so+2]; } else { out[o]=out[o+1]=out[o+2]=0; }
    }
  }

  function renderAudio(L, now, state){
    const s = L.settings, out = L.rgb, A = state.audio;
    if(s.frozen && L._audFreeze){ out.set(L._audFreeze); L._carve=null; L._alpha=null; return; }   // Freeze Animation: hold the last live frame (works for every audio style; renderAudio runs on real `now`, so it can't use the layer clock that freezes the other layer types)
    if(s.pauseStyle==='twinkle' && A._twk){ renderTwinkleOut(L, out, A, now, s); L._carve=null; L._alpha=null; return; }   // paused: sparkle the frozen frame out
    out.fill(0);
    L._carve = null; L._alpha = null;         // only bars 'subtract' fill sets a carve mask; only bars alpha-recede sets _alpha (both cleared each frame, renderBars re-sets if needed)
    const style = s.style || 'bars';
    if(style==='bars') renderBars(s, out, A, now, L);
    else if(style==='pulse') renderPulse(s, out, A, now);
    else if(style==='bloom') renderBloom(s, out, A);
    else if(style==='wave') renderWave(s, out, A, now, L);
    else if(style==='aurora') renderAurora(s, out, A, now, L);
    else if(style==='sparkle') renderSparkle(s, out, A, now, L);
    else renderBars(s, out, A, now, L);
    // Dynamics / Transparency for the wash styles (pulse/bloom/starfield), mirroring Spectrum Bars but GLOBAL
    // (whole-board, since these aren't per-column meters): a STEADY/sustained passage recedes, a beat pops it
    // back to full. Dynamics recedes BRIGHTNESS; Transparency recedes per-layer OPACITY so the layers below show
    // through between beats and the effect snaps opaque on a hit (real front/back depth). They stack.
    if(style==='pulse'||style==='bloom'||style==='sparkle'){
      const dynOn=!!s[style+'Dynamics'], alphaOn=!!s[style+'DynamicsAlpha'];
      if(dynOn||alphaOn){
        const depth=Math.max(0,Math.min(1,(s[style+'DynamicsDepth']==null?60:s[style+'DynamicsDepth'])/100));
        const gd=(1-depth)+depth*Math.min(1,A.beat);   // steady → 1-depth (receded), beat → 1 (full)
        if(dynOn){ for(let i=0;i<out.length;i++) out[i]=out[i]*gd; }
        if(alphaOn){ const ab=L._alpha=(L._alphaBuf||(L._alphaBuf=new Float32Array(NLED))); ab.fill(gd); }   // uniform per-key opacity = the global recede
      }
    }
    if(s.cropOn) cropFrame(out, L, s);   // confine the light to the crop rectangle (clip or fit) — last, so it applies to every style
    // Roll the snapshot a twinkle pause freezes on — but ONLY while the audio is near its recent peak. A pause
    // (or song end) fades the audio down over ~200ms; snapshotting every frame would capture the faded tail
    // (just the bottom row) by the time silence is confirmed. Gating on level vs the running peak holds the
    // snapshot at the last near-full frame, so the whole visualization twinkles out, not only the base row.
    if(A.level >= 0.6*Math.max(A._lpk||0, 0.05)) (L._frozen || (L._frozen = new Float32Array(NLED*3))).set(out);   // ponytail: simple peak gate; a short frame-history ring would track the pre-fade frame even more exactly if needed
    (L._audFreeze || (L._audFreeze = new Float32Array(out.length))).set(out);   // remember every live frame so Freeze Animation can hold the current one
  }

  // Twinkle pause-out: freeze the last live frame (L._frozen) and sparkle each LIT key out individually over
  // pauseDecayMs — a brief brighten ("twinkle") then fade, staggered by a per-key random start. Keys that were
  // dark stay dark. When all keys are out the layer emits nothing (composited away → board dark). Style-agnostic:
  // it works on the rendered RGB, so it freezes bars/pulse/plasma/etc. identically.
  function renderTwinkleOut(L, out, A, now, s){
    const fr = L._frozen;
    if(!fr){ out.fill(0); return; }
    if(L._twkSeq !== A._twkSeq){                          // new pause → roll a fresh per-key death schedule
      L._twkSeq = A._twkSeq;
      const r = L._twkR || (L._twkR = new Float32Array(NLED));
      for(let k=0;k<NLED;k++) r[k]=Math.random();
    }
    const apd = audioParams(s).pauseDecayMs;                              // PER-STYLE (same source the Pause-decay slider writes) — NOT s.pauseDecayMs (always undefined → wrongly 700ms)
    const dur = Math.max(200, apd==null?700:apd);                         // reuse Pause decay = total twinkle-out time
    const elapsed = now - (A._twkT0||now);
    if(elapsed >= dur){ out.fill(0); return; }            // fully dissipated → board dark
    // Deaths spread across the FULL window (each key starts over the first 75%, then fades over the last 25%)
    // so the dissipation visibly uses the whole pauseDecayMs. The per-key fade is an HONEST decline (a small
    // sparkle, then a steady drop to 0) — NOT a bright bump that exceeds the original, which kept the board lit
    // until a late plunge and made the whole thing read as ~half its set duration. The sine term is the twinkle.
    const STAGGER = 0.75, TWK = 0.25, R = L._twkR;
    for(let k=0;k<NLED;k++){
      const o=k*3, r0=fr[o], g0=fr[o+1], b0=fr[o+2];
      if(r0<=0 && g0<=0 && b0<=0){ out[o]=out[o+1]=out[o+2]=0; continue; }   // was dark → stays dark
      const p = (elapsed - R[k]*dur*STAGGER)/(dur*TWK);
      if(p<=0){ out[o]=r0; out[o+1]=g0; out[o+2]=b0; continue; }             // not yet started: held at full
      if(p>=1){ out[o]=out[o+1]=out[o+2]=0; continue; }                      // gone
      const spark = p<0.2 ? 1+(p/0.2)*0.25 : 1.25*(1-(p-0.2)/0.8);          // tiny sparkle to ~1.25×, then an honest linear decline to 0
      const m = spark*(0.7+0.3*Math.sin(now*0.05 + k*1.7));                  // per-key twinkle flicker
      out[o]=r0*m; out[o+1]=g0*m; out[o+2]=b0*m;
    }
  }

  // ===== abstract / WMP-style visualizers (auto-colored from the spectrum; all fade to dark on silence) =====
  // Aurora: soft vertical color curtains that sway with time and lift/brighten with each column's energy.
  // Activity-paced clock (shared): a per-layer time that advances FASTER when the song is busy (mean of A.hit
  // band-novelty) and slower when calm — so time-based motion reflects the song's pace, like the waveform's
  // scroll. Accumulated (not now×speed) so a pace change never jumps the phase. Used by aurora (sway) & sparkle
  // (twinkle); bloom/bars/pulse have no scrolling motion to pace, so they're left audio-driven.
  function activityClock(L, A, now){
    const W = L || A;
    const dt = W._acT ? Math.min(200, now - W._acT) : 16; W._acT = now;
    let act=0; if(A.hit){ for(let i=0;i<32;i++) act += A.hit[i]; act/=32; }
    W._acS = (W._acS==null) ? act : W._acS + (act - W._acS)*0.15;     // smooth the activity measure
    const speed = 0.7 + Math.min(1, W._acS*3.4)*2.3;                  // 0.7 (calm) … 3.0 (frantic) × real time
    return (W._acClk = (W._acClk||0) + speed * dt/1000);
  }
  function renderAurora(s, out, A, now, L){
    const t = activityClock(L, A, now);   // sway speed tracks the song's pace
    // Width: thickness of each curtain. Higher width = fatter band → smaller Gaussian falloff factor.
    // Default 50 reproduces the original 2.4 factor exactly; clamp the wide end so it can't flood the whole board.
    const wf = Math.max(0.8, 4.5 - 0.042*(s.auroraWidth==null?50:s.auroraWidth));
    // Drive: Volume (default) = curtains brighten with loudness; Beat = they surge on kicks.
    const energy = (s.auroraDrive==='beat') ? (A.level*0.3 + A.beat*0.85) : (0.85*A.level + A.beat*0.4);
    for(let k=0;k<NLED;k++){ const cell=GRID[INDICES[k]]; if(!cell) continue; const o=k*3;
      const x=GW>1?cell[0]/(GW-1):0, y=GH>1?cell[1]/(GH-1):0;
      const mag=A.bands[Math.min(31,Math.round(x*31))];
      const centerY = 0.5 - 0.28*Math.sin(t*0.6 + x*4) - mag*0.35;   // y=0 top
      const v=Math.max(0,Math.min(1, Math.exp(-Math.pow((y-centerY)*wf,2)) * energy));   // no idle floor → dark on silence
      if(v<0.03){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const c=hsv2rgb(0.45 + A.centroid*0.35 + x*0.12, 0.85, v); out[o]=c[0]|0; out[o+1]=c[1]|0; out[o+2]=c[2]|0; }
  }
  // Starfield: per-key twinkle; louder = more stars lit, kicks burst a subset.
  function renderSparkle(s, out, A, now, L){
    // Drive: Volume (default) = star density rides loudness; Beat = bursts of stars pop on kicks.
    const t = activityClock(L, A, now), energy = Math.max(0, Math.min(1, (s.sparkleDrive==='beat') ? (A.level*0.2 + A.beat*0.9) : (A.level*0.7 + A.beat*0.6)));   // twinkle rate tracks the song's pace
    const mono = !!s.sparkleMono, mc = mono ? hexToRgb(s.sparkleColor||'#00e0ff') : null;   // mono = one picked color instead of the per-key rainbow
    for(let k=0;k<NLED;k++){ const o=k*3, ph=patHash(INDICES[k]);
      const tw=0.5+0.5*Math.sin(t*(2.5+ph*5) + ph*6.283), thr=1-energy;
      let v = tw>thr ? (tw-thr)/Math.max(0.02,energy) : 0;
      v = Math.min(1, v*(0.6+0.4*A.level) + (A.beat>0.5 && ph>0.6 ? A.beat*0.6 : 0));
      if(v<0.03){ out[o]=out[o+1]=out[o+2]=0; continue; }
      if(mono){ out[o]=mc[0]*v|0; out[o+1]=mc[1]*v|0; out[o+2]=mc[2]*v|0; }
      else { const c=hsv2rgb(ph + t*0.08, 0.9, v); out[o]=c[0]|0; out[o+1]=c[1]|0; out[o+2]=c[2]|0; } }
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
    // Dynamics depth: a STEADY band recedes (A.hit→0) and a change/beat pops it to full. Two independent recede
    // styles share one depth: 'barDynamics' dims the bar's BRIGHTNESS; 'barDynamicsAlpha' fades its per-key OPACITY
    // (the layers BELOW show through → real front/back depth). depth = how far a steady bar recedes.
    const dynOn = !!s.barDynamics, alphaOn = !!s.barDynamicsAlpha;
    const depth = (dynOn||alphaOn) ? Math.max(0, Math.min(1, (s.barDynamicsDepth==null?60:s.barDynamicsDepth)/100)) : 0;
    const ctr = (GW-1)/2;
    const vert = layout==='topdown' ? 'down' : layout==='centerout' ? 'center' : 'up';   // vertical fill mode
    const midRow = (GH-1)/2, halfH = GH/2;
    // Spread uses the RAW (pre-AGC) spectrum so columns actually differ; normalize to the loudest band this
    // frame so the shape spans the full range (AGC'd bands all ride ~1 → no shape → "feature does nothing").
    // NOTE: true volume-independence of the spread depends on the CAPTURE emitting peak-normalized bands
    // (app-capture.cs / audio-sidecar.ps1) — absolute-dB bands saturate at high volume and can't be fixed here.
    const useSpread = spread && drive!=='spectrum' && A.bandsRaw;
    let maxRaw = 0.05; if(useSpread){ for(let i=0;i<32;i++) if(A.bandsRaw[i]>maxRaw) maxRaw=A.bandsRaw[i]; }
    let cb = null, any = false;
    if(subtract && L){ cb = L._carveBuf || (L._carveBuf = new Float32Array(NLED)); cb.fill(0); }
    // alpha-recede: a per-key opacity mask the compositor reads (1 = opaque). Only solid fills (not the subtract
    // silhouette, which carves separately). Default 1 at every key (unlit keys stay pass-through per blend mode).
    let aBuf = null;
    if(L){ if(alphaOn && !subtract){ aBuf = L._alpha = (L._alphaBuf || (L._alphaBuf = new Float32Array(NLED))); aBuf.fill(1); } else { L._alpha = null; } }
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
      const rec = (dynOn||alphaOn) ? (1 - depth + depth*(A.hit ? A.hit[band] : 1)) : 1;   // recede when stale, snap to full on a hit
      if(aBuf) aBuf[k] = rec;                                  // alpha recede: this LIT key fades see-through when stale
      const fillF = (partial < 1 ? partial : 1) * (dynOn ? rec : 1);   // brightness recede folds into every fill/tip path via fillF
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
    let base = hexToRgb(s.pulseColor||'#19b6ff'), base2 = hexToRgb(s.pulseColor2||'#ff00aa'); const grad = !!s.pulseGrad;
    if(grad && s.pulseGradRev){ const tmp=base; base=base2; base2=tmp; }   // reverse gradient colors
    // Drive: Volume = follow overall loudness (a steady wash); Beat = pump on kicks (the default — "Beat Pulse").
    const drv = s.pulseDrive || 'beat';
    const v0 = Math.max(0, Math.min(1, drv==='volume' ? A.level : (A.level*0.5 + A.beat*0.95)));
    // Min/Max brightness: remap the 0..1 drive into [min,max]. Min = a resting glow even at silence (default 0 →
    // dark on silence, unchanged); Max = the brightness a full beat reaches (default 100 → unchanged).
    const lo=(s.pulseMin==null?0:s.pulseMin)/100, hi=Math.max(lo, (s.pulseMax==null?100:s.pulseMax)/100);
    const v = lo + (hi-lo)*v0;
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
    let col0 = hexToRgb(s.bloomColor||'#ff5a00'), col2 = hexToRgb(s.bloomColor2||'#ffd000'); const grad = !!s.bloomGrad;
    if(grad && s.bloomGradRev){ const tmp=col0; col0=col2; col2=tmp; }   // reverse gradient colors
    const cx = (GW-1)/2, cy = (GH-1)/2;
    // BEAT-driven: a kick (beat→1) lights the center, then the ring expands outward as beat decays.
    // energy leans hard on beat (small level body) so it reads as discrete blooms, not a brightness wash.
    // Drive: Beat (default) = a kick lights the center and the ring expands as it decays; Volume = the ring rides
    // overall loudness (small/bright when loud, expands+dims as it quiets).
    const sig = (s.bloomDrive==='volume') ? A.level : A.beat;
    const energy = Math.max(sig, A.level*0.3);
    const radius = (1 - sig) * 1.5;                 // 0 at full drive → grows out as it decays
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

  // Wave: a clean traveling SINE LINE (the readable "wave" look) DRIVEN by the audio. To stream SMOOTHLY (not
  // flutter), the scroll uses a CONTINUOUS accumulated phase advanced by a smoothed speed — recomputing phase as
  // t*speed makes it JUMP whenever speed changes — and amplitude/frequency are low-passed so they glide with the
  // song instead of jittering per frame. Amplitude + brightness ride loudness; ripple count rides spectral brightness.
  function renderWave(s, out, A, now, L){
    let col0 = hexToRgb(s.waveColor||'#00e0ff'), col2 = hexToRgb(s.waveColor2||'#ff00aa'); const grad = !!s.waveGrad;
    if(grad && s.waveGradRev){ const tmp=col0; col0=col2; col2=tmp; }   // reverse gradient colors
    const dir = s.waveReverse ? -1 : 1, amp = (s.waveAmp==null?100:s.waveAmp)/100;
    const tw = 0.5 + (s.waveThick==null?50:s.waveThick)/100*2;          // line half-width in rows
    const mid = (GH-1)/2;
    // PER-LAYER scroll/smoothing state (W = L if present, else A): keeps the keyboard render and the card's preview
    // — which both render this audio — from fighting over one phase.
    const W = L || A;
    const realDt = W._waveT ? Math.max(1, now - W._waveT) : 16; W._waveT = now;
    const sdt = Math.min(realDt, 50);    // SMOOTHING dt capped so a frame hitch can't jolt the envelope/frequency
    W._wDt = W._wDt ? W._wDt*0.85 + Math.min(realDt,200)*0.15 : Math.min(realDt,50);   // SMOOTHED frame time for the scroll → a hitchy frame rate can't jolt/reverse the phase
    // Several audio-driven variables so it isn't monotonous:
    //  • AMPLITUDE (taller/shorter) rides BEATS + loudness (NOT auto-gained level alone — ~constant for music).
    //  • FREQUENCY (wider/thinner) rides spectral brightness over a WIDE range.
    //  • SCROLL SPEED rides the song's PACE — a SLOWLY-smoothed activity (~1.6s), so it tracks the section's
    //    energy/tempo without the per-beat jerk a fast speed caused.
    //  • A 2nd HARMONIC layers in with brightness so busy/bright passages get a wigglier, more complex line.
    // AUTO-RANGE the centroid: its raw swing is narrow, so map its RECENT min/max to the full frequency span — the
    // wavelength then visibly STRETCHES (bass) / SQUASHES (treble) instead of barely moving. Range forgets over ~8s.
    const cen = A.centroid==null ? 0.5 : (A.centroid<0?0:A.centroid>1?1:A.centroid), kr=1-Math.exp(-sdt/8000);
    W._cLo = W._cLo==null ? cen : Math.min(cen, W._cLo + (cen-W._cLo)*kr);   // instant drop to new lows, slow creep up
    W._cHi = W._cHi==null ? cen : Math.max(cen, W._cHi + (cen-W._cHi)*kr);   // instant rise to new highs, slow creep down
    const cNorm = (W._cHi-W._cLo > 0.04) ? (cen-W._cLo)/(W._cHi-W._cLo) : 0.5;
    const loudT = Math.min(1, A.level*0.45 + A.beat*0.75);   // Waveform is always Volume-driven (loudness + a beat swell)
    const freqT = 0.7 + cNorm*4.8;                                      // 0.7–5.5 cycles, driven by the auto-ranged brightness → dramatic stretch/squash
    const harmT = cNorm;                                              // brightness → 2nd-harmonic strength
    // PACE from spectral ACTIVITY (novelty), NOT bpm: avg of the per-band novelty envelope A.hit — it stays high
    // through busy/fast passages (a quick string of words = lots of spectral change) and drops on sustained notes.
    let act=0; if(A.hit){ for(let i=0;i<32;i++) act+=A.hit[i]; act/=32; }
    // BASS / TREBLE prominence from the RAW (pre-AGC) spectrum → each gets its own wave component when strong.
    let bassR=0, trebR=0; const rb=A.bandsRaw;
    if(rb){ for(let i=0;i<6;i++) bassR+=rb[i]; for(let i=26;i<32;i++) trebR+=rb[i]; bassR=Math.min(1,bassR/2.5); trebR=Math.min(1,trebR/2.5); }
    const ke=1-Math.exp(-sdt/170), kf=1-Math.exp(-sdt/450), kh=1-Math.exp(-sdt/450), kpa=1-Math.exp(-sdt/420);
    W._wEnv  = W._wEnv ==null ? loudT : W._wEnv  + (loudT-W._wEnv )*ke;
    W._wFreq = W._wFreq==null ? freqT : W._wFreq + (freqT-W._wFreq)*kf;
    W._wHarm = W._wHarm==null ? harmT : W._wHarm + (harmT-W._wHarm)*kh;
    W._wAct  = W._wAct ==null ? act   : W._wAct  + (act -W._wAct )*kpa;
    W._wBass = W._wBass==null ? bassR : W._wBass + (bassR-W._wBass)*(1-Math.exp(-sdt/170));
    W._wTreb = W._wTreb==null ? trebR : W._wTreb + (trebR-W._wTreb)*(1-Math.exp(-sdt/120));
    // AUTO-RANGE the activity so it spans the FULL speed range — dynamic per passage, not a fixed bpm-ish rate.
    const apr=1-Math.exp(-sdt/9000);
    W._aLo = W._aLo==null ? W._wAct : Math.min(W._wAct, W._aLo + (W._wAct-W._aLo)*apr);
    W._aHi = W._aHi==null ? W._wAct : Math.max(W._wAct, W._aHi + (W._wAct-W._aHi)*apr);
    const aNorm = (W._aHi-W._aLo > 0.015) ? (W._wAct-W._aLo)/(W._aHi-W._aLo) : 0.35;
    // Blend the RELATIVE (auto-ranged) pace with an ABSOLUTE activity floor: when the song is genuinely busy for a
    // while, the auto-range would adapt and drift back to "normal" (stasis) — the absolute term keeps it fast.
    // CAP the wave COUNT for readability — past a density threshold the small waves get hard to read. The "wanted"
    // excess frequency is redirected into faster SCROLL instead (it speeds up to fit the wavecount), so busy/bright
    // passages read as a fast-flowing capped wave rather than a cramped dense one.
    const FREQ_CAP = 1.6 + (s.waveDensity==null?50:s.waveDensity)/100*4;   // Density slider: 1.6 (chunky/readable) … 5.6 (dense); 50 = the prior 3.6 default
    const waves = Math.min(W._wFreq, FREQ_CAP), freqOver = Math.max(0, W._wFreq - FREQ_CAP);
    const aMix = Math.max(aNorm*0.8, Math.min(1, W._wAct*3.4));
    const speed = 0.6 + aMix*7.4 + freqOver*2.8;                       // base flow + the capped-frequency overflow → faster, readable
    W._wPhase = (W._wPhase||0) + speed * W._wDt/1000;                  // scroll by the SMOOTHED frame time → steady, no hitch-jerk
    const env=W._wEnv, ph0=W._wPhase, harm=W._wHarm*0.55, bassA=W._wBass*0.6, trebA=W._wTreb*0.4;
    const ampl = (0.95*env) / (1+harm+bassA+trebA), bright = env;     // normalize for the extra components; NO floor → fully dark on silence/pause
    // ADAPTIVE INTENSITY: on intense (loud/beaty) passages, fatten the line toward full and overdrive brightness;
    // the slider scales how strongly. At full slider: thickness rides 50%→100% and brightness 100%→200% with the
    // loudness envelope. At 0 (default) it's a no-op. Uses env (the smoothed loudness) as the "intensity".
    const adapt = (s.waveAdaptive==null?0:s.waveAdaptive)/100;
    const twE = tw * (1 - adapt*(1-env)*0.5);                         // calm → 50% thickness, intense → 100%
    const brightE = bright * (1 + adapt*env);                        // calm → 100% brightness, intense → 200%
    // SHAPE morph: brightness sharpens the base wave from a rounded SINE (bass) toward a flat-top SQUARE (treble).
    const sharp = 1 + W._wHarm*6, tanhSharp = Math.tanh(sharp);
    for(let k=0;k<NLED;k++){
      const idx = INDICES[k], cell = GRID[idx]; if(!cell) continue;
      const col = cell[0], row = cell[1], o = k*3, fc = GW>1 ? col/(GW-1) : 0;
      const sp = (dir>0 ? fc : 1-fc) - 0.5;                             // CENTER-anchored → frequency squishes/stretches symmetrically about the middle (no left/right reverse-jerk)
      const phase = sp * waves * 6.28318 - ph0;
      const base = Math.tanh(Math.sin(phase)*sharp) / tanhSharp;       // sine→square morph
      // base + 2nd harmonic + a BASS slow half-wavelength swell + a TREBLE fast fine ripple (each shows when prominent)
      const sNorm = (base + harm*Math.sin(phase*2 + ph0*0.6) + bassA*Math.sin(phase*0.5 - ph0*0.2) + trebA*Math.sin(phase*3.2 + ph0*0.9)) * ampl;
      const lineRow = mid - sNorm*amp*mid;                             // center the line; +amp = up (row 0 = top)
      const v = Math.max(0, 1 - Math.abs(row-lineRow)/twE) * brightE;
      if(v < 0.05){ out[o]=out[o+1]=out[o+2]=0; continue; }
      const c = grad ? [col0[0]+(col2[0]-col0[0])*fc, col0[1]+(col2[1]-col0[1])*fc, col0[2]+(col2[2]-col0[2])*fc] : col0;   // start→end (left→right)
      out[o]=Math.min(255,c[0]*v)|0; out[o+1]=Math.min(255,c[1]*v)|0; out[o+2]=Math.min(255,c[2]*v)|0;   // clamp: Adaptive brightness (v up to 2) must clip to white, not wrap in the Uint8 buffer
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
      const a=L.opacity, src=L.rgb, bl=L.blend, df=(L._duck==null?1:L._duck), alpha=L._alpha;   // df = audio-duck dim; alpha = per-key opacity mask (bars alpha-recede), null = uniform opacity
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
        for(let k=0;k<NLED;k++){ const t=k*3, sr=src[t]/255*df, sg=src[t+1]/255*df, sb=src[t+2]/255*df, ak=alpha?a*alpha[k]:a;
          if(sr>0||sg>0||sb>0){ acc[t]=acc[t]*(1-ak)+sr*ak; acc[t+1]=acc[t+1]*(1-ak)+sg*ak; acc[t+2]=acc[t+2]*(1-ak)+sb*ak; } }
        continue;
      }
      for(let i=0;i<acc.length;i++){
        const dst=acc[i], s=src[i]/255*df, aK=alpha?a*alpha[(i/3)|0]:a; let v;   // aK folds the per-key alpha-recede mask into this layer's opacity
        if(bl==='add')           v=Math.min(1, dst + s*aK);
        else if(bl==='screen'){  const sc=1-(1-dst)*(1-s); v=dst*(1-aK)+sc*aK; }
        else if(bl==='multiply'){ const mu=dst*s;           v=dst*(1-aK)+mu*aK; }
        else if(bl==='max'){     const mx=Math.max(dst,s);  v=dst*(1-aK)+mx*aK; }
        else                     v=s*aK + dst*(1-aK);          // normal
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
      const ad={ style:'bars', source:'system', appId:'', deviceId:'', pauseStyle:'linear',
        gain:1, floor:5, attackMs:40, decayMs:220, beatSens:50, micGain:100, micGate:0,
        barColorBass:'#ff2200', barColorTreble:'#22aaff', barTip:'off', barTipColor:'#ffffff', barFill:'solid',
        barColor:'bassTreble', barGradA:'#00ff66', barGradB:'#ff00aa', barLayout:'standard', barDrive:'spectrum', barSpread:false, barDynamics:false, barDynamicsAlpha:false, barDynamicsDepth:60,
        pulseColor:'#19b6ff', pulseColor2:'#ff00aa', pulseGrad:false, pulseGradRev:false, pulseMin:0, pulseMax:100, pulseDrive:'beat',
        pulseDynamics:false, pulseDynamicsAlpha:false, pulseDynamicsDepth:60,
        bloomColor:'#ff5a00', bloomColor2:'#ffd000', bloomGrad:false, bloomGradRev:false, bloomDrive:'beat',
        bloomDynamics:false, bloomDynamicsAlpha:false, bloomDynamicsDepth:60,
        waveColor:'#00e0ff', waveColor2:'#ff00aa', waveGrad:false, waveGradRev:false, waveReverse:false, waveAmp:100, waveThick:50, waveDensity:50, waveAdaptive:0, waveDrive:'volume',
        auroraWidth:50, auroraDrive:'volume', sparkleMono:false, sparkleColor:'#00e0ff', sparkleDrive:'volume',
        sparkleDynamics:false, sparkleDynamicsAlpha:false, sparkleDynamicsDepth:60,
        cropOn:false, cropFit:true, cropX:0.1, cropY:0.1, cropW:0.8, cropH:0.8 };
      Object.keys(ad).forEach(k=>{ if(s[k]===undefined)s[k]=ad[k]; });
      if(s.style==='plasma') s.style='aurora'; else if(s.style==='radial') s.style='bars';   // retired styles → nearest survivor (so an old saved layer doesn't show a blank picker)
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
    hexToRgb, hsv2rgb, patHash, patColorize, audioEnvelope, applyAudioFeatures, audioParams, audioVariantKey,
    keyCell, layerCell,
    PAT_DEFAULTS, patParams, ensureSettings, defaultLayers, createState, applyConfig,
    renderBackground, renderReactive, renderGradient, renderPattern, renderMedia, renderKeys, renderAudio,
    reactEnvelope, applyAdjust, layerNow, renderLayer, composite, flatEq,
    composeFrame, stampKey, releaseKey, SEND_FPS_CAP,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TH108Engine;
  else (root || this).TH108Engine = TH108Engine;
})(typeof self !== 'undefined' ? self : this);
