# TH108 Background Lighting Daemon — Design

**Date:** 2026-06-08
**Files:** new `th108-engine.js`, rewritten `th108-daemon/daemon.js`, edits to `th108-controller.html`
**Decisions locked:** full layer parity · daemon serves page + holds device · auto-yield handoff to the WebHID page · autostart on login · shared engine module (no code duplication).

## Goal
Run the user's *configured* controller lighting setup **always-on in the background** — most importantly so the **reactive (keypress) layer works in any app**, not only while the controller browser tab is focused. The browser can only receive key events while focused; a native global hook (uiohook) removes that limit.

All **customization stays in the WebHID controller page, direct and unchanged**. The daemon is purely a background runtime for whatever the page last produced. The device's HID interface is single-owner, so the daemon and page never drive it at once — an **automatic, invisible handoff** swaps ownership.

## Non-goals (out of scope for v1)
- Media/GIF layers in the daemon (it simply won't render `type:'media'` layers for now; use the page for GIF work).
- In-page daemon control buttons, a "daemon mode" editing surface, manual take-over UI, tray icon, profiles, multi-device.

## Architecture
Three units with clear boundaries:

1. **`th108-engine.js`** — DOM-free rendering/compositing logic. The single source of truth for *how* layers look. Pure functions over a passed-in state object. Loaded by **both** the browser (`<script src>`) and the daemon (`require`).
2. **Daemon (`th108-daemon/`)** — Node process. Owns the HID device, runs the engine from the saved config, captures keys globally (uiohook), serves the controller page + a small control API on `localhost:8123`, autostarts on login.
3. **Controller (`th108-controller.html`)** — the editor. Renders via the same engine module. Customizes over **direct WebHID exactly as today**, plus a few invisible handshake calls to the daemon.

```
  ┌─────────────────────────── localhost:8123 (daemon) ──────────────────────────┐
  │  static file server  ·  control API (/yield /resume /heartbeat /config /status)│
  │  engine (require th108-engine.js)  ·  node-hid (ACK-gated)  ·  uiohook (global) │
  └───────────────▲───────────────────────────────────────────────▲──────────────┘
                  │ serves page + handshake (fetch/sendBeacon)      │ owns HID when page idle
   ┌──────────────┴───────────────┐                        ┌────────┴─────────┐
   │ controller page (browser)    │  direct WebHID when     │  Epomaker TH108  │
   │ engine via <script src>      │  user is customizing    │  (single owner)  │
   └──────────────────────────────┘────────────────────────└──────────────────┘
```

## Component 1 — `th108-engine.js` (shared module)
Extract from `th108-controller.html` (port, do **not** rewrite):
- Renderers: `renderBackground`, `renderReactive`, `renderGradient`, `renderPattern`.
- Helpers: `patColorize`, `composite`, `layerNow`, `applyAdjust`, `layerCell`/`keyCell`, `hsv2rgb`, `hexToRgb`, `patHash`, `patParams`, `PAT_DEFAULTS`, `ensureSettings`, a default-layers factory.
- The **canonical board map**: `NLED`, `INDICES`, `KEYMAP`, key geometry — unified here (today duplicated between the HTML and `th108-daemon/th108-map.js`) so both sides use identical geometry. The daemon's `uiohook→code→LED index` map also derives from this.

**Interface (operates on an explicit state object — no globals, no DOM):**
- `createState(configLayers) → state` — builds `{ layers, react:{fg,t,down,up}, clocks, lastFlat, lastSent }` from a layer config array.
- `composeFrame(state, now) → flat` — runs each due layer (per-layer fps), composites, returns the flat `[idx,r,g,b,…]` array (or `null` when unchanged, so callers can skip the send — the existing suppression behavior).
- `stampKey(state, ledIndex)` / `releaseKey(state, ledIndex)` — reactive key down/up; browser calls from its DOM listeners, daemon from uiohook.
- Re-exports `hexToRgb`, `hsv2rgb`, etc. for callers.

**Module format:** UMD tail — `if (typeof module!=='undefined' && module.exports) module.exports = TH108Engine; else window.TH108Engine = TH108Engine;`. No build step.

**Controller refactor:** the HTML keeps all UI/DOM/state-construction code, but routes rendering through `TH108Engine` instead of inline copies. Its WebHID `sendFrame`/ACK-gating, loop scheduling, and UI stay in the HTML (transport + UI are per-side). Reactive DOM `keydown`/`keyup` call `TH108Engine.stampKey/releaseKey`.

## Component 2 — Daemon runtime
Rewrite `daemon.js` as a thin host around the engine:
- On start: load `th108-daemon/config.json` (the layer array). If absent → idle (don't touch the board) until the page hands one over.
- Build engine state; render loop (cap 30 fps) → `composeFrame` → **ACK-gated** `sendFrame` over `node-hid`.
- `uiohook` `keydown`→`stampKey`, `keyup`→`releaseKey` (the whole reason the daemon exists).
- **Device reconnect loop:** replaces today's exit-on-not-found. Poll for the 0xFF68/0x61 interface; open when present; on write error/`device.close`, drop back to polling. Survives unplug/replug.

**ACK-gated streaming (ported lesson, commit 72519bb):** the board ACKs every output write with an input report starting `0x55`. After each 56-byte chunk, **wait for that ACK before the next write**, with an ~800 ms timeout fallback (drop frame, keep looping; close+reopen on sustained stall). `node-hid`: register `device.on('data', …)` to resolve a per-write ACK promise; the render loop is async. Without gating the board's FIFO overruns and the pipe wedges after ~3-4 s.

## Component 3 — Control API + static serving (daemon, `localhost:8123`)
Same origin as the page → no CORS. Endpoints:
- `GET /` + static files → serve `th108-controller.html`, `th108-engine.js`, `th108-media-lib.js`, etc. (replaces `_serve.js`; the old script is kept as a no-daemon fallback).
- `POST /yield` → pause rendering + **close** the HID device; respond **only after** the device is released (the page awaits this before opening WebHID). Start the heartbeat watchdog.
- `POST /config` (body = layer array) → validate, write `config.json`. While yielded, store only (don't apply). Debounced by the page.
- `POST /resume` → load latest `config.json`, **reopen** the device, resume rendering. Stop the watchdog.
- `POST /heartbeat` → reset the watchdog timer.
- `GET /status` → `{ running, yielded, deviceConnected, fps }` (page uses this to detect the daemon).

**Heartbeat watchdog:** while yielded, if no `/heartbeat` for ~5 s, auto-`/resume` (assume the page crashed/closed without resuming) so the board never stays dark.

## Data flow — the auto-yield handoff
1. Page loads → `GET /status`. **No daemon →** page behaves exactly as today (direct WebHID, no handshake). **Daemon present →** continue:
2. Before connecting WebHID, page `POST /yield` and **awaits** it (device released).
3. Page connects WebHID and the user customizes **directly, unchanged**. Every ~3 s the page `POST /heartbeat`; on each (debounced) edit it `POST /config` (daemon saves to disk, doesn't apply).
4. Page close/refresh → `POST /resume` via `navigator.sendBeacon` (reliable at unload) → daemon reloads config, re-grabs the device, runs it. If that beacon is ever missed, the watchdog re-grabs within ~5 s.

**Config shape:** the **existing** controller serialization — `[{name,enabled,type,opacity,blend,fps,settings}]` (what's already written to `localStorage` key `th108_layers`). Reused verbatim as the `/config` body and `config.json` contents.

## Error handling
- **Device unplugged / not present:** reconnect loop; `/status deviceConnected:false`; lighting resumes on replug.
- **Port 8123 in use** (stale `_serve.js` or a second daemon): log a clear error naming the conflict and exit — do **not** fall back to another port (the page hard-codes `localhost:8123`, so a different port would silently break the handshake).
- **Bad `/config` body:** 400, keep last good config.
- **Page crash while holding device:** heartbeat watchdog re-grabs.
- **Send stall / wedge:** ACK-gating prevents it; sustained no-ACK → close+reopen the device, keep the loop alive.
- **No config yet (first run):** daemon idle (board shows firmware default) until the first hand-off.

## Testing / verification
- **Engine extraction parity (gate before anything else):** after the refactor, the controller must look **pixel-identical on hardware** to pre-refactor — patterns, reactive, blends, adjust. Hardware regression check.
- **Daemon core:** with a hand-written `config.json`, the board shows that exact setup; reactive lights keys **while another app (VSCode) is focused**; survives unplug/replug; ACK-gated (no wedge over minutes).
- **Handoff:** open page → board hands to WebHID (no conflict); edit → close page → daemon resumes with the edits; kill the page process → watchdog re-grabs within ~5 s.
- **Autostart:** after login, lighting + reactive are live with no manual step.

## Staged build (each its own commit, hardware-verified)
1. **Engine extraction** + map unification; controller refactored to use it; verify pixel-identical on hardware.
2. **Daemon core:** engine + `config.json` + ACK-gated `node-hid` streaming + reconnect loop + uiohook reactive. Test with a hand-written config.
3. **Control API + static serving + handoff:** `/yield /resume /heartbeat /config /status`; controller does the yield/heartbeat/save/resume handshake (detect via `/status`; `sendBeacon` on unload).
4. **Autostart polish + docs:** update `start-hidden.vbs` / `install-autostart.ps1`; daemon README.

## Defaults (resolved)
- Serve + control API on **`localhost:8123`**.
- Config persisted at **`th108-daemon/config.json`**.
