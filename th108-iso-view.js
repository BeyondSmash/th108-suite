// th108-iso-view.js — "Isometric View": a draggable floating overlay that shows the layer stack as
// separate 3D key-planes, each glowing in sync with its layer's live per-key buffer (L.rgb).
// window.TH108IsoView.create({state, engine, getRunning, onLayersChanged, onState}) -> { toggle, open, close, isOpen }.
// Self-contained (builds its own panel on <body>, own rAF while open); READS layer buffers only — no HID
// writes (composeFrame/renderLayer are pure). Reuses engine.keyCell geometry like th108-paint-board.
//
// View: orthographic 3D — yaw (spin) + pitch (tilt) rotate by click-dragging the canvas; zoom + gap +
// "Enhanced" (wave + stardust + aura) are controls. Click a plane/legend chip to FOCUS one layer (Back to
// return; Face-on tilts it front-flat). Per-layer on/off toggles mirror to the compositor cards. The top
// "System" plane shows firmware-forced lock keys (white when the lock is ON). Carved/silhouetted keys get
// a red "−" (subtract-blend or reactive-isolate keys remove light from the layers below).
(function (root) {
  'use strict';

  const LOCKS = [ {code:'NumLock', led:29}, {code:'CapsLock', led:48}, {code:'ScrollLock', led:100} ];
  const RED = '#FF3E3E', TAU = Math.PI*2, D2R = Math.PI/180;

  function create(opts) {
    const E = opts.engine, state = opts.state, getRunning = opts.getRunning || (()=>false);
    const onLayersChanged = opts.onLayersChanged || (()=>{});
    const onState = opts.onState || (()=>{});
    const extraPlanes = opts.extraPlanes || (()=>[]);   // host-supplied synthetic planes (e.g. Song-progress, future AI/subagent layer) → [{name, rgb}]
    const INDICES = E.INDICES, NLED = INDICES.length, KEYMAP = E.KEYMAP;

    // ---- firmware lock state (browser can't poll the lock LEDs — learn it from key events) ----
    const lock = { NumLock:false, CapsLock:false, ScrollLock:false, known:false };
    function updLock(e){ if(!e.getModifierState) return;
      const n=e.getModifierState('NumLock'), c=e.getModifierState('CapsLock'), s=e.getModifierState('ScrollLock');
      if(lock.known && n===lock.NumLock && c===lock.CapsLock && s===lock.ScrollLock) return;   // unchanged
      lock.known=true; lock.NumLock=n; lock.CapsLock=c; lock.ScrollLock=s;
      try{ saveSoon(); }catch(_){ } }   // persist so the System plane shows the last-known lock state on refresh (browser can't read it back until a keypress)
    // while open + NOT driving, stamp keys into state.react so the Reactive plane reacts to typing in the
    // preview (the page's own keydown handler only stamps while it's driving the board).
    const onDown = e => { ctrlDown=e.ctrlKey; updLock(e); if(!getRunning() && !e.repeat){ const i=KEYMAP[e.code]; if(i!==undefined) E.stampKey(state,i); } };
    const onUp   = e => { ctrlDown=e.ctrlKey; updLock(e); if(!getRunning()){ const i=KEYMAP[e.code]; if(i!==undefined) E.releaseKey(state,i); } };

    // ---- view params ----
    const DEF_YAW = 35*D2R, DEF_PITCH = 20*D2R, DEF_ZOOM = 100, DEF_GAP = 47, DEF_DRAWER = 20;   // default view (DEF_GAP 47 = Gap slider 80); reused by Reset Orientation
    let yaw = DEF_YAW, pitch = DEF_PITCH, zoom = DEF_ZOOM, gap = DEF_GAP, drawer = DEF_DRAWER, enhanced = false, focusIdx = null, auraI = 0.0075, faceOn = false, showKeys = true, hideOff = true, partSize = 0.55, glass = false, waveStyle = 'ripple';   // auraI baked (slider removed); 0.0075 = old slider value 0.75
    let reorder = false, _chipDragI = null;   // Reorder mode: drag a legend CHIP to re-slot that layer in the stack. Transient editing tool — deliberately NOT persisted (you enter it to do a thing, then leave)
    let fxAnim = true, fxParticles = true, fxAura = true;   // Enhanced sub-toggles; all off ⇒ Enhanced off
    const glassAmt = 50, chromaAmt = 6;   // baked (sliders removed): blur/translucency/edge-bend + chromatic-aberration strength
    let ctrlDown = false, ctrlGuide = 0;   // ctrlDown = Ctrl held; ctrlGuide = eased alpha of the Ctrl-drag corner overlay
    const waveFreqs = { ripple:0.8, waveX:1.3 };   // baked frequency per wave style
    const ISO_PITCH = DEF_PITCH, FACE_PITCH = 89*D2R;   // isometric resting tilt (= default) vs front-flat (top-down)
    // Gap slider reads 0-100 but the actual layer spacing stays its original 14-55 range (0→14, 100→55).
    const GAP_LO = 14, GAP_HI = 55;
    const gapToSlider = g => Math.round((g-GAP_LO)/(GAP_HI-GAP_LO)*100);
    const sliderToGap = v => Math.round(GAP_LO + (+v/100)*(GAP_HI-GAP_LO));
    // Zoom slider 0-100 maps to zoom% with 100% pinned at the CENTRE (slider 50): below 50 → 40-100%, above → 100-240%.
    const ZOOM_LO = 40, ZOOM_HI = 240;
    const sliderToZoom = v => { v=+v; return v<=50 ? Math.round(ZOOM_LO + v/50*(100-ZOOM_LO)) : Math.round(100 + (v-50)/50*(ZOOM_HI-100)); };
    const zoomToSlider = z => z<=100 ? Math.round((z-ZOOM_LO)/(100-ZOOM_LO)*50) : Math.round(50 + (z-100)/(ZOOM_HI-100)*50);
    // default/reset zoom scales with the VISIBLE stack (planes actually drawn — layers on + extras + System):
    // up to 6 planes → 100%, then -10% per extra plane (7 → 90%, 8 → 80%, …) so taller stacks fit without
    // manual zoom-out. Never defaults above 100%. Clamped to the slider floor.
    const ZOOM_REF = 6;
    function defZoom(){ let n = ZOOM_REF; try{ n = planeList().length; }catch(_){ } return Math.max(ZOOM_LO, Math.min(100, 100 - 10*Math.max(0, n - ZOOM_REF))); }

    // ---- panel chrome ----
    const panel = document.createElement('div'); panel.className = 'iso-panel'; panel.hidden = true;
    panel.innerHTML =
      '<div class="iso-head"><span class="iso-grip">⠿</span><b>Isometric View</b>' +
      '<span class="iso-spacer"></span>' +
      '<button type="button" class="iso-rs" hidden title="Reset the pop-out window to the default size (use the window\'s own buttons to minimize / maximize)">⤢ Reset size</button>' +
      '<button type="button" class="iso-reset" title="Reset Orientation — zoom / rotation / gap / drawer back to the default view">⟲ Reset</button>' +
      '<button type="button" class="iso-pop" title="Pop out into a separate, resizable window">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/></svg>Pop out</button>' +
      '<button type="button" class="iso-popin" hidden title="Pop back into the page">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M2 10h6V4"/><path d="m2 4 6 6"/><path d="M21 10V7a2 2 0 0 0-2-2h-7"/><path d="M3 14v2a2 2 0 0 0 2 2h3"/><rect width="10" height="7" x="12" y="13" rx="2"/></svg>Pop in</button>' +
      '<button type="button" class="iso-x" title="Close">✕</button></div>' +
      '<div class="iso-sliders">' +   // row 1: wide sliders (so they step by 1) with their value ABOVE
        '<span class="iso-sld" title="Zoom — scale the view (100% is centred)"><span class="iso-sld-top"><span>Zoom</span><small class="iso-zval">100%</small></span><input type="range" class="iso-zoom" min="0" max="100" value="50"></span>' +
        '<span class="iso-sld" title="Gap — spacing between the layers"><span class="iso-sld-top"><span>Gap</span><small class="iso-gval">80</small></span><input type="range" class="iso-gapr" min="0" max="100" value="80"></span>' +
        '<span class="iso-sld" title="Drawer — pull the layers out like a dresser (bottom out the most, each one above it less)"><span class="iso-sld-top"><span>Drawer</span><small class="iso-dval">20</small></span><input type="range" class="iso-draw" min="0" max="100" value="20"></span>' +
      '</div>' +
      '<div class="iso-ctl">' +   // row 2: buttons
        '<button type="button" class="iso-back" hidden>‹ Back</button>' +
        '<button type="button" class="iso-keys on" title="Show the inactive/unused keys so the full keyboard layout reads (esp. face-on / top-down)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/></svg>Keys</button>' +
        '<button type="button" class="iso-hideoff on" title="Hide off/inactive layers from the stack (they still appear as legend chips so you can toggle them back on)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>Hide off</button>' +
        '<button type="button" class="iso-reorder" title="Drag the layer chips in the legend below to change their position in the stack (left chip = bottom layer). The compositor cards re-order to match. Click again to finish."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></svg>Reorder</button>' +
        '<button type="button" class="iso-glass" title="Swap the window background between solid and frosted glass (the page shows through, refracted)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 6 8 9"/><path d="m16 7-8 8"/><rect x="4" y="2" width="16" height="20" rx="2"/></svg>Glass</button>' +
        '<button type="button" class="iso-enh" title="Wave + rising stardust + aura wisps"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/></svg>Enhanced</button>' +
        '<span class="iso-fxgroup iso-efx" style="display:none" title="Enhanced sub-effects — toggle each independently; turning all three off turns Enhanced off">' +
          '<button type="button" class="iso-fxanim" title="Wave ripple animation of the keys + aura">Animation</button>' +
          '<button type="button" class="iso-fxp" title="Rising stardust particles">Particles</button>' +
          '<button type="button" class="iso-fxa" title="Volumetric glow in the gaps">Aura</button>' +
        '</span>' +
        '<select class="iso-wave iso-efx" style="display:none" title="Enhanced wave pattern">' +
          '<option value="ripple">〜 Ripple</option><option value="waveX">→ Wave X</option></select>' +
        '<button type="button" class="iso-face" title="Tilt the board front-flat (keys facing you) vs isometric"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m8 14 4-4 4 4"/></svg>Face-on</button>' +
        '<span class="iso-lock" hidden title="Tilt is locked while Face-on is active — the board faces you flat. Click Face-on again to unlock and tilt freely (you can still spin/yaw).">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' +
      '</div>' +
      '<canvas class="iso-cv"></canvas>' +
      '<div class="iso-legend"></div>' +
      '<div class="iso-foot">' +
        '<div class="iso-read"></div>' +
        '<div class="iso-hint"><span class="iso-hk">Controls</span> drag = rotate · <kbd>Ctrl</kbd>+drag = snap to 90° · click a layer = focus</div>' +
        '<div class="iso-hint"><span class="iso-hk">Legend</span> top “System” plane = firmware lock keys (white = lock on) · red “−” = key carves the layers below</div>' +
      '</div>';
    if (!document.getElementById('iso-view-css')) {
      const st = document.createElement('style'); st.id = 'iso-view-css';
      st.textContent =
        '.iso-panel{position:fixed;left:50%;top:84px;transform:translateX(-50%);z-index:60;width:760px;' +
        'background:var(--card,#161b22);border:1px solid var(--border);border-radius:12px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.5);font:inherit;color:var(--text)}' +
        '.iso-head{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--border);cursor:grab;user-select:none}' +
        '.iso-head.drag{cursor:grabbing}.iso-grip{color:var(--muted,#8b949e)}.iso-head b{font-size:14px}.iso-spacer{margin-left:auto}' +
        '.iso-x{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;' +
        'background:none;border:0;color:var(--muted,#8b949e);font-size:13px;line-height:1;cursor:pointer;padding:0;margin:0}' +
        '.iso-x:hover{color:var(--text);background:rgba(255,255,255,.06)}' +
        '.iso-panel.popped{position:static;left:0;top:0;transform:none;width:100%;height:100vh;border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column}' +
        '.iso-panel.popped .iso-head{cursor:default}.iso-panel.popped .iso-grip{display:none}.iso-panel.popped .iso-x{display:none}' +   // popped: the OS window X is present → the in-UI X is redundant
        '.iso-panel.popped .iso-cv{flex:1 1 0;min-height:0;width:100%;height:auto;margin:6px 0 2px}' +   // flex-basis 0 + min-height:0 → the canvas truly shrinks when the header grows (auto basis aspect-locks a <canvas> so it wouldn\'t)
        '.iso-ctl{display:flex;justify-content:center;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 12px 9px;border-bottom:1px solid var(--border)}' +   // border = separator between the controls (header) and the viewport
        // modern buttons: soft rounded pills, subtle fill, smooth hover, glowing active state (shared by header + control bar)
        '.iso-ctl button,.iso-head>button.iso-pop,.iso-head>button.iso-popin,.iso-head>button.iso-rs,.iso-head>button.iso-reset,.iso-head>button.iso-wmax{margin:0;padding:5px 12px;' +
        'font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);color:var(--text);' +
        'box-shadow:none;cursor:pointer;transition:background .15s,border-color .15s,transform .08s}' +
        '.iso-ctl button:hover,.iso-head>button.iso-pop:hover,.iso-head>button.iso-popin:hover,.iso-head>button.iso-rs:hover,.iso-head>button.iso-reset:hover,.iso-head>button.iso-wmax:hover{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.22)}' +
        '.iso-ctl button:active,.iso-head>button.iso-pop:active,.iso-head>button.iso-popin:active,.iso-head>button.iso-rs:active,.iso-head>button.iso-reset:active,.iso-head>button.iso-wmax:active{transform:translateY(1px)}' +
        '.iso-ctl button.on{background:var(--blue,#58a6ff);border-color:transparent;color:#0d1117;box-shadow:0 2px 10px rgba(88,166,255,.35)}' +
        '.iso-ctl button svg{width:14px;height:14px;vertical-align:-2.5px;margin-right:2px}' +
        // the three Enhanced sub-toggles framed as a subset (blue tint ties them to the Enhanced button); negative left margin tucks the frame up against Enhanced
        '.iso-fxgroup{display:inline-flex;align-items:center;gap:7px;padding:4px 8px;margin-left:-3px;border-radius:11px;border:1px solid rgba(88,166,255,.40);background:rgba(88,166,255,.07)}' +
        '.iso-fxgroup button{font-size:11.5px;padding:4px 10px}' +
        '.iso-ctl select.iso-wave{margin:0;padding:5px 8px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);color:var(--text);cursor:pointer}' +
        '.iso-ctl select.iso-wave:hover{background-image:linear-gradient(0deg,rgba(255,255,255,.10),rgba(255,255,255,.10))}.iso-ctl select.iso-wave:focus{outline:none}' +   // hover brighten via flat overlay (pure paint — no text jiggle); no lingering focus ring
        '.iso-sliders{display:flex;justify-content:center;align-items:flex-end;gap:22px;flex-wrap:wrap;padding:9px 12px 2px}' +
        '.iso-sld{display:inline-flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted,#8b949e)}' +
        '.iso-sld-top{display:flex;justify-content:space-between;align-items:baseline;gap:14px}.iso-sld-top small{color:var(--text);font-size:11px}' +
        '.iso-sld input{width:190px;accent-color:var(--accent,#0ea5a5)}' +   // coral slider in BOTH docked + popped (popout misses the page-global input[type=range] rule)
        '.iso-gl{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted,#8b949e)}.iso-gl input{width:90px}' +
        '.iso-cv{display:block;width:720px;height:392px;margin:6px auto 2px;touch-action:none;cursor:grab}.iso-cv.drag{cursor:grabbing}' +
        '.iso-legend{display:flex;flex-wrap:wrap;gap:6px;padding:9px 12px 2px;border-top:1px solid var(--border)}' +   // border = separator between the viewport and the footer (legend + readout)
        '.iso-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 8px;border-radius:999px;' +
        'background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--border);cursor:pointer;user-select:none}' +
        '.iso-chip.foc{box-shadow:inset 0 0 0 1px var(--blue,#58a6ff)}.iso-chip.off{opacity:.5}' +
        '.iso-seq{color:var(--muted,#8b949e);font-size:12px;user-select:none;align-self:center}' +   // › between chips: reads as the stacking order, bottom → top (same idiom as the binder's macro-step chips)
        // Reorder mode: the draggable chips pulse a soft blue stroke so it's obvious THEY are the handles
        '.iso-chip.reo{cursor:grab;animation:isoReoPulse 1.6s ease-in-out infinite}' +
        '@keyframes isoReoPulse{0%,100%{box-shadow:inset 0 0 0 1px rgba(88,166,255,.45)}50%{box-shadow:inset 0 0 0 1.5px var(--blue,#58a6ff),0 0 9px rgba(88,166,255,.5)}}' +
        '.iso-chip.dragging{opacity:.45}' +
        // drop marks override the pulse (animation off so the edge line shows); blue = will re-slot, red = drop here changes nothing
        '.iso-chip.dropbefore,.iso-chip.dropafter{animation:none}' +
        '.iso-chip.dropbefore{box-shadow:inset 0 0 0 1px var(--border),-3px 0 0 var(--blue,#58a6ff)}' +
        '.iso-chip.dropafter{box-shadow:inset 0 0 0 1px var(--border),3px 0 0 var(--blue,#58a6ff)}' +
        '.iso-chip.dropnoop.dropbefore{box-shadow:inset 0 0 0 1px var(--border),-3px 0 0 #f85149}' +
        '.iso-chip.dropnoop.dropafter{box-shadow:inset 0 0 0 1px var(--border),3px 0 0 #f85149}' +
        '.iso-chip .pw{width:13px;height:13px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;' +
        'box-shadow:inset 0 0 0 1px var(--muted,#8b949e)}.iso-chip.on .pw{background:#3fb950;box-shadow:none;color:#0d1117}' +
        '.iso-foot{padding:7px 12px 11px;font-size:11px;color:var(--muted,#8b949e);line-height:1.5}' +
        '.iso-read{color:var(--text);font-weight:600;margin-bottom:4px}' +
        '.iso-hint{margin-top:2px}.iso-hint+.iso-hint{margin-top:1px}' +
        '.iso-hk{display:inline-block;min-width:54px;color:var(--text);font-weight:700;font-size:9.5px;letter-spacing:.5px;text-transform:uppercase;opacity:.55;margin-right:4px}' +
        '.iso-foot kbd{font:inherit;font-size:10px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:4px;padding:0 4px;color:var(--text)}' +
        // glossy glass: a diagonal light-sweep over the tinted base, a punchier backdrop, and bright inner bevel highlights
        '.iso-panel.glass{background:linear-gradient(135deg,rgba(255,255,255,.14),rgba(255,255,255,.03) 32%,rgba(255,255,255,0) 55%,rgba(255,255,255,.04)),rgba(20,25,33,var(--glass-a,.45));' +
        'backdrop-filter:blur(var(--glass-b,12px)) saturate(1.8) brightness(1.06) url(#iso-glass-ref);-webkit-backdrop-filter:blur(var(--glass-b,12px)) saturate(1.8) brightness(1.06);' +   // url() = SVG displacement-map filter → real edge refraction (Chromium; Safari falls back to blur)
        'border-color:rgba(255,255,255,.28);box-shadow:0 18px 50px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.45),inset 0 0 0 1px rgba(255,255,255,.10),inset 0 -24px 50px rgba(0,0,0,.18),inset 0 2px 14px rgba(255,255,255,.10)}' +
        '.iso-panel.glass .iso-head{border-bottom-color:rgba(255,255,255,.12)}' +
        '.iso-panel.glass.iso-dragging{backdrop-filter:blur(var(--glass-b,12px)) saturate(1.6) url(#iso-glass-ref-lite)!important;-webkit-backdrop-filter:blur(var(--glass-b,12px)) saturate(1.6)!important}';   // dragging → cheaper single-displacement refraction (still visible) instead of the full chromatic recompute
      document.head.appendChild(st);
    }
    document.body.appendChild(panel);

    const cv = panel.querySelector('.iso-cv'), ctx = cv.getContext('2d');
    const SS_MAX = 2, PIX_BUDGET = 1650000, DEF_W = 720, DEF_H = 392;   // budget caps the backing store: ~1.65M px ≈ 1080p, the same cap the renderer rule uses
    let CW = DEF_W, CH = DEF_H, SS = SS_MAX;
    // supersample for crispness, but cap so a maximized pop-out doesn't render an enormous backing store (fill cost ∝ SS²).
    // Docked (720×392 → 282k px) stays at the full 2× (1.13M backing); a big window scales SS down toward 1.
    function sizeCanvas(w,h){ CW=Math.max(160,Math.round(w)); CH=Math.max(120,Math.round(h));
      SS=Math.max(1, Math.min(SS_MAX, Math.sqrt(PIX_BUDGET/(CW*CH))));
      cv.width=Math.round(CW*SS); cv.height=Math.round(CH*SS); }
    sizeCanvas(DEF_W, DEF_H);
    // In the popped window the canvas flex-shrinks when the header grows (Glass slider / Enhanced sub-toggles wrap
    // a new row) WITHOUT a window resize — re-fit the buffer to the canvas's live size so content can't clip up.
    if(window.ResizeObserver){ new ResizeObserver(()=>{ if(popWin && cv.clientWidth>0 && cv.clientHeight>0) sizeCanvas(cv.clientWidth, cv.clientHeight); }).observe(cv); }
    const $ = s => panel.querySelector(s);
    const zoomEl=$('.iso-zoom'), zvalEl=$('.iso-zval'), gapEl=$('.iso-gapr'), gvalEl=$('.iso-gval'), drawEl=$('.iso-draw'), dvalEl=$('.iso-dval'), enhEl=$('.iso-enh'),
          fxanimEl=$('.iso-fxanim'), fxpEl=$('.iso-fxp'), fxaEl=$('.iso-fxa'), keysEl=$('.iso-keys'), hideOffEl=$('.iso-hideoff'),
          glassEl=$('.iso-glass'), waveEl=$('.iso-wave'), reorderEl=$('.iso-reorder'),
          backEl=$('.iso-back'), faceEl=$('.iso-face'), lockEl=$('.iso-lock'), legendEl=$('.iso-legend'), readEl=$('.iso-read'), hintEl=$('.iso-hint');
    // ---- persistence: remember the view settings between sessions ----
    const SKEY='th108_iso_view';
    function saveSettings(){ try{ localStorage.setItem(SKEY, JSON.stringify({yaw,pitch,zoom,gap,drawer,enhanced,fxAnim,fxParticles,fxAura,glass,showKeys,hideOff,faceOn,waveStyle,
      lockK:lock.known,lockN:lock.NumLock,lockC:lock.CapsLock,lockS:lock.ScrollLock})); }catch(_){ } }
    let _saveT=0; function saveSoon(){ clearTimeout(_saveT); _saveT=setTimeout(saveSettings, 350); }
    function loadSettings(){ let s; try{ s=JSON.parse(localStorage.getItem(SKEY)); }catch(_){ } if(!s||typeof s!=='object'){ zoom=defZoom(); return; }
      if(typeof s.yaw==='number') yaw=s.yaw; if(typeof s.pitch==='number') pitch=s.pitch;
      if(typeof s.zoom==='number') zoom=s.zoom; else zoom=defZoom(); if(typeof s.gap==='number') gap=Math.min(55,Math.max(14,s.gap));   // no saved zoom → layer-count default; clamp gap to the slider range
      if(typeof s.drawer==='number') drawer=Math.min(100,Math.max(0,s.drawer));
      enhanced=!!s.enhanced; glass=!!s.glass; showKeys=s.showKeys!==false; hideOff=s.hideOff!==false; faceOn=!!s.faceOn; if(s.waveStyle==='ripple'||s.waveStyle==='waveX') waveStyle=s.waveStyle;
      if(s.lockK){ lock.known=true; lock.NumLock=!!s.lockN; lock.CapsLock=!!s.lockC; lock.ScrollLock=!!s.lockS; }   // restore last-known lock state → System plane shows on refresh
      if(typeof s.fxAnim==='boolean') fxAnim=s.fxAnim; if(typeof s.fxParticles==='boolean') fxParticles=s.fxParticles; if(typeof s.fxAura==='boolean') fxAura=s.fxAura;
      if(enhanced && !(fxAnim||fxParticles||fxAura)){ fxAnim=fxParticles=fxAura=true; } }   // never "Enhanced on" with all three sub-features off
    function syncControls(){   // push the (possibly restored) state into the UI controls
      zoomEl.value=zoomToSlider(zoom); zvalEl.textContent=zoom+'%'; gapEl.value=gapToSlider(gap); gvalEl.textContent=gapToSlider(gap); drawEl.value=drawer; dvalEl.textContent=drawer;
      waveEl.value=waveStyle;
      enhEl.classList.toggle('on',enhanced); panel.querySelectorAll('.iso-efx').forEach(el=>el.style.display=enhanced?'':'none');
      // each sub-feature's extra widget gates on its own flag too: the Aura slider only with Aura on, the wave dropdown only with Animation on
      waveEl.style.display=(enhanced&&fxAnim)?'':'none';
      fxanimEl.classList.toggle('on',fxAnim); fxpEl.classList.toggle('on',fxParticles); fxaEl.classList.toggle('on',fxAura);
      keysEl.classList.toggle('on',showKeys); hideOffEl.classList.toggle('on',hideOff); glassEl.classList.toggle('on',glass); applyGlass();
      faceEl.classList.toggle('on',faceOn); lockEl.hidden=!faceOn; }
    // Build the SVG displacement-map filter (#iso-glass-ref) ONCE per document: a normal-map that's neutral in the
    // centre and bends outward at the rim, so backdrop-filter:url() refracts the page through the panel EDGES (not
    // just blur). Docked only — a popped OS window has no backdrop to refract.
    function buildGlassFilter(doc){ if(!doc || doc.getElementById('iso-glass-svg')) return;
      // Edge normal map: a THIN rim band whose displacement points outward at the very edge and falls to neutral
      // (128) well before the centre — so only the rim bends light, not the whole backdrop. Corners blend both axes.
      const M=220, c=document.createElement('canvas'); c.width=c.height=M; const q=c.getContext('2d');
      const im=q.createImageData(M,M), d=im.data, band=M*0.085;
      // smoothstep edge proximity → TANGENTIAL stretch: near the left/right rim the backdrop is stretched
      // VERTICALLY (along that edge), near the top/bottom rim it's stretched HORIZONTALLY — i.e. parallel to the
      // edge, not perpendicular. Displacement ∝ position so it magnifies (stretches) rather than rigidly shifts.
      const fall=t=>{ let s=Math.max(0,Math.min(1,1-t/band)); return s*s*(3-2*s); };
      for(let y=0;y<M;y++) for(let x=0;x<M;x++){ const i=(y*M+x)*4;
        const px=(x/(M-1)-0.5)*2, py=(y/(M-1)-0.5)*2;   // position across the panel, -1..1
        const fLR=Math.max(fall(x),fall(M-1-x)), fTB=Math.max(fall(y),fall(M-1-y));   // proximity to L/R vs T/B edges
        d[i]=128 + fTB*px*127;     // X-disp scaled by x-position → horizontal stretch ALONG the top/bottom edges
        d[i+1]=128 + fLR*py*127;   // Y-disp scaled by y-position → vertical stretch ALONG the left/right edges
        d[i+2]=128; d[i+3]=255; }
      q.putImageData(im,0,0); const url=c.toDataURL();
      const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg'); svg.id='iso-glass-svg';
      svg.setAttribute('width','0'); svg.setAttribute('height','0'); svg.style.position='absolute';
      // chromatic aberration: displace the backdrop's R / G / B by DIFFERENT scales, then recombine → colour fringing
      // where the displacement is strong (the rim). scales are set live from the sliders in applyGlass().
      svg.innerHTML='<filter id="iso-glass-ref" color-interpolation-filters="sRGB" x="-4%" y="-4%" width="108%" height="108%">'
        +'<feImage href="'+url+'" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" result="m"/>'
        +'<feDisplacementMap in="SourceGraphic" in2="m" xChannelSelector="R" yChannelSelector="G" scale="26" result="dr"/>'
        +'<feDisplacementMap in="SourceGraphic" in2="m" xChannelSelector="R" yChannelSelector="G" scale="20" result="dg"/>'
        +'<feDisplacementMap in="SourceGraphic" in2="m" xChannelSelector="R" yChannelSelector="G" scale="14" result="db"/>'
        +'<feColorMatrix in="dr" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cr"/>'
        +'<feColorMatrix in="dg" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cg"/>'
        +'<feColorMatrix in="db" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cb"/>'
        +'<feBlend in="cr" in2="cg" mode="screen" result="crg"/>'
        +'<feBlend in="crg" in2="cb" mode="screen"/></filter>'
        // LITE filter: a single displacement (no chroma split / recombine) → ~3x cheaper; used WHILE DRAGGING so
        // the refraction stays visible without the per-frame chromatic recompute janking the drag.
        +'<filter id="iso-glass-ref-lite" color-interpolation-filters="sRGB" x="-4%" y="-4%" width="108%" height="108%">'
        +'<feImage href="'+url+'" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" result="ml"/>'
        +'<feDisplacementMap in="SourceGraphic" in2="ml" xChannelSelector="R" yChannelSelector="G" scale="20"/></filter>';
      doc.body.appendChild(svg);
    }
    // glassiness → CSS vars consumed by .iso-panel.glass (docked: real blur + edge refraction; popped: painted sheen in draw())
    function applyGlass(){ panel.classList.toggle('glass',glass);
      panel.style.setProperty('--glass-b', (glassAmt/100*7).toFixed(1)+'px');   // minimal blur so the edge refraction + chromatic fringe stay crisp
      panel.style.setProperty('--glass-a', (0.16 + glassAmt/100*0.40).toFixed(3));
      const doc=panel.ownerDocument; buildGlassFilter(doc);
      const fdms=doc.querySelectorAll('#iso-glass-ref feDisplacementMap');   // R / G / B displaced by different amounts → chromatic aberration
      if(fdms.length>=3){ const base=34+glassAmt/100*120, sp=base*(chromaAmt/100*0.6);   // stronger displacement → the tangential stretch reads as a SMEAR along the rim
        fdms[0].setAttribute('scale',(base+sp).toFixed(1)); fdms[1].setAttribute('scale',base.toFixed(1)); fdms[2].setAttribute('scale',(base-sp).toFixed(1));
        const lite=doc.querySelector('#iso-glass-ref-lite feDisplacementMap'); if(lite) lite.setAttribute('scale',base.toFixed(1)); } }
    keysEl.addEventListener('click', ()=>{ showKeys=!showKeys; keysEl.classList.toggle('on',showKeys); saveSoon(); });
    hideOffEl.addEventListener('click', ()=>{ hideOff=!hideOff; hideOffEl.classList.toggle('on',hideOff); buildLegend(); saveSoon(); });   // hide off/inactive planes from the stack (legend chips still list them so they can be toggled back on)
    // Reorder mode — the controls hint swaps to reorder instructions while active
    const _hint0=hintEl.innerHTML;
    reorderEl.addEventListener('click', ()=>{ reorder=!reorder; _chipDragI=null; reorderEl.classList.toggle('on',reorder); buildLegend();
      hintEl.innerHTML = reorder ? '<span class="iso-hk">Reorder</span> drag a layer chip in the legend below to re-slot it (left = bottom of the stack) · click Reorder again to finish' : _hint0; });
    glassEl.addEventListener('click', ()=>{ glass=!glass; glassEl.classList.toggle('on',glass); applyGlass(); saveSoon(); });   // frosted-glass window (glassiness baked)
    waveEl.addEventListener('change', e=>{ waveStyle=e.target.value; saveSoon(); });
    // keys must NOT interact with the iso UI (Enter was re-toggling the focused Face-on button) — blur any control
    // after a click so it never holds keyboard focus. Reactive still reacts (that's a window-level key listener).
    panel.addEventListener('click', e=>{ const t=e.target.closest('button,input'); if(t&&t.blur) t.blur(); });   // NOT select — blurring it mid-click closed the dropdown (had to hold to pick)
    // Enter / numpad-Enter / Space must NOT activate a focused iso button (esp. the close ✕, which was exiting the
    // window) — these controls are mouse-driven, and Enter belongs to reactive typing. preventDefault kills the
    // keyboard "click" without stopping propagation, so the reactive key handler still sees the keydown.
    panel.addEventListener('keydown', e=>{ if((e.key==='Enter'||e.key===' ') && e.target.closest('button')) e.preventDefault(); });
    zoomEl.addEventListener('input', e=>{ zoom=sliderToZoom(e.target.value); zvalEl.textContent=zoom+'%'; saveSoon(); });
    gapEl.addEventListener('input', e=>{ gap=sliderToGap(e.target.value); gvalEl.textContent=e.target.value; saveSoon(); });
    drawEl.addEventListener('input', e=>{ drawer=+e.target.value; dvalEl.textContent=e.target.value; saveSoon(); });
    // Home/End/PageUp/PageDown natively jam a focused range input to min/max — block them so those keys
    // (used for reactive lighting / nav) don't yank a slider. Arrow keys still fine-adjust.
    [zoomEl,gapEl,drawEl].forEach(el=> el.addEventListener('keydown', e=>{ if(e.key==='Home'||e.key==='End'||e.key==='PageUp'||e.key==='PageDown') e.preventDefault(); }));
    enhEl.addEventListener('click', ()=>{ enhanced=!enhanced; if(enhanced) fxAnim=fxParticles=fxAura=true; syncControls(); saveSoon(); });   // turning Enhanced on enables all three sub-features
    // sub-toggles: flip one feature; if that leaves all three off, Enhanced itself turns off
    function toggleFx(set){ set(); if(!(fxAnim||fxParticles||fxAura)) enhanced=false; syncControls(); saveSoon(); }
    fxanimEl.addEventListener('click', ()=>toggleFx(()=>fxAnim=!fxAnim));
    fxpEl.addEventListener('click', ()=>toggleFx(()=>fxParticles=!fxParticles));
    fxaEl.addEventListener('click', ()=>toggleFx(()=>fxAura=!fxAura));
    backEl.addEventListener('click', ()=>{ focusIdx=null; backEl.hidden=true; if(!faceOn){ pitch=ISO_PITCH; yaw=DEF_YAW; } buildLegend(); saveSoon(); });
    // Face-on: snap to a flat front-facing (top-down) view AND lock tilt (so a drag can't knock it off); yaw still spins.
    faceEl.addEventListener('click', ()=>{ faceOn=!faceOn; pitch=faceOn?FACE_PITCH:ISO_PITCH; if(faceOn) yaw=0; faceEl.classList.toggle('on',faceOn); lockEl.hidden=!faceOn; saveSoon(); });
    // Reset Orientation: restore the whole view (zoom / rotation / gap / drawer) to the default and clear focus / Face-on
    $('.iso-reset').addEventListener('click', ()=>{ yaw=DEF_YAW; pitch=DEF_PITCH; zoom=defZoom(); gap=DEF_GAP; drawer=DEF_DRAWER; focusIdx=null; faceOn=false; backEl.hidden=true; lockEl.hidden=true; faceEl.classList.remove('on'); buildLegend(); syncControls(); saveSoon(); });
    loadSettings(); syncControls();

    // ---- drag the panel by its header ----
    const head = $('.iso-head'); let dg=null;
    head.addEventListener('pointerdown', e=>{ if(e.target.closest('button')) return;   // don't start a drag on the header BUTTONS (pop-out/pop-in/reset/close) — capturing the pointer here suppressed their clicks
      const r=panel.getBoundingClientRect(); panel.style.transform='none'; panel.style.left=r.left+'px'; panel.style.top=r.top+'px';
      dg={dx:e.clientX-r.left,dy:e.clientY-r.top}; head.classList.add('drag'); panel.classList.add('iso-dragging'); head.setPointerCapture(e.pointerId); e.preventDefault(); });
    head.addEventListener('pointermove', e=>{ if(!dg) return;
      const maxL=Math.max(0,window.innerWidth-panel.offsetWidth), maxT=Math.max(0,window.innerHeight-panel.offsetHeight);
      panel.style.left=Math.min(maxL,Math.max(0,e.clientX-dg.dx))+'px';
      panel.style.top =Math.min(maxT,Math.max(0,e.clientY-dg.dy))+'px'; });   // clamp to all four viewport edges
    head.addEventListener('pointerup', ()=>{ dg=null; head.classList.remove('drag'); panel.classList.remove('iso-dragging'); });

    // ---- rotate by dragging the canvas (small move = a click → focus the plane under it) ----
    let rot=null;
    cv.addEventListener('pointerdown', e=>{ rot={x:e.clientX,y:e.clientY,y0:yaw,p0:pitch,moved:0,px:hitX(e),py:hitY(e)};
      cv.setPointerCapture(e.pointerId); e.preventDefault(); });
    cv.addEventListener('pointermove', e=>{ if(!rot) return; ctrlDown=e.ctrlKey; const dx=e.clientX-rot.x, dy=e.clientY-rot.y;
      rot.moved=Math.max(rot.moved,Math.abs(dx)+Math.abs(dy));
      yaw=rot.y0 - dx*0.7*D2R; if(!faceOn) pitch=Math.max(8*D2R, Math.min(90*D2R, rot.p0 + dy*0.5*D2R));   // horizontal drag → yaw (negated so the grabbed point follows the cursor); Face-on locks tilt
      if(e.ctrlKey){   // hold Ctrl → snap yaw/tilt to the nearest 90° interval when within ~12°
        const snap=(rad)=>{ const d=rad/D2R, n=Math.round(d/90)*90; return Math.abs(d-n)<12 ? n*D2R : rad; };
        yaw=snap(yaw); if(!faceOn){ const ps=snap(pitch); pitch=Math.max(8*D2R,Math.min(90*D2R,ps)); }
      }
      cv.classList.toggle('drag', rot.moved>4); });
    cv.addEventListener('pointerup', e=>{ if(!rot) return; const click=rot.moved<=4; const mv=rot; rot=null; cv.classList.remove('drag');
      if(click) clickAt(mv.px, mv.py); saveSoon(); });   // persist the new orientation/focus
    const hitX=e=>{ const b=cv.getBoundingClientRect(); return (e.clientX-b.left)*CW/b.width; };
    const hitY=e=>{ const b=cv.getBoundingClientRect(); return (e.clientY-b.top)*CH/b.height; };

    // ---- geometry: board (u,v)∈[0,1]² + height by → orthographic screen px ----
    const BW0=360, BD=BW0*(E.BOARDH/E.BOARDW);   // board width / depth in px (keeps keys ~square)
    const RECTS = INDICES.map((led,k)=>{ const c=E.keyCell(led); return c ? { k, u:c[0], v:c[1], hw:c[2]*0.46, hh:c[3]*0.46 } : null; }).filter(Boolean);
    const LOCK_K = LOCKS.map(L=>({...L, k:INDICES.indexOf(L.led)})).filter(L=>L.k>=0);
    const sysRgb = new Uint8Array(NLED*3);

    // proj is called ~1300×/frame (every key × every plane + aura footprints). yaw/pitch/zoom are constant
    // within a frame, so cache their trig and only recompute when one actually changes — saves ~5k trig ops/frame.
    let _pY=NaN,_pP=NaN,_pZ=NaN,_cY=1,_sY=0,_cP=1,_sP=0,_Z=1;
    function proj(bx,bz,by,cx,cy){
      if(yaw!==_pY||pitch!==_pP||zoom!==_pZ){ _pY=yaw;_pP=pitch;_pZ=zoom; _cY=Math.cos(yaw);_sY=Math.sin(yaw);_cP=Math.cos(pitch);_sP=Math.sin(pitch);_Z=zoom/100; }
      const rx=bx*_cY - bz*_sY, rz=bx*_sY + bz*_cY;
      const up=by*_cP - rz*_sP, depth=by*_sP + rz*_cP;
      return [ cx + rx*_Z, cy - up*_Z, depth ];
    }
    // enhanced-wave height offset per key (u,v normalized; j = plane index; t seconds). waveFreqs[style] sets the
    // spatial frequency (the slider, per style). Ripple = diagonal; Wave X = horizontal traveling wave.
    function waveFn(u,v,j,t){ const f=waveFreqs[waveStyle]||1;
      if(waveStyle==='waveX') return Math.sin(u*TAU*f - t*2.2 + j*0.4);
      return Math.sin((u*f + v*f*0.5)*TAU + t*1.7 + j*0.6);   // 'ripple'
    }

    function avgColor(rgb){ let r=0,g=0,b=0,n=0; for(let k=0;k<NLED;k++){ const t=k*3, L=rgb[t]+rgb[t+1]+rgb[t+2]; if(L>24){ r+=rgb[t];g+=rgb[t+1];b+=rgb[t+2];n++; } } return n?[r/n|0,g/n|0,b/n|0]:null; }
    function carveMask(L){ if(L.type==='reactive') return null; return L._carve || null; }   // reactive keys never get the carve silhouette (black face + red "−")

    function fillSysRgb(){ sysRgb.fill(0); if(!lock.known) return;
      for(const L of LOCK_K) if(lock[L.code]){ sysRgb[L.k*3]=255; sysRgb[L.k*3+1]=255; sysRgb[L.k*3+2]=255; } }

    // ordered plane descriptors: real layers (numbered, toggleable) → host extras (Song-progress, AI…) → System
    function gather(){ fillSysRgb();
      const out = state.layers.map((L,i)=>({L, i, id:i, num:i+1, name:L.name||('Layer '+(i+1)), rgb:L.rgb, off:!L.enabled, toggle:true, sys:false}));
      let xi=0; for(const ex of extraPlanes()) if(ex && ex.rgb) out.push({L:null, i:-1, id:'x'+(xi++), num:0, name:ex.name||'Extra', rgb:ex.rgb, off:false, toggle:false, sys:false});
      const sysOn = lock.known && LOCK_K.some(L=>lock[L.code]);   // no lock LED lit → the System plane is inactive (off), like any other empty layer
      out.push({L:null, i:-1, id:'sys', num:0, name:'System', rgb:sysRgb, off:!sysOn, toggle:false, sys:true});
      return out;
    }
    function planeList(){ let g=gather(); if(focusIdx==null){ return hideOff ? g.filter(p=>!p.off) : g; } const f=g.find(p=>p.id===focusIdx); return f?[f]:g; }   // when focused, always show the focused plane even if off
    function focusTo(id){ focusIdx=(focusIdx===id)?null:id; backEl.hidden=(focusIdx==null); if(focusIdx==null && !faceOn) pitch=ISO_PITCH; buildLegend(); }

    // ---- legend chips (focus on click; power dot toggles enabled, mirrored to the compositor) ----
    // Chips run bottom layer → top, joined by › (same idiom as the macro-step chips in the binder).
    // In Reorder mode the real-layer chips become draggable: drop between chips re-slots the layer.
    function buildLegend(){ legendEl.innerHTML='';
      gather().forEach((p,gi)=>{
        if(gi){ const sep=document.createElement('span'); sep.className='iso-seq'; sep.textContent='›'; legendEl.appendChild(sep); }
        const chip=document.createElement('span');
        chip.className='iso-chip'+(p.off?' off':' on')+((focusIdx===p.id)?' foc':'')+((reorder&&p.toggle)?' reo':'');
        chip.innerHTML=(p.num?'<b>'+p.num+'</b> ':'')+'<span class="nm"></span>'+(p.toggle?'<span class="pw" title="toggle layer">⏻</span>':'');
        chip.querySelector('.nm').textContent=p.name;
        if(reorder && p.toggle){ chip.draggable=true; chip.dataset.i=p.i; chip.title='drag to re-slot this layer';
          chip.addEventListener('dragstart', e=>{ _chipDragI=p.i; chip.classList.add('dragging'); if(e.dataTransfer) e.dataTransfer.effectAllowed='move'; });
          chip.addEventListener('dragend', ()=>{ _chipDragI=null; chip.classList.remove('dragging'); clearChipMarks(); });
        }
        chip.addEventListener('click', e=>{ if(p.toggle && e.target.closest('.pw')){ p.L.enabled=!p.L.enabled; onLayersChanged(); buildLegend(); return; } focusTo(p.id); });
        legendEl.appendChild(chip);
      });
    }
    // container-level drag handling for Reorder mode (attached once): gap-insert semantics — the accent edge
    // shows which side of the hovered chip the layer will land on. Only real-layer chips carry data-i.
    function clearChipMarks(){ legendEl.querySelectorAll('.iso-chip').forEach(c=>c.classList.remove('dropbefore','dropafter','dropnoop')); }
    function chipDropAt(clientX){ const chips=[...legendEl.querySelectorAll('.iso-chip[data-i]')]; if(!chips.length) return null;
      let d=null;
      for(const c of chips){ const r=c.getBoundingClientRect(); if(clientX < r.left + r.width/2){ d={ i:+c.dataset.i, before:true, el:c }; break; } }
      if(!d){ const last=chips[chips.length-1]; d={ i:+last.dataset.i, before:false, el:last }; }
      let to=d.i+(d.before?0:1); if(to>from()) to--;   // removing the layer first shifts the insertion point left
      d.to=to; d.noop=(to===from());   // landing in the slot it already occupies = nothing would change
      return d; }
    const from=()=>_chipDragI;
    legendEl.addEventListener('dragover', e=>{ if(_chipDragI==null) return; e.preventDefault(); clearChipMarks();
      const d=chipDropAt(e.clientX); if(d){ d.el.classList.add(d.before?'dropbefore':'dropafter'); if(d.noop) d.el.classList.add('dropnoop'); } });
    legendEl.addEventListener('drop', e=>{ if(_chipDragI==null) return; e.preventDefault();
      const d=chipDropAt(e.clientX); clearChipMarks(); const fromI=_chipDragI; _chipDragI=null; if(!d || d.noop) return;
      const [Lm]=state.layers.splice(fromI,1); state.layers.splice(d.to,0,Lm);
      focusIdx=null; backEl.hidden=true;   // plane ids are layer indices — a move invalidates a numeric focus
      onLayersChanged(); buildLegend(); });
    function clickAt(px,py){ for(let i=_planes.length-1;i>=0;i--){ if(inQuad(px,py,_planes[i].quad)){ focusTo(_planes[i].id); return; } } }
    function inQuad(px,py,q){ let s=0; for(let i=0;i<4;i++){ const a=q[i], b=q[(i+1)%4];
      const cr=(b[0]-a[0])*(py-a[1])-(b[1]-a[1])*(px-a[0]); const sg=cr>0?1:cr<0?-1:0; if(sg){ if(s&&sg!==s) return false; s=sg; } } return true; }

    // ---- enhanced FX: rising stardust particles ----
    const P=[]; let _planes=[]; const _csm=[];   // _csm = per-plane temporally-smoothed colour (anti-twitch for the aura)
    // Particles live in BOARD space (bx,bz,by) and are re-projected every frame, so they stay rigidly anchored to
    // the scene when you rotate/zoom (no screen-space drift "catching up"). They rise by increasing their board
    // height (by) and sway a little along the board x-axis.
    function spawnParticles(dt, byOf, dzOf){
      if(_planes.length<1) return;
      const act=[]; for(let p=0;p<_planes.length;p++) if(!_planes[p].off) act.push(p);   // off/inactive layers emit no stardust
      if(!act.length) return;
      const rate = 60*dt/1000;   // small dust → spawn more of them
      let n = rate + (Math.random()<(rate%1)?1:0);
      for(let s=0;s<n;s++){ const p=act[(Math.random()*act.length)|0]; const col=_planes[p].col||[150,170,210];
        P.push({ bx:(Math.random()-0.5)*0.9*BW0, bz:(Math.random()-0.5)*0.9*BD+(dzOf?dzOf(p):0), by:byOf(p)+gap*0.12,
                 vby:14+Math.random()*22, life:0, max:0.8+Math.random()*1.0, col,
                 sz:0.45+Math.random()*0.7, seed:Math.random()*TAU, tw:14+Math.random()*16, sway:5+Math.random()*7 }); }   // board-space rise + sway; seed/tw = twinkle
      if(P.length>320) P.splice(0,P.length-320);
    }
    function drawParticles(dt, cx, cy){
      ctx.globalCompositeOperation='lighter'; const ds=dt/1000;
      for(let i=P.length-1;i>=0;i--){ const q=P[i]; q.life+=ds;
        const t=q.life/q.max; if(t>=1){ P.splice(i,1); continue; }
        q.by += q.vby*ds;                                          // rise in BOARD space (rotates/zooms with the scene)
        const bx=q.bx + Math.sin(q.life*1.5+q.seed)*q.sway;        // gentle board-space sway along the rise
        const pp=proj(bx, q.bz, q.by, cx, cy);                     // re-project against the CURRENT view → stays anchored
        const tw=0.35+0.65*(0.5+0.5*Math.sin(q.life*q.tw+q.seed));   // fast twinkle
        const a=Math.sin(t*Math.PI)*0.95*tw, r=q.sz*partSize, cs='rgba('+q.col[0]+','+q.col[1]+','+q.col[2]+',';
        ctx.fillStyle=cs+(a*0.32)+')'; ctx.beginPath(); ctx.arc(pp[0],pp[1],r*2.3,0,TAU); ctx.fill();   // faint halo (plain fill — no per-particle gradient = much cheaper)
        ctx.fillStyle=cs+a+')'; ctx.beginPath(); ctx.arc(pp[0],pp[1],r,0,TAU); ctx.fill(); }   // bright core
      ctx.globalCompositeOperation='source-over';
    }
    // ===== AURA: rising textured wisps projected from each layer's lit keys (gobo / spotlight style) =====
    // Per plane: (1) stamp its lit keys as soft COLOUR blobs into a footprint buffer; (2) smear that footprint
    // UPWARD along the board-height axis with a fade → a colour column rising off the keys; (3) MULTIPLY by a slowly
    // UV-scrolling aura texture so the column breaks into organic rising filaments (the reference look). Key-aware:
    // no lit keys → no aura; dark/carved keys emit nothing. Drawn after the plane's keys + before the next plane up
    // → the layer above occludes it (depth). The column rides the same waveFn the keys do, so it still ripples.
    const auraTex=new Image(); let texReady=false; auraTex.onload=()=>{texReady=true;}; auraTex.src='iso-aura-tex.png';
    const _glow=document.createElement('canvas'), _gctx=_glow.getContext('2d');
    const _foot=document.createElement('canvas'), _fctx=_foot.getContext('2d');
    const GLOWS=0.30;       // offscreen render scale (extra blur on upscale)
    const AURA_GAIN=3.5;    // auraI(slider/100) → footprint alpha; low because the upward smear + texture accumulate
    const RISE_K=12;        // smear copies = vertical resolution of the rising column
    function drawPlaneGlow(j, rgb, tSec, cx, cy, AMP, by, dz){
      if(auraI<=0 || !_planes[j] || !rgb) return;
      const gw=Math.max(2,Math.round(CW*GLOWS)), gh=Math.max(2,Math.round(CH*GLOWS));
      if(_glow.width!==gw){ _glow.width=gw; _foot.width=gw; } if(_glow.height!==gh){ _glow.height=gh; _foot.height=gh; }
      _fctx.setTransform(1,0,0,1,0,0); _fctx.globalAlpha=1; _fctx.globalCompositeOperation='source-over'; _fctx.clearRect(0,0,gw,gh);
      _gctx.setTransform(1,0,0,1,0,0); _gctx.globalAlpha=1; _gctx.globalCompositeOperation='source-over'; _gctx.clearRect(0,0,gw,gh);
      // (1) footprint: lit-key soft colour blobs, seated a bit ABOVE the plane so the blob's lower bloom doesn't
      // spill below the keys (the "clips through the bottom"); the column then rises up from there. Constant height
      // (NOT wave-displaced) so it doesn't breathe.
      const rad=Math.max(2.5, _planes[j].hw*GLOWS*0.13); const riseBase=by + gap*0.22; let any=false;
      _fctx.globalCompositeOperation='lighter';
      for(const r of RECTS){ const t=r.k*3, cr=rgb[t],cg=rgb[t+1],cb=rgb[t+2], lum=0.299*cr+0.587*cg+0.114*cb;
        if(lum<16) continue;
        const p=proj((r.u-0.5)*BW0, (r.v-0.5)*BD+dz, riseBase, cx, cy);
        _fctx.globalAlpha=Math.min(1, (lum/255)*AURA_GAIN*auraI);
        _fctx.fillStyle='rgb('+cr+','+cg+','+cb+')';
        _fctx.beginPath(); _fctx.arc(p[0]*GLOWS, p[1]*GLOWS, rad, 0, TAU); _fctx.fill(); any=true;
      }
      _fctx.globalAlpha=1; _fctx.globalCompositeOperation='source-over';
      if(!any) return;
      // (2) smear the footprint UP the board-height axis (one gap of rise), fading → a colour column rising off the keys
      const o0=proj(0,0,by,cx,cy), o1=proj(0,0,by+1,cx,cy);
      const sx=(o1[0]-o0[0])*gap*0.95/RISE_K*GLOWS, sy=(o1[1]-o0[1])*gap*0.95/RISE_K*GLOWS;
      _gctx.globalCompositeOperation='lighter';
      for(let k=0;k<RISE_K;k++){ _gctx.globalAlpha=Math.pow(1-k/RISE_K, 1.3); _gctx.drawImage(_foot, sx*k, sy*k); }
      _gctx.globalAlpha=1;
      // (3) carve the column into rising filaments with the UV-scrolling aura texture (scrolls upward → wisps rise).
      // multiply bleeds the texture into the EMPTY areas too (transparent backdrop → raw source), so copy the column
      // out as a shape mask first, then re-mask with destination-in to clip the texture back to the column.
      if(texReady){
        _fctx.globalCompositeOperation='source-over'; _fctx.globalAlpha=1; _fctx.clearRect(0,0,gw,gh); _fctx.drawImage(_glow,0,0);
        _gctx.globalCompositeOperation='multiply'; _gctx.globalAlpha=0.5;   // partial multiply → texture dims the glow without punching it to black (less "darkness" in the aura)
        const TH=gh*1.7, scroll=((tSec*0.16)%1)*TH;   // two stacked copies → seamless vertical wrap
        _gctx.drawImage(auraTex, 0, -scroll, gw, TH);
        _gctx.drawImage(auraTex, 0, TH-scroll, gw, TH);
        _gctx.globalCompositeOperation='destination-in'; _gctx.globalAlpha=1; _gctx.drawImage(_foot,0,0);   // clip texture back to the column shape
        _gctx.globalCompositeOperation='source-over';
      }
      // (4) composite the rising aura onto the scene (bilinear upscale = extra softening)
      ctx.setTransform(SS,0,0,SS,0,0); ctx.imageSmoothingEnabled=true; ctx.globalCompositeOperation='lighter';
      ctx.drawImage(_glow, 0,0,gw,gh, 0,0,CW,CH);
      ctx.globalCompositeOperation='source-over';
    }

    // ---- main draw ----
    let _last=0, _fam=null;
    function draw(now){
      const dt=Math.min(80, _last?now-_last:16); _last=now; const tSec=now/1000;
      const P0=planeList(), N=P0.length;
      const AMP = (enhanced && fxAnim) ? gap*0.20 : 0;   // wave ripple only when the Animation sub-toggle is on
      // height of plane index within the drawn set, centered
      const byOf = j => (j-(N-1)/2)*gap;
      // "Drawer": pull each plane out along the board-depth axis like a dresser — the BOTTOM layer (j=0) out the
      // most, each one above it less. dz is a depth (+bz) offset; stepFrac = 1 at bottom → 0 at top.
      // Scale the max pull with the layer count so drawer=100 separates every adjacent plane by >1 board-depth
      // along the pull axis — i.e. they no longer overlap even in top-down view (Face-on / 90° tilt).
      // DRAWER_CAP holds the slider's 100 to the user-preferred pull (the old value-83 distance) while it still reads 100.
      const DRAWER_CAP = 0.83;
      const DRAW_MAX = Math.max(1,N-1) * BD * 1.3;
      const dzOf = j => (N>1 ? (N-1-j)/(N-1) : 0) * (drawer/100*DRAWER_CAP) * DRAW_MAX;
      // measure the widest label first so the board can sit just right of a column wide enough to never clip them
      ctx.setTransform(SS,0,0,SS,0,0);
      const FAM=_fam||(_fam=getComputedStyle(document.body).fontFamily||'system-ui,sans-serif');   // cached — body font doesn't change frame-to-frame, and getComputedStyle forces a style recalc
      // suffix: System reads "(press a key)" until its lock state is known, then "(inactive)" when no lock LED is lit; ordinary layers read "(off)" when disabled
      const labelStr = pl => { const suf = pl.sys ? (!lock.known ? '  (press a key)' : (pl.off ? '  (inactive)' : '')) : (pl.off ? '  (off)' : ''); return (pl.num?pl.num+' · ':'')+pl.name+suf; };
      ctx.font='600 12.65px '+FAM;
      let maxLW=0; for(const pl of P0){ const w=ctx.measureText(labelStr(pl)).width; if(w>maxLW)maxLW=w; }
      // layout pass: bbox of plane backdrops at cx=cy=0
      let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
      for(let j=0;j<N;j++){ const by=byOf(j), dz=dzOf(j);
        for(const c of [proj(-BW0/2,-BD/2+dz,by,0,0),proj(BW0/2,-BD/2+dz,by,0,0),proj(BW0/2,BD/2+dz,by,0,0),proj(-BW0/2,BD/2+dz,by,0,0)]){
          if(c[0]<minX)minX=c[0]; if(c[0]>maxX)maxX=c[0]; if(c[1]<minY)minY=c[1]; if(c[1]>maxY)maxY=c[1]; } }
      // center the labels + board as ONE unit so the labels always sit close to the board (docked OR maximized — no big gap)
      const LBGAP=16, unitW=(maxX-minX)+LBGAP+maxLW, unitLeft=Math.max(8,(CW-unitW)/2);
      const labelRight=unitLeft+maxLW, cx=labelRight+LBGAP-minX, cy=(CH-(maxY-minY))/2-minY;

      if(glass){
        if(panel.classList.contains('popped')){   // a pop-out window has NO page behind it to see through (backdrop-filter can't reach the desktop) → paint a frosted dark-glass sheen so Glass still reads
          const gl=glassAmt/100;   // more glass → lighter/frostier base + stronger sheen, to approximate the docked translucency
          ctx.fillStyle='rgb('+Math.round(13+gl*15)+','+Math.round(17+gl*17)+','+Math.round(24+gl*22)+')'; ctx.fillRect(0,0,CW,CH);
          const gg=ctx.createLinearGradient(0,0,0,CH);
          gg.addColorStop(0,'rgba(150,170,205,'+(0.05+gl*0.16).toFixed(3)+')'); gg.addColorStop(0.4,'rgba(70,85,110,0.03)'); gg.addColorStop(1,'rgba(0,0,0,0.12)');
          ctx.fillStyle=gg; ctx.fillRect(0,0,CW,CH);
        } else ctx.clearRect(0,0,CW,CH);   // docked: transparent canvas → the frosted panel shows the page through it
      } else { ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,CW,CH); }

      _planes=[];
      for(let j=0;j<N;j++){ const pl=P0[j], by=byOf(j), dz=dzOf(j), raw=avgColor(pl.rgb);
        // temporally smooth the per-plane colour the aura uses, so a sudden lit key (e.g. a reactive keypress)
        // eases in/out over ~150ms instead of twitching the aura.
        let sm=_csm[j];
        if(raw){ if(sm){ sm[0]+=(raw[0]-sm[0])*0.06; sm[1]+=(raw[1]-sm[1])*0.06; sm[2]+=(raw[2]-sm[2])*0.06; } else { sm=raw.slice(); _csm[j]=sm; } }   // slow ease (~350ms) → keypress can't twitch the aura
        else if(sm){ sm[0]*=0.94; sm[1]*=0.94; sm[2]*=0.94; if(sm[0]+sm[1]+sm[2]<6){ _csm[j]=null; sm=null; } }
        const rep = sm ? [sm[0]|0,sm[1]|0,sm[2]|0] : null;
        const bg=[proj(-BW0/2,-BD/2+dz,by,cx,cy),proj(BW0/2,-BD/2+dz,by,cx,cy),proj(BW0/2,BD/2+dz,by,cx,cy),proj(-BW0/2,BD/2+dz,by,cx,cy)];
        _planes.push({ quad:bg.map(c=>[c[0],c[1]]), id:pl.id, sys:pl.sys, off:pl.off, col:rep,
          cx:(bg[0][0]+bg[2][0])/2, cy:(bg[0][1]+bg[2][1])/2, hw:Math.abs(bg[1][0]-bg[0][0])/2+Math.abs(bg[2][0]-bg[1][0])/2 });
      }

      for(let j=0;j<N;j++){ const pl=P0[j], rgb=pl.rgb, by=byOf(j), dz=dzOf(j), mask=pl.L?carveMask(pl.L):null;
        if(showKeys){   // the per-layer plane backdrop is part of "show keys" → hidden too when Keys is off (only lit keys float)
          ctx.fillStyle = pl.sys?(pl.off?'rgba(120,90,160,.04)':'rgba(120,90,160,.10)'):(pl.off?'rgba(120,130,150,.05)':'rgba(90,110,140,.09)');
          if(AMP>0){   // subdivide the backdrop into a wave-displaced mesh so it ripples WITH the keys (one flat quad can't)
            const NU=16, NV=6;
            for(let gv=0; gv<NV; gv++){ const v0=gv/NV, v1=(gv+1)/NV; ctx.beginPath();
              for(let gu=0; gu<=NU; gu++){ const u=gu/NU, p=proj((u-0.5)*BW0,(v0-0.5)*BD+dz, by+AMP*waveFn(u,v0,j,tSec), cx,cy); gu?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]); }
              for(let gu=NU; gu>=0; gu--){ const u=gu/NU, p=proj((u-0.5)*BW0,(v1-0.5)*BD+dz, by+AMP*waveFn(u,v1,j,tSec), cx,cy); ctx.lineTo(p[0],p[1]); }
              ctx.closePath(); ctx.fill(); }
          } else { const bgq=_planes[j].quad;   // no wave → the single flat quad (cheaper, identical look)
            ctx.beginPath(); ctx.moveTo(bgq[0][0],bgq[0][1]); for(let i=1;i<4;i++) ctx.lineTo(bgq[i][0],bgq[i][1]); ctx.closePath(); ctx.fill(); }
        }

        for(const r of RECTS){ const t=r.k*3, cr=rgb[t],cg=rgb[t+1],cb=rgb[t+2], lum=0.299*cr+0.587*cg+0.114*cb;
          const wz = AMP*waveFn(r.u, r.v, j, tSec);   // enhanced wave: selectable key-height ripple
          const bx0=(r.u-r.hw-0.5)*BW0, bx1=(r.u+r.hw-0.5)*BW0, bz0=(r.v-r.hh-0.5)*BD+dz, bz1=(r.v+r.hh-0.5)*BD+dz;
          const cor=[proj(bx0,bz0,by+wz,cx,cy),proj(bx1,bz0,by+wz,cx,cy),proj(bx1,bz1,by+wz,cx,cy),proj(bx0,bz1,by+wz,cx,cy)];
          ctx.beginPath(); ctx.moveTo(cor[0][0],cor[0][1]); for(let i=1;i<4;i++) ctx.lineTo(cor[i][0],cor[i][1]); ctx.closePath();
          if(lum>6){ ctx.shadowBlur=pl.off?0:Math.min(14,lum/14); ctx.shadowColor='rgb('+cr+','+cg+','+cb+')';
            ctx.fillStyle=pl.off?'rgba('+cr+','+cg+','+cb+',.22)':'rgb('+cr+','+cg+','+cb+')'; ctx.fill(); ctx.shadowBlur=0; }
          else if(showKeys){ ctx.shadowBlur=0; ctx.fillStyle=pl.off?'rgba(150,160,175,.045)':'rgba(150,160,175,.10)'; ctx.fill();   // inactive key → a faint keycap + outline so the layout reads; off/inactive planes get an even fainter keycap so the whole plane reads dim
            ctx.strokeStyle=pl.off?'rgba(180,190,205,.075)':'rgba(180,190,205,.17)'; ctx.lineWidth=1; ctx.stroke(); }
          if(mask && mask[r.k]>0.15){   // silhouetted/carving key → black it out (it removes light from below), then a red minus on top
            ctx.shadowBlur=0; ctx.fillStyle='#000'; ctx.fill();   // re-fill the same key quad black
            const m=proj((r.u-0.5)*BW0,(r.v-0.5)*BD+dz,by+wz,cx,cy);
            ctx.fillStyle=RED; ctx.font='700 '+Math.max(9,11*zoom/100)+'px '+FAM; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText('−', m[0], m[1]); }
        }
        if(enhanced && fxAura && !pl.off) drawPlaneGlow(j, rgb, tSec, cx, cy, AMP, by, dz);   // key-aware glow rising from THIS layer's lit keys (skipped for off/inactive layers), drawn after its keys + before the next plane up → occluded by it (depth)
      }

      if(enhanced && fxParticles){ spawnParticles(dt, byOf, dzOf); drawParticles(dt, cx, cy); } else if(P.length) P.length=0;

      // LABELS (numbered), decluttered into a tidy left column: sort by screen height, enforce a min vertical
      // spacing so they spread apart instead of piling up when planes crowd (e.g. when the board is rotated).
      // sort by STACK HEIGHT (not screen-Y) so the order is stable — at 90° tilt all planes share a screen-Y and a
      // Y-sort flips the list. Height-descending = top plane (System) first, matching the visual order at every angle.
      const LB=P0.map((pl,j)=>({pl, j, y:_planes[j].cy})).sort((a,b)=>byOf(b.j)-byOf(a.j));
      const MINSP=15;
      for(let k=1;k<LB.length;k++) if(LB[k].y-LB[k-1].y<MINSP) LB[k].y=LB[k-1].y+MINSP;
      if(LB.length){ const ov=LB[LB.length-1].y-(CH-8); if(ov>0) for(const L of LB) L.y-=ov;
        const tc=8-LB[0].y; if(tc>0) for(const L of LB) L.y+=tc; }
      ctx.font='600 12.65px '+FAM; ctx.textAlign='right'; ctx.textBaseline='middle';
      for(const L of LB){ const pl=L.pl;
        ctx.fillStyle=pl.sys?(pl.off?'rgba(190,170,230,.5)':'rgba(190,170,230,.95)'):(pl.off?'rgba(139,148,158,.55)':'rgba(230,237,243,.92)');
        ctx.fillText(labelStr(pl), labelRight, L.y); }
      readEl.textContent = 'zoom '+zoom+'% · yaw '+Math.round(((yaw/D2R)%360+360)%360)+'° · tilt '+Math.round(pitch/D2R)+'° · gap '+gapToSlider(gap)+(drawer?' · drawer '+drawer:'');

      // Ctrl-drag guide: 4 framing corner brackets that fade in while Ctrl is held during a viewport drag (90° snap mode)
      const gTarget = (rot && ctrlDown) ? 1 : 0;
      ctrlGuide += (gTarget - ctrlGuide) * Math.min(1, dt/110);   // ~110ms ease in/out
      if(ctrlGuide > 0.012){ ctx.setTransform(SS,0,0,SS,0,0);
        const m=15, AL=26, a=ctrlGuide*0.8;
        ctx.strokeStyle='rgba(200,210,228,'+a.toFixed(3)+')'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.lineJoin='round';
        for(const c of [[m,m,1,1],[CW-m,m,-1,1],[m,CH-m,1,-1],[CW-m,CH-m,-1,-1]]){
          ctx.beginPath(); ctx.moveTo(c[0], c[1]+c[3]*AL); ctx.lineTo(c[0],c[1]); ctx.lineTo(c[0]+c[2]*AL, c[1]); ctx.stroke(); }
      }
    }

    // ---- pop-out window + loop ----
    let raf=0, rafWin=window, popWin=null;
    const popEl=$('.iso-pop'), popinEl=$('.iso-popin'), rsEl=$('.iso-rs');
    function schedule(){ rafWin=popWin||window; raf=rafWin.requestAnimationFrame(tick); }
    function tick(now){ if(panel.hidden){ raf=0; return; }
      if(dg){ _last=now; schedule(); return; }   // dragging the WINDOW → freeze the (heavy) scene render so the drag stays smooth (also drops the backdrop-filter recompute via .iso-dragging)
      try{ if(getRunning()){ for(const L of state.layers) if(!L.enabled) E.renderLayer(L,now,state); }
           else { for(const L of state.layers) E.renderLayer(L,now,state); }
           draw(now); }catch(_){}
      schedule();
    }
    function fitPop(){ if(popWin){ sizeCanvas(cv.clientWidth, cv.clientHeight); P.length=0; } }   // clear stardust on resize/maximize so no stale-positioned dust lingers in empty space until its life expires
    const onPopResize=()=>{ if(popWin) popWin.requestAnimationFrame(fitPop); };
    function copyVars(el){ const cs=getComputedStyle(document.documentElement);
      ['--card','--line','--fg','--muted','--blue','--text','--accent','--mint','--ring'].forEach(v=>{ const val=cs.getPropertyValue(v); if(val) el.style.setProperty(v,val); }); }
    function popOut(){ if(popWin) return;
      // a real OS popup window → appears in the taskbar and the OS provides minimize / maximize / close
      // (Document PiP is always-on-top with no taskbar entry and no min/max chrome, so it can't do this).
      const w = window.open('','th108iso','popup,width=780,height=640');
      if(!w){ readEl.textContent='Pop-out blocked — allow popups for this page, then try again'; return; }
      popWin=w; const d=w.document; try{ d.title='Isometric View — th108'; d.body.replaceChildren(); d.head.querySelectorAll('#iso-view-css-pop').forEach(e=>e.remove()); }catch(_){}   // window.open reuses the named window → wipe any stale content so panels can't accumulate
      d.body.style.margin='0'; d.body.style.background='#0d1117';
      d.body.style.font='14px/1.55 "Plus Jakarta Sans",system-ui,sans-serif';   // match the page font (the panel uses font:inherit)
      document.querySelectorAll('link').forEach(l=>{ if(/fonts\.(googleapis|gstatic)/.test(l.href||'')) d.head.appendChild(l.cloneNode(true)); });   // load the webfont in the popped window
      const css=document.getElementById('iso-view-css'); if(css){ const c=css.cloneNode(true); c.id='iso-view-css-pop'; d.head.appendChild(c); }
      copyVars(d.documentElement); d.body.appendChild(panel); panel.classList.add('popped'); buildGlassFilter(d);
      w.addEventListener('resize',onPopResize); w.addEventListener('keydown',onDown,true); w.addEventListener('keyup',onUp,true);
      w.addEventListener('pagehide',onPopHide);   // closing the OS window CLOSES the whole view (Pop-in button re-docks instead)
      popEl.hidden=true; popinEl.hidden=false; rsEl.hidden=false;
      if(raf){ try{ rafWin.cancelAnimationFrame(raf); }catch(_){} raf=0; } schedule();   // drive from the child window (focused → not rAF-throttled)
      w.requestAnimationFrame(fitPop);
    }
    function popIn(){ if(!popWin) return; const w=popWin; popWin=null;
      try{ w.removeEventListener('resize',onPopResize); }catch(_){}
      try{ document.body.appendChild(panel); }catch(_){}
      panel.classList.remove('popped'); sizeCanvas(DEF_W,DEF_H);
      popEl.hidden=false; popinEl.hidden=true; rsEl.hidden=true;
      try{ w.close(); }catch(_){}
      raf=0; if(!panel.hidden) schedule();   // child rAF is dead; reschedule on the parent
    }
    // OS window closed (its X / Ctrl-W): popWin is still set here (the Pop-in BUTTON nulls it before w.close(),
    // so that path no-ops) → close the whole iso view. close() re-parents the panel back to the page first.
    function onPopHide(){ if(popWin) close(); }
    function resetSize(){ if(!popWin) return; try{ popWin.resizeTo(780,640); popWin.moveTo(Math.max(0,(popWin.screen.availWidth-780)/2), Math.max(0,(popWin.screen.availHeight-640)/2)); }catch(_){} onPopResize(); }   // restore + recenter to the default size (use the OS restore button to un-maximize)
    popEl.addEventListener('click',popOut); popinEl.addEventListener('click',popIn); rsEl.addEventListener('click',resetSize);

    function open(){ if(!panel.hidden) return; panel.hidden=false; buildLegend();
      window.addEventListener('keydown',onDown,true); window.addEventListener('keyup',onUp,true);
      if(!raf) schedule(); onState(true); }
    function close(){ if(panel.hidden) return; if(popWin) popIn(); panel.hidden=true; P.length=0;
      window.removeEventListener('keydown',onDown,true); window.removeEventListener('keyup',onUp,true);
      if(raf){ try{ rafWin.cancelAnimationFrame(raf); }catch(_){} raf=0; } onState(false); }
    function toggle(){ panel.hidden?open():close(); return !panel.hidden; }
    $('.iso-x').addEventListener('click', close);

    return { toggle, open, close, isOpen:()=>!panel.hidden };
  }

  root.TH108IsoView = { create };
})(window);
