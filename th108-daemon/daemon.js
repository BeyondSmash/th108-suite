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
const OBP = require('../th108-onboard.js');   // packAllled() — build the cmd-0x23 onboard-effect payload (for the "mask onboard flash to black" toggle)
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
let npFlashAt = 0;       // timestamp of a track change → flash the number row (keys 1-0) for 150ms
let barCount = 0, barStepAt = 0;   // ANIMATED lit-key count for the progress-bar (lerps toward target one key per BAR_STEP_MS — a seek visibly counts up/down)
const BAR_STEP_MS = 50, BAR_FADE_MS = 600;   // 50ms per key (the sequential walk) / 600ms idle crossfade-out
const SPACE_K = INDICES.indexOf(KEYMAP['Space']);   // spacebar's slot in the flat frame (for the blink overlay)
// keys 1..0 (the number row) → their slots in the flat frame, for the song-progress light-bar
const DIGIT_KS = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0']
  .map(c => INDICES.indexOf(KEYMAP[c])).filter(k => k >= 0);
// the numpad digits (1-9 then 0) — the bar can MIRROR onto these too (settings.npBarNumpad), filling bottom→top
const NUMPAD_KS = ['Numpad1','Numpad2','Numpad3','Numpad4','Numpad5','Numpad6','Numpad7','Numpad8','Numpad9','Numpad0']
  .map(c => INDICES.indexOf(KEYMAP[c])).filter(k => k >= 0);
const hexRGB = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [17, 255, 0]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// paint the first `lit` keys of `keys` as a progress bar, crossfaded over the frame by `op`. grad:
//   'solid' = flat color | 'toWhite' = fades to white at the leading edge | 'fromWhite' = white at the start, fades to color
function paintBar(flat, keys, lit, op, base, f, grad) {
  const [br, bg, bb] = base;
  for (let i = 0; i < lit && i < keys.length; i++) {
    let b = 0; if (grad && grad !== 'solid' && lit > 1) { const p = i / (lit - 1); b = grad === 'fromWhite' ? 1 - p : p; }
    const r = (br + (255 - br) * b) * f, g = (bg + (255 - bg) * b) * f, bl = (bb + (255 - bb) * b) * f, o = keys[i] * 4;
    flat[o + 1] = (flat[o + 1] * (1 - op) + r) | 0; flat[o + 2] = (flat[o + 2] * (1 - op) + g) | 0; flat[o + 3] = (flat[o + 3] * (1 - op) + bl) | 0;
  }
}
let unpausedAt = 0;      // when the daemon last took ownership — flash uploads need STABLE ownership
let resumeTimer = null;  // pending debounced take-over (see control.resume)
const HANDOFF_SETTLE_MS = 800;   // wait for a handoff burst (restart+refresh, alt-tab) to settle before the daemon re-opens the device — rapid owner-swaps stream 0x32 from alternating owners into the board's chunk parser and wedge it ("never ACKed since open"). 800ms > a refresh's internal burst, short enough to be invisible (board holds its last frame meanwhile, not black).
let framesSent = 0, framesDeduped = 0;   // HID 0x32 stream stats for /metrics (sent vs deduped — shows how much the dedupe is saving)

