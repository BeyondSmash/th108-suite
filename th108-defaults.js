// th108-defaults.js — pure allowlist + helpers for the "Author Defaults" sandbox.
// UMD: window.TH108Defaults (browser) + module.exports (node/tests). No DOM, no side effects.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TH108Defaults = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEFAULTS_PREFIX = 'th108_DEFAULTS_';
  // The ONLY keys copied into the sandbox and written to defaults.json. Allowlist:
  // anything not here (host-actions, keymap, calibration, profiles, layout, iso-view, media) is
  // never seeded, so a new visitor can't inherit personal/machine state.
  const SEED_KEYS = ['th108_layers', 'th108_layerOrder', 'th108_bri', 'th108_lightsOn', 'th108_theme'];

  function prefixKey(key) {
    if (typeof key !== 'string' || !key.startsWith('th108') || key.startsWith(DEFAULTS_PREFIX)) return key;
    return DEFAULTS_PREFIX + key;
  }
  function isDefaultsMode(search) {
    const s = search != null ? search : (typeof location !== 'undefined' ? location.search : '');
    return /[?&]defaults=1(?:&|$)/.test(s);
  }
  // read(key) -> stored string | null. Returns a plain object of ONLY the present SEED_KEYS.
  function seedSnapshot(read) {
    const out = {};
    for (const k of SEED_KEYS) { const v = read(k); if (v != null) out[k] = v; }
    return out;
  }
  // Copy raw SEED_KEYS -> their prefixed counterparts if the scratch slot is empty. Run ONCE, on the RAW
  // storage, BEFORE installStorageShim — so it reads the real keys and writes the scratch keys.
  function seedSandbox(storage) {
    for (const k of SEED_KEYS) {
      const pk = prefixKey(k);
      if (storage.getItem(pk) == null) { const v = storage.getItem(k); if (v != null) storage.setItem(pk, v); }
    }
  }
  // Patch getItem/setItem/removeItem so every th108* key is transparently rewritten to its prefixed form.
  // The rest of the app keeps calling localStorage.getItem('th108_layers') and never knows.
  function installStorageShim(storage) {
    const get = storage.getItem.bind(storage), set = storage.setItem.bind(storage), rem = storage.removeItem.bind(storage);
    storage.getItem = k => get(prefixKey(k));
    storage.setItem = (k, v) => set(prefixKey(k), v);
    storage.removeItem = k => rem(prefixKey(k));
  }

  return { DEFAULTS_PREFIX, SEED_KEYS, prefixKey, isDefaultsMode, seedSnapshot, seedSandbox, installStorageShim };
});
