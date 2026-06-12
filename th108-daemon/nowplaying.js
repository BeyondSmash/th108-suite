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
const MIN_GAP_MS = 5000;      // never two flash writes back-to-back (skip-chains wedged the board)
const EVENT_QUIET_MS = 1200;  // no page-permit uploads right after a track event — a skip makes the queued song stale

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
  let lastInfo = null;                           // full last event incl. thumb — re-rendered when the user changes text colors
  let lastUploadAt = 0, lastEventAt = 0;         // MIN_GAP / EVENT_QUIET gates

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
        try { const ev = JSON.parse(line); lastInfo = ev; lastEventAt = Date.now(); decide(state, ev, Date.now()); } catch (_) { }
      }
    });
    proc.on('exit', () => { proc = null; if (!stopped) { log('… media sidecar exited — restarting in 10s'); setTimeout(spawnSidecar, 10000); } });
  }

  // the actual flash write — callers have already settled ownership/stream questions
  async function doUpload(act) {
    busy = true;
    lastUploadAt = Date.now();
    const t0 = Date.now();
    opts.pauseRender();   // a flash upload can't share the board with the 0x32 stream
    const scr = T.openScreen();
    try {
      if (!scr) { log('now-playing: screen interface not found — will retry on the next change'); state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; return { ok: false }; }
      const plan = U.planUpload([R.render(act.upload, opts.getColors ? opts.getColors() : null)]);
      const eng = U.create({ sendChunk: scr.send, onInput: scr.onInput, log, pktLen: 4104 });
      const r = await eng.upload(plan);
      if (r.ok) { lastUploaded = { title: act.upload.title, artist: act.upload.artist, status: act.upload.status }; gateLogged = false; log('♪ now-playing on LCD: "' + act.upload.title + '" (' + act.upload.status + ', ' + plan.totalSize + 'B, ' + (Date.now() - t0) + 'ms)'); return { ok: true }; }
      log('♪ now-playing upload failed: ' + r.error); state.lastShownKey = null; state.backoffUntil = Date.now() + FAIL_BACKOFF_MS;
      return { ok: false };
    } catch (e) {
      log('♪ now-playing upload error: ' + (e && e.message || e));
      state.lastShownKey = null; state.backoffUntil = Date.now() + FAIL_BACKOFF_MS;
      return { ok: false };
    } finally {
      if (scr) scr.close();
      opts.resumeRender();
      busy = false;
    }
  }

  async function maybeUpload() {
    if (Date.now() - lastUploadAt < MIN_GAP_MS) return;   // flash writes never back-to-back
    const act = decide(state, null, Date.now());
    if (!act) return;
    // gates: hand-off safety + an upload already running. A skipped action is re-armed so the
    // next tick retries once conditions clear (or the page grants a permit via uploadNow).
    if (busy || opts.isYielded() || opts.isMute() || (opts.isUnstable && opts.isUnstable())) {
      state.pending = act.upload; state.sinceMs = 0; state.lastShownKey = null;
      if (!gateLogged && opts.isYielded()) { gateLogged = true; log('♪ queued — the page holds the keyboard (it will grant an upload window on its next heartbeat)'); }
      return;
    }
    // FINAL pre-flight inside doUpload's window is unnecessary here: /yield BLOCKS on lcdBusy,
    // so once we set busy/pauseRender no page can open mid-write. Re-check just before committing:
    if (opts.isYielded() || opts.isMute()) { state.pending = act.upload; state.sinceMs = 0; state.lastShownKey = null; return; }
    await doUpload(act);
  }

  // PAGE-PERMIT path (2026-06-12, "make it instant"): the page holds the device, has PAUSED its
  // own 0x32 stream, and calls /npgo — the protocol safety (no paint during flash) is satisfied
  // without a device handoff, so the song lands while the site stays connected.
  async function uploadNow() {
    if (busy) return { ok: false, reason: 'busy' };
    if (opts.isMute()) return { ok: false, reason: 'mute' };
    if (Date.now() - lastUploadAt < MIN_GAP_MS) return { ok: false, reason: 'min gap' };          // skip-chains wedged the board
    if (Date.now() - lastEventAt < EVENT_QUIET_MS) return { ok: false, reason: 'track changing' };// a fresh skip makes the queued song stale — wait for it to settle
    const act = decide(state, null, Date.now());   // respects settle / dedupe / backoff
    if (!act) return { ok: false, reason: 'nothing pending' };
    return await doUpload(act);
  }

  spawnSidecar();
  timer = setInterval(() => { maybeUpload().catch(() => {}); }, 500);
  log('♪ now-playing enabled — watching the system media session');

  return {
    current() { return lastUploaded; },
    queued() { return !!state.pending; },
    uploadNow,
    refresh() {   // colors changed: re-upload the current song with the new look (one flash write)
      if (!lastInfo) return;
      state.pending = lastInfo; state.sinceMs = 0; state.lastShownKey = null;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (proc) { try { proc.kill(); } catch (_) { } proc = null; }
      log('♪ now-playing disabled');
    },
  };
}

module.exports = { newState, decide, start, SETTLE_MS, PAUSE_HOLD_MS };
