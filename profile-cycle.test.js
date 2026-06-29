const test = require('node:test');
const assert = require('node:assert');
const PC = require('./profile-cycle.js');

const NEXT   = { trigger: { type: 'key', led: 1 }, action: { type: 'profileNext' } };
const PREV   = { trigger: { type: 'key', led: 2 }, action: { type: 'profilePrev' } };
const SELECT = { trigger: { type: 'key', led: 3 }, action: { type: 'profileSelect', index: 2 } };
const MIC    = { trigger: { type: 'key', led: 4 }, action: { type: 'micToggle' } };
const LAUNCH = { trigger: { type: 'key', led: 5 }, action: { type: 'launch', target: 'x' } };

test('stripCycleBindings removes only profile-cycle bindings', () => {
  assert.deepEqual(PC.stripCycleBindings([NEXT, MIC, PREV, SELECT, LAUNCH]), [MIC, LAUNCH]);
  assert.deepEqual(PC.stripCycleBindings([]), []);
  assert.deepEqual(PC.stripCycleBindings(null), []);
});

test('mergeKeepingCycle = profile non-cycle bindings + live cycle bindings', () => {
  assert.deepEqual(PC.mergeKeepingCycle([MIC], [NEXT, PREV, LAUNCH]), [MIC, NEXT, PREV]);
  // defensive: cycle bindings inside profileActions are dropped, live ones kept (no duplication)
  assert.deepEqual(PC.mergeKeepingCycle([MIC, NEXT], [NEXT]), [MIC, NEXT]);
});

test('applyAspects maps type -> {layers, hotkeys}', () => {
  assert.deepEqual(PC.applyAspects('lighting'), { layers: true,  hotkeys: false });
  assert.deepEqual(PC.applyAspects(undefined),  { layers: true,  hotkeys: false });
  assert.deepEqual(PC.applyAspects('hotkey'),   { layers: false, hotkeys: true });
  assert.deepEqual(PC.applyAspects('global'),   { layers: true,  hotkeys: true });
});

test('flashLed maps profile index -> digit/numpad LED, -1 out of range', () => {
  const D = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const N = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
  assert.equal(PC.flashLed('numberRow', 0, D, N), 10);
  assert.equal(PC.flashLed('numberRow', 9, D, N), 19);   // profile 10 -> "0" key
  assert.equal(PC.flashLed('numpad', 2, D, N), 22);
  assert.equal(PC.flashLed('numberRow', 10, D, N), -1);
  assert.equal(PC.flashLed('numberRow', -1, D, N), -1);
});

test('flashActive true within [0, dur), false otherwise', () => {
  assert.equal(PC.flashActive(1000, 1000, 1000), true);    // ft = 0
  assert.equal(PC.flashActive(1999, 1000, 1000), true);    // ft = 999
  assert.equal(PC.flashActive(2000, 1000, 1000), false);   // ft = 1000
  assert.equal(PC.flashActive(1000, 0, 1000), false);      // never set
});
