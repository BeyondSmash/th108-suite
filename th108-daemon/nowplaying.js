// nowplaying.js — the now-playing state machine + sidecar lifecycle.
// Pure part (unit-tested): newState()/decide(state, event, nowMs) — debounce track changes
// (2.5s stability so skip-spam costs ONE upload), pause must hold >5s, dedupe identity+status.
// Impure part: start(opts) spawns media-sidecar.ps1, parses its JSON lines, ticks decide(),
// and on an upload action renders + flashes the frame through the shared upload engine —
// gated so it NEVER uploads while the page owns the device or during a mute episode
// (flash-write safety: see th108-lcd-upload.js header).
const { spawn } = require('child_process');
const path = require('path');
const T = require('./hid-transport.js');
const R = require('./nowplaying-render.js');
const U = require('../th108-lcd-upload.js');

const SETTLE_MS = 2500, PAUSE_HOLD_MS = 5000, FAIL_BACKOFF_MS = 30000;

function newState() { return { pending: null, sinceMs: 0, lastShownKey: null, backoffUntil: 0 }; }
function keyOf(info) { return info.title + '|' + info.artist + '|' + info.status; }

// event = parsed sidecar object or null (timer tick). Returns {upload: info} or null.
function decide(state, event, nowMs) {
  if (event && event.title != null) {
    const k = keyOf(event);
    if (k !== (state.pending && keyOf(state.pending))) { state.pending = event; state.sinceMs = nowMs; }
  }
  if (!state.pending) return null;
  if (nowMs < state.backoffUntil) return null;
  const k = keyOf(state.pending);
  if (k === state.lastShownKey) { state.pending = null; return null; }   // already on screen
  const hold = state.pending.status === 'paused' ? PAUSE_HOLD_MS : SETTLE_MS;
  if (nowMs - state.sinceMs < hold) return null;
  const info = state.pending;
  state.pending = null;
  state.lastShownKey = k;
  return { upload: info };
}

// opts: { isYielded(), isMute(), pauseRender(), resumeRender(), log }
function start(opts) {
  const log = opts.log || function () {};
  const state = newState();
  let proc = null, timer = null, busy = false, stopped = false;
  let lastUploaded = null, gateLogged = false;   // lastUploaded feeds /status.npTrack (the page's Now Playing card)

  function spawnSidecar() {
    if (stopped) return;
    proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'media-sidecar.ps1')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let carry = '';
    proc.stdout.on('data', (d) => {
      carry += d.toString('utf8');
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
        if (!line) continue;
        try { const ev = JSON.parse(line); decide(state, ev, Date.now()); } catch (_) { }
      }
    });
    proc.on('exit', () => { proc = null; if (!stopped) { log('… media sidecar exited — restarting in 10s'); setTimeout(spawnSidecar, 10000); } });
  }

  async function maybeUpload() {
    const act = decide(state, null, Date.now());
    if (!act) return;
    // gates: hand-off safety + an upload already running. A skipped action is re-armed so the
    // next tick retries once conditions clear.
    if (busy || opts.isYielded() || opts.isMute() || (opts.isUnstable && opts.isUnstable())) {
      state.pending = act.upload; state.sinceMs = 0; state.lastShownKey = null;
      if (!gateLogged && opts.isYielded()) { gateLogged = true; log('♪ queued — the page holds the keyboard; the song uploads when the daemon takes over'); }
      return;
    }
    busy = true;
    const t0 = Date.now();
    opts.pauseRender();   // a flash upload can't share the board with the 0x32 stream
    const scr = T.openScreen();
    try {
      if (!scr) { log('now-playing: screen interface not found — will retry on the next change'); state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; return; }
      // FINAL pre-flight: ownership can flip between the tick gate and here — never start a flash
      // write unless the daemon still owns the board (2026-06-12: a yield arrived mid-upload and
      // the page streamed into an active flash-write → hard wedge + typing loss)
      if (opts.isYielded() || opts.isMute()) { state.pending = act.upload; state.sinceMs = 0; state.lastShownKey = null; return; }
      const plan = U.planUpload([R.render(act.upload)]);
      const eng = U.create({ sendChunk: scr.send, onInput: scr.onInput, log, pktLen: 4104 });
      const r = await eng.upload(plan);
      if (r.ok) { lastUploaded = { title: act.upload.title, artist: act.upload.artist, status: act.upload.status }; gateLogged = false; log('♪ now-playing on LCD: "' + act.upload.title + '" (' + act.upload.status + ', ' + plan.totalSize + 'B, ' + (Date.now() - t0) + 'ms)'); }
      else { log('♪ now-playing upload failed: ' + r.error); state.lastShownKey = null; state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; }
    } catch (e) {
      log('♪ now-playing upload error: ' + (e && e.message || e));
      state.lastShownKey = null; state.backoffUntil = Date.now() + FAIL_BACKOFF_MS;
    } finally {
      if (scr) scr.close();
      opts.resumeRender();
      busy = false;
    }
  }

  spawnSidecar();
  timer = setInterval(() => { maybeUpload().catch(() => {}); }, 500);
  log('♪ now-playing enabled — watching the system media session');

  return {
    current() { return lastUploaded; },
    queued() { return !!state.pending; },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (proc) { try { proc.kill(); } catch (_) { } proc = null; }
      log('♪ now-playing disabled');
    },
  };
}

module.exports = { newState, decide, start, SETTLE_MS, PAUSE_HOLD_MS };
