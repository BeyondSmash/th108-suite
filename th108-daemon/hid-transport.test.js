const test = require('node:test');
const assert = require('node:assert');
const { makeSender } = require('./hid-transport.js');

// fake node-hid device: records writes, fires a 0x55 ACK 'data' event after each write
function fakeDevice() {
  const handlers = {};
  return {
    writes: [],
    on(ev, cb) { (handlers[ev] ||= []).push(cb); },
    write(arr) {
      this.writes.push(arr);
      // arr = [reportId(0), 0xAA, cmd, …] → echo a 0x55 <cmd> ACK like the real board
      queueMicrotask(() => (handlers.data || []).forEach(cb => cb(Buffer.from([0x55, arr[2] || 0x32]))));
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