// ----- daemon settings (separate from config.json, which is the page's layer array verbatim) -----
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
function loadSettings() {
  const DEF = { usbReset: true, nowPlaying: false, npTitle: '#ffffff', npArtist: '#ffd98c', lightsOn: true, brightness: 100, npRevertSec: 0, npAllow: {}, npArtFit: false,
                npBar: false, npBarColor: '#11ff00', npBarBright: 60, npFlash: true, npFlashColor: '#ffd000', npBarIdleSec: 3, npBarGrad: 'solid', npBarNumpad: false, npOnboardMask: false, dimOnDisplayOff: false };   // dimOnDisplayOff = blank the board while the monitor is off on the idle timeout   // npOnboardMask = set the keyboard's onboard effect to BLACK so the per-update flash is a dark blink, not rainbow   // npBarIdleSec = fade the bar out after this long with nothing playing   // npRevertSec 0 = never revert; npAllow = per-source override (absent → Spotify-only default); npBar = the 1-0 song-progress light-bar (lighting-only, no flash writes), npFlash = yellow track-change blip
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
uIOhook.on('keydown', e => { lastKeyAt = Date.now(); if (state) { const i = UIO2IDX[e.keycode]; if (i !== undefined) E.stampKey(state, i); } });
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

// Clear any reactive keys still marked "down". The daemon's one stuck-key path is a uiohook keyup
// dropped under heavy load (the page's brief-blur path is fixed in b252b20). Fired on every fresh
// device handle — reconnect / mute-recovery / onboard cycle, all natural recovery points — so a
// missed keyup can't survive a reopen. Uses releaseKey (a fade-out), NOT rebuildState, so running
// animations and their timers are untouched. (No clean event covers the pure continuous-drive case;
// that trigger was already reduced by the media-sidecar leak fix f78d66b — see th108-reactive-stuck-keys.)
function releaseHeldKeys() {
  if (!state) return;
  const d = state.react.down;
  for (let i = 0; i < d.length; i++) if (d[i]) E.releaseKey(state, i);
}

// Write a single onboard-effect packet (cmd 0x23, 16-byte allled) on the control interface, then cycle
// the handle (a live 0x23 leaves the board ACKing-but-IGNORING 0x32 paint). Pauses the 0x32 stream while
// it writes — same protocol-safety stance as an LCD flash. Returns false if we don't own a healthy board.
async function sendOnboard(allled) {
  if (!device || paused || muteLogged) return false;
  const prevBusy = lcdBusy; lcdBusy = true;                       // hold the 0x32 stream off while we write 0x23
  const t0 = Date.now(); while (sendingFrame && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 20));
  try {
    const pkt = Buffer.alloc(64);
    pkt[0] = 0xAA; pkt[1] = 0x23; pkt[2] = 16; pkt[6] = 1;        // header: marker, cmd, len, last=1 (offset 0)
    for (let i = 0; i < 16; i++) pkt[8 + i] = allled[i];
    device.write([0x00, ...pkt]);                                // leading reportId 0 (Windows)
    await new Promise(r => setTimeout(r, 350));                  // let the 0x23 ACK land (mirrors the page)
  } catch { lcdBusy = prevBusy; return false; }
  closeDevice(); nextOpenAt = 0;                                 // cure: fresh handle so 0x32 paints again
  if (state) state.lastFlat = null;                             // force a repaint on the reopened handle
  lcdBusy = prevBusy;
  return true;
}

