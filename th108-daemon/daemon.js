// TH108 V2 PRO background lighting daemon.
// Runs the user's saved controller config (th108-daemon/config.json) always-on in the background,
// rendered host-side by the shared th108-engine.js and streamed over ACK-gated raw HID. A global
// keyboard hook (uiohook-napi) drives the reactive layer in ANY app — no browser tab needed.
// Serves the controller page + a control API on http://localhost:8123; hands the device back to
// the WebHID page when it yields, and re-grabs it on resume / heartbeat timeout.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const E = require('../th108-engine.js');
const T = require('./hid-transport.js');
const U = require('./usb-reset.js');
const { KEYMAP, INDICES, UIOHOOK_TO_CODE } = require('./th108-map.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FPS = 30;
const ts = () => new Date().toTimeString().slice(0, 8);   // timestamped logs — to correlate board mute events with system events
const log = (...a) => console.log(ts(), ...a);

// Tee everything (incl. the server's logs) into th108-daemon/daemon.log — the autostart daemon runs in a
// hidden window, so without a file these logs vanish, and we're hunting recurring spontaneous board-mute
// events whose timestamps need correlating with system/USB activity. ~1 MB cap, one .old generation.
const LOG_PATH = path.join(__dirname, 'daemon.log');
const _clog = console.log.bind(console);
console.log = (...a) => {
  _clog(...a);
  try {
    try { if (fs.statSync(LOG_PATH).size > 1_000_000) { fs.rmSync(LOG_PATH + '.old', { force: true }); fs.renameSync(LOG_PATH, LOG_PATH + '.old'); } } catch {}
    fs.appendFileSync(LOG_PATH, a.join(' ') + '\n');
  } catch {}
};
console.log(ts() + ' ───── daemon start ─────');

// The autostart daemon runs in a hidden window — stderr goes NOWHERE, so an uncaught throw used
// to kill the process with zero trace (2026-06-11: died mid-stream the instant the user flipped
// the keyboard's power switch; last log line was a healthy "board RECOVERED"). Log everything
// fatal, and for the known class (HID handle errors when the device vanishes) keep running —
// closeDevice + the 5s reopen loop is exactly the designed recovery.
process.on('uncaughtException', (err) => {
  console.log(ts() + ' ✗ UNCAUGHT: ' + (err && err.stack || err));
  try { closeDevice(); } catch {}
  nextOpenAt = Date.now() + 5000;
});
process.on('unhandledRejection', (err) => {
  console.log(ts() + ' ✗ UNHANDLED REJECTION: ' + (err && err.stack || err));
  try { closeDevice(); } catch {}
  nextOpenAt = Date.now() + 5000;
});

// ----- config -----
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}

let state = null, device = null, send = null, paused = false, timer = null;
let lcdBusy = false;     // a now-playing flash upload is running — the 0x32 stream must stay quiet
let npBlinkAt = 0;       // timestamp of a throttled-skip → blink the spacebar red twice
const SPACE_K = INDICES.indexOf(KEYMAP['Space']);   // spacebar's slot in the flat frame (for the blink overlay)
let unpausedAt = 0;      // when the daemon last took ownership — flash uploads need STABLE ownership

// ----- daemon settings (separate from config.json, which is the page's layer array verbatim) -----
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
function loadSettings() {
  const DEF = { usbReset: true, nowPlaying: false, npTitle: '#ffffff', npArtist: '#ffd98c', lightsOn: true, brightness: 100, npRevertSec: 0, npAllow: {} };   // npRevertSec 0 = never revert; npAllow = per-source override (absent → Spotify-only default)
  try { return Object.assign({}, DEF, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEF); }   // usbReset default ON — the escalation fails gracefully (one log line) if the task isn't registered
}
let settings = loadSettings();
function saveSettings() { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings)); } catch {} }

