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
    function updLock(e){ if(!e.getModifierState) return; lock.known = true;
      lock.NumLock=e.getModifierState('NumLock'); lock.CapsLock=e.getModifierState('CapsLock'); lock.ScrollLock=e.getModifierState('ScrollLock'); }
    // while open + NOT driving, stamp keys into state.react so the Reactive plane reacts to typing in the
    // preview (the page's own keydown handler only stamps while it's driving the board).
    const onDown = e => { updLock(e); if(!getRunning() && !e.repeat){ const i=KEYMAP[e.code]; if(i!==undefined) E.stampKey(state,i); } };
    const onUp   = e => { updLock(e); if(!getRunning()){ const i=KEYMAP[e.code]; if(i!==undefined) E.releaseKey(state,i); } };

    // ---- view params ----
    let yaw = 40*D2R, pitch = 22*D2R, zoom = 100, gap = 50, enhanced = false, focusIdx = null, auraI = 0.8, faceOn = false, showKeys = true, partSize = 0.55, glass = false, waveStyle = 'ripple', waveFreq = 2;
    const ISO_PITCH = 22*D2R, FACE_PITCH = 89*D2R;   // isometric tilt vs front-flat (top-down)

    // ---- panel chrome ----
    const panel = document.createElement('div'); panel.className = 'iso-panel'; panel.hidden = true;
    panel.innerHTML =
      '<div class="iso-head"><span class="iso-grip">⠿</span><b>Isometric View</b>' +
      '<span class="iso-spacer"></span>' +
      '<button type="button" class="iso-wmax" hidden title="Maximize / restore the pop-out window">⛶</button>' +
      '<button type="button" class="iso-rs" hidden title="Reset the pop-out window to the default size">⤢ Reset size</button>' +
      '<button type="button" class="iso-pop" title="Pop out into a separate, resizable window">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/></svg>Pop out</button>' +
      '<button type="button" class="iso-popin" hidden title="Pop back into the page">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M2 10h6V4"/><path d="m2 4 6 6"/><path d="M21 10V7a2 2 0 0 0-2-2h-7"/><path d="M3 14v2a2 2 0 0 0 2 2h3"/><rect width="10" height="7" x="12" y="13" rx="2"/></svg>Pop in</button>' +
      '<button type="button" class="iso-x" title="Close">✕</button></div>' +
      '<div class="iso-ctl">' +
        '<button type="button" class="iso-back" hidden>‹ Back</button>' +
        '<span class="iso-zwrap" title="Zoom — tell me the % to bake as default"><input type="range" class="iso-zoom" min="40" max="240" value="100"><small class="iso-zval">100%</small></span>' +
        '<label class="iso-gl">Gap<input type="range" class="iso-gapr" min="14" max="90" value="50"></label>' +
        '<button type="button" class="iso-keys on" title="Show the inactive/unused keys so the full keyboard layout reads (esp. face-on / top-down)">⌨ Keys</button>' +
        '<button type="button" class="iso-glass" title="Swap the window background between solid and frosted glass (the page shows through, refracted)">🫧 Glass</button>' +
        '<button type="button" class="iso-enh" title="Wave + rising stardust + aura wisps">✨ Enhanced</button>' +
        '<label class="iso-gl iso-efx" style="display:none" title="Aura glow intensity">Aura<input type="range" class="iso-aint" min="0" max="150" value="80"></label>' +
        '<label class="iso-gl iso-efx" style="display:none" title="Stardust size"><input type="range" class="iso-psz" min="40" max="280" value="55"><small class="iso-pszv" style="font-size:10px;color:var(--muted,#8b949e)">Dust 55%</small></label>' +
        '<select class="iso-wave iso-efx" style="display:none" title="Enhanced wave pattern">' +
          '<option value="ripple">〜 Ripple</option><option value="waveX">→ Wave X</option></select>' +
        '<label class="iso-gl iso-efx" style="display:none" title="Wave frequency"><input type="range" class="iso-wfreq" min="5" max="80" value="20"><small class="iso-wfv" style="font-size:10px;color:var(--muted,#8b949e)">Freq 2.0</small></label>' +
        '<button type="button" class="iso-face" title="Tilt the board front-flat (keys facing you) vs isometric">Face-on</button>' +
        '<span class="iso-lock" hidden title="Tilt is locked while Face-on is active — the board faces you flat. Click Face-on again to unlock and tilt freely (you can still spin/yaw).">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' +
      '</div>' +
      '<canvas class="iso-cv"></canvas>' +
      '<div class="iso-legend"></div>' +
      '<div class="iso-foot"><span class="iso-read"></span> · drag the view to rotate · click a layer to focus. ' +
      'Top “System” plane = firmware-forced lock keys (white = lock ON). Red “−” = key carves the layers below.</div>';
    if (!document.getElementById('iso-view-css')) {
      const st = document.createElement('style'); st.id = 'iso-view-css';
      st.textContent =
        '.iso-panel{position:fixed;left:50%;top:84px;transform:translateX(-50%);z-index:60;width:600px;' +
        'background:var(--card,#161b22);border:1px solid var(--line,#30363d);border-radius:12px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.5);font:inherit;color:var(--fg,#e6edf3)}' +
        '.iso-head{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line,#30363d);cursor:grab;user-select:none}' +
        '.iso-head.drag{cursor:grabbing}.iso-grip{color:var(--muted,#8b949e)}.iso-head b{font-size:14px}.iso-spacer{margin-left:auto}' +
        '.iso-x{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;' +
        'background:none;border:0;color:var(--muted,#8b949e);font-size:13px;line-height:1;cursor:pointer;padding:0;margin:0}' +
        '.iso-x:hover{color:var(--fg,#e6edf3);background:rgba(255,255,255,.06)}' +
        '.iso-panel.popped{position:static;left:0;top:0;transform:none;width:100%;height:100vh;border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column}' +
        '.iso-panel.popped .iso-head{cursor:default}.iso-panel.popped .iso-grip{display:none}' +
        '.iso-panel.popped .iso-cv{flex:1 1 auto;width:100%;height:auto;min-height:120px;margin:6px 0 2px}' +
        '.iso-ctl{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px 5px}' +
        // modern buttons: soft rounded pills, subtle fill, smooth hover, glowing active state (shared by header + control bar)
        '.iso-ctl button,.iso-head>button.iso-pop,.iso-head>button.iso-popin,.iso-head>button.iso-rs,.iso-head>button.iso-wmax{margin:0;padding:5px 12px;' +
        'font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);color:var(--fg,#e6edf3);' +
        'box-shadow:none;cursor:pointer;transition:background .15s,border-color .15s,transform .08s}' +
        '.iso-ctl button:hover,.iso-head>button.iso-pop:hover,.iso-head>button.iso-popin:hover,.iso-head>button.iso-rs:hover,.iso-head>button.iso-wmax:hover{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.22)}' +
        '.iso-ctl button:active,.iso-head>button.iso-pop:active,.iso-head>button.iso-popin:active,.iso-head>button.iso-rs:active,.iso-head>button.iso-wmax:active{transform:translateY(1px)}' +
        '.iso-ctl button.on{background:var(--blue,#58a6ff);border-color:transparent;color:#0d1117;box-shadow:0 2px 10px rgba(88,166,255,.35)}' +
        '.iso-ctl select.iso-wave{margin:0;padding:5px 8px;font-size:12px;font-weight:600;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);color:var(--fg,#e6edf3);cursor:pointer}' +
        '.iso-zwrap{display:inline-flex;flex-direction:column;align-items:center;gap:1px}' +
        '.iso-zwrap input{width:120px}.iso-zval{font-size:11px;color:var(--muted,#8b949e)}' +
        '.iso-gl{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted,#8b949e)}.iso-gl input{width:90px}' +
        '.iso-cv{display:block;width:576px;height:392px;margin:6px auto 2px;touch-action:none;cursor:grab}.iso-cv.drag{cursor:grabbing}' +
        '.iso-legend{display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px 2px}' +
        '.iso-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 8px;border-radius:999px;' +
        'background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line,#30363d);cursor:pointer;user-select:none}' +
        '.iso-chip.foc{box-shadow:inset 0 0 0 1px var(--blue,#58a6ff)}.iso-chip.off{opacity:.5}' +
        '.iso-chip .pw{width:13px;height:13px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;' +
        'box-shadow:inset 0 0 0 1px var(--muted,#8b949e)}.iso-chip.on .pw{background:#3fb950;box-shadow:none;color:#0d1117}' +
        '.iso-foot{padding:4px 12px 11px;font-size:11px;color:var(--muted,#8b949e);line-height:1.45}.iso-read{color:var(--fg,#e6edf3)}' +
        '.iso-panel.glass{background:rgba(20,25,33,.45);backdrop-filter:blur(22px) saturate(1.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);' +
        'border-color:rgba(255,255,255,.16);box-shadow:0 18px 50px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.05)}' +
        '.iso-panel.glass .iso-head{border-bottom-color:rgba(255,255,255,.12)}';
      document.head.appendChild(st);
    }
    document.body.appendChild(panel);

    const cv = panel.querySelector('.iso-cv'), ctx = cv.getContext('2d');
    const SS = 2, DEF_W = 576, DEF_H = 392;
    let CW = DEF_W, CH = DEF_H;
    function sizeCanvas(w,h){ CW=Math.max(160,Math.round(w)); CH=Math.max(120,Math.round(h)); cv.width=CW*SS; cv.height=CH*SS; }
    sizeCanvas(DEF_W, DEF_H);
    const $ = s => panel.querySelector(s);
    const zoomEl=$('.iso-zoom'), zvalEl=$('.iso-zval'), gapEl=$('.iso-gapr'), enhEl=$('.iso-enh'), aintEl=$('.iso-aint'), keysEl=$('.iso-keys'),
          pszEl=$('.iso-psz'), pszvEl=$('.iso-pszv'), glassEl=$('.iso-glass'), waveEl=$('.iso-wave'), wfreqEl=$('.iso-wfreq'), wfvEl=$('.iso-wfv'),
          backEl=$('.iso-back'), faceEl=$('.iso-face'), lockEl=$('.iso-lock'), legendEl=$('.iso-legend'), readEl=$('.iso-read');
    // ---- persistence: remember the view settings between sessions ----
    const SKEY='th108_iso_view';
    function saveSettings(){ try{ localStorage.setItem(SKEY, JSON.stringify({yaw,pitch,zoom,gap,enhanced,auraI,partSize,glass,showKeys,faceOn,waveStyle,waveFreq})); }catch(_){ } }
    let _saveT=0; function saveSoon(){ clearTimeout(_saveT); _saveT=setTimeout(saveSettings, 350); }
    function loadSettings(){ let s; try{ s=JSON.parse(localStorage.getItem(SKEY)); }catch(_){ } if(!s||typeof s!=='object') return;
      if(typeof s.yaw==='number') yaw=s.yaw; if(typeof s.pitch==='number') pitch=s.pitch;
      if(typeof s.zoom==='number') zoom=s.zoom; if(typeof s.gap==='number') gap=s.gap;
      if(typeof s.auraI==='number') auraI=s.auraI; if(typeof s.partSize==='number') partSize=s.partSize;
      if(typeof s.waveFreq==='number') waveFreq=s.waveFreq;
      enhanced=!!s.enhanced; glass=!!s.glass; showKeys=s.showKeys!==false; faceOn=!!s.faceOn; if(s.waveStyle==='ripple'||s.waveStyle==='waveX') waveStyle=s.waveStyle; }
    function syncControls(){   // push the (possibly restored) state into the UI controls
      zoomEl.value=zoom; zvalEl.textContent=zoom+'%'; gapEl.value=gap; aintEl.value=Math.round(auraI*100);
      pszEl.value=Math.round(partSize*100); pszvEl.textContent='Dust '+Math.round(partSize*100)+'%'; waveEl.value=waveStyle;
      wfreqEl.value=Math.round(waveFreq*10); wfvEl.textContent='Freq '+waveFreq.toFixed(1);
      enhEl.classList.toggle('on',enhanced); panel.querySelectorAll('.iso-efx').forEach(el=>el.style.display=enhanced?'':'none');
      keysEl.classList.toggle('on',showKeys); glassEl.classList.toggle('on',glass); panel.classList.toggle('glass',glass);
      faceEl.classList.toggle('on',faceOn); lockEl.hidden=!faceOn; }
    wfreqEl.addEventListener('input', e=>{ waveFreq=+e.target.value/10; wfvEl.textContent='Freq '+waveFreq.toFixed(1); saveSoon(); });
    keysEl.addEventListener('click', ()=>{ showKeys=!showKeys; keysEl.classList.toggle('on',showKeys); saveSoon(); });
    glassEl.addEventListener('click', ()=>{ glass=!glass; glassEl.classList.toggle('on',glass); panel.classList.toggle('glass',glass); saveSoon(); });   // frosted-glass window: page shows through (draw() clears the canvas instead of dark-filling)
    pszEl.addEventListener('input', e=>{ partSize=+e.target.value/100; pszvEl.textContent='Dust '+e.target.value+'%'; saveSoon(); });
    waveEl.addEventListener('change', e=>{ waveStyle=e.target.value; saveSoon(); });
    // keys must NOT interact with the iso UI (Enter was re-toggling the focused Face-on button) — blur any control
    // after a click so it never holds keyboard focus. Reactive still reacts (that's a window-level key listener).
    panel.addEventListener('click', e=>{ const t=e.target.closest('button,input'); if(t&&t.blur) t.blur(); });   // NOT select — blurring it mid-click closed the dropdown (had to hold to pick)
    zoomEl.addEventListener('input', e=>{ zoom=+e.target.value; zvalEl.textContent=zoom+'%'; saveSoon(); });
    gapEl.addEventListener('input', e=>{ gap=+e.target.value; saveSoon(); });
    aintEl.addEventListener('input', e=>{ auraI=+e.target.value/100; saveSoon(); });
    // Home/End/PageUp/PageDown natively jam a focused range input to min/max — block them so those keys
    // (used for reactive lighting / nav) don't yank a slider. Arrow keys still fine-adjust.
    [zoomEl,gapEl,aintEl,pszEl,wfreqEl].forEach(el=> el.addEventListener('keydown', e=>{ if(e.key==='Home'||e.key==='End'||e.key==='PageUp'||e.key==='PageDown') e.preventDefault(); }));
    enhEl.addEventListener('click', ()=>{ enhanced=!enhanced; enhEl.classList.toggle('on',enhanced); panel.querySelectorAll('.iso-efx').forEach(el=>el.style.display=enhanced?'':'none'); saveSoon(); });
    backEl.addEventListener('click', ()=>{ focusIdx=null; backEl.hidden=true; if(!faceOn){ pitch=ISO_PITCH; yaw=40*D2R; } buildLegend(); saveSoon(); });
    // Face-on: snap to a flat front-facing (top-down) view AND lock tilt (so a drag can't knock it off); yaw still spins.
    faceEl.addEventListener('click', ()=>{ faceOn=!faceOn; pitch=faceOn?FACE_PITCH:ISO_PITCH; if(faceOn) yaw=0; faceEl.classList.toggle('on',faceOn); lockEl.hidden=!faceOn; saveSoon(); });
    loadSettings(); syncControls();

    // ---- drag the panel by its header ----
    const head = $('.iso-head'); let dg=null;
    head.addEventListener('pointerdown', e=>{ if(e.target.closest('button')) return;   // don't start a drag on the header BUTTONS (pop-out/pop-in/reset/close) — capturing the pointer here suppressed their clicks
      const r=panel.getBoundingClientRect(); panel.style.transform='none'; panel.style.left=r.left+'px'; panel.style.top=r.top+'px';
      dg={dx:e.clientX-r.left,dy:e.clientY-r.top}; head.classList.add('drag'); head.setPointerCapture(e.pointerId); e.preventDefault(); });
    head.addEventListener('pointermove', e=>{ if(!dg) return;
      const maxL=Math.max(0,window.innerWidth-panel.offsetWidth), maxT=Math.max(0,window.innerHeight-panel.offsetHeight);
      panel.style.left=Math.min(maxL,Math.max(0,e.clientX-dg.dx))+'px';
      panel.style.top =Math.min(maxT,Math.max(0,e.clientY-dg.dy))+'px'; });   // clamp to all four viewport edges
    head.addEventListener('pointerup', ()=>{ dg=null; head.classList.remove('drag'); });

    // ---- rotate by dragging the canvas (small move = a click → focus the plane under it) ----
    let rot=null;
    cv.addEventListener('pointerdown', e=>{ rot={x:e.clientX,y:e.clientY,y0:yaw,p0:pitch,moved:0,px:hitX(e),py:hitY(e)};
      cv.setPointerCapture(e.pointerId); e.preventDefault(); });
    cv.addEventListener('pointermove', e=>{ if(!rot) return; const dx=e.clientX-rot.x, dy=e.clientY-rot.y;
      rot.moved=Math.max(rot.moved,Math.abs(dx)+Math.abs(dy));
      yaw=rot.y0 + dx*0.7*D2R; if(!faceOn) pitch=Math.max(8*D2R, Math.min(90*D2R, rot.p0 + dy*0.5*D2R));   // Face-on locks tilt
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

    function proj(bx,bz,by,cx,cy){
      const cY=Math.cos(yaw),sY=Math.sin(yaw),cP=Math.cos(pitch),sP=Math.sin(pitch), Z=zoom/100;
      const rx=bx*cY - bz*sY, rz=bx*sY + bz*cY;
      const up=by*cP - rz*sP, depth=by*sP + rz*cP;
      return [ cx + rx*Z, cy - up*Z, depth ];
    }
    // enhanced-wave height offset per key (u,v normalized; j = plane index; t seconds). waveFreq sets the spatial
    // frequency (the slider). Ripple = diagonal; Wave X = horizontal traveling wave.
    function waveFn(u,v,j,t){ const f=waveFreq;
      if(waveStyle==='waveX') return Math.sin(u*TAU*f - t*2.2 + j*0.4);
      return Math.sin((u*f + v*f*0.5)*TAU + t*1.7 + j*0.6);   // 'ripple'
    }

    function avgColor(rgb){ let r=0,g=0,b=0,n=0; for(let k=0;k<NLED;k++){ const t=k*3, L=rgb[t]+rgb[t+1]+rgb[t+2]; if(L>24){ r+=rgb[t];g+=rgb[t+1];b+=rgb[t+2];n++; } } return n?[r/n|0,g/n|0,b/n|0]:null; }
    function carveMask(L){ if(L._carve) return L._carve; if(L.type==='reactive'&&L.settings&&L.settings.isolate&&L._inten) return L._inten; return null; }

    function fillSysRgb(){ sysRgb.fill(0); if(!lock.known) return;
      for(const L of LOCK_K) if(lock[L.code]){ sysRgb[L.k*3]=255; sysRgb[L.k*3+1]=255; sysRgb[L.k*3+2]=255; } }

    // ordered plane descriptors: real layers (numbered, toggleable) → host extras (Song-progress, AI…) → System
    function gather(){ fillSysRgb();
      const out = state.layers.map((L,i)=>({L, i, id:i, num:i+1, name:L.name||('Layer '+(i+1)), rgb:L.rgb, off:!L.enabled, toggle:true, sys:false}));
      let xi=0; for(const ex of extraPlanes()) if(ex && ex.rgb) out.push({L:null, i:-1, id:'x'+(xi++), num:0, name:ex.name||'Extra', rgb:ex.rgb, off:false, toggle:false, sys:false});
      out.push({L:null, i:-1, id:'sys', num:0, name:'System', rgb:sysRgb, off:false, toggle:false, sys:true});
      return out;
    }
    function planeList(){ const g=gather(); if(focusIdx==null) return g; const f=g.find(p=>p.id===focusIdx); return f?[f]:g; }
    function focusTo(id){ focusIdx=(focusIdx===id)?null:id; backEl.hidden=(focusIdx==null); if(focusIdx==null && !faceOn) pitch=ISO_PITCH; buildLegend(); }

    // ---- legend chips (focus on click; power dot toggles enabled, mirrored to the compositor) ----
    function buildLegend(){ legendEl.innerHTML='';
      for(const p of gather()){ const chip=document.createElement('span');
        chip.className='iso-chip'+(p.off?' off':' on')+((focusIdx===p.id)?' foc':'');
        chip.innerHTML=(p.num?'<b>'+p.num+'</b> ':'')+'<span class="nm"></span>'+(p.toggle?'<span class="pw" title="toggle layer">⏻</span>':'');
        chip.querySelector('.nm').textContent=p.name;
        chip.addEventListener('click', e=>{ if(p.toggle && e.target.closest('.pw')){ p.L.enabled=!p.L.enabled; onLayersChanged(); buildLegend(); return; } focusTo(p.id); });
        legendEl.appendChild(chip);
      }
    }
    function clickAt(px,py){ for(let i=_planes.length-1;i>=0;i--){ if(inQuad(px,py,_planes[i].quad)){ focusTo(_planes[i].id); return; } } }
    function inQuad(px,py,q){ let s=0; for(let i=0;i<4;i++){ const a=q[i], b=q[(i+1)%4];
      const cr=(b[0]-a[0])*(py-a[1])-(b[1]-a[1])*(px-a[0]); const sg=cr>0?1:cr<0?-1:0; if(sg){ if(s&&sg!==s) return false; s=sg; } } return true; }

    // ---- enhanced FX: rising stardust particles ----
    const P=[]; let _planes=[];
    function spawnParticles(dt, cx, cy, byOf){
      if(_planes.length<1) return;
      // rise direction = the board's height axis projected to screen (yaw-invariant up-the-stack); spawn over
      // the (rotated) board footprint so the dust conforms to the current orientation. Works in focus too.
      const o0=proj(0,0,0,cx,cy), o1=proj(0,0,1,cx,cy); let rdx=o1[0]-o0[0], rdy=o1[1]-o0[1]; const rl=Math.hypot(rdx,rdy)||1; rdx/=rl; rdy/=rl;
      const rate = 60*dt/1000;   // small dust → spawn more of them
      let n = rate + (Math.random()<(rate%1)?1:0);
      for(let s=0;s<n;s++){ const p=(Math.random()*_planes.length)|0; const col=_planes[p].col||[150,170,210];
        const sp=proj((Math.random()-0.5)*0.9*BW0, (Math.random()-0.5)*0.9*BD, byOf(p)+gap*0.12, cx, cy);
        const spd=12+Math.random()*20;
        P.push({ x:sp[0], y:sp[1], vx:rdx*spd, vy:rdy*spd, px:-rdy, py:rdx, life:0, max:0.8+Math.random()*1.0, col,
                 sz:0.45+Math.random()*0.7, seed:Math.random()*TAU, tw:14+Math.random()*16 }); }   // sz tiny; px,py = perpendicular sway axis; seed/tw = twinkle
      if(P.length>320) P.splice(0,P.length-320);
    }
    function drawParticles(dt){
      ctx.globalCompositeOperation='lighter';
      for(let i=P.length-1;i>=0;i--){ const q=P[i]; q.life+=dt/1000;
        const sway=Math.sin(q.life*1.5+q.seed)*0.45;   // gentle drift perpendicular to the rise
        q.x+=(q.vx+q.px*sway)*dt/1000; q.y+=(q.vy+q.py*sway)*dt/1000; q.vx*=0.993; q.vy*=0.993;
        const t=q.life/q.max; if(t>=1){ P.splice(i,1); continue; }
        const tw=0.35+0.65*(0.5+0.5*Math.sin(q.life*q.tw+q.seed));   // fast twinkle
        const a=Math.sin(t*Math.PI)*0.95*tw, r=q.sz*partSize;
        ctx.fillStyle='rgba('+q.col[0]+','+q.col[1]+','+q.col[2]+','+a+')'; ctx.beginPath(); ctx.arc(q.x,q.y,r,0,TAU); ctx.fill();   // sharp dust core
        const g=ctx.createRadialGradient(q.x,q.y,0,q.x,q.y,r*2.4);   // tiny soft halo
        g.addColorStop(0,'rgba('+q.col[0]+','+q.col[1]+','+q.col[2]+','+(a*0.5)+')'); g.addColorStop(1,'rgba('+q.col[0]+','+q.col[1]+','+q.col[2]+',0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(q.x,q.y,r*2.4,0,TAU); ctx.fill(); }
      ctx.globalCompositeOperation='source-over';
    }
    // volumetric aura: a real noise texture (256² luminance RGB) additively tinted per layer and drawn as
    // several parallax slabs scrolling across each gap → a wispy, volumetric glow (not a flat radial flare).
    const auraImg=new Image(); let auraReady=false; auraImg.onload=()=>{ auraReady=true; }; auraImg.src='iso-aura-noise.png';
    const _aur=document.createElement('canvas'), _actx=_aur.getContext('2d');
    const SW=190, SH=58;   // fixed slab resolution → affine-mapped onto each gap's board-oriented parallelogram so the aura rotates WITH the planes
    function tintSlab(col,ox,oy,cover){   // feathered, tinted noise at SW×SH; drawAura maps it onto the gap parallelogram
      _aur.width=SW; _aur.height=SH;
      _actx.globalCompositeOperation='source-over'; _actx.clearRect(0,0,SW,SH);
      // ONE cover-sized draw (no tiling) → there are no repeated copies and no scroll-wrap seam, so the animation
      // loops cleanly. ox/oy drift the noise within the cover margin (a small circular path = seamless loop).
      _actx.drawImage(auraImg, (SW-cover)/2+ox, (SH-cover)/2+oy, cover, cover);
      _actx.globalCompositeOperation='multiply'; _actx.fillStyle='rgb('+col[0]+','+col[1]+','+col[2]+')'; _actx.fillRect(0,0,SW,SH);
      // edge falloff: elliptical vignette (bright center → black edges) so the noise feathers, not a hard box
      _actx.save(); _actx.translate(SW/2,SH/2); _actx.scale(1,SH/SW);
      const g=_actx.createRadialGradient(0,0,0,0,0,SW*0.5);
      g.addColorStop(0,'#fff'); g.addColorStop(0.28,'#fff'); g.addColorStop(1,'#000');   // smaller bright core → more falloff
      _actx.fillStyle=g; _actx.fillRect(-SW,-SW,2*SW,2*SW); _actx.restore();
      _actx.globalCompositeOperation='source-over';
      return _aur;
    }
    const SLABS=[[0.55,0.17,7],[0.9,0.20,12],[1.45,0.12,19]];   // [scale, baseAlpha, scrollSpeed] — 3 parallax sheets
    const NSHEETS=6;   // overlapping footprint sheets per gap → a continuous volumetric glow (not discrete bands)
    function drawAura(tSec, cx, cy, byOf){
      if(!auraReady || auraI<=0) return;
      // each aura fills the gap between two planes (or around a focused plane) with stacked footprint glow-sheets,
      // each gap seeded differently so adjacent layers' auras don't drift in lockstep.
      const spots=[];
      if(_planes.length>=2){ for(let i=1;i<_planes.length;i++){ const col=_planes[i-1].col||_planes[i].col; if(col) spots.push({lo:byOf(i-1),hi:byOf(i), col}); } }
      else if(_planes.length===1 && _planes[0].col){ const b=byOf(0); spots.push({lo:b-gap*0.45,hi:b+gap*0.45, col:_planes[0].col}); }
      if(!spots.length) return;
      ctx.globalCompositeOperation='lighter';
      let gi=0;
      for(const sp of spots){ gi++; const col=sp.col, span=sp.hi-sp.lo;
        const lum=(0.299*col[0]+0.587*col[1]+0.114*col[2])/255, ls=0.5+0.5*(1-lum*0.7);   // tame white/bright vs the colored auras
        const sdx=gi*167.3, sdy=gi*97.1, dir=(gi%2)?1:-1;   // per-gap seed: different start offset + alternating scroll direction so layers don't move in lockstep
        // MANY overlapping full-footprint sheets across the gap, alpha bell-weighted (brightest mid-gap, fading to
        // 0 at each plane) → reads as ONE continuous volumetric glow, not a few discrete squished layers. Each
        // sheet seeded differently so the noise doesn't align into visible bands.
        for(let n=0;n<NSHEETS;n++){ const fr=(n+0.5)/NSHEETS, by=sp.lo+span*fr, sl=SLABS[n%SLABS.length];
          const sc=sl[0], bell=0.4+0.6*Math.sin(fr*Math.PI);   // raised floor → no fully-dark trough between gaps (kills the dark band)
          const w=dir*(0.16+sl[2]*0.012), ph=sdx*0.013+n*0.9;   // circular drift: same freq for x & y → seamless loop (no scroll seam)
          const ox=Math.cos(tSec*w+ph)*40, oy=Math.sin(tSec*w+ph)*26, cover=300+sc*120;
          const P00=proj(-BW0/2,-BD/2,by,cx,cy), P10=proj(BW0/2,-BD/2,by,cx,cy), P01=proj(-BW0/2,BD/2,by,cx,cy);
          const ux=(P10[0]-P00[0])/SW, uy=(P10[1]-P00[1])/SW, vx=(P01[0]-P00[0])/SH, vy=(P01[1]-P00[1])/SH;
          const tex=tintSlab(col, ox, oy, cover);
          ctx.globalAlpha=0.168*bell*auraI*ls*(0.82+0.18*Math.sin(tSec*1.1+gi*1.7+n));   // 0.14→0.168 (+20% more prominent)
          ctx.setTransform(SS*ux,SS*uy,SS*vx,SS*vy, SS*P00[0], SS*P00[1]);   // affine: SW×SH rect → a footprint sheet (×SS supersample)
          ctx.drawImage(tex,0,0,SW,SH);
        }
      }
      ctx.setTransform(SS,0,0,SS,0,0); ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
    }

    // ---- main draw ----
    let _last=0;
    function draw(now){
      const dt=Math.min(80, _last?now-_last:16); _last=now; const tSec=now/1000;
      const P0=planeList(), N=P0.length;
      const AMP = enhanced ? gap*0.20 : 0;
      // height of plane index within the drawn set, centered
      const byOf = j => (j-(N-1)/2)*gap;
      // measure the widest label first so the board can sit just right of a column wide enough to never clip them
      ctx.setTransform(SS,0,0,SS,0,0);
      const FAM=getComputedStyle(document.body).fontFamily||'system-ui,sans-serif';
      const labelStr = pl => (pl.num?pl.num+' · ':'')+pl.name+(pl.off?'  (off)':'')+(pl.sys&&!lock.known?'  (press a key)':'');
      ctx.font='600 11px '+FAM;
      let maxLW=0; for(const pl of P0){ const w=ctx.measureText(labelStr(pl)).width; if(w>maxLW)maxLW=w; }
      const labelRight=8+maxLW;   // labels right-aligned end here; the longest one starts at x=8 → never cut off
      // layout pass: bbox of plane backdrops at cx=cy=0
      let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
      for(let j=0;j<N;j++){ const by=byOf(j);
        for(const c of [proj(-BW0/2,-BD/2,by,0,0),proj(BW0/2,-BD/2,by,0,0),proj(BW0/2,BD/2,by,0,0),proj(-BW0/2,BD/2,by,0,0)]){
          if(c[0]<minX)minX=c[0]; if(c[0]>maxX)maxX=c[0]; if(c[1]<minY)minY=c[1]; if(c[1]>maxY)maxY=c[1]; } }
      // place the board after the label column. Docked + board ~fills the width → tight left-anchor (labels close).
      // Popped (wide window) or lots of spare room → center it in the available space so it doesn't hug the left.
      const LBGAP=16, RMARG=14, region=CW-(labelRight+LBGAP)-RMARG, content=maxX-minX, popped=panel.classList.contains('popped');
      const cx=((popped||region>content+40) ? (labelRight+LBGAP)+(region-content)/2 : labelRight+LBGAP)-minX, cy=(CH-(maxY-minY))/2-minY;

      if(glass){
        if(panel.classList.contains('popped')){   // a pop-out window has NO page behind it to see through (backdrop-filter can't reach the desktop) → paint a frosted dark-glass sheen so Glass still reads
          ctx.fillStyle='#12161d'; ctx.fillRect(0,0,CW,CH);
          const gg=ctx.createLinearGradient(0,0,0,CH);
          gg.addColorStop(0,'rgba(130,150,185,0.12)'); gg.addColorStop(0.4,'rgba(70,85,110,0.03)'); gg.addColorStop(1,'rgba(0,0,0,0.12)');
          ctx.fillStyle=gg; ctx.fillRect(0,0,CW,CH);
        } else ctx.clearRect(0,0,CW,CH);   // docked: transparent canvas → the frosted panel shows the page through it
      } else { ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,CW,CH); }

      _planes=[];
      for(let j=0;j<N;j++){ const pl=P0[j], by=byOf(j), rep=avgColor(pl.rgb);
        const bg=[proj(-BW0/2,-BD/2,by,cx,cy),proj(BW0/2,-BD/2,by,cx,cy),proj(BW0/2,BD/2,by,cx,cy),proj(-BW0/2,BD/2,by,cx,cy)];
        _planes.push({ quad:bg.map(c=>[c[0],c[1]]), id:pl.id, sys:pl.sys, col:rep,
          cx:(bg[0][0]+bg[2][0])/2, cy:(bg[0][1]+bg[2][1])/2, hw:Math.abs(bg[1][0]-bg[0][0])/2+Math.abs(bg[2][0]-bg[1][0])/2 });
      }
      if(enhanced) drawAura(tSec, cx, cy, byOf);

      for(let j=0;j<N;j++){ const pl=P0[j], rgb=pl.rgb, by=byOf(j), mask=pl.L?carveMask(pl.L):null;
        if(showKeys){ const bgq=_planes[j].quad;   // the per-layer plane backdrop is part of "show keys" → hidden too when Keys is off (only lit keys float)
          ctx.beginPath(); ctx.moveTo(bgq[0][0],bgq[0][1]); for(let i=1;i<4;i++) ctx.lineTo(bgq[i][0],bgq[i][1]); ctx.closePath();
          ctx.fillStyle = pl.sys?'rgba(120,90,160,.10)':(pl.off?'rgba(120,130,150,.05)':'rgba(90,110,140,.09)'); ctx.fill(); }

        for(const r of RECTS){ const t=r.k*3, cr=rgb[t],cg=rgb[t+1],cb=rgb[t+2], lum=0.299*cr+0.587*cg+0.114*cb;
          const wz = AMP*waveFn(r.u, r.v, j, tSec);   // enhanced wave: selectable key-height ripple
          const bx0=(r.u-r.hw-0.5)*BW0, bx1=(r.u+r.hw-0.5)*BW0, bz0=(r.v-r.hh-0.5)*BD, bz1=(r.v+r.hh-0.5)*BD;
          const cor=[proj(bx0,bz0,by+wz,cx,cy),proj(bx1,bz0,by+wz,cx,cy),proj(bx1,bz1,by+wz,cx,cy),proj(bx0,bz1,by+wz,cx,cy)];
          ctx.beginPath(); ctx.moveTo(cor[0][0],cor[0][1]); for(let i=1;i<4;i++) ctx.lineTo(cor[i][0],cor[i][1]); ctx.closePath();
          if(lum>6){ ctx.shadowBlur=pl.off?0:Math.min(14,lum/14); ctx.shadowColor='rgb('+cr+','+cg+','+cb+')';
            ctx.fillStyle=pl.off?'rgba('+cr+','+cg+','+cb+',.22)':'rgb('+cr+','+cg+','+cb+')'; ctx.fill(); ctx.shadowBlur=0; }
          else if(showKeys){ ctx.shadowBlur=0; ctx.fillStyle='rgba(150,160,175,.10)'; ctx.fill();   // inactive key → a faint keycap + outline so the layout reads
            ctx.strokeStyle='rgba(180,190,205,.17)'; ctx.lineWidth=1; ctx.stroke(); }
          if(mask && mask[r.k]>0.15){ const m=proj((r.u-0.5)*BW0,(r.v-0.5)*BD,by+wz,cx,cy);   // silhouetted/carving key
            ctx.fillStyle=RED; ctx.font='700 '+Math.max(9,11*zoom/100)+'px '+FAM; ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText('−', m[0], m[1]); }
        }
      }

      if(enhanced){ spawnParticles(dt, cx, cy, byOf); drawParticles(dt); } else if(P.length) P.length=0;

      // LABELS (numbered), decluttered into a tidy left column: sort by screen height, enforce a min vertical
      // spacing so they spread apart instead of piling up when planes crowd (e.g. when the board is rotated).
      // sort by STACK HEIGHT (not screen-Y) so the order is stable — at 90° tilt all planes share a screen-Y and a
      // Y-sort flips the list. Height-descending = top plane (System) first, matching the visual order at every angle.
      const LB=P0.map((pl,j)=>({pl, j, y:_planes[j].cy})).sort((a,b)=>byOf(b.j)-byOf(a.j));
      const MINSP=15;
      for(let k=1;k<LB.length;k++) if(LB[k].y-LB[k-1].y<MINSP) LB[k].y=LB[k-1].y+MINSP;
      if(LB.length){ const ov=LB[LB.length-1].y-(CH-8); if(ov>0) for(const L of LB) L.y-=ov;
        const tc=8-LB[0].y; if(tc>0) for(const L of LB) L.y+=tc; }
      ctx.font='600 11px '+FAM; ctx.textAlign='right'; ctx.textBaseline='middle';
      for(const L of LB){ const pl=L.pl;
        ctx.fillStyle=pl.sys?'rgba(190,170,230,.95)':(pl.off?'rgba(139,148,158,.55)':'rgba(230,237,243,.92)');
        ctx.fillText(labelStr(pl), labelRight, L.y); }
      readEl.textContent = 'zoom '+zoom+'% · yaw '+Math.round(((yaw/D2R)%360+360)%360)+'° · tilt '+Math.round(pitch/D2R)+'° · gap '+gap;
    }

    // ---- pop-out window + loop ----
    let raf=0, rafWin=window, popWin=null, winMax=false;
    const popEl=$('.iso-pop'), popinEl=$('.iso-popin'), rsEl=$('.iso-rs'), wmaxEl=$('.iso-wmax');
    function schedule(){ rafWin=popWin||window; raf=rafWin.requestAnimationFrame(tick); }
    function tick(now){ if(panel.hidden){ raf=0; return; }
      try{ if(getRunning()){ for(const L of state.layers) if(!L.enabled) E.renderLayer(L,now,state); }
           else { for(const L of state.layers) E.renderLayer(L,now,state); }
           draw(now); }catch(_){}
      schedule();
    }
    function fitPop(){ if(popWin) sizeCanvas(cv.clientWidth, cv.clientHeight); }
    const onPopResize=()=>{ if(popWin) popWin.requestAnimationFrame(fitPop); };
    function copyVars(el){ const cs=getComputedStyle(document.documentElement);
      ['--card','--line','--fg','--muted','--blue','--text','--accent','--mint','--ring'].forEach(v=>{ const val=cs.getPropertyValue(v); if(val) el.style.setProperty(v,val); }); }
    async function popOut(){ if(popWin) return;
      let w=null;
      try{
        if(window.documentPictureInPicture && window.documentPictureInPicture.requestWindow)
          w = await window.documentPictureInPicture.requestWindow({ width:720, height:600 });   // Document Picture-in-Picture: a real resizable, always-on-top window NOT subject to popup blocking (Chromium — WebHID already requires it)
        else
          w = window.open('','th108iso','popup,width=720,height=600');                          // fallback for older Chromium
      }catch(_){ w=null; }
      if(!w){ readEl.textContent='Pop-out unavailable — update Chromium or allow popups'; return; }
      popWin=w; const d=w.document; try{ d.title='Isometric View — th108'; }catch(_){} d.body.style.margin='0'; d.body.style.background='#0d1117';
      const css=document.getElementById('iso-view-css'); if(css){ const c=css.cloneNode(true); c.id='iso-view-css-pop'; d.head.appendChild(c); }
      copyVars(d.documentElement); d.body.appendChild(panel); panel.classList.add('popped');
      w.addEventListener('resize',onPopResize); w.addEventListener('keydown',onDown,true); w.addEventListener('keyup',onUp,true);
      w.addEventListener('pagehide',popIn);
      popEl.hidden=true; popinEl.hidden=false; rsEl.hidden=false; wmaxEl.hidden=false;
      if(raf){ try{ rafWin.cancelAnimationFrame(raf); }catch(_){} raf=0; } schedule();   // drive from the child window (focused → not rAF-throttled)
      w.requestAnimationFrame(fitPop);
    }
    function popIn(){ if(!popWin) return; const w=popWin; popWin=null;
      try{ w.removeEventListener('resize',onPopResize); }catch(_){}
      try{ document.body.appendChild(panel); }catch(_){}
      panel.classList.remove('popped'); sizeCanvas(DEF_W,DEF_H);
      popEl.hidden=false; popinEl.hidden=true; rsEl.hidden=true; wmaxEl.hidden=true; winMax=false; wmaxEl.classList.remove('on');
      try{ w.close(); }catch(_){}
      raf=0; if(!panel.hidden) schedule();   // child rAF is dead; reschedule on the parent
    }
    // resizeTo on a PiP window needs a user activation — fine, these run from a real button click.
    function resetSize(){ if(!popWin) return; try{ popWin.resizeTo(720,600); }catch(_){} winMax=false; wmaxEl.classList.remove('on'); onPopResize(); }
    function winMaximize(){ if(!popWin) return; winMax=!winMax;
      try{ if(winMax) popWin.resizeTo(popWin.screen.availWidth, popWin.screen.availHeight); else popWin.resizeTo(720,600); }catch(_){}
      wmaxEl.classList.toggle('on',winMax); onPopResize(); }
    popEl.addEventListener('click',popOut); popinEl.addEventListener('click',popIn); rsEl.addEventListener('click',resetSize); wmaxEl.addEventListener('click',winMaximize);

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
