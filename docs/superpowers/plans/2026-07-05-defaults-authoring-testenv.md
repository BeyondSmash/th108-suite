# Defaults Authoring Test-Env + First-Run Seeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-app `?defaults=1` sandbox where Beyon tunes a curated default lighting look isolated from his personal config, exports it to `defaults.json`, and a brand-new visitor auto-loads it on first run.

**Architecture:** A tiny pure module (`th108-defaults.js`) holds the allowlist + helpers. At page-init top, if `?defaults=1`, we seed only the shippable keys into `th108_DEFAULTS_*` and monkey-patch `localStorage` so the entire existing UI transparently reads/writes the scratch copy. Daemon config-push is suppressed in sandbox mode (the board is previewed via Drive-from-Tab/WebHID, never the daemon's `config.json`). Export snapshots the scratch allowlist to `defaults.json`; first-run seeding fetches it when storage is empty.

**Tech Stack:** Vanilla JS (UMD module like the rest of the suite), `node --test` for unit tests, no build step. Browser = Chrome/Brave.

## Global Constraints

- **NEVER modify the user's personal config** — sandbox writes only `th108_DEFAULTS_*` keys and must never POST scratch layers to the daemon's `config.json`. (The hard project constraint.)
- **No build step / no new deps** — vanilla UMD, matches `th108-engine.js` / `th108-media-lib.js` pattern.
- **American spelling; commits authored `Beyon <you@example.com>` with NO Claude/Co-Authored-By trailer** (`git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`).
- **After editing the HTML `<script>`, syntax-check it** and reload in the browser (a TDZ can't be caught by `node --check`).
- **SEED_KEYS is an allowlist** — a key absent from it is excluded by default (personal data can never leak by omission).

---

### Task 1: `th108-defaults.js` pure module + unit tests

**Files:**
- Create: `th108-defaults.js`
- Test: `th108-defaults.test.js`

**Interfaces:**
- Produces: `DEFAULTS_PREFIX` (string `'th108_DEFAULTS_'`), `SEED_KEYS` (string[]), `isDefaultsMode(search?)` → bool, `prefixKey(key)` → string, `seedSnapshot(read)` → object. All on `window.TH108Defaults` (browser) and `module.exports` (node).

- [ ] **Step 1: Write the failing test**

```js
// th108-defaults.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-defaults.test.js`
Expected: FAIL — `Cannot find module './th108-defaults.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
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
  return { DEFAULTS_PREFIX, SEED_KEYS, prefixKey, isDefaultsMode, seedSnapshot };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-defaults.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add th108-defaults.js th108-defaults.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "defaults sandbox: pure allowlist module (SEED_KEYS, prefixKey, isDefaultsMode, seedSnapshot) + tests"
```

---

### Task 2: Storage shim + seed functions (module) + wire into the controller

**Files:**
- Modify: `th108-defaults.js` (add `seedSandbox`, `installStorageShim`)
- Modify: `th108-defaults.test.js` (add tests)
- Modify: `th108-controller.html` (install at the very top of the main inline script, before any storage read)

**Interfaces:**
- Consumes: `SEED_KEYS`, `prefixKey` (Task 1).
- Produces: `seedSandbox(storage)` (copies raw→prefixed for SEED_KEYS, once), `installStorageShim(storage)` (patches getItem/setItem/removeItem in place to prefix th108* keys). Both operate on any object exposing getItem/setItem/removeItem.

- [ ] **Step 1: Write the failing test**

```js
// append to th108-defaults.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test th108-defaults.test.js`
Expected: FAIL — `D.seedSandbox is not a function`.

- [ ] **Step 3: Add the functions to `th108-defaults.js`**

Insert before the `return { ... }` line, and add the two names to the returned object:

```js
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
```

Change the return to: `return { DEFAULTS_PREFIX, SEED_KEYS, prefixKey, isDefaultsMode, seedSnapshot, seedSandbox, installStorageShim };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test th108-defaults.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Load the module + install the shim at the top of the controller**

In `th108-controller.html`, add the script tag alongside the other module includes (near `th108-engine.js`):

```html
<script src="th108-defaults.js"></script>
```

Then, as the FIRST statements of the main inline `<script>` (before `const state = ...` and before anything reads localStorage):

```js
// ── Author-Defaults sandbox: if ?defaults=1, seed only the shippable keys into th108_DEFAULTS_* and
// redirect ALL th108* localStorage access there, so the whole UI operates on a scratch copy and the
// user's real config is never read or written. MUST run before any other storage access. ──
if (window.TH108Defaults && TH108Defaults.isDefaultsMode()) {
  try { TH108Defaults.seedSandbox(window.localStorage); TH108Defaults.installStorageShim(window.localStorage); } catch (e) { console.warn('defaults sandbox init failed', e); }
}
```

- [ ] **Step 6: Syntax-check the inline script**

Run:
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500);b.forEach(s=>new Function(s));console.log('OK '+b.length)"
```
Expected: `OK 1`.

- [ ] **Step 7: Browser-verify isolation (SAFE — sandbox writes only prefixed keys)**

Load `http://localhost:8123/?defaults=1`, open devtools console:
```js
// real key must be untouched; scratch key populated
localStorage.__proto__.getItem.call(localStorage, 'th108_DEFAULTS_th108_layers');  // -> your seeded layers
```
Confirm `Application → Local Storage` shows `th108_DEFAULTS_th108_layers` and that editing a layer only changes the prefixed key. Load `http://localhost:8123/` (no flag) and confirm normal keys are used.

- [ ] **Step 8: Commit**

```bash
git add th108-defaults.js th108-defaults.test.js th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "defaults sandbox: storage shim + seed-on-entry (redirect th108* localStorage to th108_DEFAULTS_* when ?defaults=1) + tests"
```

---

### Task 3: Suppress daemon config-push in sandbox mode

**Files:**
- Modify: `th108-controller.html:1767` (the `pushConfig` callback) and `:2234` (Export/Import `DC.pushConfig()`)

**Interfaces:**
- Consumes: `TH108Defaults.isDefaultsMode()`.
- Produces: in sandbox mode, no `/config` POST ever reaches the daemon — the real `config.json` stays untouched; the board is previewed via Drive-from-Tab (WebHID) only.

**Why:** `scheduleSaveLayers()` calls `pushConfig()` on every edit → `DC.pushConfig()` POSTs the (now scratch) layers to the daemon, overwriting the real `config.json`. That would violate the hard constraint even though localStorage is isolated.

- [ ] **Step 1: Gate the pushConfig callback**

Change line ~1767 from:
```js
  pushConfig: ()=>DC.pushConfig(),                           // mirror debounced saves to the daemon's config.json
```
to:
```js
  pushConfig: ()=>{ if(window.TH108Defaults && TH108Defaults.isDefaultsMode()) return; DC.pushConfig(); },   // sandbox: never write the daemon's config.json (preview via Drive-from-Tab only)
```

- [ ] **Step 2: Gate the Export/Import direct push**

Change line ~2234 from:
```js
    DC.pushConfig();                                         // hand it straight to the daemon if one is serving this page
```
to:
```js
    if(!(window.TH108Defaults && TH108Defaults.isDefaultsMode())) DC.pushConfig();   // sandbox: don't push scratch to the daemon
```

- [ ] **Step 3: Syntax-check the inline script**

Run:
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500);b.forEach(s=>new Function(s));console.log('OK '+b.length)"
```
Expected: `OK 1`.

- [ ] **Step 4: Browser-verify no daemon write in sandbox**

Note the daemon `config.json` layer types (`node -e "console.log(Object.values(require('./th108-daemon/config.json')).map(L=>L.type).join(','))"`). Load `?defaults=1`, add/remove a layer, wait 1s. Re-check `config.json` — **unchanged**. Load without the flag, edit a layer — `config.json` updates as normal.

- [ ] **Step 5: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "defaults sandbox: suppress daemon /config push while authoring (real config.json stays untouched; preview via Drive-from-Tab)"
```

---

### Task 4: Sandbox banner + Exit link + "Author Defaults" entry

**Files:**
- Modify: `th108-controller.html` (banner markup near the top of `<body>`; an entry link in the Docs/About area)

**Interfaces:**
- Consumes: `TH108Defaults.isDefaultsMode()`.
- Produces: a persistent banner while authoring + a way to enter/exit.

- [ ] **Step 1: Add the banner element** (top of `<body>`, before the header):

```html
<div id="defaultsBanner" hidden style="background:#8a5a00;color:#fff;text-align:center;padding:7px 12px;font-size:13px;font-weight:600">
  ⚑ Authoring Defaults — your personal config is untouched (scratch sandbox).
  <a id="defaultsExit" href="#" style="color:#fff;text-decoration:underline;margin-left:10px">Exit</a>
  <button id="defaultsExport" type="button" style="margin-left:12px;padding:3px 12px">Export defaults.json</button>
</div>
```

- [ ] **Step 2: Wire the banner + Exit** (in the inline script, after `TH108Defaults` init):

```js
if (window.TH108Defaults && TH108Defaults.isDefaultsMode()) {
  const bn = document.getElementById('defaultsBanner'); if (bn) bn.hidden = false;
  const ex = document.getElementById('defaultsExit');
  if (ex) ex.addEventListener('click', e => { e.preventDefault(); const u = new URL(location.href); u.searchParams.delete('defaults'); location.href = u.href; });
}
```

- [ ] **Step 3: Add an entry link** in the Docs/About card (find the Docs tab section; add a small link):

```html
<p class="hint"><a href="?defaults=1">Author shipped defaults →</a> — tune the look new visitors get on first run, in an isolated sandbox.</p>
```

- [ ] **Step 4: Syntax-check + browser-verify**

Syntax-check (command from Task 2 Step 6). Load `?defaults=1` → amber banner shows, Exit returns to `/`. Load `/` → no banner.

- [ ] **Step 5: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "defaults sandbox: authoring banner + Exit + an Author-Defaults entry link in Docs"
```

---

### Task 5: Export Defaults → download `defaults.json`

**Files:**
- Modify: `th108-controller.html` (wire the `#defaultsExport` button)

**Interfaces:**
- Consumes: `TH108Defaults.seedSnapshot`, the (shimmed) `localStorage`.
- Produces: a downloaded `defaults.json` containing only SEED_KEYS from the scratch state.

- [ ] **Step 1: Wire the export button** (inside the sandbox `if` block from Task 4 Step 2):

```js
const exp = document.getElementById('defaultsExport');
if (exp) exp.addEventListener('click', () => {
  // localStorage is shimmed -> getItem reads the scratch (prefixed) values
  const snap = TH108Defaults.seedSnapshot(k => localStorage.getItem(k));
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'defaults.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
```

- [ ] **Step 2: Syntax-check + browser-verify the export contents**

Syntax-check (Task 2 Step 6 command). Load `?defaults=1`, tune a layer, click **Export defaults.json**. Open the downloaded file: it must contain ONLY `th108_layers`/`th108_layerOrder`/`th108_bri`/`th108_lightsOn`/`th108_theme` — no `th108_host_actions`, `th108_profiles`, `th108_rgb_calibration`, etc.

- [ ] **Step 3: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "defaults sandbox: Export button downloads defaults.json (scratch snapshot, SEED_KEYS only)"
```

---

### Task 6: First-run seeding for new visitors

**Files:**
- Create: `defaults.json` (repo root — a placeholder, later overwritten by a real export)
- Modify: `th108-controller.html` (seed on normal boot when storage is empty)

**Interfaces:**
- Consumes: `TH108Defaults.SEED_KEYS`, `TH108Defaults.isDefaultsMode`.
- Produces: a brand-new visitor (empty `th108_layers`, not defaults mode) loads `defaults.json` into real localStorage once, then boots normally.

- [ ] **Step 1: Create a placeholder `defaults.json`** (repo root) so the fetch resolves during dev — a minimal valid snapshot:

```json
{
  "th108_layers": "[{\"name\":\"Pattern\",\"enabled\":true,\"type\":\"pattern\",\"opacity\":1,\"blend\":\"normal\",\"fps\":30,\"settings\":{}}]",
  "th108_bri": "100",
  "th108_lightsOn": "1"
}
```

- [ ] **Step 2: Seed on first run** — add BEFORE `const state = TH108Engine.createState(...)` and AFTER the sandbox-init block, so it never runs in defaults mode:

```js
// First-run seeding: a brand-new visitor (no saved layers, not authoring) gets the shipped defaults once.
// Synchronous XHR keeps it before the state/LUI bootstrap without a large refactor; the file is tiny + same-origin.
if (window.TH108Defaults && !TH108Defaults.isDefaultsMode() && !localStorage.getItem('th108_layers') && !localStorage.getItem('th108_seeded')) {
  try {
    const xhr = new XMLHttpRequest(); xhr.open('GET', 'defaults.json', false); xhr.send();
    if (xhr.status >= 200 && xhr.status < 300) {
      const snap = JSON.parse(xhr.responseText);
      for (const k of TH108Defaults.SEED_KEYS) { if (k in snap && snap[k] != null) localStorage.setItem(k, snap[k]); }
      localStorage.setItem('th108_seeded', '1');   // seed exactly once; never clobber a returning user
    }
  } catch (e) { console.warn('first-run defaults seed skipped', e); }   // missing/bad file -> fall back to engine defaultLayers()
}
```

- [ ] **Step 3: Syntax-check + browser-verify first-run**

Syntax-check (Task 2 Step 6 command). In devtools: `localStorage.clear()`, then load `/`. Confirm the layer cards match `defaults.json`, `th108_seeded === '1'`, and a second reload does not re-seed (edit a layer, reload — your edit persists).

- [ ] **Step 4: Verify graceful fallback**

Temporarily rename `defaults.json` (or point the fetch at a 404), `localStorage.clear()`, reload `/` — page still boots on `TH108Engine.defaultLayers()` with a console warning, no crash. Restore the file.

- [ ] **Step 5: Commit**

```bash
git add defaults.json th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "defaults: first-run seeding (empty storage -> load defaults.json once) + placeholder defaults.json; graceful fallback to engine defaults"
```

---

## Self-Review

**Spec coverage:** Entry/isolation (Tasks 2, 3) · seed-from-current (Task 2) · board preview via Drive-from-Tab (Task 3 keeps daemon out; existing Drive-from-Tab used as-is) · banner/exit (Task 4) · Export→defaults.json with allowlist (Tasks 1, 5) · first-run seeding + fallback (Task 6) · leak tripwire test (Task 1). All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; `defaults.json` placeholder is intentional (Task 6 Step 1) and overwritten by a real export at ship time.

**Type consistency:** `seedSnapshot(read)`, `seedSandbox(storage)`, `installStorageShim(storage)`, `prefixKey(key)`, `isDefaultsMode(search?)`, `SEED_KEYS` used identically across tasks. Banner/button ids (`defaultsBanner`, `defaultsExit`, `defaultsExport`) consistent between Task 4 markup and Task 5 wiring.

**Constraint check:** Isolation enforced at two layers (localStorage shim in Task 2 + daemon-push suppression in Task 3); allowlist prevents leak-by-omission; verification steps confirm the real `config.json` and real localStorage keys stay untouched.
