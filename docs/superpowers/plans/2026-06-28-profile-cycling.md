# Profile Cycling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add profile *types* (lighting / hotkey / global), a per-profile color + ~1s on-keyboard number flash on switch, and make manual Apply live — on top of the already-working daemon profile cycle.

**Architecture:** A new pure UMD module `profile-cycle.js` holds the testable decision logic (which aspects a type applies, cycle-binding preservation, flash-key mapping). The daemon's existing `applyProfile` branches on type and renders a flash overlay (cloning the now-playing-flash pattern). The page (`th108-profiles.js`) gains per-profile type/color UI + an indicator settings row and captures hotkeys by type; the controller's `applyData` switches live (no reload) and signals the daemon via a new `POST /apply-profile`.

**Tech Stack:** Vanilla JS, no build step. UMD modules. `node:test` for unit tests. Node daemon with `node-hid` + `uiohook-napi`. WebHID on the page.

## Global Constraints

- Commits authored as `Beyon <you@example.com>`, NO Claude / Co-Authored-By trailer. Use: `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`
- American spelling. No new dependencies. Keep the zero-build, open-in-browser model (UMD/IIFE, no bundler).
- After editing any `.js` module: `node --check <file>`. After editing `th108-controller.html`'s inline script, syntax-check it (command in Task 5).
- `profile-cycle.js` lives in the **repo root** (alongside `th108-engine.js`): the daemon requires `../profile-cycle.js`; the page loads `<script src="profile-cycle.js">`; its test runs from root via `node --test profile-cycle.test.js`.
- Hotkey profiles swap **Host Actions only** (never the firmware keymap). No new firmware-flash writes.
- Max 10 profiles (= the 10 digit keys). Existing profiles with no `type` are treated as `lighting`.
- Engine/daemon code changes require a **daemon restart** to take effect on the board (note in verification steps; the user runs it).

---

### Task 1: Pure helpers — `profile-cycle.js`

**Files:**
- Create: `profile-cycle.js`
- Test: `profile-cycle.test.js`

**Interfaces:**
- Produces (UMD export `TH108ProfileCycle` / `module.exports`):
  - `stripCycleBindings(actions: Array) -> Array` — actions minus any whose `action.type` is `profileNext|profilePrev|profileSelect`.
  - `mergeKeepingCycle(profileActions: Array, liveActions: Array) -> Array` — `stripCycleBindings(profileActions)` concatenated with the cycle bindings found in `liveActions`.
  - `applyAspects(type: string) -> {layers: boolean, hotkeys: boolean}` — `'hotkey'` → `{layers:false,hotkeys:true}`; `'global'` → both true; anything else (incl. `'lighting'`/undefined) → `{layers:true,hotkeys:false}`.
  - `flashLed(keys: string, idx: number, digitKs: number[], numpadKs: number[]) -> number` — `numpadKs[idx]` if `keys==='numpad'` else `digitKs[idx]`; `-1` if out of range.
  - `flashActive(now: number, flashAt: number, durMs: number) -> boolean` — `flashAt` truthy and `0 <= now-flashAt < durMs`.

- [ ] **Step 1: Write the failing test**

Create `profile-cycle.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test profile-cycle.test.js`
Expected: FAIL — `Cannot find module './profile-cycle.js'`.

- [ ] **Step 3: Write the implementation**

Create `profile-cycle.js`:

