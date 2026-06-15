// th108-paint-board.js — interactive per-key paint board for the Individual-keys layer.
// window.TH108PaintBoard.mount(host, opts) renders a canvas of the 104 keys (geometry from the engine's
// keyCell) and runs the paint/selection model: click/marquee paints settings.current; Shift adds; Ctrl
// deselects; Alt-box erases; the color picker recolors the live selection. opts:
//   { engine, getKeys()->{idx:'#rrggbb'}, getColor()->'#rrggbb', onPaint(idx,hex|null), onChange() }
// It NEVER touches the keymap binder's KBOARD — it only reuses keyCell geometry.
(function (root) {
  'use strict';
  const W = 468, H = 135, PAD = 4, SS = 3;   // logical W/H; SS = supersample factor so the board stays crisp when shown large (full Pick-a-Key width)
  // key-face labels — matches the Pick-a-Key board's NICE map + slicing so the paint board reads the same
  const NICE = { Escape:'Esc', Backquote:'`', Minus:'-', Equal:'=', Backspace:'⌫', Tab:'Tab', BracketLeft:'[', BracketRight:']',
    Backslash:'\\', CapsLock:'Caps', Semicolon:';', Quote:"'", Enter:'Enter', ShiftLeft:'Shift', ShiftRight:'Shift',
    Comma:',', Period:'.', Slash:'/', ControlLeft:'Ctrl', ControlRight:'Ctrl', MetaLeft:'Win', AltLeft:'Alt', AltRight:'Alt',
    ContextMenu:'☰', Space:'', PrintScreen:'PrtSc', ScrollLock:'ScrLk', Pause:'Pause', Insert:'Ins', Home:'Home',
    PageUp:'PgUp', Delete:'Del', End:'End', PageDown:'PgDn', ArrowUp:'↑', ArrowLeft:'←', ArrowDown:'↓', ArrowRight:'→',
    NumLock:'Num', NumpadDivide:'/', NumpadMultiply:'*', NumpadSubtract:'-', NumpadAdd:'+', NumpadEnter:'⏎',
    NumpadDecimal:'.', IntlBackslash:'\\' };
  const keyLabel = code => { if (!code) return 'Fn'; if (NICE[code] !== undefined) return NICE[code];
    if (code.startsWith('Key')) return code.slice(3); if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return code.slice(6); return code; };

  function mount(host, opts) {
    const E = opts.engine, INDICES = E.INDICES;
    const cv = document.createElement('canvas');
    cv.width = W * SS; cv.height = H * SS; cv.className = 'pb-canvas'; cv.style.touchAction = 'none';
    host.innerHTML = ''; host.appendChild(cv);
    const ctx = cv.getContext('2d');

    let sel = new Set();          // currently-selected LED indices (transient)
    let drag = null;              // {x0,y0,x1,y1,mode:'paint'|'add'|'deselect'|'erase'} during a marquee

    // bare-Alt focuses the browser menu and can interrupt an Alt-drag erase — swallow Alt while the
    // pointer is over/using THIS board (scoped, so Alt+letter shortcuts elsewhere are unaffected).
    let overBoard = false;
    cv.addEventListener('pointerenter', () => { overBoard = true; });
    cv.addEventListener('pointerleave', () => { if (!drag) overBoard = false; });
    const altGuard = e => { if ((overBoard || drag) && (e.key === 'Alt' || e.altKey)) e.preventDefault(); };
    window.addEventListener('keydown', altGuard);
    cv.addEventListener('contextmenu', e => e.preventDefault());   // no browser right-click menu over the paint board

    // key rect in canvas pixels, from the engine's normalized keyCell (center x,y + w,h, 0..1)
    function rectOf(idx) {
      const c = E.keyCell(idx); if (!c) return null;
      const iw = W - 2*PAD, ih = H - 2*PAD;
      return { x: PAD + (c[0]-c[2]/2)*iw, y: PAD + (c[1]-c[3]/2)*ih, w: c[2]*iw, h: c[3]*ih, idx };
    }
    const RECTS = INDICES.map(rectOf).filter(Boolean);
    const CODE_BY_IDX = {}; for (const [code, i] of Object.entries(E.KEYMAP)) CODE_BY_IDX[i] = code;   // idx → KeyboardEvent.code, for the key-face label

    function draw() {
      const keys = opts.getKeys();
      ctx.setTransform(SS,0,0,SS,0,0);   // render at SS× internal res but draw in logical W/H coords (crisp at any display size); hit-testing/toCv stay in logical coords too
      ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);
      // labels read EXACTLY like the Pick-a-Key board: pull the live page body font + --muted, weight 600,
      // ~15px CSS. baseFs converts a 15px-CSS target into logical units via the current display scale.
      const FONTFAM = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
      const MUTED = (getComputedStyle(cv).getPropertyValue('--muted') || '#8b949e').trim();
      const baseFs = 15 * W / (cv.getBoundingClientRect().width || W);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const r of RECTS) {
        const hex = keys[r.idx];
        ctx.fillStyle = hex || '#222831';                 // painted color, else dim neutral
        ctx.fillRect(r.x+0.75, r.y+0.75, Math.max(1,r.w-1.5), Math.max(1,r.h-1.5));
        if (sel.has(r.idx)) { ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2; ctx.strokeRect(r.x+1, r.y+1, r.w-2, r.h-2); }
        const lbl = keyLabel(CODE_BY_IDX[r.idx]);         // key-face character(s)
        if (lbl) {
          const c = E.hexToRgb(hex || '#222831'), lum = 0.299*c[0]+0.587*c[1]+0.114*c[2];
          ctx.fillStyle = hex ? (lum>140 ? '#000' : '#fff') : MUTED;   // painted: black/white by luminance; unpainted: page --muted (= Pick-a-Key)
          let fs = Math.min(baseFs, r.h*0.52);
          ctx.font = '600 '+fs+'px '+FONTFAM;
          const maxw = r.w*0.84, tw = ctx.measureText(lbl).width;
          if (tw > maxw) { fs *= maxw/tw; ctx.font = '600 '+fs+'px '+FONTFAM; }
          ctx.fillText(lbl, r.x+r.w/2, r.y+r.h/2);
        }
      }
      if (drag) {                                          // marquee outline
        const x=Math.min(drag.x0,drag.x1), y=Math.min(drag.y0,drag.y1), w=Math.abs(drag.x1-drag.x0), h=Math.abs(drag.y1-drag.y0);
        ctx.strokeStyle = '#58a6ff'; ctx.setLineDash([5,3]); ctx.lineWidth = 1; ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
      }
    }

    const toCv = e => { const b=cv.getBoundingClientRect(); return { x:(e.clientX-b.left)*W/b.width, y:(e.clientY-b.top)*H/b.height }; };
    const hit = p => { for (const r of RECTS) if (p.x>=r.x && p.x<=r.x+r.w && p.y>=r.y && p.y<=r.y+r.h) return r.idx; return undefined; };
    const inMarquee = (r, m) => { const x0=Math.min(m.x0,m.x1),x1=Math.max(m.x0,m.x1),y0=Math.min(m.y0,m.y1),y1=Math.max(m.y0,m.y1);
      return r.x < x1 && r.x+r.w > x0 && r.y < y1 && r.y+r.h > y0; };

    function paint(idx) { opts.onPaint(idx, opts.getColor()); }   // set to current color
    function erase(idx) { opts.onPaint(idx, null); }              // remove the color

    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;   // only the left button paints — right/middle never paint or start a marquee
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      const p = toCv(e), idx = hit(p);
      const mode = e.altKey ? 'erase' : e.ctrlKey ? 'deselect' : e.shiftKey ? 'add' : 'paint';
      if (idx === undefined) { drag = { x0:p.x, y0:p.y, x1:p.x, y1:p.y, mode }; draw(); return; }
      // single-key gesture
      if (mode === 'erase') { sel.delete(idx); erase(idx); }
      else if (mode === 'deselect') { sel.delete(idx); }
      else if (mode === 'add') { sel.add(idx); paint(idx); }
      else { sel = new Set([idx]); paint(idx); }            // plain click = paint + select-only-this
      drag = { x0:p.x, y0:p.y, x1:p.x, y1:p.y, mode, single:true };
      draw(); opts.onChange();
    });
    cv.addEventListener('pointermove', e => { if (!drag) return; const p = toCv(e); drag.x1=p.x; drag.y1=p.y; drag.single=false; draw(); });
    cv.addEventListener('pointerup', e => {
      if (!drag) return;
      if (!drag.single) {                                  // a real marquee: apply to every enclosed key
        if (drag.mode === 'paint') sel = new Set();
        for (const r of RECTS) if (inMarquee(r, drag)) {
          if (drag.mode === 'erase') { sel.delete(r.idx); erase(r.idx); }
          else if (drag.mode === 'deselect') sel.delete(r.idx);
          else { sel.add(r.idx); paint(r.idx); }           // paint + add both fill with current
        }
      }
      drag = null; draw(); opts.onChange();
    });

    // changing the current color recolors the live selection
    function recolorSelection() { const c = opts.getColor(); for (const idx of sel) opts.onPaint(idx, c); draw(); opts.onChange(); }
    function clearSelection() { for (const idx of sel) erase(idx); sel = new Set(); draw(); opts.onChange(); }
    function selectNone() { sel = new Set(); draw(); }
    function selCount() { return sel.size; }

    draw();
    return { draw, recolorSelection, clearSelection, selectNone, selCount,
             destroy(){ window.removeEventListener('keydown', altGuard); host.innerHTML=''; } };
  }

  root.TH108PaintBoard = { mount };
})(window);
