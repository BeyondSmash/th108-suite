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
const MIN_GAP_MS = 20000;     // SAFETY: 20s minimum between flash writes (each is a brick risk; was 5s)
const EVENT_QUIET_MS = 1200;  // no page-permit uploads right after a track event — a skip makes the queued song stale
const MAX_WRITES_PER_HOUR = 30;   // SAFETY cap: refuse to flash more than this in any rolling hour

function newState() { return { pending: null, sinceMs: 0, lastShownKey: null, backoffUntil: 0 }; }
// TRACK-CHANGE-ONLY (user request 2026-06-13, brick mitigation): the key is title+artist ONLY —
// play/pause/resume do NOT change it, so they never trigger a flash write. Only a genuinely new
// song writes the LCD. Fewer flash writes = far lower softbrick odds.
function keyOf(info) { return info.title + '|' + info.artist; }

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
  let pausedSince = 0, reverted = false;         // pause-revert: after N s paused, the standard GIF returns to the LCD
  let lastBlockedSrc = null;                     // dedupe the "ignoring media from X" log line
  let writeTimes = [];                           // upload timestamps for the rolling-hour cap
  function hourlyCapHit() { const now = Date.now(); writeTimes = writeTimes.filter(t => now - t < 3600000); return writeTimes.length >= MAX_WRITES_PER_HOUR; }

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
        try {
          const ev = JSON.parse(line);
          if (ev.source && opts.noteSource) opts.noteSource(ev.source);   // remember every source for the UI list
          // SAFETY-CRITICAL whitelist: only allowed sources (default = Spotify) may drive the LCD.
          // X/Twitter video tabs spam media changes; each one is a flash write = a softbrick risk.
          if (opts.isSourceAllowed && !opts.isSourceAllowed(ev.source || '')) {
            if (lastBlockedSrc !== (ev.source || '')) { lastBlockedSrc = ev.source || ''; log('♪ ignoring media from "' + (ev.source || 'unknown') + '" (not whitelisted)'); }
            continue;
          }
          lastInfo = ev; lastEventAt = Date.now();
          if (ev.status === 'paused') { if (!pausedSince) pausedSince = Date.now(); }
          else { pausedSince = 0; reverted = false; }   // playing again → the song repaints via the normal flow
          decide(state, ev, Date.now());
        } catch (_) { }
      }
    });
    proc.on('exit', () => { proc = null; if (!stopped) { log('… media sidecar exited — restarting in 10s'); setTimeout(spawnSidecar, 10000); } });
  }

  // the actual flash write — callers have already settled ownership/stream questions
  async function doUpload(act) {
    busy = true;
    lastUploadAt = Date.now();
    writeTimes.push(Date.now());   // count every flash write toward the rolling-hour cap
    const t0 = Date.now();
    opts.pauseRender();   // a flash upload can't share the board with the 0x32 stream
    const scr = T.openScreen();
    try {
      if (!scr) { log('now-playing: screen interface not found — will retry on the next change'); state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; return { ok: false }; }
      const plan = U.planUpload([R.render(act.upload, opts.getColors ? opts.getColors() : null, opts.getCal ? opts.getCal() : null)]);
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

  // after the configured pause duration, the user's standard GIF (mirrored from the page's GIF
  // Screen uploads) goes back to the LCD; the next play/track event repaints the song
  function revertDue() {
    if (reverted || !pausedSince || !opts.getRevertSec || !opts.getStandardGif) return null;
    const sec = opts.getRevertSec();
    if (!sec || Date.now() - pausedSince < sec * 1000) return null;
    const frames = opts.getStandardGif();
    return frames && frames.length ? frames : null;
  }
  async function doRevert(frames) {
    busy = true; lastUploadAt = Date.now();
    opts.pauseRender();
    const scr = T.openScreen();
    try {
      if (!scr) { state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; return { ok: false }; }
      const plan = U.planUpload(frames);
      const eng = U.create({ sendChunk: scr.send, onInput: scr.onInput, log, pktLen: 4104 });
      const r = await eng.upload(plan);
      if (r.ok) { reverted = true; lastUploaded = null; log('♪ paused ' + opts.getRevertSec() + 's — standard GIF restored to the LCD (' + plan.frameCount + ' frames)'); return { ok: true }; }
      log('♪ GIF revert failed: ' + r.error); state.backoffUntil = Date.now() + FAIL_BACKOFF_MS;
      return { ok: false };
    } catch (e) { log('♪ GIF revert error: ' + (e && e.message || e)); state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; return { ok: false }; }
    finally { if (scr) scr.close(); opts.resumeRender(); busy = false; }
  }

  async function maybeUpload() {
    if (Date.now() - lastUploadAt < MIN_GAP_MS) return;   // flash writes never back-to-back
    if (hourlyCapHit()) { if (state.pending) { if (!gateLogged) { gateLogged = true; log('♪ hourly flash-write cap reached (' + MAX_WRITES_PER_HOUR + '/hr) — holding off to protect the board'); } } return; }
    const rf = !busy && !opts.isYielded() && !opts.isMute() && !(opts.isUnstable && opts.isUnstable()) && Date.now() >= state.backoffUntil && revertDue();
    if (rf) { await doRevert(rf); return; }
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
    if (hourlyCapHit()) return { ok: false, reason: 'hourly cap' };                                 // brick-protection write cap
    if (Date.now() - lastUploadAt < MIN_GAP_MS) return { ok: false, reason: 'min gap' };          // skip-chains wedged the board
    if (Date.now() - lastEventAt < EVENT_QUIET_MS) return { ok: false, reason: 'track changing' };// a fresh skip makes the queued song stale — wait for it to settle
    const rf = Date.now() >= state.backoffUntil && revertDue();
    if (rf) return await doRevert(rf);                                                            // the GIF revert rides the page-permit path too
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
    // would uploadNow plausibly proceed? — gates mirrored so heartbeats only advertise REAL work
    // (advertising while gated made the page freeze its stream pointlessly every beat)
    ready() {
      const now = Date.now();
      return (!!state.pending || !!revertDue()) && !busy && !hourlyCapHit() && now - lastUploadAt >= MIN_GAP_MS &&
             now - lastEventAt >= EVENT_QUIET_MS && now >= state.backoffUntil;
    },
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

// the Spotify-only default for the source whitelist (matches desktop "Spotify.exe" + store
// "SpotifyAB.SpotifyMusic…"; browsers report Chrome/MSEdge/Brave and are blocked by default)
function isSpotifySource(aumid) { return /spotify/i.test(aumid || ''); }

module.exports = { newState, decide, start, isSpotifySource, SETTLE_MS, PAUSE_HOLD_MS };
