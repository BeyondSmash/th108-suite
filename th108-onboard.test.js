// th108-onboard.test.js — unit tests for the pure part of th108-onboard.js
// (the 16-byte cmd-0x23 allledPack builder; byte layout hardware-confirmed on the TH108 V2 PRO).
// Run: node --test th108-onboard.test.js   (no DOM / no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const OB = require('./th108-onboard.js');

test('packAllled lays out effect/primary/255/secondary/colorful/brightness/speed, zero tail', () => {
  const a = OB.packAllled({ effect: 7, primary: [10, 20, 30], secondary: [40, 50, 60], colorful: false, brightness: 3, speed: 5 });
  assert.equal(a.length, 16);
  assert.deepEqual([...a], [7, 10, 20, 30, 255, 40, 50, 60, 0, 3, 5, 0, 0, 0, 0, 0]);
});

test('packAllled colorful flag → byte 8 = 1', () => {
  const a = OB.packAllled({ effect: 8, primary: [0, 0, 0], secondary: [0, 0, 0], colorful: true, brightness: 6, speed: 1 });
  assert.equal(a[8], 1);
});

test('packAllled clamps brightness/speed to 1..6 and rounds', () => {
  const a = OB.packAllled({ effect: 1, primary: [0, 0, 0], secondary: [0, 0, 0], colorful: false, brightness: 0, speed: 99 });
  assert.equal(a[9], 1);                  // 0 → floor 1
  assert.equal(a[10], 6);                 // 99 → ceil 6
  const b = OB.packAllled({ effect: 1, primary: [0, 0, 0], secondary: [0, 0, 0], colorful: false, brightness: 2.6, speed: NaN });
  assert.equal(b[9], 3);                  // rounds
  assert.equal(b[10], 1);                 // NaN → default 1
});
