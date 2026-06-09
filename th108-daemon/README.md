# TH108 Lighting Daemon (always-on, type-anywhere)

Runs **your saved controller lighting setup** as a background process, so it works in **any** app —
no browser tab, no focus required. It renders the exact same layers as the WebHID controller page
(via the shared `../th108-engine.js`), streams them over ACK-gated `node-hid` (raw HID), and drives
the reactive layer from a system-wide keyboard hook (`uiohook-napi`).

It also **serves the controller page** at `http://localhost:8123`, and hands the keyboard back and
forth automatically: open the page to customize (it takes the device over WebHID), close it and the
daemon resumes with whatever you changed.

## Requirements
- Node.js 18+ (`node -v`).
- `node-hid` and `uiohook-napi` ship prebuilt binaries, so `npm install` usually needs no compiler.
  If it tries to compile and fails, install the
  [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Desktop C++).

## Install & run
```powershell
cd "path\to\th108-suite\th108-daemon"
npm install
node daemon.js
```
You'll see `✓ serving controller + control API on http://localhost:8123` and (once a config exists)
`✓ device open`. Open **http://localhost:8123/** to customize. **Ctrl+C** stops it.

## How config works
- Customize on the page as usual. Every edit is mirrored to **`config.json`** in this folder
  (the daemon writes it from the page's pushed config — you don't manage it by hand).
- On first run there's no `config.json`, so the daemon stays idle (board untouched) until you open
  the page once and let it push your setup.
- The daemon reloads `config.json` whenever it re-grabs the device (i.e. when you close the page).

## The device handoff (automatic)
The keyboard's control interface is single-owner, so the page and daemon never drive it at once:
1. Open the page → it calls `/yield` → the daemon releases the device → you customize over WebHID.
2. While open, the page sends heartbeats and pushes config.
3. Close/refresh the page → it calls `/resume` (or the ~5 s heartbeat watchdog fires) → the daemon
   re-grabs the device and runs your latest config.

Control API (same origin, no CORS): `GET /status`, `POST /yield | /resume | /heartbeat | /config`.

## Run on login (always-on)
```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1   # register (hidden) at logon
wscript "path\to\th108-suite\th108-daemon\start-hidden.vbs"  # start now
powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1 # remove later
```

## Tests
```powershell
npm test   # node --test: hid-transport + server unit tests (no hardware needed)
```

## Notes
- The decorative side/ring/separator LEDs are firmware-controlled and can't be driven from software
  (confirmed) — the daemon controls the **key** LEDs only, same as the browser controller.
- `Fn` never reaches the OS, so it can't be captured for the reactive layer.
- Media/GIF layers are **not** rendered by the daemon yet (use the page for GIF work); all other
  layer types (background, reactive, gradient, patterns) render at full parity.
- ACK-gated streaming: the board ACKs every write (`0x55 …`); the daemon waits for each ACK before
  the next write, which is what keeps its HID pipe from wedging under sustained streaming.
