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

function mockStorage() {
  const store = {};
  return { store,
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; } };
}

test('seedSandbox copies only SEED_KEYS from raw to prefixed, once', () => {
  const m = mockStorage();
  m.setItem('th108_layers', '[1]'); m.setItem('th108_theme', 'dark');
  m.setItem('th108_host_actions', 'PERSONAL');
  D.seedSandbox(m);
  assert.equal(m.getItem('th108_DEFAULTS_th108_layers'), '[1]');
  assert.equal(m.getItem('th108_DEFAULTS_th108_theme'), 'dark');
  assert.equal(m.getItem('th108_DEFAULTS_th108_host_actions'), null); // personal never seeded
  // seeding again must not overwrite an edited scratch value
  m.setItem('th108_DEFAULTS_th108_layers', '[9]');
  D.seedSandbox(m);
  assert.equal(m.getItem('th108_DEFAULTS_th108_layers'), '[9]');
});

test('installStorageShim redirects th108* access to the prefixed key; leaves others alone', () => {
  const m = mockStorage();
  D.installStorageShim(m);
  m.setItem('th108_layers', '[2]');
  assert.equal(m.store['th108_DEFAULTS_th108_layers'], '[2]'); // physically stored prefixed
  assert.equal(m.getItem('th108_layers'), '[2]');              // reads back through the prefix
  assert.equal(m.store['th108_layers'], undefined);            // real key untouched
  m.setItem('unrelated', 'x');
  assert.equal(m.store['unrelated'], 'x');                     // non-th108 keys pass through
  m.removeItem('th108_layers');
  assert.equal(m.getItem('th108_layers'), null);
});