// Reload config.json → rebuild engine state. Absent/invalid config → idle (state = null).
function rebuildState() {
  const cfg = loadConfig();
  state = cfg ? E.createState(cfg) : null;
  if (state) state.bri = Math.max(0, Math.min(100, settings.brightness != null ? settings.brightness : 100)) / 100;   // global brightness parity with the page (shared engine reads state.bri)
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
// Global recovery hotkey: Ctrl+Alt+End in ANY app = "my lighting broke — fix it" (user request
// 2026-06-11). Typing keeps flowing through an ACK-mute wedge, so the chord always arrives.
// Action = the proven PnP software replug + a reopen window; ownership then sorts itself out
// (the page rebinds and resumes, or hands back and the daemon drives). Deliberately ignores the
// settings.usbReset toggle — that governs AUTOMATIC restarts, and this is an explicit human ask.
let hotkeyAt = 0;
uIOhook.on('keydown', e => {
  if (e.keycode !== UiohookKey.End || !e.ctrlKey || !e.altKey) return;
  if (Date.now() - hotkeyAt < 15_000) return;   // swallow key-repeat + no replug spam
  hotkeyAt = Date.now();
  log('🔧 recovery hotkey (Ctrl+Alt+End) — PnP-restarting the keyboard; typing drops ~1-2s, lighting returns by itself');
  usbFiredAt = Date.now();
  U.fire(log);
  closeDevice(); nextOpenAt = Date.now() + 3000;   // let the re-enumeration settle, then the tick reopens (when not yielded)
});
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
let probing = false, nextOpenAt = Date.now() + 5000;   // startup grace: a live page's heartbeat needs a beat (≤3s) to park us before we first touch the device
let lastOkAt = 0, streakStart = 0, muteLogged = false, muteAt = 0;   // mute-episode tracking (transition logging)
let usbFiredAt = 0, lastTickAt = 0;   // USB-restart escalation state + sleep-gap detection
let offCleared = false;               // lights-off: the one black frame was sent
let sendingFrame = false;             // a 0x32 frame is mid-flight — closing the device NOW leaves the board's chunk parser desynced
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
      nextOpenAt = Date.now() + 5000;   // cool down — re-probing every tick churns handles against a live streamer, and once raced into a double-open ("backing off" → "device open" 2s later → mute, 2026-06-11 log)
      log(`… another writer on the device (${traffic} reports during probe) — backing off`);
      return;
    }
    device = d;
    send = T.makeSender(device, { ackTimeoutMs: 800 });
    if (!muteLogged) log('✓ device open');   // stay quiet during a mute-retry loop — the MUTE/recovered transition lines tell the story
  } catch { try { if (d) d.close(); } catch {} nextOpenAt = Date.now() + 5000; }
  finally { probing = false; }
}

