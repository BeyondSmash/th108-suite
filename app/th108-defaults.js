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
  // Workspace-comfort keys: seeded INTO the sandbox so the card arrangement + Grid/Fill mode match your
  // real setup while authoring, but deliberately NOT exported (not in SEED_KEYS) — a fresh visitor gets the
  // default card layout, not yours. Purely cosmetic/local, so copying them can't leak personal state.
  const COMFORT_KEYS = ['th108_layout2', 'th108_cardfill'];

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
    for (const k of SEED_KEYS.concat(COMFORT_KEYS)) {   // export allowlist + local workspace comfort
      const pk = prefixKey(k);
      if (storage.getItem(pk) == null) { const v = storage.getItem(k); if (v != null) storage.setItem(pk, v); }
    }
  }
  // Patch getItem/setItem/removeItem so every th108* key is transparently rewritten to its prefixed form.
  // The rest of the app keeps calling localStorage.getItem('th108_layers') and never knows.
  // clear() is ALSO overridden: a raw clear() would wipe the real config too (it ignores the per-method
  // prefixing), so in the sandbox it must delete ONLY the scratch (th108_DEFAULTS_*) keys — this keeps the
  // "Reset all settings" button (and any other clear()) from destroying the user's real localStorage.
  function installStorageShim(storage) {
    const get = storage.getItem.bind(storage), set = storage.setItem.bind(storage), rem = storage.removeItem.bind(storage);
    storage.getItem = k => get(prefixKey(k));
    storage.setItem = (k, v) => set(prefixKey(k), v);
    storage.removeItem = k => rem(prefixKey(k));
    storage.clear = () => {
      const doomed = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.indexOf(DEFAULTS_PREFIX) === 0) doomed.push(k); }
      doomed.forEach(k => rem(k));   // rem is the native removeItem; keys are already prefixed
    };
  }

  // Device-lease / control endpoints the sandbox MUST still reach so Drive-from-Tab board preview works.
  // Everything else that WRITES (POST/PUT/PATCH/DELETE to the same-origin daemon) is blocked in sandbox —
  // a single choke point so no boot-sync or feature control (config, profiles, host-actions, now-playing,
  // apply-profile, …) can ever mutate the user's real daemon state while authoring. GETs always pass.
  const WRITE_ALLOW = ['/claim', '/release', '/yield', '/heartbeat'];
  // returns true if this request should be BLOCKED (sandbox + a same-origin write to a non-allowlisted path)
  function isBlockedDaemonWrite(url, method) {
    const m = String(method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') return false;
    const u = String(url || '');
    let path;
    if (u.charAt(0) === '/' && u.charAt(1) !== '/') {        // relative same-origin path (e.g. /config)
      path = u;
    } else {                                                 // absolute URL: only our-origin counts as the daemon
      if (typeof location === 'undefined') return false;     // node / no DOM → can't be our daemon
      try { const p = new URL(u, location.href); if (p.origin !== location.origin) return false; path = p.pathname; }
      catch (_) { return false; }
    }
    path = path.split('?')[0].split('#')[0];
    if (WRITE_ALLOW.indexOf(path) >= 0) return false;        // lease/control the preview needs
    return true;                                             // any other same-origin write → block in sandbox
  }
  // Wrap fetch so blocked writes resolve to a harmless 204 no-op (callers are fire-and-forget). Idempotent.
  function installDaemonWriteGuard(win) {
    if (!win || typeof win.fetch !== 'function' || win.fetch.__th108Guarded) return;
    const nativeFetch = win.fetch.bind(win);
    const guarded = function (input, init) {
      try {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (isBlockedDaemonWrite(url, method)) return Promise.resolve(new Response(null, { status: 204, statusText: 'sandbox-blocked' }));
      } catch (_) { /* fall through to real fetch on any inspection error */ }
      return nativeFetch(input, init);
    };
    guarded.__th108Guarded = true;
    win.fetch = guarded;
  }

  return { DEFAULTS_PREFIX, SEED_KEYS, COMFORT_KEYS, prefixKey, isDefaultsMode, seedSnapshot, seedSandbox, installStorageShim, isBlockedDaemonWrite, installDaemonWriteGuard };
});
