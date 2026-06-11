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
