// TH108 V2 PRO background lighting daemon.
// Runs the user's saved controller config (th108-daemon/config.json) always-on in the background,
// rendered host-side by the shared th108-engine.js and streamed over ACK-gated raw HID. A global
// keyboard hook (uiohook-napi) drives the reactive layer in ANY app — no browser tab needed.
// Serves the controller page + a control API on http://localhost:8123; hands the device back to
// the WebHID page when it yields, and re-grabs it on resume / heartbeat timeout.

const fs = require('fs');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const E = require('../th108-engine.js');
const T = require('./hid-transport.js');
const { KEYMAP, INDICES, UIOHOOK_TO_CODE } = require('./th108-map.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FPS = 30;

// ----- config -----
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}

let state = null, device = null, send = null, paused = false, timer = null;

// Reload config.json → rebuild engine state. Absent/invalid config → idle (state = null).
function rebuildState() {
  const cfg = loadConfig();
  state = cfg ? E.createState(cfg) : null;
}
rebuildState();

// ----- global keyboard hook: uiohook keycode -> LED index -----
// UIOHOOK_TO_CODE: UiohookKey property name -> KeyboardEvent.code; KEYMAP: code -> LED index.
const UIO2IDX = {};
for (const [name, code] of Object.entries(UIOHOOK_TO_CODE)) {
  const kc = UiohookKey[name], idx = KEYMAP[code];
  if (kc !== undefined && idx !== undefined) UIO2IDX[kc] = idx;
}
uIOhook.on('keydown', e => { if (state) { const i = UIO2IDX[e.keycode]; if (i !== undefined) E.stampKey(state, i); } });
uIOhook.on('keyup',   e => { if (state) { const i = UIO2IDX[e.keycode]; if (i !== undefined) E.releaseKey(state, i); } });
uIOhook.start();

// ----- device lifecycle -----
function closeDevice() {
  if (device) { try { device.close(); } catch {} }
  device = null; send = null;
}

// Try to (re)open the control interface when we have none and aren't paused.
function openIfPossible() {
  if (device || paused) return;
  const p = T.findPath();
  if (!p) return;
  try {
    device = T.openDevice(p);
    send = T.makeSender(device, { ackTimeoutMs: 800 });
    console.log('✓ device open');
  } catch {
    closeDevice();
  }
}

// ----- render loop ~30fps -----
async function tick() {
  if (paused) return;
  openIfPossible();
  if (device && send && state) {
    const now = performance.now();
    const flat = E.composeFrame(state, now);
    if (!E.flatEq(flat, state.lastFlat) || now - state.lastSent >= 1000) {
      const ok = await send(flat);
      if (ok) { state.lastFlat = flat; state.lastSent = now; }
      else { closeDevice(); }   // stall → drop device, reconnect next tick
    }
  }
}
timer = setInterval(() => { tick().catch(() => {}); }, Math.round(1000 / FPS));

// ----- control hooks for the server -----
const control = {
  // Release the device for the WebHID page.
  yield() { paused = true; closeDevice(); },
  // Reload config (the page may have saved edits) and resume rendering.
  resume() { rebuildState(); paused = false; },
  // Persist the page's config; refresh live state immediately unless yielded to the page.
  saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg)); if (!paused) rebuildState(); },
  status() { return { running: true, paused, deviceConnected: !!device, fps: FPS }; },
};
module.exports = { control };

// ----- server (static page + control API) -----
const { createServer } = require('./server.js');
const server = createServer({ control, root: path.join(__dirname, '..'), port: 8123 });
server.listening.then(() => console.log(`✓ serving controller + control API on http://localhost:${server.port}`));

// ----- clean shutdown: black-out the board, release hook -----
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  try { clearInterval(timer); } catch {}
  try {
    if (device) {
      const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0));
      if (send) send(off);
      device.close();
    }
  } catch {}
  try { uIOhook.stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('▶ TH108 daemon running (config:', loadConfig() ? 'loaded' : 'none yet', ')');
