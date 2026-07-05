const test = require('node:test');
const assert = require('node:assert');
const D = require('./th108-defaults.js');

test('SEED_KEYS is the exact shippable allowlist', () => {
  assert.deepEqual(D.SEED_KEYS, ['th108_layers','th108_layerOrder','th108_bri','th108_lightsOn','th108_theme']);
});

test('prefixKey prefixes th108* keys, leaves others, never double-prefixes', () => {
  assert.equal(D.prefixKey('th108_layers'), 'th108_DEFAULTS_th108_layers');
  assert.equal(D.prefixKey('th108.autoConnectFocus'), 'th108_DEFAULTS_th108.autoConnectFocus');
  assert.equal(D.prefixKey('some_other_key'), 'some_other_key');
  assert.equal(D.prefixKey('th108_DEFAULTS_th108_layers'), 'th108_DEFAULTS_th108_layers'); // idempotent
});

test('isDefaultsMode reads the ?defaults=1 flag', () => {
  assert.equal(D.isDefaultsMode('?defaults=1'), true);
  assert.equal(D.isDefaultsMode('?foo=1&defaults=1'), true);
  assert.equal(D.isDefaultsMode('?defaults=0'), false);
  assert.equal(D.isDefaultsMode(''), false);
});

test('seedSnapshot returns ONLY SEED_KEYS even when personal keys are present (leak tripwire)', () => {
  const src = { th108_layers:'[1]', th108_bri:'80', th108_theme:'dark',
                th108_host_actions:'PERSONAL', th108_rgb_calibration:'PERSONAL', th108_profiles:'PERSONAL' };
  const snap = D.seedSnapshot(k => (k in src ? src[k] : null));
  assert.deepEqual(Object.keys(snap).sort(), ['th108_bri','th108_layers','th108_theme']);
  assert.ok(!('th108_host_actions' in snap) && !('th108_profiles' in snap));
});

test('seedSnapshot skips missing keys (no null-fill)', () => {
  const snap = D.seedSnapshot(k => (k === 'th108_layers' ? '[1]' : null));
  assert.deepEqual(snap, { th108_layers:'[1]' });
});
