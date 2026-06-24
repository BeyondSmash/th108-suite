// th108-binder.test.js — unit tests for the pure parts of th108-binder.js
// (keymap-entry encoders, palette integrity, default-entry lookup, the 0x22 write chunking,
//  and the read-validity gate that protects against committing a failed keymap read).
// Run: node --test th108-binder.test.js   (no DOM / no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const B = require('./th108-binder.js');

test('entry encoders match the hardware-confirmed 4-byte layouts', () => {
  assert.deepEqual(B.encodeNormal(0x2c), [0x02, 0x00, 0x2c, 0x00]);   // normal char (Space)
  assert.deepEqual(B.encodeMedia(0xE9), [0x03, 0xE9, 0x00, 0x00]);    // single-byte consumer usage (Volume +)
  assert.deepEqual(B.encodeMedia(0x192), [0x03, 0x92, 0x01, 0x00]);   // 16-bit LE — the wire-captured Calculator entry
  assert.deepEqual(B.encodeFunc(164), [0x0d, 0x00, 0x00, 164]);       // light function (Ambient Color)
  assert.deepEqual(B.encodeFunc(22), [0x0d, 0x00, 0x00, 22]);         // Lock Win (wire-captured)
});

test('entryBytes dispatches on the item shape', () => {
  assert.deepEqual(B.entryBytes({ label: 'A', hid: 4 }), [0x02, 0, 4, 0]);
  assert.deepEqual(B.entryBytes({ label: 'Mute', usage: 0xE2 }), [0x03, 0xE2, 0, 0]);
  assert.deepEqual(B.entryBytes({ label: 'Side', code: 23 }), [0x0d, 0, 0, 23]);
  assert.deepEqual(B.entryBytes({ label: 'LMB', bytes: [1, 1, 1, 0] }), [1, 1, 1, 0]);   // raw captured entry
  assert.notEqual(B.entryBytes({ label: 'LMB', bytes: [1, 1, 1, 0] }), undefined);
  const item = { label: 'LMB', bytes: [1, 1, 1, 0] };
  assert.notStrictEqual(B.entryBytes(item), item.bytes);              // defensive copy — callers must not mutate the palette
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
  assert.deepEqual(tabs, ['basic', 'extended', 'special', 'function', 'host']);
  for (const tab of B.PALETTE) { if (tab.key === 'host') continue;   // host items are daemon actions, not firmware encodings
    for (const item of tab.items) assert.ok(B.entryBytes(item), tab.key + '/' + item.label + ' must encode'); }
  const hostItems = B.PALETTE.find(t => t.key === 'host').items;
  assert.ok(hostItems.length && hostItems.every(i => i.host && !B.entryBytes(i)), 'host items carry an action, not a firmware encoding');
  const f = B.PALETTE.find(t => t.key === 'function').items;
  assert.ok(f.some(i => i.code === 46), 'knob-mute (46) stays available');
  assert.ok(f.some(i => i.code === 164), 'ambient color (164) present');
  assert.ok(f.some(i => i.code === 22), 'Lock Win (22, wire-captured) present');
  assert.ok(f.some(i => i.code === 2), 'Bluetooth Channel 1 (2, wire-captured) present');
  // full code table from the official Fn-layer list (fnlistarray.txt), cross-validated by captures
  [1, 3, 4, 5, 7, 11, 12, 13, 14, 15, 16, 17].forEach(c =>
    assert.ok(f.some(i => i.code === c), 'function code ' + c + ' present'));
  assert.equal(f.length, 27);
  const sp = B.PALETTE.find(t => t.key === 'special').items;
  assert.deepEqual(B.entryBytes(sp.find(i => i.label === 'Calculator')), [0x03, 0x92, 0x01, 0x00]);   // exact captured bytes
  assert.deepEqual(B.entryBytes(sp.find(i => i.label === 'Left Mouse Button')), [0x01, 0x01, 0x01, 0x00]);
  assert.deepEqual(B.entryBytes(sp.find(i => i.label === 'Right Mouse Button')), [0x01, 0x01, 0x02, 0x00]);    // captured 2026-06-11
  assert.deepEqual(B.entryBytes(sp.find(i => i.label === 'Middle Mouse Button')), [0x01, 0x01, 0x04, 0x00]);   // captured 2026-06-11
  assert.ok(!sp.some(i => /scroll/i.test(i.label)), 'mouse scroll is not mask-based — must NOT ship until captured');
  const basic = B.PALETTE.find(t => t.key === 'basic').items;
  assert.equal(basic[0].hid, 4);                                      // A
  assert.equal(basic.length, 26 + 10 + 11);                           // letters + digits + punctuation
});

