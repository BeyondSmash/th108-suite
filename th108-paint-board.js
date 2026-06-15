// th108-paint-board.js — interactive per-key paint board for the Individual-keys layer.
// window.TH108PaintBoard.mount(host, opts) renders a canvas of the 104 keys (geometry from the engine's
// keyCell) and runs the paint/selection model: click/marquee paints settings.current; Shift adds; Ctrl
// deselects; Alt-box erases; the color picker recolors the live selection. opts:
//   { engine, getKeys()->{idx:'#rrggbb'}, getColor()->'#rrggbb', onPaint(idx,hex|null), onChange() }
// It NEVER touches the keymap binder's KBOARD — it only reuses keyCell geometry.
(function (root) {
  'use strict';
  const W = 468, H = 135, PAD = 4;   // same canvas proportions as the GIF->key preview (drawKb)

  function mount(host, opts) {
    const E = opts.engine, INDICES = E.INDICES;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H; cv.className = 'pb-canvas'; cv.style.touchAction = 'none';
    host.innerHTML = ''; host.appendChild(cv);
    const ctx = cv.getContext('2d');

    let sel = new Set();          // currently-selected LED indices (transient)
    let drag = null;              // {x0,y0,x1,y1,mode:'paint'|'add'|'deselect'|'erase'} during a marquee

    // key rect in canvas pixels, from the engine's normalized keyCell (center x,y + w,h, 0..1)
    function rectOf(idx) {
      const c = E.keyCell(idx); if (!c) return null;
      const iw = W - 2*PAD, ih = H - 2*PAD;
      return { x: PAD + (c[0]-c[2]/2)*iw, y: PAD + (c[1]-c[3]/2)*ih, w: c[2]*iw, h: c[3]*ih, idx };
    }
    const RECTS = INDICES.map(rectOf).filter(Boolean);

    function draw() {
      const keys = opts.getKeys();
      ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);
      for (const r of RECTS) {
        const hex = keys[r.idx];
        ctx.fillStyle = hex || '#222831';                 // painted color, else dim neutral
        ctx.fillRect(r.x+0.75, r.y+0.75, Math.max(1,r.w-1.5), Math.max(1,r.h-1.5));
        if (sel.has(r.idx)) { ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2; ctx.strokeRect(r.x+1, r.y+1, r.w-2, r.h-2); }
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
    return { draw, recolorSelection, clearSelection, selectNone, selCount, destroy(){ host.innerHTML=''; } };
  }

  root.TH108PaintBoard = { mount };
})(window);
