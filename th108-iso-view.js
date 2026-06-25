// th108-iso-view.js — "Isometric View": a draggable floating overlay that shows the layer stack as
// separate isometric key-planes, each glowing in sync with its layer's live per-key buffer (L.rgb).
// window.TH108IsoView.create({state, engine, getRunning}) -> { toggle, open, close, isOpen }.
// Self-contained: builds its own panel on <body>, runs its own rAF while open, NO hardware writes
// (it only READS each layer's rgb — composeFrame/renderLayer are pure). Mirrors th108-paint-board's
// reuse of engine.keyCell geometry; it never touches the keymap binder or the keyboard loop.
(function (root) {
  'use strict';

  // firmware-forced lock keys (LED indices) — these light WHITE on the board while their lock is ON,
  // overriding host lighting (confirmed unbeatable by 0x32 paint — see the NumLock roadmap item). The
  // "System" plane visualizes exactly that override so you can see it vs the host layers.
  const LOCKS = [ {code:'NumLock', led:29}, {code:'CapsLock', led:48}, {code:'ScrollLock', led:100} ];

  function create(opts) {
    const E = opts.engine, state = opts.state, getRunning = opts.getRunning || (()=>false);
    const INDICES = E.INDICES, NLED = INDICES.length;

    // browser can't poll lock-LED state; we learn it from key events' getModifierState (resolves on the
    // first keypress). Until then it's UNKNOWN → the System plane shows neutral, not a guessed state.
    const lock = { NumLock:false, CapsLock:false, ScrollLock:false, known:false };
    const onKey = e => { if (!e.getModifierState) return; lock.known = true;
      lock.NumLock = e.getModifierState('NumLock'); lock.CapsLock = e.getModifierState('CapsLock');
      lock.ScrollLock = e.getModifierState('ScrollLock'); };

    // ----- panel chrome -----
    const panel = document.createElement('div'); panel.className = 'iso-panel'; panel.hidden = true;
    panel.innerHTML =
      '<div class="iso-head"><span class="iso-grip">⠿</span><b>Isometric View</b>' +
      '<label class="iso-gap" title="Vertical gap between the stacked layer planes">Gap' +
      '<input type="range" class="iso-gapr" min="14" max="90" value="46"></label>' +
      '<button type="button" class="iso-x" title="Close">✕</button></div>' +
      '<canvas class="iso-cv"></canvas>' +
      '<div class="iso-foot">Each plane = one layer (bottom→top), glowing live. Top “System” plane = ' +
      'firmware-forced lock keys (white = lock ON, overrides host lighting).</div>';
    if (!document.getElementById('iso-view-css')) {
      const st = document.createElement('style'); st.id = 'iso-view-css';
      st.textContent =
        '.iso-panel{position:fixed;left:50%;top:90px;transform:translateX(-50%);z-index:60;width:540px;' +
        'background:var(--card,#161b22);border:1px solid var(--line,#30363d);border-radius:12px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.5);font:inherit;color:var(--fg,#e6edf3)}' +
        '.iso-head{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line,#30363d);cursor:grab;user-select:none}' +
        '.iso-head.drag{cursor:grabbing}.iso-grip{color:var(--muted,#8b949e)}.iso-head b{font-size:14px}' +
        '.iso-gap{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted,#8b949e);cursor:default}' +
        '.iso-gapr{width:96px}.iso-x{background:none;border:0;color:var(--muted,#8b949e);font-size:15px;cursor:pointer;line-height:1;padding:2px 4px}' +
        '.iso-x:hover{color:var(--fg,#e6edf3)}.iso-cv{display:block;width:516px;height:392px;margin:10px auto 2px}' +
        '.iso-foot{padding:4px 12px 11px;font-size:11px;color:var(--muted,#8b949e);line-height:1.45}';
      document.head.appendChild(st);
    }
    document.body.appendChild(panel);

    const cv = panel.querySelector('.iso-cv'), ctx = cv.getContext('2d');
    const SS = 2, CW = 516, CH = 392;
    cv.width = CW * SS; cv.height = CH * SS;
    let gap = 46;
    panel.querySelector('.iso-gapr').addEventListener('input', e => { gap = +e.target.value; });

    // ----- drag the panel by its header -----
    const head = panel.querySelector('.iso-head');
    let dg = null;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('.iso-x, .iso-gap')) return;        // close button + slider aren't drag zones
      const r = panel.getBoundingClientRect();
      panel.style.transform = 'none'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      dg = { dx: e.clientX - r.left, dy: e.clientY - r.top }; head.classList.add('drag');
      head.setPointerCapture(e.pointerId); e.preventDefault();
    });
    head.addEventListener('pointermove', e => { if (!dg) return;
      panel.style.left = Math.max(0, e.clientX - dg.dx) + 'px';
      panel.style.top  = Math.max(0, e.clientY - dg.dy) + 'px'; });
    head.addEventListener('pointerup', () => { dg = null; head.classList.remove('drag'); });

    // ----- isometric projection: board (u,v)∈[0,1]² on plane p → screen px.
    // u = horizontal (0 left), v = depth (0 back/top of board). AX horizontal, AY sheared down-right
    // → each plane is a parallelogram; planes lift straight up by `gap` (classic exploded-layers look).
    const BW = 372, aspect = E.BOARDW / E.BOARDH, BH = (BW / aspect) * 0.5, SHEAR = BH * 1.05;
    const proj = (u, v, p, ox, oy) => [ ox + u*BW + v*SHEAR, oy + v*BH - p*gap ];

    // key rects from keyCell (normalized center+size), inset slightly so tiles don't touch
    const RECTS = INDICES.map((led, k) => { const c = E.keyCell(led); return c ? { k,
      u0:c[0]-c[2]*0.46, u1:c[0]+c[2]*0.46, v0:c[1]-c[3]*0.46, v1:c[1]+c[3]*0.46 } : null; }).filter(Boolean);
    const LOCK_K = LOCKS.map(L => ({ ...L, k: INDICES.indexOf(L.led) })).filter(L => L.k >= 0);

    // synthetic rgb for the System plane: white at a locked key, else 0 (transparent/dim)
    const sysRgb = new Uint8Array(NLED * 3);
    function fillSysRgb() { sysRgb.fill(0);
      if (!lock.known) return;                                  // unknown → leave all 0 (neutral tiles)
      for (const L of LOCK_K) if (lock[L.code]) { sysRgb[L.k*3]=255; sysRgb[L.k*3+1]=255; sysRgb[L.k*3+2]=255; } }

    // planes to draw, bottom→top: each layer, then the System plane on top
    function planes() {
      const ps = state.layers.map((L,i) => ({ rgb:L.rgb, name:L.name||('Layer '+(i+1)), off:!L.enabled }));
      fillSysRgb();
      ps.push({ rgb:sysRgb, name:'System', off:false, sys:true });
      return ps;
    }

    function projcorners(r, p, ox, oy) {
      return [ proj(r.u0,r.v0,p,ox,oy), proj(r.u1,r.v0,p,ox,oy), proj(r.u1,r.v1,p,ox,oy), proj(r.u0,r.v1,p,ox,oy) ]; }

    function draw() {
      const P = planes(), N = P.length;
      // center the whole stack: measure extents at ox=oy=0
      let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
      for (let p=0;p<N;p++) for (const c of [proj(0,0,p,0,0), proj(1,0,p,0,0), proj(1,1,p,0,0), proj(0,1,p,0,0)]) {
        if(c[0]<minX)minX=c[0]; if(c[0]>maxX)maxX=c[0]; if(c[1]<minY)minY=c[1]; if(c[1]>maxY)maxY=c[1]; }
      const LGUT = 98;   // left gutter reserved for the right-aligned plane labels
      const ox = LGUT + (CW-LGUT-(maxX-minX))/2 - minX, oy = (CH-(maxY-minY))/2 - minY;

      ctx.setTransform(SS,0,0,SS,0,0);
      ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,CW,CH);   // canvas backdrop (slightly darker than the card)

      const FAM = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
      for (let p=0;p<N;p++) {                                  // bottom→top so upper planes occlude
        const pl = P[p], rgb = pl.rgb;
        // faint plane backdrop quad so an all-dark layer still reads as a board
        const bg = [proj(0,0,p,ox,oy), proj(1,0,p,ox,oy), proj(1,1,p,ox,oy), proj(0,1,p,ox,oy)];
        ctx.beginPath(); ctx.moveTo(bg[0][0],bg[0][1]); for(let i=1;i<4;i++) ctx.lineTo(bg[i][0],bg[i][1]); ctx.closePath();
        ctx.fillStyle = pl.sys ? 'rgba(120,90,160,.10)' : (pl.off ? 'rgba(120,130,150,.05)' : 'rgba(90,110,140,.09)');
        ctx.fill();
        // keys
        ctx.shadowBlur = 0;
        for (const r of RECTS) {
          const t = r.k*3, cr=rgb[t], cg=rgb[t+1], cb=rgb[t+2], lum = 0.299*cr+0.587*cg+0.114*cb;
          const cor = projcorners(r, p, ox, oy);
          ctx.beginPath(); ctx.moveTo(cor[0][0],cor[0][1]); for(let i=1;i<4;i++) ctx.lineTo(cor[i][0],cor[i][1]); ctx.closePath();
          if (lum > 6) {                                        // lit key: its color, glow scaled by brightness
            ctx.shadowBlur = pl.off ? 0 : Math.min(14, lum/14); ctx.shadowColor = 'rgb('+cr+','+cg+','+cb+')';
            ctx.fillStyle = pl.off ? 'rgba('+cr+','+cg+','+cb+',.22)' : 'rgb('+cr+','+cg+','+cb+')';   // off layers ghost subordinate to the live ones
          } else {                                              // dark key: faint tile so the board shape reads
            ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(150,160,175,.07)';
          }
          ctx.fill();
        }
        ctx.shadowBlur = 0;
        // plane label at the back-left corner
        const lp = proj(0, -0.04, p, ox, oy);
        ctx.font = '600 11px '+FAM; ctx.textAlign='right'; ctx.textBaseline='middle';
        ctx.fillStyle = pl.sys ? 'rgba(190,170,230,.95)' : (pl.off ? 'rgba(139,148,158,.55)' : 'rgba(230,237,243,.92)');
        ctx.fillText(pl.name + (pl.off?'  (off)':'') + (pl.sys && !lock.known ? '  (press a key)':''), lp[0]-8, lp[1]);
      }
    }

    // ----- live loop while open: keep every layer's rgb fresh, then draw -----
    let raf = 0;
    function tick(now) {
      if (panel.hidden) { raf = 0; return; }
      try {
        if (getRunning()) { for (const L of state.layers) if (!L.enabled) E.renderLayer(L, now, state); }
        else { for (const L of state.layers) E.renderLayer(L, now, state); }   // idle: keyboard loop isn't rendering — do it here (read-only, no HID)
        draw();
      } catch(_){ }
      raf = requestAnimationFrame(tick);
    }

    function open() { if (!panel.hidden) return; panel.hidden = false;
      window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKey, true);
      if (!raf) raf = requestAnimationFrame(tick); }
    function close() { panel.hidden = true;
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true);
      if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    function toggle() { panel.hidden ? open() : close(); return !panel.hidden; }
    panel.querySelector('.iso-x').addEventListener('click', close);

    return { toggle, open, close, isOpen:()=>!panel.hidden };
  }

  root.TH108IsoView = { create };
})(window);