// Try to (re)open the control interface when we have none and aren't paused.
// PROBE BEFORE WRITING (defense in depth for the single-writer rule): Windows HID opens are SHARED,
// so nothing at the OS level stops daemon + page from both holding the device. Listen ~1.5s on the
// fresh handle first — unsolicited 0x55 ACK traffic means a live page is streaming (its yield expired
// but it's still there); writing too would wedge the board. Back off and re-probe on a later tick.
let probing = false, nextOpenAt = Date.now() + 5000;   // startup grace: a live page's heartbeat needs a beat (≤3s) to park us before we first touch the device
let lastOkAt = 0, streakStart = 0, muteLogged = false, muteAt = 0;   // mute-episode tracking (transition logging)
let usbFiredAt = 0, lastTickAt = 0;   // USB-restart escalation state + sleep-gap detection
let lastKeyAt = Date.now();           // last physical keypress (from the global hook) — drives the idle-aware USB-restart threshold
let offCleared = false;               // lights-off / display-off: the one black frame was sent
let displayOff = false;               // monitor is off on the idle timeout (from display-watch.ps1) → blank the board
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
    releaseHeldKeys();   // fresh handle = a recovery point: drop any key a missed keyup left stuck
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
  // board goes dark when the master switch is off OR (opt-in) while the monitor is off on the idle timeout:
  // clear it once, then stay quiet until it should light again.
  if (!settings.lightsOn || displayOff) {
    if (device && send && !offCleared) {
      const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0));
      if (await send(off)) offCleared = true;
    }
    return;
  }
  if (device && send && state) {
    const now = performance.now();
    if (acHandle) {   // fold the latest real-audio frame into state.audio (>250ms stale → null → engine decays to silence)
      const raw = AC.freshOr(acHandle.latest(), Date.now(), 250);
      const aL = state.layers.find(L => L.enabled && L.type === 'audio');
      // On stale (capture stalled on pause) feed a SILENT frame instead of skipping — skipping froze the bars
      // and ran the fast decay for the first 250ms; feeding {live:0} lets pause-decay settle them to 0 evenly.
      if (aL) E.applyAudioFeatures(state, raw || { level: 0, live: 0 }, aL.settings, now);
    }
    const flat = E.composeFrame(state, now);
    // throttled-skip feedback: blink the SPACEBAR red TWICE when a media command lands inside the
    // safety window (it's queued until the buffer clears). Overlaid on the live frame — flatEq below
    // sends only on each phase change (on↔off), so static frames still idle to the 1fps keepalive.
    if (npBlinkAt) {
      const bt = Date.now() - npBlinkAt;
      if (bt >= 0 && bt < 640) {                       // 2 blinks: on [0,160) off [160,320) on [320,480) off [480,640)
        const ph = Math.floor(bt / 160);
        if (ph === 0 || ph === 2) { flat[SPACE_K * 4 + 1] = 255; flat[SPACE_K * 4 + 2] = 0; flat[SPACE_K * 4 + 3] = 0; }
      } else npBlinkAt = 0;
    }
    // song-progress light-bar on the number row (keys 1-0): light the first N of 10 keys in the bar
    // color to show how far through the song we are. SAFE — lighting only, no LCD flash writes. The
    // yellow track-change flash (150ms, all 10) rides the same toggle, gated by its own on/off.
    if (settings.npBar && npHandle && DIGIT_KS.length) {
      const ms = npHandle.mediaState();
      // idle crossfade: nothing playing for npBarIdleSec → fade the bar out (reveal the lighting beneath)
      let op = 1;
      if (ms.hasMedia && !ms.playing) {
        const idleSec = settings.npBarIdleSec == null ? 3 : settings.npBarIdleSec;
        const over = (ms.idleMs || 0) - idleSec * 1000;
        if (over > 0) op = Math.max(0, 1 - over / BAR_FADE_MS);
      }
      if (ms.hasMedia && op > 0) {
        const [br, bg, bb] = hexRGB(settings.npBarColor);
        const f = (Math.max(0, Math.min(100, settings.npBarBright == null ? 60 : settings.npBarBright)) / 100) * op;
        // sequential lerp: walk the lit-key count toward the target ONE key per BAR_STEP_MS, so a seek
        // (e.g. 73% → 24%) visibly counts down rather than snapping. Normal playback advances 1 step
        // every ~(song/10)s, so it just keeps pace.
        const target = Math.round(ms.progress * DIGIT_KS.length);
        const nowMs = Date.now();
        if (barCount !== target && nowMs - barStepAt >= BAR_STEP_MS) { barCount += Math.sign(target - barCount); barStepAt = nowMs; }
        // crossfade the bar OVER the underlying lighting (op<1 mid-fade); mirror onto the numpad when enabled
        paintBar(flat, DIGIT_KS, barCount, op, [br, bg, bb], f, settings.npBarGrad);
        if (settings.npBarNumpad) paintBar(flat, NUMPAD_KS, barCount, op, [br, bg, bb], f, settings.npBarGrad);
        // NO lastFlat reset: flatEq below catches a step/fade change and sends it; a STATIC bar over
        // static lighting stays equal → idles to the 1fps keepalive instead of forcing 30fps.
      } else if (!ms.hasMedia) { barCount = 0; }   // media gone → next song fills from empty
      if (npFlashAt && settings.npFlash) {
        const ft = Date.now() - npFlashAt;
        if (ft >= 0 && ft < 150) { const [fr, fg, fb] = hexRGB(settings.npFlashColor); const fks = settings.npBarNumpad ? DIGIT_KS.concat(NUMPAD_KS) : DIGIT_KS; for (const k of fks) { const o = k * 4; flat[o + 1] = fr; flat[o + 2] = fg; flat[o + 3] = fb; } }   // flatEq sends the flash on its on/off edges
        else if (ft >= 150) npFlashAt = 0;
      } else if (npFlashAt && !settings.npFlash) npFlashAt = 0;
    }
    if (!E.flatEq(flat, state.lastFlat) || now - state.lastSent >= 1000) {
      sendingFrame = true;
      let ok; try { ok = await send(flat); } finally { sendingFrame = false; }
      if (ok) {
        framesSent++;
        state.lastFlat = flat; state.lastSent = now;
        if (!lastOkAt || muteLogged) {                     // streaming (re)started — one transition line, with mute duration if recovering
          streakStart = Date.now();
          if (muteLogged) { log(`✓ board RECOVERED — ACKing again (mute lasted ${Math.round((Date.now() - muteAt) / 1000)}s)`); muteLogged = false; }
        }
        lastOkAt = Date.now();
      } else {                  // stall → drop device, retry after a pause (a wedged board stays mute until replug)
        const trace = (send && send.flightRecorder) ? send.flightRecorder() : null;   // grab BEFORE closeDevice() nulls send — this is the pre-silence trace
        closeDevice(); nextOpenAt = Date.now() + 5000;
        if (paused) return;                                // the "stall" was our own yield closing the device mid-frame — not a board event, don't log MUTE
        if (!muteLogged) {                                 // one transition line per mute episode (the 5s retries stay silent)
          muteLogged = true; muteAt = Date.now();
          log('⚠ board went MUTE — no ACKs (' + (lastOkAt
            ? 'was streaming ' + Math.round((muteAt - streakStart) / 60000) + ' min, last ACK ' + Math.round((muteAt - lastOkAt) / 1000) + 's ago'
            : 'never ACKed since open') + ') — retrying every 5s; USB restart fires at ' + Math.round(U.IDLE_THRESHOLD_MS / 1000) + 's if AFK, ' + Math.round(U.THRESHOLD_MS / 1000) + 's while typing');
          if (trace) log('   ↳ flight recorder (last input reports + writes before silence):\n' + trace);
        }
        // Escalation: a PnP restart of the keyboard's USB node = software replug (proven to clear a true
        // wedge). Loud by design — it drops typing ~1-2s, so the log must say exactly when and why.
        // Idle-aware threshold: a USB restart costs a ~1-2s typing dropout, so wait the full 30s while you're
        // actively typing — but if you've been AFK (no keypress for IDLE_AFTER_MS) the dropout is free, so
        // recover the lighting much sooner (IDLE_THRESHOLD_MS). lastKeyAt comes from the global key hook.
        const afk = Date.now() - lastKeyAt > U.IDLE_AFTER_MS;
        const thresholdMs = afk ? U.IDLE_THRESHOLD_MS : U.THRESHOLD_MS;
        if (settings.usbReset && U.shouldFire({ muteAt, now: Date.now(), lastFireAt: usbFiredAt, thresholdMs })) {
          usbFiredAt = Date.now();
          log('⚡ ESCALATING: mute has lasted ' + Math.round((usbFiredAt - muteAt) / 1000) + 's (' + (afk ? 'AFK — recovering early' : 'actively typing') + ') — PnP-restarting the keyboard USB device (task "' + U.TASK_NAME + '"); typing drops ~1-2s');
          U.fire(log);
        }
      }
    } else framesDeduped++;   // frame identical to the last + inside the keepalive window → skipped (the dedupe idling static lighting to ~1fps)
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

// ----- th108:// URL protocol (HKCU, no admin) — lets the controller page start/restart us via a link.
// Self-registered on startup so the path self-heals if the folder moves; idempotent (reg add /f). The
// dispatcher (th108-url.vbs) only honors fixed "start"/"restart" words, so a stray th108:// link is safe. -----
function registerUrlScheme() {
  if (process.platform !== 'win32') return;
  const ROOT = 'HKCU\\Software\\Classes\\th108';
  const cmd = `wscript.exe "${path.join(__dirname, 'th108-url.vbs')}" "%1"`;
  const steps = [
    ['add', ROOT, '/ve', '/d', 'URL:TH108 Lighting Protocol', '/f'],
    ['add', ROOT, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', ROOT + '\\shell\\open\\command', '/ve', '/d', cmd, '/f'],
  ];
  let i = 0;
  const next = () => {
    if (i >= steps.length) { console.log(ts() + ' ✓ th108:// protocol registered (page Start/Restart links work)'); return; }
    execFile('reg', steps[i++], { windowsHide: true }, (err) => { if (err) console.log(ts() + ' … th108:// scheme registration step failed (non-fatal): ' + err.message); else next(); });
  };
  next();
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
  const wantSidecar = settings.nowPlaying || settings.npBar;   // the bar needs the sidecar's media position too — run it, but with LCD writes gated off
  if (wantSidecar && !npHandle) {
    npHandle = NP.start({
      lcdEnabled: () => settings.nowPlaying,   // bar-only (nowPlaying off) → sidecar runs for the progress-bar, but NO LCD flash writes
      onTrackChange: () => { npFlashAt = Date.now(); },   // new song → yellow flash on the number row (150ms)
      isYielded: () => paused,
      isMute: () => muteLogged,
      // flash writes need STABLE ownership: the daemon must hold a healthy, recently-ACKing board
      // and must not be fresh off a takeover (handover turbulence muted boards three times today)
      isUnstable: () => !device || (Date.now() - lastOkAt > 3000) || (Date.now() - unpausedAt < 3000),
      // PARK the key lighting to BLACK right before the flash, then RESUME (force-repaint) right after.
      // The board reclaims to its onboard startup-animation when the host goes silent mid-effect; a clean
      // "all-off" command parks it dark (a lights-out blink the user accepts) instead, and the forced
      // repaint re-asserts custom lighting the instant the flash ends (not after the 1s keepalive).
      pauseRender: async () => {
        lcdBusy = true;
        try {
          if (device && send) {
            const t0 = Date.now(); while (sendingFrame && Date.now() - t0 < 500) await new Promise(r => setTimeout(r, 10));   // let any in-flight frame finish
            const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0));
            sendingFrame = true; try { await send(off); } finally { sendingFrame = false; }
            if (state) state.lastFlat = null;   // so the post-flash repaint is guaranteed to differ from this black frame
          }
        } catch {}
      },
      resumeRender: () => { lcdBusy = false; if (state) state.lastFlat = null; },   // force an immediate repaint — re-assert lighting at once
      getColors: () => ({ title: settings.npTitle, artist: settings.npArtist }),
      getFit: () => !!settings.npArtFit,       // album-art style: true = Fit (letterbox the whole cover), false = Crop (fill+crop)
      getCal: () => settings.npCal || null,   // page-pushed LCD calibration (null → the baked default profile)
      getRevertSec: () => settings.npRevertSec || 0,
      getStandardGif: loadStandardGif,        // the page's last GIF Screen upload, mirrored here
      isSourceAllowed, noteSource,            // SAFETY whitelist: only Spotify drives the LCD by default
      onThrottled: () => { npBlinkAt = Date.now(); },   // a skip landed inside the safety window → spacebar blinks "queued, wait"
      log,
    });
  } else if (!wantSidecar && npHandle) { npHandle.stop(); npHandle = null; }
}
syncNowPlaying();