```javascript
/* profile-cycle.js — pure helpers for profile cycling (UMD: node daemon + browser page).
   No DOM, no I/O — just the decision logic, unit-tested under node --test. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108ProfileCycle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CYCLE = new Set(['profileNext', 'profilePrev', 'profileSelect']);
  const isCycle = b => !!(b && b.action && CYCLE.has(b.action.type));

  // strip profile-cycle bindings so they're never captured INTO a profile (the cycle key must survive a switch)
  function stripCycleBindings(actions) { return (Array.isArray(actions) ? actions : []).filter(b => !isCycle(b)); }

  // a profile's non-cycle bindings PLUS the live cycle bindings preserved
  function mergeKeepingCycle(profileActions, liveActions) {
    return stripCycleBindings(profileActions).concat((Array.isArray(liveActions) ? liveActions : []).filter(isCycle));
  }

  // which aspects a profile type applies on switch
  function applyAspects(type) {
    return { layers: type !== 'hotkey', hotkeys: type === 'hotkey' || type === 'global' };
  }

  // the single LED index to flash for profile #idx (0-based), or -1 if out of range
  function flashLed(keys, idx, digitKs, numpadKs) {
    const arr = keys === 'numpad' ? numpadKs : digitKs;
    return (Array.isArray(arr) && idx >= 0 && idx < arr.length) ? arr[idx] : -1;
  }

  function flashActive(now, flashAt, durMs) { return !!flashAt && (now - flashAt) >= 0 && (now - flashAt) < durMs; }

  return { CYCLE, stripCycleBindings, mergeKeepingCycle, applyAspects, flashLed, flashActive };
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test profile-cycle.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add profile-cycle.js profile-cycle.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "profile-cycle: pure helpers (aspects/cycle-binding preserve/flash mapping) + tests"
```

---

### Task 2: Daemon — apply-by-type + flash overlay + indicator

**Files:**
- Modify: `th108-daemon/daemon.js`

**Interfaces:**
- Consumes: `profile-cycle.js` (Task 1) via `require('../profile-cycle.js')`; existing `hostActions`, `saveHostActions()`, `_haReset()`, `HA.normalize`, `DIGIT_KS`, `NUMPAD_KS`, `hexRGB`, `curProfile`, `CONFIG_PATH`, `loadJSON`, `E.applyConfig`.
- Produces (on the `control` object returned to `server.js`): `setIndicator(ind)`, `applyProfileByIndex(i)`. New module state: `profileFlashAt`, `profileFlashColor`, `profileFlashLed`, `indicator`.

- [ ] **Step 1: Require the pure module**

In `th108-daemon/daemon.js`, just after the engine require (`const E = require('../th108-engine.js');`, line ~12), add:

```javascript
const PC = require('../profile-cycle.js');
```

- [ ] **Step 2: Add flash + indicator state**

Just after `let npFlashAt = 0;` (line ~61) add:

```javascript
let profileFlashAt = 0, profileFlashColor = '#ffffff', profileFlashLed = -1;
const PROFILE_FLASH_MS = 1000;   // ~1s number flash on profile switch
```

Just after the `let profiles = loadJSON(PROFILES_PATH) || [];` line (line ~153) add:

```javascript
const INDICATOR_PATH = path.join(__dirname, 'profile-indicator.json');
let indicator = loadJSON(INDICATOR_PATH) || { on: true, keys: 'numberRow' };
function saveIndicator() { try { fs.writeFileSync(INDICATOR_PATH, JSON.stringify(indicator)); } catch {} }
```

- [ ] **Step 3: Rewrite `applyProfile` to branch on type**

Replace the whole `applyProfile` function (currently lines ~174-181) with:

```javascript
function applyProfile(p, label) {   // shared apply path (cycle + direct-select); applies aspects per profile type
  if (!p) return;
  const asp = PC.applyAspects(p.type);
  if (asp.layers && Array.isArray(p.layers)) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(p.layers)); } catch {}   // persist so it survives + the page sees it
    if (!paused && state) { state = E.applyConfig(state, p.layers);             // apply live unless the page holds the device
      if (state) { state.bri = Math.max(0, Math.min(100, settings.brightness != null ? settings.brightness : 100)) / 100; state.lastFlat = null; } }
  }
  if (asp.hotkeys) {   // swap Host Actions, preserving the LIVE profile-cycle bindings so the cycle key survives
    hostActions = HA.normalize(PC.mergeKeepingCycle(p.hostActions || [], hostActions)); saveHostActions(); _haReset();
  }
  syncAudioCapture();
  if (indicator.on) { profileFlashAt = Date.now(); profileFlashColor = p.color || '#ffffff'; profileFlashLed = PC.flashLed(indicator.keys, curProfile, DIGIT_KS, NUMPAD_KS); }
  log('🎚 host action: profile → "' + label + '"');
}
```

