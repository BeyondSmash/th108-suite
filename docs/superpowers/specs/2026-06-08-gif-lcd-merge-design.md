# GIF-to-LCD Merge — Design

**Date:** 2026-06-08
**Files:** new `th108-lcd.js`, edits to `th108-controller.html`
**Decisions locked:** integrate the LCD GIF/image uploader into the controller as a **self-contained overlay section** · port faithfully from `th108-screen.html` (don't unify the media input yet) · **drop `0x51`** (confirmed inert on TH108) · single device owner (inherits the daemon auto-yield) · the user does the later tab/visual redesign.

## Goal
Bring `th108-screen.html`'s LCD image/animated-GIF uploader into the localhost suite (`th108-controller.html`) so one page does both **key lighting** and **LCD content** over a single WebHID connection. The LCD's only dynamic path is confirmed: upload one animated GIF via **cmd `0x50`** to flash `0x650000`; the **firmware plays it from flash** (header carries frame count + per-frame delays). There is no live-framebuffer path (verified in the web-driver source). So this is a faithful port of the existing, working `0x50` pipeline — not new protocol work.

## Non-goals (out of scope)
- Unifying the media input across the key-GIF panel and the LCD (deferred — the doc's "one input, all targets"; would collide with the planned tab redesign).
- The tab/visual redesign itself (the user's follow-up; this spec only delivers a self-contained, restyleable overlay section).
- DRYing the two GIF-decode paths (key panel vs LCD).
- `0x51` slot switching, live-screen/framebuffer, still-sequence frame player — all confirmed dead/unviable (see [[th108-lighting-protocol]]).
- Screen-capture → key ambient layer (`ScreenLight`-style) — a separate future feature.

## Architecture
Two units:

1. **`th108-lcd.js`** (new, repo root, served by the daemon) — a self-contained module `window.TH108LCD` holding **all** LCD state + logic + its own UI builder. Namespaced so it can't collide with the controller's existing GIF→key panel globals (`czoom`, `cpanX/Y`, `gifFrames`, `processFile`, crop history, etc. — names that exist in both). It does image/GIF decode, crop/fit, calibration, frame sampling, preview, and the `0x50` upload + `0x34` clock-sync. It does **not** open the device — the controller hands it the HID handles.
2. **`th108-controller.html`** — adds: a toolbar button + a hidden full-screen **overlay** container that `TH108LCD.mount()` renders into; opens the **screen interface** alongside the control interface in `bindDevice`; hands both handles to the LCD module; nothing else changes.

```
 toolbar [🖵 LCD screen] ──opens──> overlay (#lcdOverlay)
                                      └─ TH108LCD.mount(container)  (own UI + state)
 bindDevice() ── opens 0xFF68 control (key lighting + 0x34)  ─┐
              └─ opens 0xFF67 screen  (0x50 image/GIF upload) ─┴─> TH108LCD.setDevices({screen, control})
 (page already yields the daemon on connect → single owner)
```

## Component 1 — `th108-lcd.js`
Port from `th108-screen.html` (its inline `<script>`), wrapped in one IIFE exposing:
- `TH108LCD.mount(containerEl)` — build the LCD UI inside `containerEl` (loaders incl. file/URL/clipboard + `th108-media-lib.js` picker, crop/fit + zoom/pan + undo/redo, bar-fill selector, forward/inverse color-calibration controls + save/load preset, the 160×96 preview canvases, an Upload button, a Sync-clock button, a progress bar/status line). All element lookups scoped to `containerEl` (no global `getElementById` collisions with the controller).
- `TH108LCD.setDevices({ screen, control })` — receive the two open HID handles (and their reportIds/report lengths). The module uses `screen` for `0x50` and `control` for `0x34`. If null (not connected), upload/clock buttons disable with a "connect first" hint.
- `TH108LCD.onShow()/onHide()` — start/stop the preview loop when the overlay opens/closes (don't run the preview timer while hidden).

Internals moved verbatim (then de-globalized into module scope): `coverDraw`/`cropRect`/`edgeAverage`/`barFill` (crop/fit + bar fills), `sampleFrames`/`tickPreview`/`stopPreview` (frame sampling + preview), the crop history (`cropPush`/`cropBtns`/`cropApplySnap`/`cropReset`), color calibration (`params`/`fwd`/`inv`/`applyColor`/`saveCal`/`loadCal`), `processFile`, the RGB565 conversion, the `0x50` chunked upload (`buildPkt_TFT`-style framing → `screen.sendReport`), and the `0x34` clock sync (`control.sendReport`). **Drop** the `0x51` slot button + handler.

UMD/global tail: `window.TH108LCD = {...}` (browser only; not needed in Node).

## Component 2 — controller wiring
- **Overlay + button:** add `<button id="lcdBtn">🖵 LCD screen</button>` to the toolbar and a hidden `<div id="lcdOverlay" class="overlay">` (full-screen, dark, with a ✕/Esc close). Button → show overlay + `TH108LCD.onShow()`; ✕/Esc → hide + `TH108LCD.onHide()`. Self-contained so the later tab redesign can relocate it.
- **`<script src="th108-lcd.js"></script>`** before the inline script; `TH108LCD.mount(document.getElementById('lcdOverlay-body'))` once on load.
- **Dual-interface bind:** extend `bindDevice` to also locate + open the **screen interface** (the collection with the large output report, à la `th108-screen.html`'s `findScreen`), storing `screenDevice/screenReportId/screenLen`. The control interface (0xFF68/0x61) is already opened. After binding, call `TH108LCD.setDevices({screen, control})`; on disconnect, `setDevices({screen:null, control:null})`.
- **Daemon coexistence (inherited):** the page already `/yield`s the daemon (control interface) on connect; the screen interface isn't used by the daemon. Surface a one-line note near the Upload button: *"Uploading briefly blanks the key lighting (firmware writes the GIF to flash), then it resumes."*

## Data flow
1. Connect (controller) → daemon yields → both interfaces open → `setDevices` to the LCD module.
2. Open 🖵 LCD overlay → load image/GIF → crop/fit/calibrate → preview (host-side).
3. Upload → chunked `0x50` to flash `0x650000` (progress bar). Firmware then loops the GIF on the LCD. Key lighting blanks during the write, resumes after.
4. Clock-sync button → `0x34` on the control interface.
5. Close overlay → preview loop stops; key lighting/daemon handoff unaffected.

## Error handling
- Not connected → upload/clock disabled with "connect first".
- Screen interface not found → LCD upload disabled with a clear message (control-only connection still drives key lighting).
- Upload mid-failure → surface the chunk error + status; the existing `th108-screen.html` recovery note ("replug → wait → reconnect → retry") carries over.
- Bad/oversized image → reuse `th108-screen.html`'s existing handling.

## Testing / verification
- **Syntax:** `node --check th108-lcd.js`; inline-script check on `th108-controller.html`.
- **[MANUAL/HW]** From inside the controller (served at `localhost:8123`, daemon running): connect → open LCD overlay → upload a static image AND an animated GIF → both display (GIF loops); color calibration + crop/fit behave as in `th108-screen.html`; clock-sync works; **key lighting + the daemon handoff are unaffected** (lighting blanks only during the upload, then resumes).
- Confirm the LCD module's element IDs don't collide with the controller (no duplicate-id breakage; preview only runs while the overlay is open).

## Staged build (each its own commit, hardware-verified)
1. **Extract `th108-lcd.js`** from `th108-screen.html` (IIFE module + `mount`/`setDevices`/`onShow`/`onHide`, `0x51` dropped). `node --check` passes. (No controller change yet; module standalone.)
2. **Controller wiring** — script tag, overlay + button, `bindDevice` dual-interface open, `setDevices` hand-off, blank-during-upload note. Inline-script syntax check.
3. **[MANUAL/HW] verify** the full flow, then it's ready to merge.

## Defaults (resolved)
- LCD lives in a hidden overlay toggled by a toolbar button (restyleable; the user redesigns into tabs later).
- `0x51` dropped. `0x34` clock-sync kept. Media library reused (already loaded).