test('validateBackup only passes a plausible 512-byte keymap (restore writes these bytes raw)', () => {
  const good = new Array(512).fill(0);
  Object.keys(B.DEFAULT_HID).forEach(v => { good[v * 4] = 0x02; good[v * 4 + 2] = B.DEFAULT_HID[v]; });
  assert.ok(B.validateBackup({ bytes: good, savedAt: 1 }) instanceof Uint8Array);
  assert.equal(B.validateBackup(null), null);
  assert.equal(B.validateBackup({ bytes: good.slice(0, 511) }), null);          // wrong length
  assert.equal(B.validateBackup({ bytes: new Array(512).fill(0) }), null);      // empty map = failed read
  const junk = good.slice(); junk[3] = 999;
  assert.equal(B.validateBackup({ bytes: junk }), null);                        // non-byte values
});

test('Fn: factory entry is HID 175 (wire-captured) but Fn stays non-bindable', () => {
  assert.equal(B.DEFAULT_HID[B.FN_VAL], 175);                         // 02 00 af 00 seen in every capture
  assert.equal(B.defaultEntry(B.FN_VAL), null);                       // still excluded — overwriting Fn loses the FN layer
});

test('SPACE_FUNCS are all light functions a Spacebar tap can cycle (Ambient Color dropped — its effect cycle covers colors)', () => {
  assert.equal(B.SPACE_FUNCS.length, 5);
  for (const f of B.SPACE_FUNCS) assert.ok([23, 24, 27, 29, 165].includes(f.code));
  assert.ok(!B.SPACE_FUNCS.some(f => f.code === 164), 'Ambient Color stays out of the toggle card');
  const pal = B.PALETTE.find(t => t.key === 'function').items;
  assert.ok(pal.some(i => i.code === 164), 'code 164 remains available via Function Keys');
});

test('advanced-key encoders match the wire captures byte-for-byte', () => {
  assert.deepEqual(B.encodeCB(0xE2, 0xE4, 0x06), [0x07, 0xE2, 0xE4, 0x06]);   // CB_ex1: M = L-Alt+R-Ctrl+C
  assert.deepEqual(B.encodeMT(0x1c, 0x2b, 0x28), [0x09, 0x1c, 0x2b, 0x28]);   // MT_ex1: Y = tap Y / hold Tab / 40
  assert.deepEqual(B.encodeMT(0x1c, 0x2b), [0x09, 0x1c, 0x2b, 0x28]);         // 40 = the captured default time
  assert.deepEqual(B.encodeTGL(0x15), [0x0a, 0x15, 0x00, 0x00]);              // Tgl_ex1: K toggles R
  assert.deepEqual(B.encodeSOCD(0x50, 0x51), [0x0b, 0x03, 0x50, 0x51]);       // SOCD_ex1: ←/↓, mode 3 only
});

test('MODIFIERS are exactly the 8 HID modifier usages', () => {
  assert.deepEqual(B.MODIFIERS.map(m => m.hid), [0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7]);
  assert.ok(B.MODIFIERS.every(m => typeof m.label === 'string' && m.label));
});

test('normalizeMods migrates legacy label-only marks and validates stored bytes', () => {
  const m = B.normalizeMods({
    49: 'Calculator',                                       // pre-group-toggle format: bare label
    50: { label: 'Mute', bytes: [0x03, 0xE2, 0, 0] },
    51: { label: 'Bad', bytes: [1, 2, 3] },                 // wrong length — bytes dropped, mark kept
    52: { label: 'Off', bytes: [0x02, 0, 4, 0], off: true },
    53: { label: 'Lone off', off: true },                   // off without bytes can't round-trip → active
    54: 7, 55: { nolabel: true }                            // junk values vanish
  });
  assert.deepEqual(m[49], { label: 'Calculator' });
  assert.deepEqual(m[50], { label: 'Mute', bytes: [0x03, 0xE2, 0, 0] });
  assert.deepEqual(m[51], { label: 'Bad' });
  assert.equal(m[52].off, true);
  assert.deepEqual(m[53], { label: 'Lone off' });
  assert.equal(m[54], undefined);
  assert.equal(m[55], undefined);
  assert.deepEqual(B.normalizeMods(null), {});
});

test('groupPlan → typing parks every active remapped key on its factory character', () => {
  const mods = {
    49: { label: 'Calculator', bytes: [0x03, 0x92, 0x01, 0] },        // A
    83: { label: 'Side Light Color', bytes: [0x0d, 0, 0, 24] },       // Space
    50: { label: 'old mark' }                                         // legacy, no bytes — skipped
  };
  const p = B.groupPlan(mods, true);
  assert.deepEqual(p.writes.sort((a, b) => a.idx - b.idx),
    [{ idx: 49, bytes: [0x02, 0, 4, 0] }, { idx: 83, bytes: [0x02, 0, 0x2c, 0] }]);
  assert.equal(p.next[49].off, true);
  assert.equal(p.next[83].off, true);
  assert.equal(p.next[50].off, undefined);                            // byte-less marks stay active
  assert.deepEqual(mods[49], { label: 'Calculator', bytes: [0x03, 0x92, 0x01, 0] });   // input not mutated
});

