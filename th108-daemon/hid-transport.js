// th108-daemon/hid-transport.js — open the TH108 0xFF68 control interface and stream frames to it.
// ACK-gated: the board replies with a 0x55 input report per write; we wait for it before the next
// write so its command FIFO can't overrun and wedge the HID pipe (see the lighting-protocol notes).
const HID = require('node-hid');
const VENDOR = 0x0C45, USAGE_PAGE = 0xFF68, USAGE = 0x61;

const ts = () => new Date().toTimeString().slice(0, 8);
const hex8 = (b) => Array.from(b.slice(0, 8)).map((x) => x.toString(16).padStart(2, '0')).join(' ');

// Find the path of the writable per-key control interface (NOT the screen iface 0xFF67).
function findPath() {
  const list = HID.devices();
  const m = list.find(d => d.vendorId === VENDOR && d.usagePage === USAGE_PAGE && d.usage === USAGE)
        || list.find(d => d.vendorId === VENDOR && d.usagePage === USAGE_PAGE);
  return m ? m.path : null;
}

function openDevice(path) {
  const d = new HID.HID(path);
  // node-hid emits 'error' from its read pump (wedged board, or a handle closed mid-read) — with no
  // listener that's an UNCAUGHT exception that kills the whole daemon. Swallow it: the send/probe
  // paths already detect and handle a dead device (stall → close → reopen with backoff).
  d.on('error', () => {});
  return d;
}

// Build an ACK-gated sender bound to one open device.
// Returns async sendFrame(flat) -> true on success, false on stall (never throws, so the loop survives).
function makeSender(device, { packLen = 64, cmd = 0x32, ackTimeoutMs = 800 } = {}) {
  let ackWaiter = null, noise = 0, falseHits = 0, ackSigLogged = false;
  // Flight recorder: a small ring of the most recent input reports + writes, dumped to daemon.log the
  // instant a mute is detected — so we capture the moments BEFORE the board goes silent (the data the
  // mute investigation has always lacked: was there a false hit, a timing gap, a broadcast?), not just
  // the silence itself. Pure observation — it does not touch the gate/write logic.
  const trace = [];
  const rec = (e) => { trace.push(e); if (trace.length > 48) trace.shift(); };
  device.on('data', (buf) => {
    if (!buf || buf[0] !== 0x55) return;
    const pending = !!ackWaiter, isAck = pending && buf[1] === cmd;
    rec({ t: Date.now(), dir: 'in', tag: isAck ? 'ACK' : pending ? 'FALSE-HIT' : 'bcast', s: hex8(buf) });
    // A genuine ACK echoes the COMMAND byte we wrote (0x32 lighting → 0x55 32; the SAME filter the
    // page uses on its reads — see webhid-test.html "0x55 <cmd>, rejects stray broadcasts"). Gating
    // on the cmd match stops a FOREIGN-command report — e.g. the onboard engine's 0x55 23, chatty
    // right after a factory reset — from falsely satisfying a 0x32 write's gate, which would let us
    // outrun the board's FIFO into a wedge. (Confirmed safe: real 0x32 ACKs carry buf[1]=0x32, which
    // is exactly what the board's unsolicited 0x55 32 reports below show.)
    if (isAck) {
      if (!ackSigLogged) {   // capture the real ACK's full byte signature ONCE per device — the only way to later tell a true 0x32 ACK from a spurious 0x55 32 broadcast (identical in the bytes we gate on) is to diff their payloads
        ackSigLogged = true;
        console.log(ts() + ` … real ${cmd.toString(16)} ACK signature: ${hex8(buf)} (diff this against the unsolicited 0x55 ${cmd.toString(16)} broadcasts to find a payload discriminator)`);
      }
      const w = ackWaiter; ackWaiter = null; w(true);
      return;
    }
    noise++;
    if (pending) {
      // A 0x55 with a DIFFERENT cmd arrived while we await our ACK — exactly the false hit this guard
      // now rejects (pre-guard it satisfied the gate → FIFO overrun → wedge). Rare + important → log it.
      falseHits++;
      if (falseHits === 1 || falseHits % 10 === 0)
        console.log(ts() + ` … 0x55 ${hex8(buf)} arrived mid-await for a ${cmd.toString(16)} ACK — REJECTED as a false hit (#${falseHits}); pre-guard this is what outran the FIFO`);
    } else if (noise === 1 || noise % 50 === 0) {
      // 0x55 with NO write pending = a genuine firmware broadcast. Harmless on its own; logged with
      // FULL bytes so a same-cmd (0x55 32) broadcast can be diffed against the real ACK signature above.
      console.log(ts() + ` … unsolicited 0x55 ${hex8(buf)} broadcast from board (#${noise}) — no write pending; logged to diff against the real ACK signature`);
    }
  });
  const waitAck = () => new Promise((res) => {
    ackWaiter = res;
    setTimeout(() => { if (ackWaiter === res) { ackWaiter = null; res(false); } }, ackTimeoutMs);
  });

  const sendFrame = async function (flat) {
    const room = packLen - 8, n = Math.max(1, Math.ceil(flat.length / room));
    for (let c = 0; c < n; c++) {
      const off = c * room, chunk = flat.slice(off, off + room), last = c === n - 1;
      const pkt = Buffer.alloc(packLen);
      pkt[0] = 0xAA; pkt[1] = cmd; pkt[2] = chunk.length;
      pkt[3] = off & 0xFF; pkt[4] = (off >> 8) & 0xFF; pkt[5] = 0; pkt[6] = last ? 1 : 0;
      for (let i = 0; i < chunk.length; i++) pkt[8 + i] = chunk[i];
      const ack = waitAck();                       // arm BEFORE the write so we can't miss the ACK
      rec({ t: Date.now(), dir: 'out', off, last: last ? 1 : 0, len: chunk.length });
      try { device.write([0x00, ...pkt]); }        // leading reportId 0 (Windows)
      catch { return false; }
      if (!(await ack)) return false;              // stalled → drop frame; caller keeps looping / reconnects
    }
    return true;
  };
  // Dump the flight recorder as text (timestamps relative to the latest event). The daemon calls this
  // at the mute transition — capturing what the board+host were doing in the ~second before silence.
  sendFrame.flightRecorder = () => {
    if (!trace.length) return '(no recent traffic recorded)';
    const t0 = trace[trace.length - 1].t;
    return trace.map((e) => e.dir === 'in'
      ? `${String(e.t - t0).padStart(6)}ms  in   ${e.tag.padEnd(9)} ${e.s}`
      : `${String(e.t - t0).padStart(6)}ms  out  write off=${e.off} last=${e.last} len=${e.len}`).join('\n');
  };
  return sendFrame;
}

