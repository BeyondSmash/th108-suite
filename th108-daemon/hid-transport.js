// th108-daemon/hid-transport.js — open the TH108 0xFF68 control interface and stream frames to it.
// ACK-gated: the board replies with a 0x55 input report per write; we wait for it before the next
// write so its command FIFO can't overrun and wedge the HID pipe (see the lighting-protocol notes).
const HID = require('node-hid');
const VENDOR = 0x0C45, USAGE_PAGE = 0xFF68, USAGE = 0x61;

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
  let ackWaiter = null, noise = 0;
  device.on('data', (buf) => {
    if (buf && buf[0] === 0x55 && ackWaiter) { const w = ackWaiter; ackWaiter = null; w(true); }
    else if (buf && buf[0] === 0x55) {
      // 0x55 with NO write pending = firmware broadcast (e.g. 55 23 from the onboard-effect engine).
      // Dangerous: one of these landing while a write IS pending falsely satisfies the ACK gate →
      // we outpace the board's FIFO → wedge. Count + log them so the rate shows up in daemon.log.
      noise++;
      if (noise === 1 || noise % 50 === 0) console.log(new Date().toTimeString().slice(0, 8) + ` … unsolicited 0x55 ${(buf[1] || 0).toString(16).padStart(2, '0')} broadcast from board (#${noise}) — firmware is chatty; ACK gate may be getting false hits`);
    }
  });
  const waitAck = () => new Promise((res) => {
    ackWaiter = res;
    setTimeout(() => { if (ackWaiter === res) { ackWaiter = null; res(false); } }, ackTimeoutMs);
  });

  return async function sendFrame(flat) {
    const room = packLen - 8, n = Math.max(1, Math.ceil(flat.length / room));
    for (let c = 0; c < n; c++) {
      const off = c * room, chunk = flat.slice(off, off + room), last = c === n - 1;
      const pkt = Buffer.alloc(packLen);
      pkt[0] = 0xAA; pkt[1] = cmd; pkt[2] = chunk.length;
      pkt[3] = off & 0xFF; pkt[4] = (off >> 8) & 0xFF; pkt[5] = 0; pkt[6] = last ? 1 : 0;
      for (let i = 0; i < chunk.length; i++) pkt[8 + i] = chunk[i];
      const ack = waitAck();                       // arm BEFORE the write so we can't miss the ACK
      try { device.write([0x00, ...pkt]); }        // leading reportId 0 (Windows)
      catch { return false; }
      if (!(await ack)) return false;              // stalled → drop frame; caller keeps looping / reconnects
    }
    return true;
  };
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

module.exports = { findPath, openDevice, makeSender, probeTraffic, VENDOR, USAGE_PAGE, USAGE };
