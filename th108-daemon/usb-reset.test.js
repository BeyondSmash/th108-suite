// usb-reset.test.js — unit tests for the USB-restart escalation decision (pure part).
// Run: node --test   (in th108-daemon/)
const test = require('node:test');
const assert = require('node:assert');
const U = require('./usb-reset.js');

const T = 30_000, C = 600_000;

test('shouldFire: no mute → never', () => {
  assert.equal(U.shouldFire({ muteAt: 0, now: 1_000_000, lastFireAt: 0 }), false);
});

test('shouldFire: mute younger than the threshold → wait', () => {
  assert.equal(U.shouldFire({ muteAt: 1_000_000, now: 1_000_000 + T - 1, lastFireAt: 0 }), false);
});

test('shouldFire: mute at/past the threshold → fire', () => {
  assert.equal(U.shouldFire({ muteAt: 1_000_000, now: 1_000_000 + T, lastFireAt: 0 }), true);
});

test('shouldFire: cooldown blocks a second shot, then re-arms', () => {
  const muteAt = 1_000_000, fired = muteAt + T;
  assert.equal(U.shouldFire({ muteAt, now: fired + C - 1, lastFireAt: fired }), false);
  assert.equal(U.shouldFire({ muteAt, now: fired + C, lastFireAt: fired }), true);
});

test('idle threshold: AFK recovers strictly sooner than the typing threshold', () => {
  assert.ok(U.IDLE_THRESHOLD_MS < U.THRESHOLD_MS, 'AFK threshold must be shorter than the typing one');
  const muteAt = 1_000_000, mid = muteAt + U.IDLE_THRESHOLD_MS;   // a moment that's past the AFK bar but not the typing bar
  // AFK (short override) → fires; actively typing (default 30s) → still waiting at the same instant
  assert.equal(U.shouldFire({ muteAt, now: mid, lastFireAt: 0, thresholdMs: U.IDLE_THRESHOLD_MS }), true);
  assert.equal(U.shouldFire({ muteAt, now: mid, lastFireAt: 0 }), false);
});

test('key-hold-off: a held key past the threshold defers the re-enumeration', () => {
  const muteAt = 1_000_000, now = muteAt + T;   // past threshold, well under the hard ceiling
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: Infinity }), false);
});

test('key-hold-off: mid-burst (recent keydown, nothing held now) still defers', () => {
  const muteAt = 1_000_000, now = muteAt + T;
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 0, sinceKeydownMs: U.LULL_MS - 1 }), false);
});

test('key-hold-off: fires once a lull arrives (nothing held + quiet gap)', () => {
  const muteAt = 1_000_000, now = muteAt + T;
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 0, sinceKeydownMs: U.LULL_MS }), true);
});

test('key-hold-off: hard ceiling recovers even with a key stuck held (missed keyup)', () => {
  assert.ok(U.HARD_CEILING_MS > T, 'ceiling must be past the fire threshold to matter');
  const muteAt = 1_000_000;
  // still under the ceiling with a stuck held key → deferred
  assert.equal(U.shouldFire({ muteAt, now: muteAt + U.HARD_CEILING_MS - 1, lastFireAt: 0, keysHeld: 1 }), false);
  // at the ceiling → fires regardless of the stuck held key
  assert.equal(U.shouldFire({ muteAt, now: muteAt + U.HARD_CEILING_MS, lastFireAt: 0, keysHeld: 1 }), true);
});