// ----- real audio capture (audio-capture.js: WASAPI loopback sidecar → state.audio) -----
const AC = require('./audio-capture.js');
let acHandle = null, acKey = null;
// What capture does the active config want? null = none; else {key, app?}. The daemon handles 'system'
// (WASAPI loopback) and 'app' (process-loopback); 'tab'/'mic' are page-only. NOTE: NOT gated on `paused` —
// audio capture is independent of the HID device, so we keep capturing while the page drives so the page can
// poll /audio/frame for its preview + to drive the keys with real system/app audio (else it'd be blank/synth).
function audioCfg() {
  if (!state) return null;
  const aL = state.layers.find(L => L.enabled && L.type === 'audio');
  if (!aL) return null;
  const s = aL.settings || {};
  if (s.source === 'app' && s.appId) return { key: 'app:' + s.appId, app: s.appId };
  if (s.source === 'tab' || s.source === 'mic') return null;   // page captures these in-tab
  return { key: 'system' };
}
function syncAudioCapture() {
  const cfg = audioCfg();
  if (cfg && acKey !== cfg.key) {                                   // (re)start when the target changes (system↔app, or a new app)
    if (acHandle) { acHandle.stop(); acHandle = null; }
    acHandle = AC.start({ log, app: cfg.app });
    acKey = cfg.key;
    log('♪ audio capture started (' + (cfg.app ? 'app: ' + cfg.app : 'system loopback') + ')');
  } else if (!cfg && acHandle) {
    acHandle.stop(); acHandle = null; acKey = null; log('♪ audio capture stopped');
  }
}
syncAudioCapture();

