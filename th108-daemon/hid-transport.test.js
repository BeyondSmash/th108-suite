const test = require('node:test');
const assert = require('node:assert');
const { makeSender, probeTraffic } = require('./hid-transport.js');

// fake node-hid device: records writes, fires a 0x55 ACK 'data' event after each write
function fakeDevice() {
  const handlers = {};
  return {
    writes: [],
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    write(arr) {
      this.writes.push(arr);
      // arr = [reportId(0), 0xAA, cmd, len, offLo, offHi, 0, last, …] → echo a real-shaped ACK that
      // ECHOES the offset (buf[3]=offLo=arr[4], buf[4]=offHi=arr[5]), like the board; the gate matches on that.
      queueMicrotask(() => (handlers.data || []).forEach(cb => cb(Buffer.from([0x55, arr[2] || 0x32, 0x38, arr[4], arr[5], 0, arr[7], 0]))));
      return arr.length;
    },
    close() { this.closed = true; },
  };
}

test('sendFrame chunks into 56-byte payloads and waits for each ACK', async () => {
  const dev = fakeDevice();
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 200 });
  const flat = []; for (let k = 0; k < 104; k++) flat.push(k, 1, 2, 3);   // 416 entries
  const ok = await send(flat);
  assert.equal(ok, true);
  assert.equal(dev.writes.length, Math.ceil(416 / 56));   // 8 chunks
  assert.equal(dev.writes[0][0], 0x00);                   // leading reportId 0 (Windows)
  assert.equal(dev.writes[0][1], 0xAA);                   // framing byte
  assert.equal(dev.writes[0][2], 0x32);                   // cmd
  assert.equal(dev.writes[7][7], 1);                      // last chunk's isLast flag (pkt[6] → arr[7])
});

test('sendFrame returns false (no throw) when ACK never arrives', async () => {
  const dev = { on() {}, write() { return 0; }, close() {} };   // never ACKs
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 50 });
  const ok = await send([0, 1, 2, 3]);
  assert.equal(ok, false);
});

test('sendFrame returns false when write() throws', async () => {
  const dev = { on() {}, write() { throw new Error('device gone'); }, close() {} };
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 50 });
  assert.equal(await send([0, 1, 2, 3]), false);
});

test('ACK gate accepts only a matching-cmd 0x55 — a foreign 0x55 23 mid-await does NOT satisfy it', async () => {
  // each write emits a foreign 0x55 23 broadcast FIRST, then the real 0x55 32 ACK. The frame must
  // still complete, proving the foreign report was rejected and only the matching cmd satisfied.
  const handlers = {};
  const dev = {
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    write(arr) {
      queueMicrotask(() => {
        (handlers.data || []).forEach(cb => cb(Buffer.from([0x55, 0x23])));            // foreign — must NOT satisfy
        (handlers.data || []).forEach(cb => cb(Buffer.from([0x55, arr[2] || 0x32, 0x38, arr[4], arr[5], 0, arr[7], 0]))); // real ACK (echoes offset: arr[4]=offLo, arr[5]=offHi)
      });
      return arr.length;
    },
    close() {},
  };
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 200 });
  assert.equal(await send([0, 1, 2, 3]), true);
});

test('ACK gate stalls (no false hit) when ONLY a foreign-command 0x55 is returned', async () => {
  const handlers = {};
  const dev = {
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    write(arr) { queueMicrotask(() => (handlers.data || []).forEach(cb => cb(Buffer.from([0x55, 0x23])))); return arr.length; },
    close() {},
  };
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 50 });
  assert.equal(await send([0, 1, 2, 3]), false);   // 0x55 23 never satisfies a 0x32 gate → clean stall, not a wedge-inducing false hit
});

test('ACK gate rejects a same-cmd 0x55 32 carrying a STALE offset (the unsolicited-broadcast wedge)', async () => {
  // the board emits unsolicited 0x55 32 reports with a STALE offset (byte-identical to a real last-chunk
  // ACK). Here every write gets ONLY such a broadcast (offset 0x188), never the real ACK for offset 0.
  // The cmd-only gate would have accepted it (false hit → over-send → wedge); the offset gate rejects it.
  const handlers = {};
  const dev = {
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    write() { queueMicrotask(() => (handlers.data || []).forEach(cb => cb(Buffer.from([0x55, 0x32, 0x18, 0x88, 0x01, 0, 1, 0])))); return 8; },
    close() {},
  };
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 50 });
  assert.equal(await send([0, 1, 2, 3]), false);   // stale-offset 0x55 32 must NOT satisfy a write at offset 0 → clean stall, not a wedge-inducing false hit
});

test('flightRecorder captures recent writes + ACKs (the pre-mute trace the daemon dumps)', async () => {
  const dev = fakeDevice();
  const send = makeSender(dev, { packLen: 64, cmd: 0x32, ackTimeoutMs: 200 });
  await send([0, 1, 2, 3, 4, 5, 6, 7]);
  const dump = send.flightRecorder();
  assert.match(dump, /out {2}write/, 'records the chunk writes');
  assert.match(dump, /in {3}ACK/, 'records the matching-cmd ACKs');
});

// fake device for probeTraffic: lets the test emit unsolicited input reports (= another writer's ACKs)
function fakeListener() {
  const handlers = {};
  return {
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    removeListener(ev, cb) { handlers[ev] = (handlers[ev] || []).filter(f => f !== cb); },
    emit(ev, ...a) { (handlers[ev] || []).forEach(cb => cb(...a)); },
    listenerCount(ev) { return (handlers[ev] || []).length; },
  };
}

test('probeTraffic counts unsolicited input reports (another writer streaming)', async () => {
  const dev = fakeListener();
  const p = probeTraffic(dev, 80);
  dev.emit('data', Buffer.from([0x55, 0x32]));
  dev.emit('data', Buffer.from([0x55, 0x32]));
  assert.equal(await p, 2);
  assert.equal(dev.listenerCount('data'), 0, 'probe must detach its listener');
});

test('probeTraffic resolves 0 on a silent device', async () => {
  const dev = fakeListener();
  assert.equal(await probeTraffic(dev, 60), 0);
});

test('pickScreenPath picks the 0xFF67 screen interface on our vendor only', () => {
  const T = require('./hid-transport.js');
  const list = [
    { vendorId: 0x0C45, usagePage: 0xFF68, usage: 0x61, path: 'ctrl' },
    { vendorId: 0x0C45, usagePage: 0xFF67, usage: 0x61, path: 'screen' },
    { vendorId: 0x9999, usagePage: 0xFF67, usage: 0x61, path: 'other' },
  ];
  assert.equal(T.pickScreenPath(list), 'screen');
  assert.equal(T.pickScreenPath([list[0]]), null);
  assert.equal(T.pickScreenPath([list[2]]), null);
});
