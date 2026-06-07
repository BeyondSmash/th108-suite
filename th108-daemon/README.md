# TH108 Lighting Daemon (always-on, type-anywhere)

Runs the pulsing-cyan + keypress-reactive-orange effect as a background process, so it works in
**any** app — no browser tab, no focus required. Same frame protocol as the browser controller,
but driven by `node-hid` (raw HID) + `uiohook-napi` (system-wide keyboard hook).

## Requirements
- Node.js 18+ (`node -v`).
- Windows build prerequisites are usually **not** needed — `node-hid` and `uiohook-napi` ship
  prebuilt binaries. If `npm install` tries to compile and fails, install the
  [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Desktop C++).
- The keyboard plugged in, and **nothing else streaming to it** (close the browser controller tab
  and the stock software first — only one app should drive the lighting at a time).

## Install & run
```powershell
cd "path\to\th108-suite\th108-daemon"
npm install
npm start
```
You should see `✓ opening "Epomaker_TH108 V2PRO"`, `✓ mapped N keys to LEDs`, then the board starts
breathing cyan and every key you press anywhere flashes orange. **Ctrl+C** stops it and clears the board.

## Tuning (environment variables)
```powershell
$env:PERIOD=2000; $env:BG_MIN=10; $env:BG_MAX=60; $env:FADE=300; `
$env:BG="0,255,255"; $env:KEY="255,140,0"; npm start
```
- `PERIOD` — pulse period in ms (lower = faster breathing)
- `BG_MIN` / `BG_MAX` — background brightness range, 0..1 (e.g. `0.1` / `0.6`)
- `FADE` — key flash fade time in ms
- `BG` / `KEY` — `"R,G,B"` for background and keypress colours

## If some keys don't react
The keypress→LED map is bridged through `uiohook-napi`'s key codes. If a particular key doesn't
light, run in discovery mode and press it — it prints the raw keycode so the map can be fixed:
```powershell
$env:DISCOVER=1; npm start
```
Send me the `· unmapped keycode <n>` numbers for the keys that didn't react.

## Run on login (optional, later)
Once it's dialed in, we can register it to auto-start (Task Scheduler / a tray wrapper) so it's
always on. Ask and I'll add it.

## Notes
- The decorative side/ring/separator LEDs are firmware-controlled and can't be driven from software
  (confirmed) — this daemon controls the **key** LEDs only, same as the browser controller.
- `Fn` can't be captured (it never reaches the OS), so it won't flash.
