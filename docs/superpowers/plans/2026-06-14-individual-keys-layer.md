# Individual-Keys Color Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `individual` compositor layer type that lets the user paint explicit per-key colors on an interactive on-screen keyboard, composited via the engine's existing `replace` blend.

**Architecture:** The engine gets a `renderKeys` renderer + settings (`keys` map, `current` color). The layers-UI gets `individual` in its type dropdown and a card body (Show-Keyboard pill, color picker, selection count, clear buttons). A new self-contained canvas component `th108-paint-board.js` renders the board (reusing `keyCell` geometry) and implements the marquee/selection painting model; the binder's `KBOARD` is untouched. Everything persists through the existing `th108_layers` path, so the daemon renders it with no new code.

**Tech Stack:** Vanilla JS (zero-build UMD/IIFE, like `th108-engine.js` / `th108-lcd.js`), `node --test`, canvas 2D, HTML `new Function` syntax check, in-browser smoke against the daemon page on `:8123`.

**Hard rules:** commits authored as `Beyon <you@example.com>`, NO Claude attribution (`git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`). `node --check` after every `.js` edit; the `new Function` inline-script check after every `th108-controller.html` edit. American spelling.

---

## File Structure

- **`th108-engine.js`** (modify) — `renderKeys(L)` renderer; `individual` block in `ensureSettings`; dispatch in `renderLayer`. Pure, shared by page + daemon.
- **`th108-engine.test.js`** (modify) — unit test for the `individual` layer + `replace` composite.
- **`th108-layers-ui.js`** (modify) — `'individual'` in `TYPES`; `individual` branch in `buildLayerBody` (controls + Show-Keyboard pill that mounts the paint board above the card).
- **`th108-paint-board.js`** (create) — `window.TH108PaintBoard = { mount(host, opts) }`: a canvas board that renders keys from `keyCell`, runs the selection/painting model, and calls back to mutate the layer's `settings.keys`/`settings.current`.
- **`th108-controller.html`** (modify) — `<script src="th108-paint-board.js">` include + the board's CSS.

---

### Task 1: Engine — the `individual` layer type (renderer + settings + dispatch)

**Files:**
- Modify: `th108-engine.js` (`renderKeys` after `renderMedia` ~line 210; `ensureSettings` ~line 446; `renderLayer` ~line 391)
- Test: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test** (append to `th108-engine.test.js`)

```js
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
  // painted A = red (replace overrides the green background)
  assert.ok(flat[oA+1] > 200 && flat[oA+2] < 60 && flat[oA+3] < 60, 'painted A is red over the background');
  // unpainted B = the green background shows through (replace passes black keys)
  assert.ok(flat[oB+2] > 0, 'unpainted B reveals the green background');
});

test('ensureSettings backfills individual fields', () => {
  const L = { type:'individual', settings:{} };
  E.ensureSettings(L);
  assert.deepEqual(L.settings.keys, {});
  assert.equal(L.settings.current, '#ff8c00');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test th108-engine.test.js`
Expected: FAIL — the individual layer renders nothing (painted A not red) and `ensureSettings` leaves `keys` undefined.

- [ ] **Step 3: Add `renderKeys`** (in `th108-engine.js`, immediately after `function renderMedia(L,now){ ... }` ~line 210)

```js
  // individual-keys layer: paint explicit per-key colors. settings.keys = {ledIndex:'#rrggbb'};
  // unpainted keys are black, i.e. transparent under the 'replace' blend (painted keys override below).
  function renderKeys(L){
    const keys=(L.settings&&L.settings.keys)||{}, out=L.rgb;
    for(let k=0;k<NLED;k++){ const o=k*3, hex=keys[INDICES[k]];
      if(hex){ const c=hexToRgb(hex); out[o]=c[0]; out[o+1]=c[1]; out[o+2]=c[2]; }
      else { out[o]=out[o+1]=out[o+2]=0; } }
  }
```