// ----- display-off watcher: blank the board while the monitor is off on the idle timeout (opt-in) -----
const { spawn: _spawn } = require('child_process');
let dwProc = null;
function syncDisplayWatch() {
  const want = !!settings.dimOnDisplayOff;
  if (want && !dwProc) {
    const start = () => {
      dwProc = _spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'display-watch.ps1')],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let carry = '';
      dwProc.stdout.on('data', d => { carry += d.toString('utf8'); let i;
        while ((i = carry.indexOf('\n')) >= 0) { const s = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
          if (s === 'off' && !displayOff) { displayOff = true; log('🌒 monitor off (idle) — blanking the board'); }
          else if ((s === 'on' || s === 'dim') && displayOff) { displayOff = false; offCleared = false; if (state) state.lastFlat = null; nextOpenAt = 0; log('🌞 monitor on — restoring lighting'); }
        } });
      dwProc.on('exit', () => { dwProc = null; if (settings.dimOnDisplayOff) setTimeout(() => { if (settings.dimOnDisplayOff) start(); }, 3000); });
    };
    start();
  } else if (!want && dwProc) {
    const p = dwProc; dwProc = null; try { p.kill(); } catch {}
    if (displayOff) { displayOff = false; offCleared = false; if (state) state.lastFlat = null; }   // turning the feature off un-blanks
  }
}
syncDisplayWatch();