// ----- render loop ~30fps -----
async function tick() {
  if (paused || lcdBusy) return;   // lcdBusy: a flash upload owns the board — no lighting writes
  // Sleep-gap re-baseline: after a suspend, the pre-sleep muteAt is hours stale — without this the USB
  // restart would insta-fire on the first failed send at wake, even though wake mutes recover on their own.
  const nowWall = Date.now();
  if (lastTickAt && nowWall - lastTickAt > 30_000 && muteLogged) muteAt = nowWall;
  lastTickAt = nowWall;
  await openIfPossible();
  // master lighting switch (header toggle, mirrored here): clear the board once, then stay quiet
  if (!settings.lightsOn) {
    if (device && send && !offCleared) {
      const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0));
      if (await send(off)) offCleared = true;
    }
    return;
  }
  if (device && send && state) {
    const now = performance.now();
    const flat = E.composeFrame(state, now);
    // throttled-skip feedback: blink the SPACEBAR red TWICE when a media command lands inside the
    // safety window (it's queued until the buffer clears). Overlay on the live frame; force-send.
    if (npBlinkAt) {
      const bt = Date.now() - npBlinkAt;
      if (bt >= 0 && bt < 640) {                       // 2 blinks: on [0,160) off [160,320) on [320,480) off [480,640)
        const ph = Math.floor(bt / 160);
        if (ph === 0 || ph === 2) { flat[SPACE_K * 4 + 1] = 255; flat[SPACE_K * 4 + 2] = 0; flat[SPACE_K * 4 + 3] = 0; }
        state.lastFlat = null;                         // force every blink frame out (bust the dedupe)
      } else npBlinkAt = 0;
    }
    if (!E.flatEq(flat, state.lastFlat) || now - state.lastSent >= 1000) {
      sendingFrame = true;
      let ok; try { ok = await send(flat); } finally { sendingFrame = false; }
      if (ok) {
        state.lastFlat = flat; state.lastSent = now;
        if (!lastOkAt || muteLogged) {                     // streaming (re)started — one transition line, with mute duration if recovering
          streakStart = Date.now();
          if (muteLogged) { log(`✓ board RECOVERED — ACKing again (mute lasted ${Math.round((Date.now() - muteAt) / 1000)}s)`); muteLogged = false; }
        }
        lastOkAt = Date.now();
      } else {                  // stall → drop device, retry after a pause (a wedged board stays mute until replug)
        closeDevice(); nextOpenAt = Date.now() + 5000;
        if (paused) return;                                // the "stall" was our own yield closing the device mid-frame — not a board event, don't log MUTE
        if (!muteLogged) {                                 // one transition line per mute episode (the 5s retries stay silent)
          muteLogged = true; muteAt = Date.now();
          log('⚠ board went MUTE — no ACKs (' + (lastOkAt
            ? 'was streaming ' + Math.round((muteAt - streakStart) / 60000) + ' min, last ACK ' + Math.round((muteAt - lastOkAt) / 1000) + 's ago'
            : 'never ACKed since open') + ') — retrying every 5s; USB restart fires at ' + Math.round(U.THRESHOLD_MS / 1000) + 's');
        }
        // Escalation: a PnP restart of the keyboard's USB node = software replug (proven to clear a true
        // wedge). Loud by design — it drops typing ~1-2s, so the log must say exactly when and why.
        if (settings.usbReset && U.shouldFire({ muteAt, now: Date.now(), lastFireAt: usbFiredAt })) {
          usbFiredAt = Date.now();
          log('⚡ ESCALATING: mute has lasted ' + Math.round((usbFiredAt - muteAt) / 1000) + 's — PnP-restarting the keyboard USB device (task "' + U.TASK_NAME + '"); typing drops ~1-2s');
          U.fire(log);
        }
      }
    }
  }
}
timer = setInterval(() => { tick().catch(() => {}); }, Math.round(1000 / FPS));

// ----- autostart = per-user HKCU Run key (NO admin needed, so the daemon can toggle it itself) -----
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', RUN_NAME = 'TH108LightingDaemon';
const RUN_CMD = `wscript.exe "${path.join(__dirname, 'start-tray.vbs')}"`;   // login starts the TRAY, which starts (and supervises via menu) the daemon
function getAutostart() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => execFile('reg', ['query', RUN_KEY, '/v', RUN_NAME], (err) => resolve(!err)));
}
function setAutostart(on) {
  if (process.platform !== 'win32') return Promise.reject(new Error('autostart is Windows-only'));
  const args = on ? ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', RUN_CMD, '/f']
                  : ['delete', RUN_KEY, '/v', RUN_NAME, '/f'];
  return new Promise((resolve, reject) =>
    execFile('reg', args, (err) => (err && on) ? reject(new Error('registry write failed')) : resolve()));
    // deleting an absent value errors — that's "already off", treat as success
}

// ----- standard-GIF mirror: the page pushes its last GIF Screen upload here so now-playing can
// revert to it after a long pause. Stored as JSON {frames:[{d,b64}]} (≤33 frames ≈ ≤1.4 MB). -----
const GIF_PATH = path.join(__dirname, 'standard-lcd.json');
function saveStandardGif(obj) {
  if (!obj || !Array.isArray(obj.frames) || !obj.frames.length || obj.frames.length > 33) return false;
  for (const f of obj.frames) { if (typeof f.b !== 'string' || Buffer.from(f.b, 'base64').length !== 30720) return false; }
  fs.writeFileSync(GIF_PATH, JSON.stringify(obj));
  console.log(ts() + ' [api] standard GIF mirrored (' + obj.frames.length + ' frames) — pause-revert has a target');
  return true;
}
function loadStandardGif() {
  try {
    const o = JSON.parse(fs.readFileSync(GIF_PATH, 'utf8'));
    return o.frames.map(f => ({ bytes: new Uint8Array(Buffer.from(f.b, 'base64')), delayMs: Math.max(20, +f.d || 100) }));
  } catch { return null; }
}