(`cycleProfile`/`selectProfile` already set `curProfile` before calling `applyProfile`, so `flashLed` reads the correct index — no change to those two functions.)

- [ ] **Step 4: Inject the flash overlay into the frame**

Find the now-playing flash block (lines ~463-467, the `if (npFlashAt && settings.npFlash) {…}` … `} else if (npFlashAt && !settings.npFlash) npFlashAt = 0;`). Immediately AFTER that block, add:

```javascript
      if (profileFlashAt && profileFlashLed >= 0) {
        const pt = Date.now() - profileFlashAt;
        if (pt >= 0 && pt < PROFILE_FLASH_MS) { const [pr, pg, pb] = hexRGB(profileFlashColor); const o = profileFlashLed * 4; flat[o + 1] = pr; flat[o + 2] = pg; flat[o + 3] = pb; }
        else if (pt >= PROFILE_FLASH_MS) profileFlashAt = 0;
      }
```

- [ ] **Step 5: Add the control hooks**

In the `control` object literal (the one with `setHostActions` / `setProfiles`, lines ~717-721), add these two members (e.g. right after `setProfiles(...)`):

```javascript
  setIndicator(ind) { if (ind && typeof ind === 'object') { indicator = { on: ind.on !== false, keys: ind.keys === 'numpad' ? 'numpad' : 'numberRow' }; saveIndicator(); } },
  applyProfileByIndex(i) { selectProfile(i | 0); },
```

- [ ] **Step 6: Syntax-check + run the daemon suite**

Run: `node --check th108-daemon/daemon.js && (cd th108-daemon && node --test)`
Expected: `node --check` prints nothing (OK); the daemon test suite passes (same count as before — no daemon tests were changed).

- [ ] **Step 7: Commit**

```bash
git add th108-daemon/daemon.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "daemon: apply profiles by type (lighting/hotkey/global) + 1s number-flash overlay + indicator settings"
```

---

### Task 3: Server endpoints — `/apply-profile` + indicator on `/profiles`

**Files:**
- Modify: `th108-daemon/server.js`

**Interfaces:**
- Consumes: `control.setProfiles`, `control.setIndicator`, `control.applyProfileByIndex` (Task 2); existing `readBody`, `sendJson`.

- [ ] **Step 1: Carry indicator settings on the existing `/profiles` POST**

Find the `/profiles` handler (line ~106-110). After the `if (control.setProfiles) control.setProfiles(body.profiles || []);` line, add:

```javascript
        if (control.setIndicator && body.indicator) control.setIndicator(body.indicator);
```

- [ ] **Step 2: Add the `/apply-profile` endpoint**

Immediately after the `/profiles` handler's closing `}` (before the next `if (req.method...` block), add:

```javascript
      if (req.method === 'POST' && u === '/apply-profile') {   // page-side manual Apply → daemon applies live + flashes
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.applyProfileByIndex) control.applyProfileByIndex(body.index | 0);
        return sendJson(res, 200, { ok: true });
      }
```

- [ ] **Step 3: Syntax-check + run the daemon suite**

Run: `node --check th108-daemon/server.js && (cd th108-daemon && node --test)`
Expected: OK; daemon tests pass.

- [ ] **Step 4: Commit**

```bash
git add th108-daemon/server.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "server: POST /apply-profile (live manual apply + flash); carry indicator settings on /profiles"
```

---

### Task 4: Page — profile schema, capture-by-type, type/color UI, indicator row, push

**Files:**
- Modify: `th108-profiles.js`