// ----- control hooks for the server -----
const control = {
  // Release the device for the WebHID page. MUST NOT complete while a flash upload is mid-flight:
  // the page opens the device the moment /yield responds, and streaming 0x32 into a board that is
  // mid-flash-write wedged it hard and cost typing (2026-06-12 incident, "chunk N: no ACK" right
  // after a /yield line). Block the response until the upload finishes (≤ erase window) or 25s.
  async yield() {
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }   // a pending take-over is cancelled by a yield — the page wants the device again. This is half of the handoff-burst coalesce: resume→yield nets to nothing here, so a restart/refresh storm never opens-then-closes.
    paused = true; syncAudioCapture();   // stop capturing while the page drives (audioWanted()==false when paused)
    // stops NEW frames; the in-flight one must COMPLETE before we close —
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
  // Reload config (the page may have saved edits) and resume rendering — but DEBOUNCED: don't grab the
  // device until the handoff has been quiet for HANDOFF_SETTLE_MS. A burst of /resume/yield (restart+
  // refresh, alt-tabbing) thus resolves to ONE clean open instead of a thrash that wedges the board. A
  // /yield arriving first cancels the pending take-over (see yield()). Idempotent: repeated resumes in a
  // burst just reset the timer.
  resume() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null; rebuildState(); paused = false; unpausedAt = Date.now(); syncAudioCapture();
    }, HANDOFF_SETTLE_MS);
  },
  // Persist the page's config; refresh live state immediately unless yielded to the page.
  saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    if (!paused) { state = E.applyConfig(state, cfg);   // in-place on a settings edit → no animation reset; rebuilds only on a structural change
      if (state) state.bri = Math.max(0, Math.min(100, settings.brightness != null ? settings.brightness : 100)) / 100; }
    syncAudioCapture(); },   // an edit that enables/disables the audio layer starts/stops capture live
  // List currently-playing audio apps for the page's "Specific app" picker (one-shot app-capture.exe --list).
  listAudioApps() { return new Promise(r => AC.listApps((_e, arr) => r(arr))); },
  // Latest captured audio frame (system/app) so the open page can preview it + drive the keys in real time.
  audioFrame() { return acHandle ? AC.freshOr(acHandle.latest(), Date.now(), 300) : null; },
  // Current media position so the open page can draw the song-progress bar itself while it drives the device.
  npPos() { return npHandle ? npHandle.mediaState() : null; },
  status() { return { running: true, paused, deviceConnected: !!device, fps: FPS, setupPath: path.resolve(__dirname, '..', 'setup.cmd'), usbReset: settings.usbReset, dimOnDisplayOff: settings.dimOnDisplayOff, nowPlaying: settings.nowPlaying,
                      npTrack: npHandle ? npHandle.current() : null, npQueued: npHandle ? npHandle.queued() : false,
                      npHealth: npHandle ? npHandle.health() : null,
                      npLog: npHandle ? npHandle.recent() : [],
                      npTitle: settings.npTitle, npArtist: settings.npArtist, npArtFit: settings.npArtFit,
                      lightsOn: settings.lightsOn, brightness: settings.brightness,
                      npRevertSec: settings.npRevertSec, npHasGif: fs.existsSync(GIF_PATH),
                      npSources: sourceList(),
                      npBar: settings.npBar, npBarColor: settings.npBarColor, npBarBright: settings.npBarBright,
                      npFlash: settings.npFlash, npFlashColor: settings.npFlashColor, npBarIdleSec: settings.npBarIdleSec,
                      npBarGrad: settings.npBarGrad, npBarNumpad: settings.npBarNumpad,
                      npOnboardMask: settings.npOnboardMask }; },
  setNowPlaying(on) {
    const was = settings.nowPlaying;
    settings.nowPlaying = !!on; saveSettings();
    let revert = null;
    if (was && !on && npHandle) revert = npHandle.revertNow();   // turning OFF → restore the standard GIF (fast gate-check; the upload fires async). revert.reason explains a no-op
    syncNowPlaying();
    return { revert };
  },
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
  setNpArtFit(on) {   // album-art style Crop⇄Fit — re-paints the current song (one flash write)
    const before = !!settings.npArtFit; settings.npArtFit = !!on; saveSettings();
    if (npHandle && before !== settings.npArtFit) npHandle.refresh();
  },
  // song-progress light-bar (keys 1-0) + yellow track-change flash — SAFE (lighting only, no flash writes)
  setNpBar(o) {
    if (o && 'on' in o) settings.npBar = !!o.on;
    if (o && o.color != null && /^#[0-9a-f]{6}$/i.test(o.color)) settings.npBarColor = o.color;
    if (o && o.bright != null) settings.npBarBright = Math.max(0, Math.min(100, Math.round(+o.bright || 0)));
    if (o && 'flash' in o) settings.npFlash = !!o.flash;
    if (o && o.flashColor != null && /^#[0-9a-f]{6}$/i.test(o.flashColor)) settings.npFlashColor = o.flashColor;
    if (o && o.idleSec != null) settings.npBarIdleSec = Math.max(0, Math.min(60, Math.round(+o.idleSec || 0)));
    if (o && o.grad != null && ['solid', 'toWhite', 'fromWhite'].includes(o.grad)) settings.npBarGrad = o.grad;
    if (o && 'numpad' in o) settings.npBarNumpad = !!o.numpad;
    saveSettings();
    syncNowPlaying();   // toggling the bar may need to start/stop the media sidecar
    if (state) state.lastFlat = null;   // repaint now
  },
  npRefresh() { return npHandle ? npHandle.forceUpload() : Promise.resolve({ ok: false, reason: 'now-playing off' }); },   // DEBUG "Refresh LCD" — force-repaint the live song now
  // "Mask onboard flash to black": write the keyboard's onboard EFFECT (persistent cmd 0x23) to a solid
  // black so when the board reclaims to onboard during an LCD flash it shows a dark blink, not rainbow.
  // Mirrors th108-onboard.js's proven page sequence (write 0x23 → settle → cycle the handle, since a live
  // 0x23 leaves the board ACKing-but-IGNORING 0x32 paint). Best-effort; needs the daemon to own the board.
  async setOnboardMask(on) {
    settings.npOnboardMask = !!on; saveSettings();
    const allled = on
      ? OBP.packAllled({ effect: 1, primary: [0, 0, 0], secondary: [0, 0, 0], colorful: false, brightness: 1, speed: 1 })       // Static Bright + black = off
      : OBP.packAllled({ effect: 11, primary: [255, 0, 0], secondary: [0, 0, 255], colorful: true, brightness: 4, speed: 3 });  // restore a visible flowing-rainbow default
    const ok = await sendOnboard(allled);
    log(ok ? ('♪ onboard mask ' + (on ? 'ON — onboard set to BLACK (LCD flash now a dark blink)' : 'OFF — onboard restored to a colorful default'))
           : '♪ onboard mask could not apply — the daemon must be driving a healthy board (not yielded/muted)');
    return { ok, reason: ok ? undefined : 'daemon not driving the board' };
  },
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
  // HID/now-playing diagnostics for /metrics — pairs with the server's per-endpoint rates
  metrics() {
    const sec = Math.max(1, Math.round(process.uptime()));
    return {
      uptimeSec: sec, paused, deviceConnected: !!device, fps: FPS,
      framesSent, framesDeduped, framesSentPerSec: +(framesSent / sec).toFixed(2),
      dedupeRatio: framesSent + framesDeduped ? +(framesDeduped / (framesSent + framesDeduped)).toFixed(2) : 0,
      np: npHandle ? npHandle.health() : null,
    };
  },
  setUsbReset(on) { settings.usbReset = !!on; saveSettings(); },
  setDimOnDisplayOff(on) { settings.dimOnDisplayOff = !!on; saveSettings(); syncDisplayWatch(); },
  quit() { shutdown(0); },
  restart() { shutdown(42); },   // exit non-zero so start-hidden.vbs's supervisor revives us (clean exit 0 would STOP supervision — that's why /quit needs a manual Start)
};
module.exports = { control };

// ----- server (static page + control API) -----
const { createServer } = require('./server.js');
const server = createServer({ control, root: path.join(__dirname, '..'), port: 8123 });
server.listening.then(() => console.log(`✓ serving controller + control API on http://localhost:${server.port}`));

// ----- clean shutdown: black-out the board, release hook -----
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  try { clearInterval(timer); } catch {}
  // FREE PORT 8123 FIRST. A wedged/muted board can make the HID cleanup below block (node-hid write/close
  // are synchronous native calls), and if that hangs while the port is still held, the supervisor's revived
  // instance hits EADDRINUSE and the daemon never comes back — the "Restart did nothing" port-squat
  // (diagnosed 2026-06-20: a /restart hung after 'now-playing disabled', pid kept :8123). Releasing the
  // listener up front means even a hung cleanup can't squat the port.
  try { server.close(); } catch {}
  // KILL CHILD PROCESSES NEXT, before any HID/hook cleanup. The device.close()/uIOhook.stop() calls below are
  // synchronous native calls that can BLOCK on a wedged board; if they hang while the capture sidecars are
  // still alive, those sidecars orphan and auto-respawn → zombie daemons pile up across restarts, each holding
  // its own (possibly wrong-source) capture (the 2026-06-21 multi-daemon / kick.com-bleed mess). Reaping the
  // children first guarantees no orphans even if the cleanup below hangs.
  try { if (npHandle) npHandle.stop(); } catch {}   // kill the now-playing sidecar
  try { if (acHandle) acHandle.stop(); } catch {}   // kill the audio-capture sidecar (app-capture.exe / audio-sidecar.ps1)
  try { if (dwProc) dwProc.kill(); } catch {}        // kill the display-off watcher
  try { if (device && send && !muteLogged) { const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0)); send(off); } } catch {}   // best-effort blackout (fire-and-forget; skip on a muted board)
  setTimeout(() => process.exit(code), 1500).unref();   // backstop
  // These can block on a wedged board — do them LAST. The OS releases the HID handle + global hook on exit
  // anyway, so a hang here can't orphan anything (port + children already cleaned).
  try { if (device) device.close(); } catch {}
  try { uIOhook.stop(); } catch {}
  process.exit(code);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

registerUrlScheme();   // make th108://start | th108://restart links work from the controller page
console.log('▶ TH108 daemon running (config:', loadConfig() ? 'loaded' : 'none yet', ')');