// ----- media-source whitelist (SAFETY: X/Twitter video tabs spamming LCD flash writes softbricked
// the board 2026-06-12). Default = Spotify only; the user can allow others per-source in the UI. -----
const seenSources = new Set();          // every source AUMID observed this run (for the UI list)
function isSourceAllowed(aumid) {
  aumid = aumid || '';
  if (Object.prototype.hasOwnProperty.call(settings.npAllow, aumid)) return !!settings.npAllow[aumid];
  return NP.isSpotifySource(aumid);     // default: only Spotify (desktop "Spotify.exe" / store "SpotifyAB.SpotifyMusic…")
}
function noteSource(aumid) { if (aumid && !seenSources.has(aumid)) { seenSources.add(aumid); console.log(ts() + ' ♪ media source seen: ' + aumid + (isSourceAllowed(aumid) ? ' (allowed)' : ' (blocked)')); } }
function sourceList() {                  // seen ∪ configured, each with its current allow state
  const ids = new Set(seenSources); Object.keys(settings.npAllow).forEach(k => ids.add(k));
  return [...ids].map(id => ({ id, allowed: isSourceAllowed(id) }));
}

// ----- now-playing on the LCD (nowplaying.js: sidecar + state machine + flash upload) -----
const NP = require('./nowplaying.js');
let npHandle = null;
function syncNowPlaying() {
  if (settings.nowPlaying && !npHandle) {
    npHandle = NP.start({
      isYielded: () => paused,
      isMute: () => muteLogged,
      // flash writes need STABLE ownership: the daemon must hold a healthy, recently-ACKing board
      // and must not be fresh off a takeover (handover turbulence muted boards three times today)
      isUnstable: () => !device || (Date.now() - lastOkAt > 3000) || (Date.now() - unpausedAt < 3000),
      pauseRender: () => { lcdBusy = true; },
      resumeRender: () => { lcdBusy = false; },
      getColors: () => ({ title: settings.npTitle, artist: settings.npArtist }),
      getCal: () => settings.npCal || null,   // page-pushed LCD calibration (null → the baked default profile)
      getRevertSec: () => settings.npRevertSec || 0,
      getStandardGif: loadStandardGif,        // the page's last GIF Screen upload, mirrored here
      isSourceAllowed, noteSource,            // SAFETY whitelist: only Spotify drives the LCD by default
      onThrottled: () => { npBlinkAt = Date.now(); },   // a skip landed inside the safety window → spacebar blinks "queued, wait"
      log,
    });
  } else if (!settings.nowPlaying && npHandle) { npHandle.stop(); npHandle = null; }
}
syncNowPlaying();

