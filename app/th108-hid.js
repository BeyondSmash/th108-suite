/* th108-hid.js — WebHID transport for the Epomaker TH108 V2 PRO.
   Owns the control-interface handle (usagePage 0xFF68 / usage 0x61 — NEVER "the first output report",
   which can be the screen iface 0xFF67 that ACKs but doesn't drive LEDs) and the ACK-gated 0x32 frame
   streaming: the board ACKs every output write with a 0x55 input report, and the next write MUST wait
   for it or the command FIFO overruns and the HID pipe wedges (replug to recover).
   Extracted unchanged from th108-controller.html's inline script. UMD so the pure helpers
   (findWritable / findScreen / buildPkt) are unit-testable under node --test.

   Usage: const HID = TH108Hid.create({log, setStatus, ledCount, stopHost,
            beforeConnect, beforeAutoReconnect, onBound, onConnected, onDisconnected, onReconnected});
   The module knows nothing about the DOM — all of that arrives via these callbacks. The one exception is
   the device LEASE: every auto/manual bind path gates on claimGate() (window.DC.claim(), if a
   th108-daemon-client.js is present on the page) before opening, and registers DC.onLeaseLost() to close
   this page's handle the instant another controller wins the lease — this direct coupling is deliberate
   (see claimGate/_wireLeaseLoss below) because that close-before-the-winner-opens race is safety-critical
   and can't be mediated through a plain callback the way the rest of the DOM/daemon glue is. With no DC
   present (or an old daemon lacking the route) every gate call resolves granted — same as before, direct
   WebHID, no behavior change. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108Hid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VENDOR = 0x0C45, CMD = 0x32;

  function findWritable(devs) {
    const grab = col => { const or = (col.outputReports || [])[0]; if (!or) return null; const it = (or.items || [])[0] || {}; return { reportId: or.reportId || 0, packLen: it.reportCount || 64, usagePage: col.usagePage, usage: col.usage }; };
    const pick = test => { for (const d of devs) for (const col of d.collections || []) { if (test(col)) { const g = grab(col); if (g) return Object.assign({ d }, g); } } return null; };
    // the per-key control interface is 0xFF68 usage 0x61 — pick it explicitly, NOT just the first output report (which can be the screen iface 0xFF67)
    return pick(c => c.usagePage === 0xFF68 && c.usage === 0x61) || pick(c => c.usagePage === 0xFF68) || pick(() => true);
  }
  function findScreen(devs) {
    let best = null;
    for (const d of devs) for (const col of d.collections || []) {
      for (const or of col.outputReports || []) {
        const bytes = (or.items || []).reduce((n, it) => n + (it.reportCount || 0) * ((it.reportSize || 8) / 8), 0);
        if (!best || bytes > best.bytes) best = { d, reportId: or.reportId || 0, bytes };
      }
    }
    return best;
  }

  function create(opts) {
    opts = opts || {};
    const noop = function () {};
    const log = opts.log || noop, setStatus = opts.setStatus || noop,
          stopHost = opts.stopHost || noop,
          beforeConnect = opts.beforeConnect || noop, beforeAutoReconnect = opts.beforeAutoReconnect || noop,
          onBound = opts.onBound || noop, onConnected = opts.onConnected || noop,
          onDisconnected = opts.onDisconnected || noop, onReconnected = opts.onReconnected || noop,
          onGrantLost = opts.onGrantLost || noop,   // replug revoked the WebHID grant — only a user click can get it back
          onWedged = opts.onWedged || noop,         // handle-rebind retries exhausted on a mute board — last-resort recovery hook (daemon USB restart)
          onDeferred = opts.onDeferred || noop,     // an AUTO-bind path declined to grab (a daemon is driving and this page wasn't) — clean up any stale yield/heartbeat so the daemon keeps the board
          canDrive = opts.canDrive || (() => true), // SINGLE-DRIVER GATE: only the tab holding the cross-tab lock may auto-bind (WebHID opens are shared on Windows → two tabs streaming 0x32 interleave and wedge the board → onboard rainbow). Manual connect() bypasses this.
          shouldAutoBind = opts.shouldAutoBind || (() => true); // DAEMON-DEFERENCE GATE (async): true only when no daemon is driving OR this page was genuinely driving (running/_wasRunning) and is reclaiming its own session. Stops the wake/replug 'connect' event + rebind poll from silently yanking the board from a daemon the user never asked to displace. Manual connect() bypasses this.
    let device = null, reportId = 0, packLen = 64;
    let _binding = false;   // SINGLE-FLIGHT bind guard: a replug fires one 'connect' event PER interface and the rebind poll runs too — without this they bind concurrently (observed: "operation in progress" + null _inHooked + a board that ACKs but stays dark until a manual Connect). Set synchronously (no await) right after the entry checks so the claim is atomic.
    // DEVICE LEASE (daemon-authoritative, replaces the old cooperative /yield): if the host page wired
    // up th108-daemon-client.js, it's reachable here as window.DC (set by DC's own create(), which the
    // host page runs right after this create() — so DC doesn't exist yet AT this line, only later when
    // an actual bind path runs). A page with no DC at all (older host, or DC never loaded) is ungated —
    // behaves exactly as before, direct WebHID.
    let _leaseWired = false;
    function _dc() { return (typeof window !== 'undefined') ? window.DC : null; }
    // Safety-critical: the instant another controller wins the lease, close THIS page's handle BEFORE
    // the winner opens — this is what prevents the two-writers-both-open mute. Wired lazily (once, from
    // claimGate() below) so it's registered by the time it's needed regardless of which bind path runs first.
    function _wireLeaseLoss() {
      if (_leaseWired) return;
      const dc = _dc();
      if (!dc || typeof dc.onLeaseLost !== 'function') return;
      _leaseWired = true;
      dc.onLeaseLost(async () => {
        if (!device) return;
        try { await device.close(); } catch (_) { }
        device = null; reportId = 0;
        stopRebindPoll();
        log('lease lost — another controller took the keyboard; closed this tab\'s handle', 'dim');
        try { onDisconnected(); } catch (_) { }   // Task 5 shows the richer banner; this is the same "we no longer hold it" cleanup as a physical disconnect
      });
    }
    // Ask the lease owner for permission to open. True = safe to bindDevice() — either no daemon-client
    // is present (ungated, legacy standalone behavior) or /claim granted THIS page the lease. False =
    // another controller holds it; the caller must stay hands-off (the banner offers "Take control").
    async function claimGate() {
      _wireLeaseLoss();
      const dc = _dc();
      if (!dc || typeof dc.claim !== 'function') return true;
      try { const r = await dc.claim(); return !!(r && r.granted); } catch (_) { return true; }
    }
    let _sendStalls = 0, _ackWaiter = null, _inRpts = 0, _lastWriteAt = 0, _ackOff = -1;
    // minimum gap between writes — the board's real per-chunk drain rate. The board sends UNSOLICITED
    // 0x55 broadcasts (chatty, esp. while an animated onboard effect runs after a factory reset) that
    // FALSELY satisfy the ACK gate; without this floor the 8 chunks/frame fire in a sub-ms burst that
    // overruns the board's buffer → it goes silent ~0.8s in (the recurring "board not keeping up").
    // 3ms/chunk = ~330 chunks/s, comfortably above 30fps×8=240, but far below a runaway false-ACK burst.
    const MIN_WRITE_GAP_MS = 3;
    const _sleep = ms => new Promise(r => setTimeout(r, ms));

    function buildPkt(cmd, len, off, chunk, aux, last) {
      const s = new Uint8Array(packLen);
      s[0] = 0xAA; s[1] = cmd; s[2] = len; s[3] = off & 0xFF; s[4] = (off >> 8) & 0xFF; s[5] = aux & 0xFF; s[6] = last ? 1 : 0; s.set(chunk, 8);
      return s;
    }
    function onInputReport(e) {                          // the board replies with a 0x55 ACK per write on this iface — read it AND gate the next write on it
      _inRpts++;
      const b = new Uint8Array(e.data.buffer);
      if (_inRpts === 1) log(TH108i18n.tfLog('board input reports: id={0} first=[{1}…]', e.reportId, Array.from(b.slice(0, 8)).map(x => x.toString(16).padStart(2, '0')).join(' ')), 'dim');
      // A genuine 0x32 ACK ECHOES the offset of the write it answers (b[3]=off&0xFF, b[4]=off>>8) — confirmed
      // in the daemon flight recorder (off=56→b[3]=0x38, off=392→b[3]=0x88 b[4]=0x01). The board ALSO emits
      // unsolicited 0x55 32 reports carrying a STALE offset; gating on bare 0x55 let those false-satisfy a
      // pending write → over-send → FIFO wedge/mute. Require the echoed offset to match the write we're awaiting.
      if (b[0] === 0x55 && b[1] === CMD && _ackWaiter && b[3] === (_ackOff & 0xFF) && b[4] === ((_ackOff >> 8) & 0xFF)) {
        const w = _ackWaiter; _ackWaiter = null; _ackOff = -1; w(true);
      }
    }
    function waitAck(ms, off) { _ackOff = off; return new Promise(res => { _ackWaiter = res; setTimeout(() => { if (_ackWaiter === res) { _ackWaiter = null; res(false); } }, ms); }); }
    // ===== WEDGE-RECOVERY LADDER — tuned 2026-06-19 for faster wired recovery (was ~46s → ~15s). =====
    // Two knobs: _sendStalls threshold (here, 8) and _stallRetries cap (releaseAfterFailure, 1). They trade
    // recovery SPEED against false-positive USB-restarts. Going faster (lower numbers) means a board that was
    // only briefly stalling — a momentary blip that WOULD have self-healed — gets a real USB re-enumeration
    // (~1-2s typing dropout) it didn't need.
    //   SYMPTOM of the downside (too aggressive): you notice occasional unprompted ~1-2s typing freezes while
    //     music plays, and the log shows "⚡ board wedged — asked the daemon to USB-restart" without you having
    //     actually lost the lighting. → COURSE-CORRECT: raise _sendStalls back toward 12-15 and/or _stallRetries to 2.
    //   SYMPTOM of too patient (the old behavior): a real mute sits dead for ~30-46s before auto-recovery (or you
    //     replug first). → go lower.
    function noteStall() {
      if (++_sendStalls === 1 || _sendStalls % 20 === 0) log('board not keeping up (no ACK) — pacing/dropping to keep the loop alive', 'dim');
      // REVERTED to 15 (2026-06-19): 8 fired /usbfix too eagerly → repeated USB re-enumerations dropped typing
      // ("keys won't type"). 15 lets brief self-healing blips recover before we ever touch USB. See the ladder note.
      if (_sendStalls >= 15) { log('board unresponsive — stopping.', 'err'); stopHost(); releaseAfterFailure(); }
    }
    // ACK silence with NO disconnect event = the handle may be stale (a hub power blip can reset/re-enumerate
    // the keyboard without Chrome firing 'disconnect' — observed when flipping an audio device on the same bus).
    // Drop the dead handle and let the rebind poll pick up the fresh enumeration; cap retries so a genuinely
    // wedged board (FIFO overrun) doesn't loop forever.
    let _stallRetries = 0;
    function releaseAfterFailure() {
      if (!device) return;
      try { device.close(); } catch (_) { }
      device = null; reportId = 0;
      if (++_stallRetries <= 2) { setStatus('board stopped responding — re-binding…', 'dim'); startRebindPoll(); }   // REVERTED to 2 (with the 15-stall threshold) — patient recovery so blips don't trigger needless USB restarts
      else {   // a fresh handle didn't help = true wedge; hand it to the recovery hook (daemon USB restart) and keep polling for the re-enumeration it causes
        setStatus('board unresponsive after retries — attempting recovery…', 'err');
        _stallRetries = 0;          // the restart (or a manual replug) starts a fresh episode
        onWedged();
        startRebindPoll();
      }
    }
    async function sendFrame(flat, aux = 0) {
      if (!device) return false;
      const room = packLen - 8, n = Math.max(1, Math.ceil(flat.length / room));
      for (let c = 0; c < n; c++) {
        const off = c * room, chunk = flat.slice(off, off + room);
        const since = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _lastWriteAt;
        if (since < MIN_WRITE_GAP_MS) await _sleep(MIN_WRITE_GAP_MS - since);   // pacing floor: never burst faster than the board can drain (false-ACK guard)
        const ack = waitAck(800, off);                    // arm the ACK waiter BEFORE the write so we can't miss it (matched to THIS chunk's offset)
        let timer; const wto = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__wstall__')), 800); });
        try {
          await Promise.race([device.sendReport(reportId, buildPkt(CMD, chunk.length, off, chunk, aux, c === n - 1)), wto]);
          clearTimeout(timer);
          _lastWriteAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        } catch (e) {
          clearTimeout(timer);
          if (e && e.message === '__wstall__') { noteStall(); return false; }    // the write itself hung — drop frame, keep loop alive
          log('send failed: ' + e.message, 'err'); stopHost(); return false;     // genuine error (e.g. unplugged)
        }
        // WAIT for the board's 0x55 ACK before sending the next chunk. This pacing matches the board's FIFO drain
        // rate, which is the actual fix: firing chunks without waiting overran the FIFO and wedged the pipe.
        if (!(await ack)) { noteStall(); return false; }
        _sendStalls = 0; _stallRetries = 0;               // a clean ACK = the board genuinely recovered — re-arm the stall-rebind budget
      }
      return true;
    }

    async function bindDevice(devs, silent) {
      const w = findWritable(devs);
      if (!w) { if (!silent) setStatus('no FF68 control interface found — re-pick the 0xff68 entry', 'err'); return false; }
      device = w.d; reportId = w.reportId; packLen = w.packLen;
      stopRebindPoll();                                  // any successful bind path (event, poll, manual Connect) ends the recovery poll
      if (!device.opened) await device.open();
      if (!device._inHooked) { device._inHooked = true; device.addEventListener('inputreport', onInputReport); }   // read the board's ACK/status reports + gate sends on them
      // user-facing status; the wire jargon rides the hover tooltip (3rd arg) and the log keeps the full line
      setStatus(TH108i18n.tf('Keyboard Connected: {0}', String(device.productName || 'unknown').replace(/_/g, ' ')), 'ok',
        'iface 0x' + (w.usagePage || 0).toString(16) + '/0x' + (w.usage || 0).toString(16) + ' · reportId=' + reportId + ' · packLen=' + packLen + ' · ' + opts.ledCount + ' LEDs');
      log(TH108i18n.tfLog('connected: {0} · iface 0x{1}/0x{2} · reportId={3} · packLen={4} · {5} LEDs', device.productName, (w.usagePage || 0).toString(16), (w.usage || 0).toString(16), reportId, packLen, opts.ledCount), 'ok');
      let screenDev = null, screenRid = 0;
      const sc = findScreen(devs);
      if (sc && sc.bytes >= 4096) {
        screenDev = sc.d; screenRid = sc.reportId; if (!screenDev.opened) await screenDev.open();
        log(TH108i18n.tfLog('screen interface bound (report {0}B) — LCD upload available', sc.bytes), 'ok');
      }
      else log('screen interface not in this grant — LCD upload disabled until you re-pick the keyboard', 'dim');
      onBound({ screen: screenDev, screenReportId: screenRid, control: device, controlReportId: reportId });
      return true;
    }
    async function connect() {
      if (!('hid' in navigator)) { setStatus('WebHID needs Chrome/Edge', 'err'); return; }
      if (_binding) return;        // a bind is already in flight (auto-rebind) — don't race it
      _binding = true;
      try {
        await beforeConnect();   // daemon holds the device — make it release BEFORE we open, or the open fails
        if (!(await claimGate())) { setStatus('another controller holds the keyboard — Take control to claim it', 'dim'); return; }   // lease denied: stay hands-off, don't open over the current owner
        // a surviving grant binds silently — the picker is ONLY for re-granting after Chrome forgot
        // the device (true replug). Pair with install-webhid-grant.ps1 (policy pre-grant) and the
        // picker never appears at all.
        const known = await navigator.hid.getDevices();
        const kw = findWritable(known);
        if (kw && kw.usagePage === 0xFF68 && kw.usage === 0x61) {
          const ok = await bindDevice(known, true);
          if (ok) { onConnected(); return; }
          // silent bind failed (stale handle mid-enumeration etc.) — fall through to the picker
        }
        const picked = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR }] });   // grant the whole keyboard so BOTH the control (0xFF68/0x61) AND screen (large report) interfaces are available (LCD upload needs the screen iface)
        if (!picked || !picked.length) { setStatus('connection cancelled', 'dim'); return; }   // respect Cancel — don't silently fall back to a previously-granted device
        const ok = await bindDevice(picked, false);
        if (ok) onConnected();   // tell the daemon's watchdog we're alive & holding the device
      } catch (e) {
        setStatus(TH108i18n.tf('connect failed: {0}', e.message), 'err'); log(TH108i18n.tfLog('connect error: {0}', e.message), 'err');
        try { console.error('[th108 connect] threw AFTER opening the device — full stack:', e); } catch (_) { }   // expandable, source-linked stack in DevTools
        try { if (e && e.stack) log('  ↳ ' + String(e.stack).split('\n').slice(1, 4).map(s => s.trim()).join('  ◂  '), 'dim'); } catch (_) { }   // and the top frames straight into the on-page Log
        // A connect that threw mid-setup (e.g. a UI callback in onBound) leaves the control handle OPEN but
        // with no heartbeat → the daemon's watchdog resumes and the two writers wedge the board. Close cleanly
        // so a FAILED connect can never wedge; the daemon then keeps driving (watchdog resume / our handback).
        try { if (device) await device.close(); } catch (_) { }
        device = null; reportId = 0;
        try { onDisconnected(); } catch (_) { }
      }
      finally { _binding = false; }
    }
    async function autoReconnect() {   // on page load: if the keyboard was granted in a past session, reconnect silently (keeps the convenience, without Cancel-means-connect)
      if (!canDrive()) { setStatus('another th108 tab is driving the keyboard — close it, or use that tab', 'dim'); return; }   // never auto-grab from another tab
      if (_binding) return; _binding = true;   // single-flight: don't race a connect-event / poll bind
      try {
        if (!('hid' in navigator)) return;
        const known = await navigator.hid.getDevices();
        if (known && known.length) {
          await beforeAutoReconnect();
          if (!(await claimGate())) { onDeferred(); return; }   // another controller (daemon or newer tab) already holds the lease — leave it, don't reopen over it
          const ok = await bindDevice(known, true); if (ok) onConnected();
        }
      } catch (_) { }
      finally { _binding = false; }
    }

    // After a disconnect, ALSO poll getDevices() for the grant coming back — the navigator.hid 'connect' event
    // is not reliable on every recovery path (it never fires after a physical replug here: Chrome REVOKES the
    // grant on disconnect for devices without a serial number, and the TH108 reports none). The poll silently
    // re-binds whenever the grant survived (sleep/wake, USB blips); when it was revoked, nothing we can do
    // headlessly — prompt for the one Connect click.
    let _pollT = null, _pollN = 0;
    function stopRebindPoll() { if (_pollT) { clearInterval(_pollT); _pollT = null; } }
    function startRebindPoll() {
      stopRebindPoll(); _pollN = 0;
      _pollT = setInterval(async () => {
        if (device || _binding) { if (device) stopRebindPoll(); return; }   // bound, or a bind is already in flight — don't race it
        if (!canDrive()) { stopRebindPoll(); return; }   // another tab owns the driver lock — don't auto-rebind
        let known = []; try { known = await navigator.hid.getDevices(); } catch (_) { }
        const w = findWritable(known);
        if (w && w.usagePage === 0xFF68 && w.usage === 0x61) {
          if (device || _binding) return;   // re-check after the getDevices await, THEN claim synchronously (atomic with this check — no await between)
          _binding = true;
          stopRebindPoll();
          try {
            if (!(await shouldAutoBind())) { onDeferred(); return; }   // a daemon is driving and this page wasn't — leave the board to it (Connect to take over from here)
            await beforeAutoReconnect();   // re-yield the daemon FIRST — at wake its watchdog may have resumed it, and silently rebinding over it = two writers (the 2026-06-11 wake fight)
            if (!(await claimGate())) { onDeferred(); return; }   // wake can't reopen over another owner — the lease says no, stay hands-off
            const ok = await bindDevice(known, true); if (ok) onReconnected();
          } catch (_) { device = null; reportId = 0; startRebindPoll(); }   // not ready yet — keep polling
          finally { _binding = false; }
        } else if (++_pollN === 4) {   // ~6s with no grant in sight → it was a replug (grant revoked) — needs the user
          setStatus('keyboard disconnected — if you replugged it, click Connect Keyboard to re-grant (Chrome forgets the permission on unplug)', 'dim');
          onGrantLost();               // hand lighting back to the daemon — the page can't recover without a click anyway
        }
      }, 1500);
    }

    // Survive sleep/wake + unplug/replug: WebHID invalidates the device handle when the keyboard re-enumerates,
    // so the old handle goes stale (Start layers silently hits a dead device). Auto re-bind the fresh handle and
    // let the host resume layers if they were running — no manual reconnect/Start needed.
    if (typeof navigator !== 'undefined' && navigator.hid) {
      navigator.hid.addEventListener('disconnect', e => {
        if (!device || e.device !== device) return;            // only react to OUR control interface going away
        onDisconnected();                                      // host: capture running state, stop the loop, clear LCD handles, disable buttons
        device = null; reportId = 0;
        setStatus('keyboard disconnected (sleep/unplug) — reconnecting automatically…', 'dim');
        log('keyboard disconnected — waiting for it to come back…', 'dim');
        startRebindPoll();                                     // the 'connect' event alone is not enough — see startRebindPoll
      });
      navigator.hid.addEventListener('connect', async e => {
        if (device || _binding) return;                         // already bound, or a bind is already in flight (replug fires one event PER interface — serialize them; this is the dark-board race fix)
        if (e.device && e.device.vendorId !== VENDOR) return;   // not our keyboard
        if (!canDrive()) return;                                // another tab owns the driver lock — let it handle the replug
        _binding = true;                                        // claim the bind slot synchronously (no await since the checks above) — only ONE bind runs at a time
        try {
          if (!(await shouldAutoBind())) { onDeferred(); return; }   // a daemon is driving and this page wasn't — the first wake/replug event must NOT silently take the board from it (this was the #1 recurring villain). Connect to drive from here.
          try { await beforeConnect(); } catch (_) { }
          if (!(await claimGate())) { onDeferred(); return; }   // the replug lease-claim was denied — another controller already re-bound; stay hands-off
          const known = await navigator.hid.getDevices();
          // a replug fires one connect event per HID interface as each re-enumerates — don't bind until the
          // 0xFF68/0x61 control iface is actually back, or findWritable's fallback could grab the screen iface
          // (writes ACK but don't drive LEDs) and lock out the later, correct events
          const w = findWritable(known);
          if (!w || w.usagePage !== 0xFF68 || w.usage !== 0x61) { log('keyboard re-enumerating — waiting for the control interface…', 'dim'); return; }
          const ok = await bindDevice(known, true);             // re-open the FRESH handle (control + screen)
          if (ok) onReconnected();
        } catch (err) {
          device = null; reportId = 0;                          // bind failed mid-enumeration (e.g. open() too early) — release so a later event/poll retries cleanly
          log(TH108i18n.tfLog('reconnect attempt failed: {0} — retrying shortly', (err && err.message || err)), 'dim');
          setTimeout(() => { if (!device && !_binding) startRebindPoll(); }, 1000);   // single guarded retry via the poll instead of a racing direct bind
        } finally {
          _binding = false;
        }
      });
    }

    // Close + reopen the control/screen handles and re-bind (grant permitting). Cure for the post-0x23
    // "ignore" state: after a LIVE onboard-effect write the board can keep ACKing 0x32 paint while
    // ignoring it — a same-handle stream restart does NOT clear it, but a handle close+reopen does
    // (discovered 2026-06-09: a page refresh fixed it with no replug).
    async function rebind() {
      try { if (device) await device.close(); } catch (_) { }
      device = null; reportId = 0;
      try { const known = await navigator.hid.getDevices(); return await bindDevice(known, true); }
      catch (_) { return false; }
    }
    // Deliberate user disconnect: release the WebHID handle entirely so the tab no longer holds the device
    // (the daemon can then own it cleanly). NOT a rebind — we stay disconnected until an explicit Connect.
    // device.close() does NOT fire navigator.hid 'disconnect' (that's for physical removal), so no auto-poll.
    async function disconnect() {
      stopRebindPoll();
      try { if (device) await device.close(); } catch (_) { }
      device = null; reportId = 0;
      onDisconnected();   // host cleanup: stop the loop, clear LCD/binder handles, refresh the toggle/pill
    }

    return {
      connect, disconnect, autoReconnect, bindDevice, sendFrame, buildPkt, findWritable, findScreen, rebind,
      resetStalls() { _sendStalls = 0; },
      get device() { return device; },
      get binding() { return _binding; },   // a bind is in flight (Connect picker open / rebind attempt) — the lease-liveness guard must not hand back mid-bind
      get reportId() { return reportId; },
      get packLen() { return packLen; }
    };
  }

  return { create, findWritable, findScreen };
});
