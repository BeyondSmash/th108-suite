# GIF-to-LCD Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `th108-screen.html`'s LCD image/animated-GIF uploader into `th108-controller.html` as a self-contained overlay section, so one page (one WebHID connection) drives both key lighting and the LCD.

**Architecture:** Port the LCD pipeline into a new DOM-scoped module `th108-lcd.js` (`window.TH108LCD`, namespaced so it can't collide with the controller's existing GIF→key globals). The controller adds a toolbar button + hidden overlay it mounts the module into, opens the **screen interface (large output report, 0xFF67)** alongside the already-opened **control interface (0xFF68/0x61)** in `bindDevice`, and hands both HID handles to the module. The LCD uses the screen handle for cmd `0x50` (flash GIF upload) and the control handle for cmd `0x34` (clock-sync). `0x51` is dropped (confirmed inert on TH108). Single device owner → inherits the daemon auto-yield. Spec: [docs/superpowers/specs/2026-06-08-gif-lcd-merge-design.md](../specs/2026-06-08-gif-lcd-merge-design.md).

**Tech Stack:** Vanilla JS (UMD/global module, no build step), WebHID, Canvas/GDI-free RGB565 conversion. Reuses `th108-media-lib.js`.

**Conventions for this repo (must follow):**
- Work on a feature branch **`gif-lcd-merge`** off `master` (do not build on `master`). Create it first: `git switch -c gif-lcd-merge`.
- Commits authored as `Beyon <you@example.com>`, **no Claude/Co-Authored-By** trailer: `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "…"`.
- After editing `th108-controller.html`, syntax-check the inline script:
  `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`
- After editing `th108-lcd.js`: `node --check th108-lcd.js`.
- **Hardware steps can't be automated** — marked **[MANUAL/HW]**; the executor pauses for the user.
- This is a **faithful port** of a working tool — preserve behavior; do not redesign the UI (the user does the tab/visual redesign later). When unsure, copy `th108-screen.html`'s behavior exactly.

---

## File Structure
- **Create `th108-lcd.js`** (repo root, served by the daemon) — `window.TH108LCD` module: all LCD state + logic + UI builder, DOM-scoped to a passed container. Interface: `mount(container)`, `setDevices({screen, screenReportId, control, controlReportId})`, `onShow()`, `onHide()`. Owns: image/GIF/video + URL/clipboard + media-library load, crop/fit + zoom/pan + undo/redo, bar fills, forward/inverse color calibration + save/load preset, frame sampling + preview, `0x50` upload, `0x34` clock-sync. `0x51` dropped.
- **Modify `th108-controller.html`** — add `<script src="th108-lcd.js">`, a `🖵 LCD screen` toolbar button, a hidden full-screen overlay container, overlay CSS, the show/hide wiring (button + ✕ + Esc), `findScreen()`, the dual-interface open in `bindDevice`, and the `setDevices` hand-off on connect/disconnect.

---

## Task 1: Extract `th108-lcd.js` (DOM-scoped module, 0x51 dropped)

**Files:**
- Create: `th108-lcd.js`
- Read (source to port from): `th108-screen.html`

- [ ] **Step 1: Create the branch**

```bash
git switch -c gif-lcd-merge
```

- [ ] **Step 2: Create the module shell**

Create `th108-lcd.js` with this exact scaffold, then (Step 3) move the internals in:

```js
// th108-lcd.js — LCD image / animated-GIF uploader, self-contained module ported from th108-screen.html.
// The board's only dynamic-LCD path is cmd 0x50 (flash upload at 0x650000); the firmware then plays the
// uploaded multi-frame GIF itself. No live framebuffer exists. Clock-sync is cmd 0x34. (0x51 is inert here.)
(function (root) {
  // --- device handles, set by the controller via setDevices ---
  let scrDev = null, scrId = 0;     // screen interface (large output report) — cmd 0x50
  let ctlDev = null, ctlId = 0;     // control interface (0xFF68/0x61)        — cmd 0x34
  const TFT_CMD = 0x50, ADDR = 6619136; // 0x650000

  // --- mount container + scoped lookup (NO global getElementById — avoids clashing with the controller) ---
  let el = null;
  const $ = (sel) => el.querySelector(sel);

  // --- ported state (module scope; renamed where they'd clash is unnecessary since they're scoped here) ---
  // frames[], baseData, previewTimer/previewIdx, czoom/cpanX/cpanY + crop history, calibration params, currentFile …
  // (moved verbatim from th108-screen.html in Step 3)

  function log(m, c) { /* lightweight: append to the controller's #log if present, else console */
    const host = document.getElementById('log');
    if (host) { const d = document.createElement('div'); if (c) d.className = c; d.textContent = '[lcd] ' + m; host.appendChild(d); host.scrollTop = host.scrollHeight; }
    else console.log('[lcd]', m);
  }

  function mount(container) {
    el = container;
    container.innerHTML = LCD_HTML;   // the screen-tool markup (Step 3), MINUS the 0x51 slot button
    wire();                           // attach handlers via $() (Step 3)
  }
  function setDevices(d) {
    d = d || {};
    scrDev = d.screen || null; scrId = d.screenReportId || 0;
    ctlDev = d.control || null; ctlId = d.controlReportId || 0;
    const up = $('#lcdUpload'), sc = $('#lcdSyncClock'), st = $('#lcdDevNote');
    if (up) up.disabled = !scrDev;
    if (sc) sc.disabled = !ctlDev;
    if (st) st.textContent = scrDev ? (ctlDev ? 'screen + control bound' : 'screen bound (clock needs the control interface)')
                                    : 'not connected — connect on the main page first';
  }
  function onShow() { /* start preview loop if frames present (Step 3: startPreview) */ }
  function onHide() { /* stop preview loop (Step 3: stopPreview) */ }

  root.TH108LCD = { mount, setDevices, onShow, onHide };
})(window);
```

