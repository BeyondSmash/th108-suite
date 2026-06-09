/* th108-hid.js — WebHID transport for the Epomaker TH108 V2 PRO.
   Owns the control-interface handle (usagePage 0xFF68 / usage 0x61 — NEVER "the first output report",
   which can be the screen iface 0xFF67 that ACKs but doesn't drive LEDs) and the ACK-gated 0x32 frame
   streaming: the board ACKs every output write with a 0x55 input report, and the next write MUST wait
   for it or the command FIFO overruns and the HID pipe wedges (replug to recover).
   Extracted unchanged from th108-controller.html's inline script. UMD so the pure helpers
   (findWritable / findScreen / buildPkt) are unit-testable under node --test.

   Usage: const HID = TH108Hid.create({log, setStatus, ledCount, stopHost,
            beforeConnect, beforeAutoReconnect, onBound, onConnected, onDisconnected, onReconnected});
   The module knows nothing about the DOM or the daemon — all of that arrives via these callbacks. */
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
          onDisconnected = opts.onDisconnected || noop, onReconnected = opts.onReconnected || noop;
    let device = null, reportId = 0, packLen = 64;
    let _sendStalls = 0, _ackWaiter = null, _inRpts = 0;

    function buildPkt(cmd, len, off, chunk, aux, last) {
      const s = new Uint8Array(packLen);
      s[0] = 0xAA; s[1] = cmd; s[2] = len; s[3] = off & 0xFF; s[4] = (off >> 8) & 0xFF; s[5] = aux & 0xFF; s[6] = last ? 1 : 0; s.set(chunk, 8);
      return s;
    }
    function onInputReport(e) {                          // the board replies with a 0x55 ACK per write on this iface — read it AND gate the next write on it
      _inRpts++;
      const b = new Uint8Array(e.data.buffer);
      if (_inRpts === 1) log('board input reports: id=' + e.reportId + ' first=[' + Array.from(b.slice(0, 8)).map(x => x.toString(16).padStart(2, '0')).join(' ') + '…]', 'dim');
      if (b[0] === 0x55 && _ackWaiter) { const w = _ackWaiter; _ackWaiter = null; w(true); }
    }
    function waitAck(ms) { return new Promise(res => { _ackWaiter = res; setTimeout(() => { if (_ackWaiter === res) { _ackWaiter = null; res(false); } }, ms); }); }
    function noteStall() {
      if (++_sendStalls === 1 || _sendStalls % 20 === 0) log('board not keeping up (no ACK) — pacing/dropping to keep the loop alive', 'dim');
      if (_sendStalls >= 15) { log('board unresponsive — stopping. Unplug/replug it, then Connect → Start layers.', 'err'); stopHost(); }
    }
    async function sendFrame(flat, aux = 0) {
      if (!device) return false;
      const room = packLen - 8, n = Math.max(1, Math.ceil(flat.length / room));
      for (let c = 0; c < n; c++) {
        const off = c * room, chunk = flat.slice(off, off + room);
        const ack = waitAck(800);                         // arm the ACK waiter BEFORE the write so we can't miss it
        let timer; const wto = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__wstall__')), 800); });
        try {
          await Promise.race([device.sendReport(reportId, buildPkt(CMD, chunk.length, off, chunk, aux, c === n - 1)), wto]);
          clearTimeout(timer);
        } catch (e) {
          clearTimeout(timer);
          if (e && e.message === '__wstall__') { noteStall(); return false; }    // the write itself hung — drop frame, keep loop alive
          log('send failed: ' + e.message, 'err'); stopHost(); return false;     // genuine error (e.g. unplugged)
        }
        // WAIT for the board's 0x55 ACK before sending the next chunk. This pacing matches the board's FIFO drain
        // rate, which is the actual fix: firing chunks without waiting overran the FIFO and wedged the pipe.
        if (!(await ack)) { noteStall(); return false; }
        _sendStalls = 0;
      }
      return true;
    }

    async function bindDevice(devs, silent) {
      const w = findWritable(devs);
      if (!w) { if (!silent) setStatus('no FF68 control interface found — re-pick the 0xff68 entry', 'err'); return false; }
      device = w.d; reportId = w.reportId; packLen = w.packLen;
      if (!device.opened) await device.open();
      if (!device._inHooked) { device._inHooked = true; device.addEventListener('inputreport', onInputReport); }   // read the board's ACK/status reports + gate sends on them
      setStatus('connected: ' + device.productName + ' · reportId=' + reportId + ' · packLen=' + packLen, 'ok');
      log('connected: ' + device.productName + ' · iface 0x' + (w.usagePage || 0).toString(16) + '/0x' + (w.usage || 0).toString(16) + ' · reportId=' + reportId + ' · packLen=' + packLen + ' · ' + opts.ledCount + ' LEDs', 'ok');
      let screenDev = null, screenRid = 0;
      const sc = findScreen(devs);
      if (sc && sc.bytes >= 4096) {
        screenDev = sc.d; screenRid = sc.reportId; if (!screenDev.opened) await screenDev.open();
        log('screen interface bound (report ' + sc.bytes + 'B) — LCD upload available', 'ok');
      }
      else log('screen interface not in this grant — LCD upload disabled until you re-pick the keyboard', 'dim');
      onBound({ screen: screenDev, screenReportId: screenRid, control: device, controlReportId: reportId });
      return true;
    }
    async function connect() {
      if (!('hid' in navigator)) { setStatus('WebHID needs Chrome/Edge', 'err'); return; }
      try {
        await beforeConnect();   // daemon holds the device — make it release BEFORE we open, or the open fails
        const picked = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR }] });   // grant the whole keyboard so BOTH the control (0xFF68/0x61) AND screen (large report) interfaces are available (LCD upload needs the screen iface)
        if (!picked || !picked.length) { setStatus('connection cancelled', 'dim'); return; }   // respect Cancel — don't silently fall back to a previously-granted device
        const ok = await bindDevice(picked, false);
        if (ok) onConnected();   // tell the daemon's watchdog we're alive & holding the device
      } catch (e) { setStatus('connect failed: ' + e.message, 'err'); log('connect error: ' + e.message, 'err'); }
    }
    async function autoReconnect() {   // on page load: if the keyboard was granted in a past session, reconnect silently (keeps the convenience, without Cancel-means-connect)
      try { if (!('hid' in navigator)) return; const known = await navigator.hid.getDevices(); if (known && known.length) { await beforeAutoReconnect(); const ok = await bindDevice(known, true); if (ok) onConnected(); } } catch (_) { }
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
      });
      navigator.hid.addEventListener('connect', async e => {
        if (device) return;                                     // already bound
        if (e.device && e.device.vendorId !== VENDOR) return;   // not our keyboard
        try { await beforeConnect(); } catch (_) { }
        const known = await navigator.hid.getDevices();
        const ok = await bindDevice(known, true);               // re-open the FRESH handle (control + screen)
        if (ok) onReconnected();
      });
    }

    return {
      connect, autoReconnect, bindDevice, sendFrame, buildPkt, findWritable, findScreen,
      resetStalls() { _sendStalls = 0; },
      get device() { return device; },
      get reportId() { return reportId; },
      get packLen() { return packLen; }
    };
  }

  return { create, findWritable, findScreen };
});