- [ ] **Step 4: Dispatch it in `renderLayer`** (change the `else` fallthrough ~line 391-392)

Replace:
```js
    else if(L.type==='pattern') renderPattern(L,tnow);
    else renderMedia(L,now);
```
with:
```js
    else if(L.type==='pattern') renderPattern(L,tnow);
    else if(L.type==='individual') renderKeys(L);
    else renderMedia(L,now);
```

- [ ] **Step 5: Backfill settings in `ensureSettings`** (add a branch ~line 447, after the `pattern` branch, before the common-adjust block)

```js
    else if(L.type==='individual'){ if(!L.settings.keys || typeof L.settings.keys!=='object') L.settings.keys={}; if(L.settings.current===undefined) L.settings.current='#ff8c00'; }
```

- [ ] **Step 6: Export `renderKeys`** (add to the `TH108Engine` object ~line 519, the renderers line)

Change `renderBackground, renderReactive, renderGradient, renderPattern, renderMedia,` to include `renderKeys`:
```js
    renderBackground, renderReactive, renderGradient, renderPattern, renderMedia, renderKeys,
```

- [ ] **Step 7: Verify pass**

Run: `node --check th108-engine.js && node --test th108-engine.test.js`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add th108-engine.js th108-engine.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat(engine): individual-keys layer type (renderKeys + replace-blend per-key paint)"
```

---

### Task 2: The paint-board canvas component (`th108-paint-board.js`)

**Files:**
- Create: `th108-paint-board.js`

A self-contained canvas board: draws each key at its `keyCell` rect, hit-tests pointer + marquee against those rects, and runs the selection/painting model. No DOM key divs (canvas only), so marquee selection is a simple rect test.

- [ ] **Step 1: Create the file**

```js
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
```

- [ ] **Step 2: Syntax check**

Run: `node --check th108-paint-board.js`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add th108-paint-board.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: th108-paint-board.js — canvas per-key paint board (marquee/select model)"
```

---

### Task 3: Load the board script + add its CSS (`th108-controller.html`)

**Files:**
- Modify: `th108-controller.html` (the `<script src=...>` block near the other module includes; a `<style>` rule)

- [ ] **Step 1: Add the script include**

Find the line that includes the layers UI or another module, e.g. `<script src="th108-layers-ui.js"></script>`, and add immediately after it:
```html
  <script src="th108-paint-board.js"></script>
```
(If `th108-layers-ui.js` is not loaded via `<script src>` but inlined, add the include alongside the other `th108-*.js` includes; verify with `grep -n 'th108-.*\.js"' th108-controller.html`.)

