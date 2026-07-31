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

test('key-hold-off: a GENUINELY held key (repeats still arriving) past the threshold defers', () => {
  const muteAt = 1_000_000, now = muteAt + T;   // past threshold, well under the hard ceiling
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: 0 }), false);
});

test('key-hold-off: a STALE held key (missed keyup, no keydown for staleHeldMs) recovers at the threshold', () => {
  const muteAt = 1_000_000, now = muteAt + T;   // past threshold, far under the hard ceiling
  // keysHeld>0 but no keydown for staleHeldMs ⇒ physically up (alt-tab ate the keyup) ⇒ safe to re-enumerate now
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: U.STALE_HELD_MS }), true);
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: Infinity }), true);
  // …but a hold whose repeats are still arriving is NOT stale → still deferred
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: U.STALE_HELD_MS - 1 }), false);
});

test('key-hold-off: mid-burst (recent keydown, nothing held now) still defers', () => {
  const muteAt = 1_000_000, now = muteAt + T;
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 0, sinceKeydownMs: U.LULL_MS - 1 }), false);
});

test('key-hold-off: fires once a lull arrives (nothing held + quiet gap)', () => {
  const muteAt = 1_000_000, now = muteAt + T;
  assert.equal(U.shouldFire({ muteAt, now, lastFireAt: 0, keysHeld: 0, sinceKeydownMs: U.LULL_MS }), true);
});

test('key-hold-off: hard ceiling recovers even with a key GENUINELY held the whole time', () => {
  assert.ok(U.HARD_CEILING_MS > T, 'ceiling must be past the fire threshold to matter');
  const muteAt = 1_000_000;
  // a genuine hold whose repeats keep arriving (sinceKeydownMs small) defers right up to the ceiling…
  assert.equal(U.shouldFire({ muteAt, now: muteAt + U.HARD_CEILING_MS - 1, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: 0 }), false);
  // …then fires at the ceiling regardless, so a truly stuck-down key can't block recovery forever
  assert.equal(U.shouldFire({ muteAt, now: muteAt + U.HARD_CEILING_MS, lastFireAt: 0, keysHeld: 1, sinceKeydownMs: 0 }), true);
});