// ----- control hooks for the server -----
const control = {
  // Release the device for the WebHID page. MUST NOT complete while a flash upload is mid-flight:
  // the page opens the device the moment /yield responds, and streaming 0x32 into a board that is
  // mid-flash-write wedged it hard and cost typing (2026-06-12 incident, "chunk N: no ACK" right
  // after a /yield line). Block the response until the upload finishes (≤ erase window) or 25s.
  async yield() {
    paused = true;   // stops NEW frames; the in-flight one must COMPLETE before we close —
    // closing mid-frame leaves the board's chunk parser waiting for bytes that never come, and
    // the page's first writes then land desynced → no ACKs → onboard fallback (the recurring
    // "refresh + Connect → rainbow" pattern, finally pinned 2026-06-12 17:51)
    const tf = Date.now();
    while (sendingFrame && Date.now() - tf < 1500) await new Promise(r => setTimeout(r, 25));
    closeDevice();
    muteLogged = false;   // a mute episode ends at handoff — a stale flag here vetoed every page-permit upload (live repro 2026-06-12 13:41, endless /npgo "mute")
    const t0 = Date.now();
    while (lcdBusy && Date.now() - t0 < 25000) await new Promise(r => setTimeout(r, 100));
    if (lcdBusy) console.log(ts() + ' ⚠ yield proceeded with a flash upload still busy after 25s — investigate');
  },
  // Reload config (the page may have saved edits) and resume rendering.
  resume() { rebuildState(); paused = false; unpausedAt = Date.now(); },
  // Persist the page's config; refresh live state immediately unless yielded to the page.
  saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg)); if (!paused) rebuildState(); },
  status() { return { running: true, paused, deviceConnected: !!device, fps: FPS, usbReset: settings.usbReset, nowPlaying: settings.nowPlaying,
                      npTrack: npHandle ? npHandle.current() : null, npQueued: npHandle ? npHandle.queued() : false,
                      npTitle: settings.npTitle, npArtist: settings.npArtist,
                      lightsOn: settings.lightsOn, brightness: settings.brightness,
                      npRevertSec: settings.npRevertSec, npHasGif: fs.existsSync(GIF_PATH),
                      npSources: sourceList() }; },
  setNowPlaying(on) { settings.nowPlaying = !!on; saveSettings(); syncNowPlaying(); },
  // page-permit upload path: the heartbeat advertises a pending song; the page pauses its own
  // 0x32 stream and POSTs /npgo, so songs land WITHOUT a device handoff (lighting holds, not off)
  npWants() { return !!(npHandle && paused && !muteLogged && npHandle.ready()); },
  npGo() { return npHandle ? npHandle.uploadNow() : Promise.resolve({ ok: false, reason: 'now-playing off' }); },
  // master lighting switch + global brightness (header controls; the page mirrors them here so the
  // look survives page↔daemon handoffs)
  setLighting(o) {
    if (o && 'on' in o) {
      settings.lightsOn = !!o.on; offCleared = false;
      if (settings.lightsOn) {
        if (state) state.lastFlat = null;            // force a repaint
        closeDevice(); nextOpenAt = 0;               // fresh handle: host silence can leave the board in the ACK-but-ignore state
      }
    }
    if (o && o.brightness != null) {
      settings.brightness = Math.max(0, Math.min(100, Math.round(o.brightness)));
      if (state) { state.bri = settings.brightness / 100; state.lastFlat = null; }   // live, and bust the dedupe so it applies now
    }
    saveSettings();
  },
  setNpColors(title, artist) {   // valid hex only; a change re-paints the current song (one flash write)
    if (/^#[0-9a-f]{6}$/i.test(title || '')) settings.npTitle = title;
    if (/^#[0-9a-f]{6}$/i.test(artist || '')) settings.npArtist = artist;
    saveSettings();
    if (npHandle) npHandle.refresh();
  },
  setNpRevertSec(sec) { settings.npRevertSec = Math.max(0, Math.min(3600, Math.round(+sec || 0))); saveSettings(); },
  setNpSource(id, allow) { if (typeof id === 'string' && id) { settings.npAllow[id] = !!allow; saveSettings(); } },
  saveLcdGif(obj) { try { return saveStandardGif(obj); } catch { return false; } },
  setNpCal(cal) {   // the page's LCD color-correction sliders, mirrored so the art matches GIF uploads
    if (!cal || typeof cal !== 'object') return;
    const clean = {};
    for (const k of Object.keys(cal)) { const v = +cal[k]; if (Number.isFinite(v) && v >= 0 && v <= 300) clean[k] = v; }
    if (!Object.keys(clean).length) return;
    const before = JSON.stringify(settings.npCal || null);
    settings.npCal = clean;
    saveSettings();
    if (npHandle && JSON.stringify(clean) !== before) npHandle.refresh();   // re-paint only on a real change
  },
  // page-initiated escalation: the PAGE drives the device and detected a persistent wedge its own
  // handle-rebinds couldn't clear — fire the same PnP restart the daemon uses, with a cooldown so
  // a stuck page can't replug-loop the keyboard.
  usbFix() {
    if (!settings.usbReset) return { fired: false, reason: 'disabled' };
    if (Date.now() - usbFiredAt < 60_000) return { fired: false, reason: 'cooldown' };
    usbFiredAt = Date.now();
    log('⚡ page requested a USB restart (board wedged while the page was driving) — PnP-restarting the keyboard; typing drops ~1-2s');
    U.fire(log);
    return { fired: true };
  },
  getAutostart, setAutostart,
  setUsbReset(on) { settings.usbReset = !!on; saveSettings(); },
  quit() { shutdown(); },
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
  try { if (npHandle) npHandle.stop(); } catch {}   // kill the sidecar — no orphaned powershell
  try { uIOhook.stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('▶ TH108 daemon running (config:', loadConfig() ? 'loaded' : 'none yet', ')');
