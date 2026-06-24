'use strict';
const test = require('node:test');
const assert = require('node:assert');
const HA = require('./host-actions.js');

test('normalize migrates the old single-key format', () => {
  const out = HA.normalize([{ led: 102, action: 'micToggle' }]);
  assert.deepEqual(out, [{ trigger: { type: 'key', led: 102 }, action: { type: 'micToggle' } }]);
});

test('normalize accepts + defaults the new trigger types', () => {
  const out = HA.normalize([
    { trigger: { type: 'multitap', led: 5 }, action: { type: 'profileNext' } },
    { trigger: { type: 'chord', led: 71, mods: { ctrl: true, shift: true } }, action: { type: 'micToggle' } },
    { trigger: { type: 'hold', led: 9, holdMs: 800 }, action: { type: 'profileSelect', index: 3 } },
  ]);
  assert.equal(out[0].trigger.count, 2);          // multitap default count
  assert.equal(out[0].trigger.windowMs, 400);     // multitap default window
  assert.deepEqual(out[1].trigger.mods, { ctrl: true, alt: false, shift: true, meta: false });
  assert.equal(out[2].trigger.holdMs, 800);
  assert.equal(out[2].action.index, 3);
});

test('normalize drops invalid entries + clamps out-of-range values', () => {
  const out = HA.normalize([
    { trigger: { type: 'bogus', led: 1 }, action: { type: 'micToggle' } },   // bad trigger type
    { led: 1, action: 'doesNotExist' },                                       // bad action
    null, 42,                                                                 // junk
    { trigger: { type: 'multitap', led: 1, count: 99, windowMs: 9 }, action: { type: 'launch', target: '  notepad.exe ' } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].trigger.count, 8);          // clamped to max
  assert.equal(out[0].trigger.windowMs, 120);     // clamped to min
  assert.equal(out[0].action.target, 'notepad.exe');   // trimmed
});

test('normalize keeps macro steps as KeyboardEvent.code + modifier flags', () => {
  const out = HA.normalize([{ trigger: { type: 'key', led: 1 }, action: { type: 'macro', steps: [
    { code: 'KeyC', ctrl: true }, { code: 'KeyV', ctrl: true, shift: false }, { bogus: 1 } ] } }]);
  assert.deepEqual(out[0].action.steps, [
    { code: 'KeyC', ctrl: true, alt: false, shift: false, meta: false },
    { code: 'KeyV', ctrl: true, alt: false, shift: false, meta: false }]);
});

test('chordMatches is exact (Ctrl+M does not fire a Ctrl+Shift+M binding)', () => {
  const want = { ctrl: true, shift: true };
  assert.ok(HA.chordMatches(want, { ctrl: true, shift: true }));
  assert.ok(!HA.chordMatches(want, { ctrl: true }));               // missing shift
  assert.ok(!HA.chordMatches(want, { ctrl: true, shift: true, alt: true }));  // extra alt
  assert.ok(HA.chordMatches({}, {}));                              // bare key, no mods
  assert.ok(!HA.chordMatches({}, { ctrl: true }));                 // bare key won't fire while Ctrl held
});

test('tapFires counts presses within the window and resets on fire', () => {
  let taps = [];
  let r = HA.tapFires(taps, 1000, 2, 400); assert.equal(r.fire, false); taps = r.taps;   // 1st
  r = HA.tapFires(taps, 1200, 2, 400); assert.equal(r.fire, true);  taps = r.taps;        // 2nd within 400ms → fire
  assert.deepEqual(taps, []);                                                              // reset
  r = HA.tapFires(taps, 2000, 2, 400); assert.equal(r.fire, false); taps = r.taps;        // 1st of a new pair
  r = HA.tapFires(taps, 2600, 2, 400); assert.equal(r.fire, false);                       // too slow (600ms) → no fire, just a fresh 1st
  assert.equal(r.taps.length, 1);
});