// Listen on a freshly-opened handle WITHOUT writing anything: input reports arriving on their own
// (0x55 ACKs answering someone ELSE's writes, or FN-key broadcasts) mean another host process is
// driving the device — e.g. a WebHID page whose yield expired but which is still alive and streaming.
// Writing too would interleave two 0x32 streams and wedge the board's pipe; callers must back off.
function probeTraffic(device, ms = 1500) {
  return new Promise((resolve) => {
    let n = 0;
    const onData = () => { n++; };
    device.on('data', onData);
    setTimeout(() => { try { device.removeListener('data', onData); } catch {} resolve(n); }, ms);
  });
}

// ----- screen interface (usagePage 0xFF67, ~4104B output reports) — cmd 0x50 LCD flash upload -----
const SCREEN_PAGE = 0xFF67;
function pickScreenPath(list) {   // pure (unit-tested): the 0xFF67 iface on our vendor
  const d = list.find(d => d.vendorId === VENDOR && d.usagePage === SCREEN_PAGE);
  return d ? d.path : null;
}
function findScreenPath() { try { return pickScreenPath(HID.devices()); } catch { return null; } }
// Open the screen iface and adapt it to th108-lcd-upload's transport contract
// ({sendChunk, onInput}). Caller owns close(); never hold this open between uploads.
function openScreen() {
  const p = findScreenPath(); if (!p) return null;
  const d = new HID.HID(p);
  d.on('error', () => {});   // a vanished handle must not crash the daemon (same rule as openDevice)
  return {
    raw: d,
    send: (pkt) => new Promise((res, rej) => { try { d.write([0x00, ...pkt]); res(); } catch (e) { rej(e); } }),
    onInput: (cb) => { const h = buf => cb(new Uint8Array(buf)); d.on('data', h); return () => { try { d.removeListener('data', h); } catch {} }; },
    close: () => { try { d.close(); } catch {} },
  };
}

module.exports = { findPath, openDevice, makeSender, probeTraffic, VENDOR, USAGE_PAGE, USAGE,
                   SCREEN_PAGE, pickScreenPath, findScreenPath, openScreen };
