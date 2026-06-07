# Epomaker TH108 V2 PRO — Custom Lighting Controller: Handoff Brief

## Goal
Keypress-reactive yellow-orange keys AND a simultaneously pulsing cyan background on an
Epomaker TH108 V2 PRO — something the stock software can't do — driven host-side, no firmware modification.

## Why the stock software can't do it (already established)
- On-board lighting runs ONE effect at a time (single `effectCurrent` / one effect code in the
  profile's `allledPack`). Reactive and breathing/pulsing are different, mutually-exclusive codes.
- A reactive effect can carry one background color ("point off" = lit field, keys dim on press),
  but it's a single color with no independent animated background.
- Firmware CAN composite a static color over an animation (the white Num Lock indicator proves it),
  but it's locked to lock-key indicators and tied to live key state. The per-key `infoColor` field
  in the profile exists but is always null — not exposed.
- The Musical Rhythm plugin DOES run two layers at once (per-key foreground + background), but its
  foreground is AUDIO-reactive, not keypress, and it isn't saved to the profile.
- No VIA/QMK JSON exists for this model — it's a proprietary web-driver board.

## The host-side opening (this is the path)
From `MusicPlug.exe` (in the installed `Music\` folder):
- Native MFC/C++ app. Captures SYSTEM AUDIO via WASAPI loopback ("Default Loopback Device").
- Drives the keyboard over raw HID: enumerates via `SetupDi*`, opens with `CreateFile`, writes
  **64-byte reports** via `WriteFile` (`HidD_GetIndexedString` present). => keyboard is a frame sink;
  the PC computes the lighting. A custom host can take the same path with keypress-driven frames.
- Runs a CORS-enabled localhost HTTP/JSON server (WS2_32 + statically-linked JsonCpp).
  CORS header: `Access-Control-Allow-Headers: Content-Type` => any-origin web page can call it.
- Endpoints found in the binary (GET):
  - `/api/audio/amplitude`
  - `/api/hardware/info`
  - `/api/keyboard/layout/base64`
  - `/api/keyboard/musiceffect`
  - `/api/keyboard/musiceffect/close`
  - `/api/keyboard/musiceffect/layout`   (takes `layout=`; responds `{"status":"layout received via GET"}`)
- JSON field literals in the binary: `keyIndex`, `keyCode`, `color`, `backmodebrightness`, `amplitude`, `layouts`.
  Interpretation: `color` per `keyIndex` = per-key FOREGROUND layer; `backmodebrightness` = a BACKGROUND
  layer with its own brightness. That's exactly the foreground+background composite we want, over HTTP.

## Source to read (web driver front-end)
SPA at https://epomaker.driveall.cn (Vue). Relevant bundles:
- `static/js/chunk-keyboard.0ff72ea3.js`  <- keyboard + music logic (endpoint construction, payload shapes)
- `static/js/app.a59971f3.js`             <- likely the localhost base URL / port
Skip `chunk-vendors`, `chunk-elementUI`, `chunk-pintura` (framework / UI widgets / image editor).
Local install: the `Music\` directory (MusicPlug.exe + mfc140u/msvcp140/vcruntime140 dlls +
`HardwareMonitor\` = LibreHardwareMonitor, so it can also drive lighting from CPU/GPU sensors).

## THE question that gates the build
Are per-key foreground `color` values LIVE-PUSHABLE over the HTTP API (repaint pressed keys each frame),
or is `layout` a one-time "which keys participate" map with live colors computed from audio inside MusicPlug?

## First tasks (in order)
1. Read `chunk-keyboard.0ff72ea3.js` and `app.a59971f3.js` locally. Grep for: `api/`, `127.0.0.1`,
   `localhost`, a port number, `keyIndex`, `color`, `backmodebrightness`, `musiceffect`, `layout`.
   Extract: localhost base URL + PORT, exact endpoint paths, and the request payload shape for
   setting key colors and the background.
2. With the keyboard connected and MusicPlug running, hit the live endpoints (curl/fetch) and test
   whether per-key colors can be pushed on demand. This is the definitive answer.
3. Decision:
   - If per-key colors ARE live-pushable over HTTP -> build an HTML controller: a requestAnimationFrame
     loop pushing a pulsing-cyan background (vary `backmodebrightness` or the background color), plus a
     `keydown` listener that pushes yellow-orange to the pressed key's index with a fade-out decay.
     Open it locally in the browser (CORS allows it). NOTE: `keydown` only fires while that tab is focused.
   - For type-anywhere / always-on -> port the same logic to a native host daemon: global
     `WH_KEYBOARD_LL` hook + a framebuffer + push frames ~30-60fps, either via the local HTTP API or by
     replicating MusicPlug's 64-byte HID `WriteFile` reports.
   - If NOT HTTP-pushable -> get the HID frame format directly: USBPcap capture of MusicPlug streaming a
     music effect (decode the 64-byte reports), or static disasm of MusicPlug.exe's `WriteFile` sites.
     Then stream via raw HID (node-hid / hidapi / Python `hid`).

## Color targets
- Keys (foreground, on press): yellow-orange ~ `255,140,0` (toward `255,165,0` for more yellow).
- Background (pulsing): pale cyan ~ `160,255,255` (toward `0,255,255` for truer cyan).

## Gotchas
- HID reports are 64 bytes (`push 0x40`); a full TH108 frame probably spans several reports.
- MusicPlug must be running for the localhost server to exist; the web driver depends on it.
- Keyboard must be connected; the app requests administrator execution level.
