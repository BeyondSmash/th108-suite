// th108-hid.test.js — unit tests for the pure parts of th108-hid.js (packet framing + interface selection).
// Run: node --test th108-hid.test.js   (no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const TH108Hid = require('./th108-hid.js');

// --- buildPkt (via a created instance; default packLen 64) ---
test('buildPkt frames the 64-byte packet: AA cmd len offLo offHi aux last 0, payload at byte 8', () => {
  const h = TH108Hid.create({});
  const pkt = h.buildPkt(0x32, 56, 0x1234, new Uint8Array([1, 2, 3]), 7, true);
  assert.equal(pkt.length, 64);
  assert.equal(pkt[0], 0xAA);
  assert.equal(pkt[1], 0x32);
  assert.equal(pkt[2], 56);
  assert.equal(pkt[3], 0x34);        // offset low byte
  assert.equal(pkt[4], 0x12);        // offset high byte
  assert.equal(pkt[5], 7);           // aux (amplitude)
  assert.equal(pkt[6], 1);           // isLast flag
  assert.equal(pkt[7], 0);
  assert.deepEqual([pkt[8], pkt[9], pkt[10]], [1, 2, 3]);
});

test('buildPkt: last=false → byte6 is 0; rest of packet zero-padded', () => {
  const h = TH108Hid.create({});
  const pkt = h.buildPkt(0x32, 3, 0, new Uint8Array([9, 9, 9]), 0, false);
  assert.equal(pkt[6], 0);
  assert.equal(pkt[63], 0);
});

// --- findWritable: must bind 0xFF68/0x61 explicitly, NOT the first output report ---
const mkCol = (usagePage, usage, reportId, reportCount) =>
  ({ usagePage, usage, outputReports: [{ reportId, items: [{ reportCount, reportSize: 8 }] }] });

test('findWritable picks 0xFF68/0x61 even when a screen iface (0xFF67) comes first', () => {
  const screen = { collections: [mkCol(0xFF67, 0x61, 0, 4104)] };
  const ctrl = { collections: [mkCol(0xFF68, 0x61, 0, 64)] };
  const w = TH108Hid.findWritable([screen, ctrl]);
  assert.equal(w.d, ctrl);
  assert.equal(w.packLen, 64);       // reportCount verbatim — do NOT +1
  assert.equal(w.usagePage, 0xFF68);
  assert.equal(w.usage, 0x61);
});

test('findWritable falls back: any 0xFF68, then any output report; null when none', () => {
  const ff68other = { collections: [mkCol(0xFF68, 0x99, 0, 64)] };
  assert.equal(TH108Hid.findWritable([ff68other]).d, ff68other);
  const anyOut = { collections: [mkCol(0x0001, 0x02, 0, 32)] };
  assert.equal(TH108Hid.findWritable([anyOut]).d, anyOut);
  const noOut = { collections: [{ usagePage: 0xFF68, usage: 0x61, outputReports: [] }] };
  assert.equal(TH108Hid.findWritable([noOut]), null);
});

// --- findScreen: largest output report wins (the 4104-byte screen iface) ---
test('findScreen picks the largest output report across devices', () => {
  const ctrl = { collections: [mkCol(0xFF68, 0x61, 0, 64)] };
  const screen = { collections: [mkCol(0xFF67, 0x61, 0, 4104)] };
  const best = TH108Hid.findScreen([ctrl, screen]);
  assert.equal(best.d, screen);
  assert.equal(best.bytes, 4104);
});

test('findScreen returns null with no output reports anywhere', () => {
  assert.equal(TH108Hid.findScreen([{ collections: [{ outputReports: [] }] }]), null);
});