**Interfaces:**
- Consumes: `window.TH108ProfileCycle.stripCycleBindings` (Task 1, loaded by Task 5's script tag); existing `load()`, `store()`, `render()`, `snapshot()`, `getCurrent()`, `flushSave()`.
- Produces: profile objects now carry `type`, `color`, and (for hotkey/global) `hostActions`; `pushToDaemon` sends those + `indicator`; localStorage `th108_profileIndicator` = `{on, keys}`.

- [ ] **Step 1: Add palette + capture helpers + indicator persistence**

In `th108-profiles.js`, inside `create(opts)` just after the `function load() {…}` line (line ~54), add:

```javascript
    const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff2d55', '#a2845e'];
    const defaultColor = i => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
    function loadIndicator() { try { return Object.assign({ on: true, keys: 'numberRow' }, JSON.parse(localStorage.getItem('th108_profileIndicator') || '{}')); } catch (_) { return { on: true, keys: 'numberRow' }; } }
    function saveIndicator(ind) { try { localStorage.setItem('th108_profileIndicator', JSON.stringify(ind)); } catch (_) {} pushToDaemon(); }
    // current Host Actions, minus the profile-cycle bindings (those must never be captured into a profile)
    function captureHotkeys() {
      let acts = []; try { acts = JSON.parse(localStorage.getItem('th108_host_actions') || '[]'); } catch (_) {}
      return (typeof window !== 'undefined' && window.TH108ProfileCycle) ? window.TH108ProfileCycle.stripCycleBindings(acts) : acts;
    }
```

- [ ] **Step 2: Send the new fields + indicator to the daemon**

Replace the whole `pushToDaemon` function (lines ~57-60) with:

```javascript
    function pushToDaemon(list) {
      try { fetch('/profiles', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profiles: (list || load()).map(p => ({ name: p.name, layers: p.layers || [], order: p.order || null, type: p.type || 'lighting', color: p.color || '', hostActions: p.hostActions || [] })),
          indicator: loadIndicator()
        }) }).catch(() => {}); } catch (_) {}
    }
```

- [ ] **Step 3: Capture by type in `snapshot`**

Replace the whole `snapshot` function (lines ~63-67) with:

```javascript
    function snapshot(name, type, color) {
      flushSave();   // flush the live layer state to localStorage first, same as Toolbox Export
      const t = type || 'lighting';
      const p = { name, type: t, color: color || '', savedAt: Date.now() };
      if (t !== 'hotkey') { const cur = getCurrent(); p.layers = cur.layers; p.order = cur.order; }   // lighting/global capture layers
      else { p.layers = []; p.order = null; }
      if (t === 'hotkey' || t === 'global') p.hostActions = captureHotkeys();
      return p;
    }
```

- [ ] **Step 4: New-Save assigns a default color (lighting type)**

In the `$('profSave')` click handler (lines ~123-130), replace the line `const prof = snapshot(defaultName(list));` with:

```javascript
      const prof = snapshot(defaultName(list), 'lighting', defaultColor(list.length));
```

And in the import handler (`$('profFile')` change, line ~140), replace `list.push({ name, layers: imp.layers, order: imp.order, savedAt: Date.now() }); store(list);` with:

```javascript
        list.push({ name, type: 'lighting', color: defaultColor(list.length), layers: imp.layers, order: imp.order, savedAt: Date.now() }); store(list);
```

- [ ] **Step 5: Per-card type dropdown + color swatch**

In `render()`'s `list.forEach((prof, i) => {…})`, after `row.appendChild(name);` (line ~91) and before the `const btn = …` definition, insert:

```javascript
        const typeSel = document.createElement('select');
        typeSel.title = 'what this profile switches when applied or cycled';
        [['lighting', 'Lighting'], ['hotkey', 'Hotkey'], ['global', 'Global']].forEach(o => {
          const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1];
          if ((prof.type || 'lighting') === o[0]) op.selected = true; typeSel.appendChild(op);
        });
        typeSel.addEventListener('change', () => { const l = load(); l[i].type = typeSel.value; store(l); render(); });
        row.appendChild(typeSel);
        const color = document.createElement('input');
        color.type = 'color'; color.value = prof.color || '#888888'; color.title = 'on-keyboard flash color for this profile';
        color.addEventListener('input', () => { const l = load(); l[i].color = color.value; store(l); });
        row.appendChild(color);
```

- [ ] **Step 6: Update applies per type; Apply goes live (passes the profile + index)**

In the same `render()` forEach, replace the **Apply** button block (lines ~97-100) with:

```javascript
        btn('Apply', 'apply this profile live (no reload)', () => {
          if (!confirm('Apply "' + prof.name + '"?\n\nThis replaces your current setup live (save it as a profile first to keep it).')) return;
          applyData(prof, i);
        }, 'go');
```

And replace the **Update** button block (lines ~101-105) with:

```javascript
        btn('Update', 'overwrite this profile from the current setup (per its type)', () => {
          const l = load(); l[i] = snapshot(l[i].name, l[i].type, l[i].color); store(l);
          log('✓ profile "' + l[i].name + '" updated', 'ok');
          render();
        });
```

- [ ] **Step 7: Build the indicator settings row once**

At the end of `create(opts)`, just before `render();` (line ~146), add:

```javascript
    (function buildIndicatorRow() {
      const host = $('profList'); if (!host || !host.parentNode || $('profIndRow')) return;
      const ind = loadIndicator();
      const row = document.createElement('div'); row.id = 'profIndRow'; row.className = 'hint';
      row.style.cssText = 'display:flex;align-items:center;gap:14px;margin:0 0 10px;flex-wrap:wrap';
      row.innerHTML =
        '<label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="profIndOn"' + (ind.on ? ' checked' : '') + '> Flash the profile number on switch</label>' +
        '<label style="display:flex;align-items:center;gap:6px;margin:0">Keys <select id="profIndKeys"><option value="numberRow"' + (ind.keys !== 'numpad' ? ' selected' : '') + '>Number row</option><option value="numpad"' + (ind.keys === 'numpad' ? ' selected' : '') + '>Numpad</option></select></label>' +
        '<span style="opacity:.65">Bind the cycle key on the <b>Host Actions</b> tab (Profile → Next / Previous / Jump).</span>';
      host.parentNode.insertBefore(row, host);
      $('profIndOn').addEventListener('change', () => { const v = loadIndicator(); v.on = $('profIndOn').checked; saveIndicator(v); });
      $('profIndKeys').addEventListener('change', () => { const v = loadIndicator(); v.keys = $('profIndKeys').value; saveIndicator(v); });
    })();
```

- [ ] **Step 8: Syntax-check**

Run: `node --check th108-profiles.js`
Expected: OK (no output).

- [ ] **Step 9: Commit**

```bash
git add th108-profiles.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "profiles: per-profile type + color, capture-by-type, indicator settings row, push new fields"
```

---

### Task 5: Controller — load `profile-cycle.js`, live `applyData` (no reload)

**Files:**
- Modify: `th108-controller.html`

**Interfaces:**
- Consumes: `window.TH108ProfileCycle.mergeKeepingCycle` (Task 1); `LUI.restore`, `LUI.buildCards` (existing); `DC.pushConfig` (existing). The `applyData` callback is now invoked as `applyData(prof, index)` by `th108-profiles.js` Task 4.

- [ ] **Step 1: Load the pure module in the page**

In `th108-controller.html`, immediately after `<script src="th108-engine.js"></script>` (line ~1205), add:

```html
<script src="profile-cycle.js"></script>
```

- [ ] **Step 2: Make `applyData` live + type-aware**

Find the `applyData:` property passed to `TH108Profiles.create({…})` (the inline-script block around line ~2435-2441 — it currently does `localStorage.setItem('th108_layers', …)` … `location.reload();`). Replace the whole `applyData: d=>{ … }` arrow with:

```javascript
  applyData: (prof, index)=>{
    const type = (prof && prof.type) || 'lighting';
    if(type !== 'hotkey'){                                                   // lighting/global → swap layers live (no reload)
      localStorage.setItem('th108_layers', JSON.stringify((prof && prof.layers) || []));
      if(prof && prof.order) localStorage.setItem('th108_layerOrder', JSON.stringify(prof.order));
      else localStorage.removeItem('th108_layerOrder');
      try{ LUI.restore(); LUI.buildCards(); }catch(_){}                      // rebuild the layer cards in place from storage
      DC.pushConfig();
    }
    if(type === 'hotkey' || type === 'global'){                             // mirror host-actions into THIS page so the Host Actions tab reflects them
      let live=[]; try{ live=JSON.parse(localStorage.getItem('th108_host_actions')||'[]'); }catch(_){}
      const merged = (window.TH108ProfileCycle ? TH108ProfileCycle.mergeKeepingCycle((prof&&prof.hostActions)||[], live) : ((prof&&prof.hostActions)||[]));
      localStorage.setItem('th108_host_actions', JSON.stringify(merged));
    }
    try{ fetch('/apply-profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({index:index|0})}).catch(()=>{}); }catch(_){}   // daemon applies live + renders the flash
    log('profile "'+((prof&&prof.name)||'')+'" applied (live)','ok');
  },
```

- [ ] **Step 3: Syntax-check the inline script**

Run:
```bash
node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "controller: load profile-cycle.js; live profile Apply (no reload) via /apply-profile + host-action mirror"
```

---

### Task 6: Full verification (manual, with hardware)

**Files:** none (verification only).

- [ ] **Step 1: Regression — all unit suites green**

Run: `node --test profile-cycle.test.js th108-engine.test.js th108-layers-ui.test.js && (cd th108-daemon && node --test)`
Expected: all pass (profile-cycle 5, engine 76, layers-ui 8, daemon suite unchanged count).

- [ ] **Step 2: Restart the daemon**

The user restarts the daemon so it loads the new `daemon.js` + `profile-cycle.js`. Confirm `th108-daemon/daemon.log` shows a clean start.

- [ ] **Step 3: Lighting profile cycle + flash**

Save 2-3 **Lighting** profiles with distinct colors. Bind a key to **Profile → Next** on the Host Actions tab. Press it (page closed or not-driving): the board's lighting changes AND the corresponding number key (profile N → key N, number-row or numpad per the toggle) flashes its color for ~1s. Toggle the indicator off → no flash. Toggle numpad → flash moves to the numpad digit.

- [ ] **Step 4: Hotkey + global profiles**

Make a **Hotkey** profile (Update it while specific Host Actions are set) and a **Global** profile. Cycle to the Hotkey profile: Host Actions swap, lighting unchanged, and **the cycle key still works** (preserved). Cycle to Global: both swap. Confirm `th108-daemon/daemon.log` reflects the switches.

- [ ] **Step 5: Live manual Apply (no reload)**

On the Profiles tab, click **Apply** on a profile: the page must **NOT reload**; the layer cards rebuild in place; the board updates live and flashes the number (daemon mode). For a Hotkey/Global profile, the Host Actions tab reflects the swapped bindings.

- [ ] **Step 6: Persistence**

Refresh the page: profiles keep their type/color; the indicator toggle persists. Cycle with the page closed: still flashes per the saved indicator setting (daemon read `profile-indicator.json`).

---

## Self-Review notes (verified while writing)

- **Spec coverage:** types/capture/apply (Tasks 1,2,4,5) · per-profile color + 1s flash (Tasks 1,2) · indicator on/off + row/numpad (Tasks 2,3,4) · cycle-key preservation (Task 1 `stripCycleBindings`/`mergeKeepingCycle`, applied in Tasks 2,4,5) · live manual Apply + `/apply-profile` (Tasks 3,5) · daemon-mode scope (no page-open flash — `applyProfile` flash only renders while the daemon paints) · tests (Task 1, regression Task 6).
- **Type consistency:** `applyAspects`/`stripCycleBindings`/`mergeKeepingCycle`/`flashLed`/`flashActive` names match across Tasks 1↔2↔4↔5. `applyData(prof, index)` signature matches between Task 4 (caller) and Task 5 (impl). `setIndicator`/`applyProfileByIndex` match between Task 2 (control) and Task 3 (server).
- **Out of scope (v1):** keymap in profiles; page-open live cycling/flash; separate per-type rings; configurable flash duration.