test('groupPlan → custom re-applies the stored bytes; a full round-trip is lossless', () => {
  const mods = { 49: { label: 'Calculator', bytes: [0x03, 0x92, 0x01, 0] } };
  const there = B.groupPlan(mods, true);
  const back = B.groupPlan(there.next, false);
  assert.deepEqual(back.writes, [{ idx: 49, bytes: [0x03, 0x92, 0x01, 0] }]);
  assert.deepEqual(back.next, mods);
  assert.equal(B.modsOff(mods), false);
  assert.equal(B.modsOff(there.next), true);
  assert.equal(B.modsOff(back.next), false);
});

test('groupPlan never parks a key it could not default, nor re-parks an already-parked key', () => {
  const p = B.groupPlan({ 85: { label: 'X', bytes: [0x02, 0, 4, 0] } }, true);   // Fn has no default entry
  assert.deepEqual(p.writes, []);
  assert.equal(p.next[85].off, undefined);
  const p2 = B.groupPlan({ 49: { label: 'C', bytes: [0x03, 0x92, 0x01, 0], off: true } }, true);
  assert.deepEqual(p2.writes, []);                                    // second → typing pass is a no-op
});

test('normalizeMods preserves a valid SOCD pair and drops a dangling one', () => {
  const m = B.normalizeMods({
    88: { label: 'SOCD ←', bytes: [0x0b, 3, 0x50, 0x51], pair: 89 },
    89: { label: 'SOCD ↓', bytes: [0x0b, 3, 0x50, 0x51], pair: 88 },
    56: { label: 'TGL R', bytes: [0x0a, 0x15, 0, 0], pair: 999 },    // out of range → dropped
    50: { label: 'X', bytes: [0x02, 0, 4, 0], pair: 51 },            // partner has no entry → dropped
    40: { label: 'Y', bytes: [0x02, 0, 4, 0], pair: 40 }             // self-pair → dropped
  });
  assert.equal(m[88].pair, 89);
  assert.equal(m[89].pair, 88);
  assert.equal(m[56].pair, undefined);
  assert.equal(m[50].pair, undefined);
  assert.equal(m[40].pair, undefined);
});

test('a SOCD pair survives the group-toggle round-trip', () => {
  const mods = { 88: { label: 'SOCD ←', bytes: [0x0b, 3, 0x50, 0x51], pair: 89 },
                 89: { label: 'SOCD ↓', bytes: [0x0b, 3, 0x50, 0x51], pair: 88 } };
  const there = B.groupPlan(mods, true);
  assert.deepEqual(there.writes.map(w => w.idx).sort((a, b) => a - b), [88, 89]);   // both keys park
  assert.equal(there.next[88].pair, 89);                                            // pair survives
  const back = B.groupPlan(there.next, false);
  assert.deepEqual(back.next, mods);                                                // lossless round-trip
});

test('restoreTargets pulls in the SOCD partner, never Fn or unknown keys', () => {
  const mods = { 88: { label: 'SOCD ←', bytes: [0x0b, 3, 0x50, 0x51], pair: 89 } };
  assert.deepEqual(B.restoreTargets(mods, 88), [88, 89]);                 // pair → both restored
  assert.deepEqual(B.restoreTargets(mods, 50), [50]);                     // unpaired key → itself
  assert.deepEqual(B.restoreTargets({ 50: { label: 'x', bytes: [2, 0, 4, 0], pair: 85 } }, 50), [50]);   // Fn partner excluded
});

test('every color toggle carries the static-color caveat and swaps to its own zone\'s effect toggle', () => {
  const pairs = { 24: 23, 29: 27 };   // color code → effect code, per zone (ambient has no color toggle anymore)
  for (const [color, effect] of Object.entries(pairs)) {
    const f = B.SPACE_FUNCS.find(x => x.code === +color);
    assert.ok(f.note && /static-color/.test(f.note), f.name + ' has the caveat');
    assert.equal(f.swapTo, +effect, f.name + ' swaps to its zone effect');
    assert.ok(B.SPACE_FUNCS.some(x => x.code === f.swapTo), 'swap target exists in SPACE_FUNCS');
  }
  for (const f of B.SPACE_FUNCS) if (![24, 29].includes(f.code)) assert.ok(!f.note, 'effect toggles carry no caveat');
});