- [ ] **Step 2: Add the board CSS** (in the page's `<style>`, near the other component styles)

```html
  <style>
    .pb-wrap{ margin:8px 0; padding:10px; background:var(--inset,#0d1117); border:1px solid var(--line,#30363d); border-radius:12px; }
    .pb-canvas{ width:100%; max-width:520px; height:auto; image-rendering:pixelated; border-radius:6px; cursor:crosshair; display:block; }
    .pb-hint{ color:var(--dim,#8b949e); font-size:11px; margin-top:6px; }
  </style>
```

- [ ] **Step 3: Syntax check the inline script**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: load th108-paint-board.js + its board styles in the controller"
```

---

### Task 4: Layers-UI — `individual` type + card body + Show-Keyboard board mount

**Files:**
- Modify: `th108-layers-ui.js` (`TYPES` ~line 16; `buildLayerBody` ~line 130, add an `individual` branch before the closing of the type chain)

- [ ] **Step 1: Add `individual` to the type dropdown**

Change line 16:
```js
  const TYPES=['background','reactive','gradient','pattern','media'], BLENDS=['normal','add','screen','multiply','max','replace'];
```
to:
```js
  const TYPES=['background','reactive','gradient','pattern','individual','media'], BLENDS=['normal','add','screen','multiply','max','replace'];
```

- [ ] **Step 2: Add the `individual` body branch** (in `buildLayerBody`, add an `else if` after the `pattern` branch ends ~line 285, before the shared adjust/`a-frozen` block that runs for all types)

Locate the end of the `else if(L.type==='pattern'){ … }` block. Add:
```js
      } else if(L.type==='individual'){
        if(!s.keys||typeof s.keys!=='object') s.keys={};
        if(s.current===undefined) s.current='#ff8c00';
        body.innerHTML='<div class="ctl">'+
          row('Paint color','<input type="color" class="s-current" value="'+s.current+'"><span></span>')+
          row('','<button class="s-showkb" type="button">⌨ Show Keyboard</button><span class="val s-selcount" style="margin-left:8px"></span>')+
          row('','<button class="s-clearsel" type="button">Clear selection</button> <button class="s-clearall" type="button">Clear all</button>')+
        '</div>';
        const c=q=>body.querySelector(q);
        let pb=null, wrap=null;
        const reRender=()=>{ L.lastTick=0; };   // force the running layer loop to repaint next frame
        const updCount=()=>{ const el=c('.s-selcount'); if(el) el.textContent = pb ? (pb.selCount()+' selected') : ''; };
        function mountBoard(){
          if(pb) return;
          wrap=document.createElement('div'); wrap.className='pb-wrap';
          wrap.innerHTML='<div class="pb-board"></div><div class="pb-hint">Click/drag to paint · Shift+ add · Ctrl+ deselect · Alt+drag erase · pick a color to recolor the selection</div>';
          card.parentNode.insertBefore(wrap, card);   // wedge the board directly ABOVE this layer card
          pb=root_PaintBoard().mount(wrap.querySelector('.pb-board'), {
            engine:E,
            getKeys:()=>s.keys,
            getColor:()=>s.current,
            onPaint:(idx,hex)=>{ if(hex) s.keys[idx]=hex; else delete s.keys[idx]; reRender(); },
            onChange:()=>{ updCount(); scheduleSaveLayers(); },
          });
          c('.s-showkb').textContent='⌨ Hide Keyboard'; updCount();
        }
        function unmountBoard(){ if(!pb) return; pb.destroy(); pb=null; if(wrap&&wrap.parentNode) wrap.parentNode.removeChild(wrap); wrap=null; c('.s-showkb').textContent='⌨ Show Keyboard'; updCount(); }
        c('.s-current').addEventListener('input',e=>{ s.current=e.target.value; if(pb) pb.recolorSelection(); });
        c('.s-showkb').addEventListener('click',()=>{ pb?unmountBoard():mountBoard(); });
        c('.s-clearsel').addEventListener('click',()=>{ if(pb){ pb.clearSelection(); } reRender(); scheduleSaveLayers(); });
        c('.s-clearall').addEventListener('click',()=>{ s.keys={}; if(pb){ pb.selectNone(); pb.draw(); } reRender(); scheduleSaveLayers(); });
```

(Note: `root_PaintBoard` is a tiny accessor for the global, defined in Step 3 — avoids a hard `window.TH108PaintBoard` reference inside the UMD factory.)

- [ ] **Step 3: Add the `root_PaintBoard` accessor** (near the top of the `factory()` body in `th108-layers-ui.js`, after `const TYPES=...`)

```js
  const root_PaintBoard = () => (typeof window!=='undefined' && window.TH108PaintBoard) || { mount(){ return { draw(){}, recolorSelection(){}, clearSelection(){}, selectNone(){}, selCount(){return 0;}, destroy(){} }; } };
```

- [ ] **Step 4: `node --check`**

Run: `node --check th108-layers-ui.js && node --test th108-layers-ui.test.js`
Expected: `th108-layers-ui.js` parses; the existing pure-helper tests still pass (no behavior change to serialize/overlay).

- [ ] **Step 5: Commit**

```bash
git add th108-layers-ui.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: Individual-keys layer card — type, color, Show-Keyboard paint board, clear actions"
```

---

### Task 5: Alt-suppress on the board (bare-Alt menu guard)

**Files:**
- Modify: `th108-paint-board.js` (inside `mount`, after the canvas is created)

The browser focuses its menu on a bare Alt press, which can steal the Alt-drag. Suppress Alt only while the pointer is interacting with the board.

- [ ] **Step 1: Add the guard** (inside `mount`, right after `host.appendChild(cv);`)

```js
    // bare-Alt focuses the browser menu and can interrupt an Alt-drag erase — swallow Alt while the
    // pointer is over/using THIS board (scoped, so Alt+letter shortcuts elsewhere are unaffected).
    let overBoard = false;
    cv.addEventListener('pointerenter', () => { overBoard = true; });
    cv.addEventListener('pointerleave', () => { if (!drag) overBoard = false; });
    const altGuard = e => { if ((overBoard || drag) && (e.key === 'Alt' || e.altKey)) e.preventDefault(); };
    window.addEventListener('keydown', altGuard);
```
And in the returned object's `destroy()`, remove the listener:
```js
    return { draw, recolorSelection, clearSelection, selectNone, selCount,
             destroy(){ window.removeEventListener('keydown', altGuard); host.innerHTML=''; } };
```
(Replace the earlier `destroy(){ host.innerHTML=''; }` with this version.)

- [ ] **Step 2: Syntax check**

Run: `node --check th108-paint-board.js`
Expected: valid.

- [ ] **Step 3: Commit**

```bash
git add th108-paint-board.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: scoped bare-Alt suppression on the paint board (Alt-drag erase works)"
```

---

### Task 6: In-browser smoke + hardware glance

No new hardware risk (pure lighting). The daemon serves the page at `:8123` (or `node _serve.js`).

- [ ] **Step 1: Load `http://localhost:8123/th108-controller.html`**, go to the Lighting tab.

- [ ] **Step 2: Verify via the page / `browser_evaluate`:**
  - Change a layer's **type** dropdown to **Individual** → the card body shows the Paint color picker + "⌨ Show Keyboard" + Clear buttons; no console errors.
  - Click **Show Keyboard** → a board panel appears **directly above** that layer's card; clicking a key fills it with the paint color; drag-marquee fills a region; **Shift**+click adds; **Ctrl**+click deselects; **Alt**+drag erases; changing the **Paint color** recolors the highlighted selection.
  - **Clear selection** un-paints the selected keys; **Clear all** empties the board.
  - **Reload** the page → the painted keys persist (restored from `th108_layers`).
  - Zero console errors throughout.

- [ ] **Step 3: Screenshot** the Individual card + its board for the session record.

- [ ] **Step 4: Hardware glance (user):** with the board Connected and an Individual layer enabled over a Background layer, painted keys light in their colors and unpainted keys show the background through (the `replace` blend).

---

## Self-Review (completed during planning)

- **Spec coverage:** §2 engine type → Task 1; §3 card body + placement → Task 4; §4 board component → Task 2; §5 painting model → Task 2 (+ recolor/clear wired in Task 4); §6 Alt-suppress → Task 5; §7 persistence → automatic via `serializeLayers` (Task 4 mutates `settings`); §8 testing → Tasks 1 + 6. All covered.
- **Type consistency:** `renderKeys` (engine), `TH108PaintBoard.mount(host,opts)` with `{engine,getKeys,getColor,onPaint,onChange}`, board API `{draw,recolorSelection,clearSelection,selectNone,selCount,destroy}` — used consistently in Tasks 2/4/5. `settings.keys` / `settings.current` consistent across engine + UI.
- **Placeholder scan:** every code step shows complete code; no TBDs.
- **Open verification:** Task 4 Step 2 inserts the board via `card.parentNode.insertBefore(wrap, card)` — confirm `card` is the layer's top-level element in `buildLayerCards` (it is: `card` is the `.lcard` passed to `buildLayerBody`). If layer cards live inside a per-column wrapper, "above the card" is still correct (same parent).
