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
// PROBE BEFORE WRITING (defense in depth for the single-writer rule): Windows HID opens are SHARED,
// so nothing at the OS level stops daemon + page from both holding the device. Listen ~1.5s on the
// fresh handle first — unsolicited 0x55 ACK traffic means a live page is streaming (its yield expired
// but it's still there); writing too would wedge the board. Back off and re-probe on a later tick.
let probing = false, nextOpenAt = 0;
async function openIfPossible() {
  if (device || paused || probing) return;
  if (Date.now() < nextOpenAt) return;   // backoff after a mute/failed device — no 2s open/close churn against a wedged board
  const p = T.findPath();
  if (!p) return;
  probing = true;
  let d = null;
  try {
    d = T.openDevice(p);
    const traffic = await T.probeTraffic(d, 1500);
    if (paused) { try { d.close(); } catch {} return; }   // yielded mid-probe — hand it straight back
    if (traffic > 0) {
      try { d.close(); } catch {}
      console.log(`… another writer on the device (${traffic} reports during probe) — backing off`);
      return;
    }
    device = d;
    send = T.makeSender(device, { ackTimeoutMs: 800 });
    console.log('✓ device open');
  } catch { try { if (d) d.close(); } catch {} nextOpenAt = Date.now() + 5000; }
  finally { probing = false; }
}

// ----- render loop ~30fps -----
async function tick() {
  if (paused) return;
  await openIfPossible();
  if (device && send && state) {
    const now = performance.now();
    const flat = E.composeFrame(state, now);
    if (!E.flatEq(flat, state.lastFlat) || now - state.lastSent >= 1000) {
      const ok = await send(flat);
      if (ok) { state.lastFlat = flat; state.lastSent = now; }
      else {                    // stall → drop device, retry after a pause (a wedged board stays mute until replug)
        closeDevice(); nextOpenAt = Date.now() + 5000;
        console.log('… board not ACKing — retrying in 5s (replug clears a wedged board)');
      }
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