- [ ] **Step 3: Move the LCD internals from `th108-screen.html` (port, don't rewrite)**

Open `th108-screen.html` and move its inline `<script>` logic into the module, with these rules:
- **Scope every element lookup to the container:** replace each `document.getElementById('X')` / `document.querySelector('X')` with `$('#X')` / `$(sel)`. Prefix the screen tool's element ids with `lcd` when building `LCD_HTML` (e.g. `upload`→`lcdUpload`, `syncClock`→`lcdSyncClock`, `preview`→`lcdPreview`, `previewActual`→`lcdPreviewActual`, `cropZoom`→`lcdCropZoom`, `barFill`→`lcdBarFill`, `barColor`→`lcdBarColor`, `status`→`lcdStatus`, the crop undo/redo, the calibration inputs, the file/URL/paste inputs, the media-library picker mount). This guarantees no id collision with the controller.
- **`LCD_HTML`** = the screen tool's body markup (loaders incl. file + URL box + paste + `th108-media-lib.js` picker; the two 160×96 canvases `lcdPreview`/`lcdPreviewActual`; crop/fit radios + `lcdCropZoom` + zoom/pan + crop undo/redo; `lcdBarFill` select + `lcdBarColor`; the forward/inverse calibration controls + save/load preset; an Upload button `lcdUpload`; a Sync-clock button `lcdSyncClock`; a progress bar + `lcdStatus`; and a small `#lcdDevNote` line). **Omit the `switchSlot` (0x51) button entirely.**
- **Move these functions into module scope (de-globalized):** `coverDraw`, `cropRect`, `edgeAverage`, `barFill`, `captureSource`, `drawCropGuide`, `sampleFrames`, `tickPreview`/`stopPreview` (rename the start to `startPreview`, call it from `onShow`, `stopPreview` from `onHide`), the crop history (`cropPush`/`cropBtns`/`cropApplySnap`/`cropResetState`/`cropSnap`), `updateBarColorVis`, color calibration (`params`/`fwd`/`inv`/`applyColor`/`saveCal`/`loadCal` — keep its `localStorage` preset key), `processFile`, `drawActual`, and the RGB565 conversion.
- **The upload** (the screen tool's upload handler): keep its chunking but send via the passed screen handle — `scrDev.sendReport(scrId, pkt)` building the same TFT packet (`buildPkt_TFT`-equivalent: cmd `0x50`, the 256-byte header `[frameCount, 5×perFrameDelay…, 0]` + RGB565 data, address `ADDR=6619136`, 4096-byte chunks). Guard: `if(!scrDev){ log('connect first','err'); return; }`. Drive the progress bar + `lcdStatus`.
- **The clock-sync** (`syncClock`): send the `0x34` packet via `ctlDev.sendReport(ctlId, …)` (same payload as `th108-screen.html`). Guard `if(!ctlDev)`.
- **`wire()`**: attach all the `$()` handlers (loaders, crop, calibration, bar-fill visibility, upload, sync-clock). Do NOT auto-connect any device (the controller owns connection).
- **Do NOT** port `connect`/`findScreen`/`findControl` (the controller handles device binding) or the `switchSlot`/`0x51` handler.

- [ ] **Step 4: Syntax-check the module**

Run: `node --check th108-lcd.js`
Expected: no output (exit 0). (It won't be `require`d — it touches `window`/`document` only inside functions; `node --check` parses without executing.)

- [ ] **Step 5: Commit**

```bash
git add th108-lcd.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "lcd: extract th108-lcd.js — self-contained LCD GIF/image uploader module (0x50 + 0x34), DOM-scoped, 0x51 dropped"
```

---

## Task 2: Wire the LCD overlay into the controller

**Files:**
- Modify: `th108-controller.html`

- [ ] **Step 1: Load the module + add the toolbar button and overlay**

Add `<script src="th108-lcd.js"></script>` immediately before the inline `<script>` (next to the existing `th108-engine.js` / `th108-media-lib.js` tags). Add a `🖵 LCD screen` button to the toolbar row (next to `editBtn`/Export/Import):

```html
<button id="lcdBtn" title="Open the LCD screen uploader">🖵 LCD screen</button>
```

Add the overlay container at the end of `<body>` (before the scripts):

```html
<div id="lcdOverlay" class="lcdOverlay" style="display:none">
  <div class="lcdOverlayBar"><b>LCD screen</b><span id="lcdDevNote" class="hint"></span><button id="lcdClose" title="Close (Esc)">✕</button></div>
  <div id="lcdBody"></div>
</div>
```

Add CSS (in the existing `<style>`):

```css
.lcdOverlay{position:fixed;inset:0;background:#0d1117;z-index:50;overflow:auto;padding:14px}
.lcdOverlayBar{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.lcdOverlayBar button{margin-left:auto}
```

- [ ] **Step 2: Mount the module + show/hide wiring**

In the inline script (after the engine/UI setup), add:

```js
TH108LCD.mount(document.getElementById('lcdBody'));
const lcdOverlay = document.getElementById('lcdOverlay');
function lcdShow(){ lcdOverlay.style.display='block'; TH108LCD.onShow(); }
function lcdHide(){ lcdOverlay.style.display='none'; TH108LCD.onHide(); }
document.getElementById('lcdBtn').addEventListener('click', lcdShow);
document.getElementById('lcdClose').addEventListener('click', lcdHide);
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && lcdOverlay.style.display==='block') lcdHide(); });
```

- [ ] **Step 3: Find + open the screen interface in `bindDevice`, broaden the grant, hand off to the module**

The LCD needs the **screen** interface (large output report) in addition to the control interface. Two edits:

(a) Add `findScreen` near the existing `findWritable` (port from `th108-screen.html`):

```js
function findScreen(devs){
  let best=null;
  for(const d of devs) for(const col of d.collections||[]){
    for(const or of col.outputReports||[]){
      const bytes=(or.items||[]).reduce((n,it)=>n+(it.reportCount||0)*((it.reportSize||8)/8),0);
      if(!best || bytes>best.bytes) best={d, reportId:or.reportId||0, bytes};
    }
  }
  return best;
}
```

(b) In `connect()`, broaden the picker filter so the grant can include BOTH interfaces (the control interface is the key one; the screen interface is the large-report one). Change the `requestDevice` filter from the control-only `{vendorId:VENDOR, usagePage:USAGE_PAGE, usage:0x61}` to `{vendorId:VENDOR}` (same as `th108-screen.html`). In `bindDevice(devs, silent)`, after the existing control-interface open, also locate + open the screen interface and hand both to the module:

```js
// after the control interface (device/reportId/packLen) is opened and the inputreport hook is attached:
let screenDev=null, screenRid=0;
const sc=findScreen(devs);
if(sc && sc.bytes>=4096){ screenDev=sc.d; screenRid=sc.reportId; if(!screenDev.opened) await screenDev.open();
  log('screen interface bound (report '+sc.bytes+'B) — LCD upload available','ok'); }
else log('screen interface not in this grant — LCD upload disabled until you re-pick the keyboard','dim');
TH108LCD.setDevices({ screen:screenDev, screenReportId:screenRid, control:device, controlReportId:reportId });
```

On the disconnect / hand-back path (where the daemon resume / device release happens), add `TH108LCD.setDevices({});` so the LCD buttons disable.

- [ ] **Step 4: Add the upload-blanks-lighting note**

In the LCD UI (the module's `LCD_HTML`, near the Upload button) the `#lcdDevNote`/a static hint should read: *"Uploading writes the GIF to flash — the key lighting briefly blanks during the write, then resumes."* (Add as a static line in `LCD_HTML` if not already; this is informational.)

- [ ] **Step 5: Syntax-check**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "controller: integrate LCD uploader as an overlay section (th108-lcd.js); open screen interface in bindDevice + hand off to the module"
```

---

## Task 3: [MANUAL/HW] Verify on hardware

**Files:** none (verification only)

- [ ] **Step 1: Serve + connect**

With the daemon running (`node th108-daemon/daemon.js`), open `http://localhost:8123/`. Click **Connect**. In the WebHID picker, pick the keyboard. Confirm the log shows both the control interface (key lighting) and `screen interface bound (report ~4104B)`.
*(WebHID nuance: a grant may include only some interfaces. If the log says "screen interface not in this grant", re-pick the keyboard / pick the other entry until both bind. If it never binds the screen, key lighting still works; only LCD upload is disabled.)*

- [ ] **Step 2: LCD upload**

Open **🖵 LCD screen**. Load a **static image** → crop/fit + calibrate → **Upload** → it appears on the LCD. Load an **animated GIF** → Upload → the LCD plays/loops it. Confirm the key lighting blanks only during the upload, then resumes. Confirm crop/fit, zoom/pan, undo/redo, bar fills, and forward/inverse calibration behave exactly as in `th108-screen.html`.

- [ ] **Step 3: Clock-sync + isolation**

Click **Sync clock** → confirm the keyboard's built-in clock updates (cmd `0x34`). Close the overlay (✕/Esc) → confirm the preview loop stops and key lighting + the daemon handoff are unaffected. Confirm no duplicate-id breakage (the page still works normally with the overlay closed).

- [ ] **Step 4: Report**

Confirm to the user: LCD upload (static + GIF), calibration, crop, clock-sync all work from inside the controller, and key lighting/daemon are unaffected. If all good → ready to merge `gif-lcd-merge` → `master`.

---

## Self-Review notes (for the executor)
- **Faithful port:** the LCD logic already works in `th108-screen.html`; the only substantive changes are (1) scoping element lookups to the mounted container with prefixed ids, (2) using the passed `scrDev`/`ctlDev` handles instead of the screen tool's own `connect`, and (3) dropping `0x51`. Don't "improve" the pipeline.
- **No collisions:** the controller's existing GIF→key panel uses names like `czoom`/`cpanX`/`gifFrames`/`processFile`/`coverDraw`. The LCD module keeps its copies **inside the IIFE**, so they don't clash. Verify the controller's inline script has no leftover reference expecting LCD globals.
- **WebHID grant** is the main hardware risk (Step 1 note) — handle the "screen interface not granted" case gracefully (LCD disabled, key lighting unaffected); don't throw.
- Media/GIF *cycling*, live-screen, still-sequence are out of scope (confirmed dead — see the spec / [[th108-lighting-protocol]]).
