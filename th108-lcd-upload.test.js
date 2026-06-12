// th108-lcd-upload.test.js — unit tests for the shared LCD flash-upload engine (cmd 0x50).
// Golden values transcribed from the hardware-proven uploader in th108-lcd.js.
// Run: node --test th108-lcd-upload.test.js   (no DOM / no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const U = require('./th108-lcd-upload.js');

test('packRgb565 packs RGBA → RGB565 with optional byte swap', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);   // red, green
  const be = U.packRgb565(rgba, false);
  assert.deepEqual([...be], [0xF8, 0x00, 0x07, 0xE0]);
  const le = U.packRgb565(rgba, true);
  assert.deepEqual([...le], [0x00, 0xF8, 0xE0, 0x07]);
});

test('buildPktTFT matches the official framing (th108-lcd.js source of truth)', () => {
  const data = new Uint8Array(4096).fill(7);
  const pkt = U.buildPktTFT(2, 30720 * 3, data, 4104);
  assert.equal(pkt.length, 4104);
  // totalChunks = ceil(92160/4096) = 23; ADDR/4096 = 6619136/4096 = 1616 = 0x0650 → lo 0x50, hi 0x06
  assert.deepEqual([...pkt.slice(0, 8)], [0xAA, 0x50, 2, 0, 23, 0, 0x50, 0x06]);
  assert.equal(pkt[8], 7);
});

test('buildHeader: frameCount + per-frame delay bytes (ms/2), 0 terminator, 0xFF fill', () => {
  const h = U.buildHeader([{ delayMs: 100 }, { delayMs: 510 }, { delayMs: 100 }]);
  assert.equal(h.length, 256);
  assert.equal(h[0], 3);
  assert.equal(h[1], 50);       // 100/2
  assert.equal(h[2], 255);      // 510/2 clamped
  assert.equal(h[3], 0);        // terminator at header[frameCount]
  assert.equal(h[10], 255);     // fill
});

test('planUpload: even frame count gets the last frame duplicated (bottom-row glitch guard)', () => {
  const f = b => ({ bytes: new Uint8Array(30720).fill(b), delayMs: 100 });
  const odd = U.planUpload([f(1), f(2), f(3)]);
  assert.equal(odd.frameCount, 3);
  assert.equal(odd.totalSize, 3 * 30720);
  assert.equal(odd.chunkCount, Math.ceil((3 * 30720) / 4096));
  const even = U.planUpload([f(1), f(2)]);
  assert.equal(even.frameCount, 3);                          // duplicated to odd
  assert.equal(even.data.length, 3 * 30720);
  assert.equal(even.data[2 * 30720], 2);                     // dup of last frame
});

test('planUpload enforces the 33-frame region cap (overflow corrupts config flash)', () => {
  const f = { bytes: new Uint8Array(30720), delayMs: 100 };
  assert.throws(() => U.planUpload(new Array(34).fill(f)), /33/);
  assert.throws(() => U.planUpload([{ bytes: new Uint8Array(100), delayMs: 1 }]), /30720/);
});

test('create().upload sends each chunk once, ACK-gated, and aborts WITHOUT re-send on stall', async () => {
  const sent = [];
  let inputCb = null, ackAll = true;
  const eng = U.create({
    sendChunk: async (pkt) => { sent.push(pkt[2] | (pkt[3] << 8)); if (ackAll || sent.length < 3) setImmediate(() => inputCb(new Uint8Array([0x55, 0x41]))); },
    onInput: (cb) => { inputCb = cb; return () => { inputCb = null; }; },
    log: () => {},
    timeouts: { erase: 50, chunk: 50, settle: 1 },   // test-speed windows
  });
  const plan = U.planUpload([{ bytes: new Uint8Array(U.FB), delayMs: 100 }]);
  assert.equal((await eng.upload(plan, () => {})).ok, true);
  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7]);          // 30720B → 8 chunks, each exactly once

  sent.length = 0; ackAll = false;                            // ACKs stop after chunk 1
  const r = await eng.upload(plan, () => {});
  assert.equal(r.ok, false);
  assert.match(r.error, /no ACK/);
  assert.deepEqual(sent, [0, 1, 2], 'aborts cleanly: the stalled chunk is never re-sent');
});

test('chunkData: chunk 0 = 256B header + first 3840 data bytes; later chunks offset by -256', () => {
  const plan = U.planUpload([{ bytes: new Uint8Array(30720).map((_, i) => i & 0xFF), delayMs: 100 }]);
  const c0 = U.chunkData(plan, 0);
  assert.equal(c0.length, 4096);
  assert.equal(c0[0], 1);                                    // header[0] = frameCount
  assert.equal(c0[256], 0);                                  // data byte 0
  assert.equal(c0[257], 1);
  const c1 = U.chunkData(plan, 1);
  assert.equal(c1[0], 3840 & 0xFF);                          // continues at data offset 3840
});
