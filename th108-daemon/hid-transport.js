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

function openDevice(path) { return new HID.HID(path); }

// Build an ACK-gated sender bound to one open device.
// Returns async sendFrame(flat) -> true on success, false on stall (never throws, so the loop survives).
function makeSender(device, { packLen = 64, cmd = 0x32, ackTimeoutMs = 800 } = {}) {
  let ackWaiter = null;
  device.on('data', (buf) => {
    if (buf && buf[0] === 0x55 && ackWaiter) { const w = ackWaiter; ackWaiter = null; w(true); }
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

module.exports = { findPath, openDevice, makeSender, VENDOR, USAGE_PAGE, USAGE };
