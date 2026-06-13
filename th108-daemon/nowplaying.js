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
function fmtTime(ms) { const s = Math.max(0, Math.floor((+ms || 0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }   // ms → m:ss for the seek log

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
  let lastTrackKey = null;                       // detect a genuine track change (for the throttled-skip blink + flash)
  let mediaPos = 0, mediaPosAt = 0, mediaDur = 0, mediaPlaying = false, lastPlayingAt = 0;   // timeline for the keyboard progress-bar (+ idle-fade clock)
  let writeTimes = [];                           // upload timestamps for the rolling-hour cap
  function hourlyCapHit() { const now = Date.now(); writeTimes = writeTimes.filter(t => now - t < 3600000); return writeTimes.length >= MAX_WRITES_PER_HOUR; }
  // ----- send-health + anti-stasis bookkeeping (the LCD got "stuck two songs ago" 2026-06-13) -----
  let staleLogged = false;                       // dedupe the verifier's "live != on-screen" line
  let sendOk = true, sendFails = 0, lastSendAt = 0, lastSendErr = null;   // surfaced via health() → /status
  let sidecarUpAt = 0, watchdogHits = 0;         // sidecar liveness (recycle if it goes silent while playing)
  // live-status feed for the Now Playing card — human-readable transitions surfaced via /status.npLog
  const events = []; let lastNotedStatus = null;
  function note(msg) { events.push({ t: Date.now(), msg }); if (events.length > 20) events.shift(); }

  function spawnSidecar() {
    if (stopped) return;
    sidecarUpAt = Date.now();
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
            if (lastBlockedSrc !== (ev.source || '')) { lastBlockedSrc = ev.source || ''; log('♪ ignoring media from "' + (ev.source || 'unknown') + '" (not whitelisted)'); note('Ignoring "' + (ev.source || 'unknown') + '" — not an allowed source'); }
            continue;
          }
          const k = keyOf(ev), nowMs = Date.now();
          // SEEK detection (same song, position jumped beyond what normal playback would advance) — surfaced
          // so the 1-0 progress-bar's sudden count up/down is explained in the feed
          if (k === lastTrackKey && mediaDur && Number.isFinite(+ev.posMs)) {
            const expected = mediaPos + (mediaPlaying ? (nowMs - mediaPosAt) : 0);
            if (Math.abs((+ev.posMs) - expected) > 3000) note('Seeked to ' + fmtTime(+ev.posMs) + ' (from ' + fmtTime(expected) + ') — progress bar follows');
          }
          // timeline for the keyboard progress-bar (the daemon extrapolates pos while playing)
          mediaPos = +ev.posMs || 0; mediaPosAt = nowMs; mediaDur = +ev.durMs || 0; mediaPlaying = (ev.status === 'playing');
          if (mediaPlaying) lastPlayingAt = nowMs;   // idle-fade clock: how long since the music was actually playing
          if (k !== lastTrackKey) {
            const firstEver = lastTrackKey === null;
            lastTrackKey = k;
            if (!firstEver && opts.onTrackChange) opts.onTrackChange();   // a real song change → yellow flash (not on the first detection)
            // a genuinely NEW track that can't write the LCD yet (20s gap / hourly cap) → spacebar blink "queued, wait"
            const throttled = lastUploadAt && (nowMs - lastUploadAt < MIN_GAP_MS || hourlyCapHit());
            if (throttled && opts.onThrottled) opts.onThrottled();
            if (!opts.lcdEnabled || opts.lcdEnabled())
              note('Next song: "' + ev.title + '" — ' + (throttled ? (hourlyCapHit() ? 'queued (hourly write cap reached)' : 'queued (waiting for the min gap)') : 'pending LCD sync'));
            else note('Next song: "' + ev.title + '" (progress bar)');
          }
          // pause/resume transitions — informational (track-change-only mode never syncs the LCD on these)
          if (ev.status !== lastNotedStatus) {
            lastNotedStatus = ev.status;
            if (ev.status === 'paused') note('Paused — LCD holds (it syncs on track change, not on pause)');
            else if (ev.status === 'playing') note('Playing: "' + ev.title + '"');
          }
          // keep the album art across thumb-less 2s position ticks (so refresh() still has it)
          if (!ev.thumb && lastInfo && lastInfo.title === ev.title && lastInfo.artist === ev.artist) ev.thumb = lastInfo.thumb;
          lastInfo = ev; lastEventAt = nowMs;
          if (ev.status === 'paused') { if (!pausedSince) pausedSince = Date.now(); }
          else { pausedSince = 0; reverted = false; }   // playing again → the song repaints via the normal flow
          decide(state, ev, nowMs);
        } catch (_) { }
      }
    });
    proc.on('exit', () => { proc = null; if (!stopped) { log('… media sidecar exited — restarting in 5s'); setTimeout(spawnSidecar, 5000); } });
  }

  // SIDECAR WATCHDOG (anti-stasis): the sidecar emits >= every 2s while playing and on any change.
  // If we last heard a PLAYING song but have had silence for SIDECAR_SILENT_MS, the PowerShell side
  // has hung (a WinRT call wedged) — that freezes BOTH the LCD song and the keyboard progress-bar on
  // an old track. Recycle it; the exit handler respawns. (This was a real stuck-two-songs-ago cause.)
  const SIDECAR_SILENT_MS = 15000;
  function watchdogSidecar() {
    if (stopped || !proc) return;
    if (mediaPlaying && lastEventAt && Date.now() - lastEventAt > SIDECAR_SILENT_MS) {
      watchdogHits++;
      log('⚠ media sidecar silent ' + Math.round((Date.now() - lastEventAt) / 1000) + 's while a song was playing — recycling it (anti-stasis; the LCD/bar were likely frozen on an old track)');
      lastEventAt = Date.now();   // debounce so a slow respawn doesn't kill-loop
      try { proc.kill(); } catch (_) {}
    }
  }

  // the actual flash write — callers have already settled ownership/stream questions
  async function doUpload(act) {
    busy = true;
    lastUploadAt = Date.now();
    const t0 = Date.now();
    await opts.pauseRender();   // parks the key lighting to black (the daemon's async impl), then the flash owns the board
    const scr = T.openScreen();
    try {
      if (!scr) { log('now-playing: screen interface not found — will retry on the next change'); state.backoffUntil = Date.now() + FAIL_BACKOFF_MS; return { ok: false }; }
      const plan = U.planUpload([R.render(act.upload, opts.getColors ? opts.getColors() : null, opts.getCal ? opts.getCal() : null, opts.getFit ? opts.getFit() : false)]);
      writeTimes.push(Date.now());   // count toward the rolling-hour cap only once we're actually about to write the flash (a failed render never touched the board)
      const eng = U.create({ sendChunk: scr.send, onInput: scr.onInput, log, pktLen: 4104 });
      const r = await eng.upload(plan);
      if (r.ok) { lastUploaded = { title: act.upload.title, artist: act.upload.artist, status: act.upload.status }; gateLogged = false; staleLogged = false; sendOk = true; sendFails = 0; lastSendAt = Date.now(); lastSendErr = null; note('✓ LCD synced: "' + act.upload.title + '" (' + (Date.now() - t0) + 'ms)'); log('♪ now-playing on LCD: "' + act.upload.title + '" (' + act.upload.status + ', ' + plan.totalSize + 'B, ' + (Date.now() - t0) + 'ms)'); return { ok: true }; }
      // FAILED send: keep lastShownKey null so the verifier re-queues this song, and ARM a fresh
      // sidecar event re-check. Loud + surfaced via health() so a botched update can't go silent.
      sendOk = false; sendFails++; lastSendAt = Date.now(); lastSendErr = String(r.error || 'upload returned not-ok');
      note('✗ LCD sync failed: ' + lastSendErr + ' — retrying');
      log('♪ ✗ now-playing upload FAILED (' + sendFails + 'x): ' + lastSendErr + ' — re-queueing, retry after backoff'); state.lastShownKey = null; state.backoffUntil = Date.now() + FAIL_BACKOFF_MS;
      return { ok: false };
    } catch (e) {
      sendOk = false; sendFails++; lastSendAt = Date.now(); lastSendErr = String(e && e.message || e);
      note('✗ LCD sync error: ' + lastSendErr + ' — retrying');
      log('♪ ✗ now-playing upload ERROR (' + sendFails + 'x): ' + lastSendErr + ' — re-queueing, retry after backoff');
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
    await opts.pauseRender();
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
    watchdogSidecar();   // keep the sidecar alive — the bar AND the LCD song both freeze if it hangs
    if (opts.lcdEnabled && !opts.lcdEnabled()) return;    // bar-only mode: the sidecar runs for the progress-bar, but NO LCD flash writes (the safe path)
    // CURRENT-SONG VERIFIER (anti-stasis): if the live song no longer matches what's on the LCD and
    // nothing is queued, re-arm it. A failed/contested upload consumes `pending` and nulls the shown
    // key, so without this the machine can sit idle forever showing an old track. The safety gates
    // below still throttle the actual write — this only restores the INTENT to re-show the song.
    if (!state.pending && lastInfo && keyOf(lastInfo) !== state.lastShownKey && Date.now() >= state.backoffUntil) {
      state.pending = lastInfo; state.sinceMs = Date.now();
      if (!staleLogged) { staleLogged = true; log('♪ verifier: "' + lastInfo.title + '" is playing but the LCD shows "' + (lastUploaded ? lastUploaded.title : '(none)') + '" — re-queueing'); }
    }
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
      if (!gateLogged && opts.isYielded()) { gateLogged = true; note('Page holds the keyboard — will sync when it grants a window (or you hide/close the tab)'); log('♪ queued — the page holds the keyboard (it will grant an upload window on its next heartbeat)'); }
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
    if (opts.lcdEnabled && !opts.lcdEnabled()) return { ok: false, reason: 'lcd off' };   // bar-only mode never writes the LCD
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
    // extrapolated playback progress (0..1) for the keyboard progress-bar; hasMedia false = nothing to show
    mediaState() {
      if (!mediaPosAt || !mediaDur) return { hasMedia: false };
      const since = Date.now() - mediaPosAt;
      if (mediaPlaying && since > 15000) return { hasMedia: false };   // playing but the sidecar went quiet → media stopped
      const pos = mediaPos + (mediaPlaying ? since : 0);
      return { hasMedia: true, progress: Math.max(0, Math.min(1, pos / mediaDur)), playing: mediaPlaying, durMs: mediaDur, track: lastTrackKey,
               idleMs: mediaPlaying ? 0 : (lastPlayingAt ? Date.now() - lastPlayingAt : 1e9) };   // ms since playback was last active (for the bar's idle crossfade)
    },
    recent() { return events.slice(-10); },   // live-status feed (newest last) for the Now Playing card
    // send-health snapshot for /status — lets the page (and the user) SEE a botched/failed update
    // and a frozen pipeline instead of it failing silently into stasis
    health() {
      return {
        sendOk, sendFails, lastSendErr,
        lastSendAgoMs: lastSendAt ? Date.now() - lastSendAt : null,
        onScreen: lastUploaded ? (lastUploaded.title + ' — ' + lastUploaded.artist) : null,
        livePlaying: lastInfo ? (lastInfo.title + ' — ' + lastInfo.artist) : null,
        inSync: !lastInfo || keyOf(lastInfo) === state.lastShownKey,   // false = LCD is behind the live song (verifier will chase it)
        capHit: hourlyCapHit(), writesThisHour: writeTimes.length,
        sidecarAgeMs: sidecarUpAt ? Date.now() - sidecarUpAt : null, watchdogHits,
      };
    },
    // would uploadNow plausibly proceed? — gates mirrored so heartbeats only advertise REAL work
    // (advertising while gated made the page freeze its stream pointlessly every beat)
    ready() {
      const now = Date.now();
      if (opts.lcdEnabled && !opts.lcdEnabled()) return false;   // bar-only mode advertises no LCD work
      return (!!state.pending || !!revertDue()) && !busy && !hourlyCapHit() && now - lastUploadAt >= MIN_GAP_MS &&
             now - lastEventAt >= EVENT_QUIET_MS && now >= state.backoffUntil;
    },
    uploadNow,
    refresh() {   // colors changed: re-upload the current song with the new look (one flash write)
      if (!lastInfo) return;
      state.pending = lastInfo; state.sinceMs = 0; state.lastShownKey = null;
    },
    // DEBUG "Refresh LCD" button: force-repaint the live song NOW, bypassing the dedupe / MIN_GAP /
    // backoff (an explicit user click). Still respects busy / mute / ownership for board safety.
    async forceUpload() {
      if (opts.lcdEnabled && !opts.lcdEnabled()) return { ok: false, reason: 'LCD now-playing is off' };
      if (busy) return { ok: false, reason: 'an upload is already running' };
      if (opts.isMute()) return { ok: false, reason: 'board is muted — try the Connect/recovery flow first' };
      if (opts.isYielded()) return { ok: false, reason: 'the page holds the keyboard — hide/close the tab so the daemon can drive' };
      if (!lastInfo) return { ok: false, reason: 'no song detected yet' };
      state.backoffUntil = 0;
      const r = await doUpload({ upload: lastInfo });
      if (r && r.ok) state.lastShownKey = keyOf(lastInfo);
      return r || { ok: false, reason: 'upload failed' };
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
