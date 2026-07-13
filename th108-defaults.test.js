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
    get length() { return Object.keys(store).length; },
    key(i) { const ks = Object.keys(store); return i < ks.length ? ks[i] : null; },
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; } };
}

test('isBlockedDaemonWrite blocks same-origin config writes, allows lease + GETs + cross-origin', () => {
  // blocked: any same-origin write that isn't a lease/control endpoint
  assert.equal(D.isBlockedDaemonWrite('/config', 'POST'), true);
  assert.equal(D.isBlockedDaemonWrite('/profiles', 'POST'), true);
  assert.equal(D.isBlockedDaemonWrite('/host-actions', 'POST'), true);
  assert.equal(D.isBlockedDaemonWrite('/nowplaying', 'POST'), true);
  assert.equal(D.isBlockedDaemonWrite('/apply-profile', 'POST'), true);
  // allowed: lease/control the preview needs
  assert.equal(D.isBlockedDaemonWrite('/yield', 'POST'), false);
  assert.equal(D.isBlockedDaemonWrite('/claim', 'POST'), false);
  assert.equal(D.isBlockedDaemonWrite('/heartbeat', 'POST'), false);
  // allowed: reads and cross-origin
  assert.equal(D.isBlockedDaemonWrite('/config', 'GET'), false);
  assert.equal(D.isBlockedDaemonWrite('/status', 'GET'), false);
  assert.equal(D.isBlockedDaemonWrite('https://other.example.com/x', 'POST'), false);
});

test('shimmed clear() wipes ONLY scratch (th108_DEFAULTS_*) keys, never real keys', () => {
  const m = mockStorage();
  m.setItem('th108_layers', 'REAL');
  m.setItem('th108_host_actions', 'REAL_PERSONAL');
  m.setItem('unrelated', 'REAL_OTHER');
  D.installStorageShim(m);
  m.setItem('th108_layers', 'SCRATCH');   // -> th108_DEFAULTS_th108_layers
  m.clear();
  assert.equal(m.store['th108_DEFAULTS_th108_layers'], undefined, 'scratch key cleared');
  assert.equal(m.store['th108_layers'], 'REAL', 'real key survives clear()');
  assert.equal(m.store['th108_host_actions'], 'REAL_PERSONAL', 'real personal key survives clear()');
  assert.equal(m.store['unrelated'], 'REAL_OTHER', 'unrelated key survives clear()');
});

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

test('seedSandbox seeds COMFORT_KEYS (card layout) too, but they are NOT in the export snapshot', () => {
  const m = mockStorage();
  m.setItem('th108_layers', '[1]');
  m.setItem('th108_layout2', '["cardA","cardB"]');   // real card arrangement
  m.setItem('th108_cardfill', '1');                    // real Fill mode
  D.seedSandbox(m);
  assert.equal(m.getItem('th108_DEFAULTS_th108_layout2'), '["cardA","cardB"]', 'layout seeded into sandbox');
  assert.equal(m.getItem('th108_DEFAULTS_th108_cardfill'), '1', 'fill mode seeded into sandbox');
  // but the shipped snapshot must NOT carry them (a fresh visitor gets the default arrangement)
  const snap = D.seedSnapshot(k => m.getItem('th108_DEFAULTS_' + k) ?? m.getItem(k));
  assert.ok(!('th108_layout2' in snap) && !('th108_cardfill' in snap), 'comfort keys never exported');
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
