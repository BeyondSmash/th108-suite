// th108-binder.test.js — unit tests for the pure parts of th108-binder.js
// (keymap-entry encoders, palette integrity, default-entry lookup, the 0x22 write chunking,
//  and the read-validity gate that protects against committing a failed keymap read).
// Run: node --test th108-binder.test.js   (no DOM / no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const B = require('./th108-binder.js');

test('entry encoders match the hardware-confirmed 4-byte layouts', () => {
  assert.deepEqual(B.encodeNormal(0x2c), [0x02, 0x00, 0x2c, 0x00]);   // normal char (Space)
  assert.deepEqual(B.encodeMedia(0xE9), [0x03, 0xE9, 0x00, 0x00]);    // consumer usage (Volume +)
  assert.deepEqual(B.encodeFunc(164), [0x0d, 0x00, 0x00, 164]);       // light function (Ambient Color)
});

test('entryBytes dispatches on the item shape', () => {
  assert.deepEqual(B.entryBytes({ label: 'A', hid: 4 }), [0x02, 0, 4, 0]);
  assert.deepEqual(B.entryBytes({ label: 'Mute', usage: 0xE2 }), [0x03, 0xE2, 0, 0]);
  assert.deepEqual(B.entryBytes({ label: 'Side', code: 23 }), [0x0d, 0, 0, 23]);
  assert.equal(B.entryBytes({ label: 'nothing' }), null);
});

test('defaultEntry reverts to the factory character; Fn and unknown keys refuse', () => {
  assert.deepEqual(B.defaultEntry(B.SPACE_VAL), [0x02, 0, 0x2c, 0]);  // Space → HID 0x2c
  assert.deepEqual(B.defaultEntry(49), [0x02, 0, 4, 0]);              // A (value 49) → HID 4
  assert.equal(B.defaultEntry(B.FN_VAL), null);                       // Fn is firmware-special
  assert.equal(B.defaultEntry(127), null);                            // not a key on this board
});

test('setEntry writes the 4 bytes at offset 4·keyValue', () => {
  const km = new Uint8Array(512);
  B.setEntry(km, 86, [0x0d, 0, 0, 164]);                              // Super → Ambient Color (the hw-confirmed binding)
  assert.deepEqual([...km.slice(86 * 4, 86 * 4 + 4)], [0x0d, 0, 0, 164]);
  assert.equal(km.reduce((n, b) => n + b, 0), 0x0d + 164);            // nothing else touched
});

test('keymapChunks frames the full 512 bytes as 10 cmd-0x22 chunks, last flag only on the final', () => {
  const km = new Uint8Array(512).map((_, i) => i & 0xFF);
  const chunks = B.keymapChunks(km);
  assert.equal(chunks.length, 10);
  assert.equal(chunks.reduce((n, c) => n + c.len, 0), 512);
  assert.deepEqual(chunks.map(c => c.off), [0, 56, 112, 168, 224, 280, 336, 392, 448, 504]);
  assert.equal(chunks[9].len, 8);                                     // 512 - 504
  assert.deepEqual(chunks.map(c => c.last), [false, false, false, false, false, false, false, false, false, true]);
  assert.deepEqual(chunks[1].payload, [...km.slice(56, 112)]);        // payloads carry the right slices
});

test('keymapLooksValid accepts a populated keymap, rejects an empty/failed read', () => {
  const good = new Uint8Array(512);
  Object.keys(B.DEFAULT_HID).forEach(v => { good[v * 4] = 0x02; });   // 104 populated entries
  assert.equal(B.keymapLooksValid(good), true);
  assert.equal(B.keymapLooksValid(new Uint8Array(512)), false);       // all zeros = failed read
  const sparse = new Uint8Array(512); for (let v = 0; v < 40; v++) sparse[v * 4] = 0x02;
  assert.equal(B.keymapLooksValid(sparse), false);                    // half-missed read
});

test('palette holds only hardware-confirmed encodings and the knob-mute option', () => {
  const tabs = B.PALETTE.map(t => t.key);
  assert.deepEqual(tabs, ['basic', 'extended', 'special', 'function']);
  for (const tab of B.PALETTE) for (const item of tab.items) assert.ok(B.entryBytes(item), tab.key + '/' + item.label + ' must encode');
  const f = B.PALETTE.find(t => t.key === 'function').items;
  assert.ok(f.some(i => i.code === 46), 'knob-mute (46) stays available');
  assert.ok(f.some(i => i.code === 164), 'ambient color (164) present');
  const basic = B.PALETTE.find(t => t.key === 'basic').items;
  assert.equal(basic[0].hid, 4);                                      // A
  assert.equal(basic.length, 26 + 10 + 11);                           // letters + digits + punctuation
});

test('SPACE_FUNCS are all light functions a Spacebar tap can cycle', () => {
  assert.equal(B.SPACE_FUNCS.length, 6);
  for (const f of B.SPACE_FUNCS) assert.ok([23, 24, 27, 29, 164, 165].includes(f.code));
});
