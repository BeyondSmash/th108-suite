# Advanced Keys UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Combination / Mod-Tap / Toggle / SOCD advanced-key binding to the Hotkeys tab, using the wire-captured keymap entry types (spec: `docs/superpowers/specs/2026-06-11-advanced-keys-design.md`).

**Architecture:** Everything extends `th108-binder.js` — pure encoders + mods-map `pair` support exported for `node --test`; the Advanced Keys card UI lives inside `create()` and reuses the existing `keymapRMW` (validated read → full 512-byte rewrite), board selection, marks, and progress overlay. `th108-controller.html` only gains the card markup.

**Tech Stack:** Vanilla JS (zero-build UMD), `node --test`, playwright MCP smoke against the daemon page on :8123.

**Ground truth (sniffer captures, `_parse_sniff.js` output):** CB on M = `07 e2 e4 06` (L-Alt+R-Ctrl+C) · MT on Y = `09 1c 2b 28` (tap Y, hold Tab, time 40) · TGL on K = `0a 15 00 00` (toggles R) · SOCD on ←/↓ = `0b 03 50 51` written identically to BOTH key slots (mode 3 = the only captured mode).

**Hard rules:** commits authored as `Beyon <you@example.com>`, NO Claude attribution. `node --check` after every .js edit; the `new Function` HTML script check after every HTML edit. Never write a keymap from an unvalidated read (keymapRMW already enforces this — do not bypass it).

---

### Task 1: Pure encoders + MODIFIERS table

**Files:**
- Modify: `th108-binder.js` (after the existing `entryBytes` helpers, ~line 60)
- Test: `th108-binder.test.js`

- [ ] **Step 1: Write the failing tests** (append to `th108-binder.test.js`)

```js
test('advanced-key encoders match the wire captures byte-for-byte', () => {
  assert.deepEqual(B.encodeCB(0xE2, 0xE4, 0x06), [0x07, 0xE2, 0xE4, 0x06]);   // CB_ex1: M = L-Alt+R-Ctrl+C
  assert.deepEqual(B.encodeMT(0x1c, 0x2b, 0x28), [0x09, 0x1c, 0x2b, 0x28]);   // MT_ex1: Y = tap Y / hold Tab / 40
  assert.deepEqual(B.encodeMT(0x1c, 0x2b), [0x09, 0x1c, 0x2b, 0x28]);         // 40 = the captured default time
  assert.deepEqual(B.encodeTGL(0x15), [0x0a, 0x15, 0x00, 0x00]);              // Tgl_ex1: K toggles R
  assert.deepEqual(B.encodeSOCD(0x50, 0x51), [0x0b, 0x03, 0x50, 0x51]);       // SOCD_ex1: ←/↓, mode 3 only
});

test('MODIFIERS are exactly the 8 HID modifier usages', () => {
  assert.deepEqual(B.MODIFIERS.map(m => m.hid), [0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7]);
  assert.ok(B.MODIFIERS.every(m => typeof m.label === 'string' && m.label));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test th108-binder.test.js`
Expected: 2 failures — `B.encodeCB is not a function` etc.

- [ ] **Step 3: Implement** (in `th108-binder.js`, directly after the `entryBytes` function)

```js
  // ---- advanced-key entry encoders (types 0x07/0x09/0x0a/0x0b, wire-captured 2026-06-11) ----
  const MODIFIERS = [
    { label: 'L-Ctrl', hid: 0xE0 }, { label: 'L-Shift', hid: 0xE1 }, { label: 'L-Alt', hid: 0xE2 }, { label: 'L-Win', hid: 0xE3 },
    { label: 'R-Ctrl', hid: 0xE4 }, { label: 'R-Shift', hid: 0xE5 }, { label: 'R-Alt', hid: 0xE6 }, { label: 'R-Win', hid: 0xE7 }
  ];
  function encodeCB(mod1, mod2, key)    { return [0x07, mod1 & 0xFF, mod2 & 0xFF, key & 0xFF]; }            // one key = a whole chord
  function encodeMT(click, hold, time)  { return [0x09, click & 0xFF, hold & 0xFF, (time == null ? 0x28 : time) & 0xFF]; }   // tap/hold; 0x28=40 = official default
  function encodeTGL(key)               { return [0x0a, key & 0xFF, 0x00, 0x00]; }                          // tap toggles <key> held
  function encodeSOCD(hidA, hidB)       { return [0x0b, 0x03, hidA & 0xFF, hidB & 0xFF]; }                  // mode 3 (last-pressed-wins) = the only captured mode; write to BOTH keys
```

Add `MODIFIERS, encodeCB, encodeMT, encodeTGL, encodeSOCD` to the UMD return object at the bottom of the file.

- [ ] **Step 4: Verify pass**

Run: `node --check th108-binder.js && node --test th108-binder.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add th108-binder.js th108-binder.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: advanced-key entry encoders (CB/MT/TGL/SOCD) byte-matched to the wire captures"
```

---

### Task 2: SOCD `pair` support in the mods map + `restoreTargets`

**Files:**
- Modify: `th108-binder.js` (`normalizeMods`, plus a new pure helper after `groupPlan`)
- Test: `th108-binder.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test('normalizeMods preserves a valid SOCD pair and drops a dangling one', () => {
  const m = B.normalizeMods({
    88: { label: 'SOCD ←', bytes: [0x0b, 3, 0x50, 0x51], pair: 89 },
    89: { label: 'SOCD ↓', bytes: [0x0b, 3, 0x50, 0x51], pair: 88 },
    56: { label: 'TGL R', bytes: [0x0a, 0x15, 0, 0], pair: 999 },    // out of range → dropped
    50: { label: 'X', bytes: [0x02, 0, 4, 0], pair: 51 },            // partner has no entry → dropped
    40: { label: 'Y', bytes: [0x02, 0, 4, 0], pair: 40 }             // self-pair → dropped
  });
  assert.equal(m[88].pair, 89);
  assert.equal(m[89].pair, 88);
  assert.equal(m[56].pair, undefined);
  assert.equal(m[50].pair, undefined);
  assert.equal(m[40].pair, undefined);
});

test('a SOCD pair survives the group-toggle round-trip', () => {
  const mods = { 88: { label: 'SOCD ←', bytes: [0x0b, 3, 0x50, 0x51], pair: 89 },
                 89: { label: 'SOCD ↓', bytes: [0x0b, 3, 0x50, 0x51], pair: 88 } };
  const there = B.groupPlan(mods, true);
  assert.deepEqual(there.writes.map(w => w.idx).sort((a, b) => a - b), [88, 89]);   // both keys park
  assert.equal(there.next[88].pair, 89);                                            // pair survives
  const back = B.groupPlan(there.next, false);
  assert.deepEqual(back.next, mods);                                                // lossless round-trip
});

test('restoreTargets pulls in the SOCD partner, never Fn or unknown keys', () => {
  const mods = { 88: { label: 'SOCD ←', bytes: [0x0b, 3, 0x50, 0x51], pair: 89 } };
  assert.deepEqual(B.restoreTargets(mods, 88), [88, 89]);                 // pair → both restored
  assert.deepEqual(B.restoreTargets(mods, 50), [50]);                     // unpaired key → itself
  assert.deepEqual(B.restoreTargets({ 50: { label: 'x', bytes: [2, 0, 4, 0], pair: 85 } }, 50), [50]);   // Fn partner excluded
});
```

(Note: `pair: 85` in the last case is unreachable via `normalizeMods` — `restoreTargets` guards anyway because it plans raw keymap writes.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test th108-binder.test.js`
Expected: 3 failures (`pair` stripped by normalizeMods; `restoreTargets` undefined).

- [ ] **Step 3: Implement**

In `normalizeMods`, after the `if (v.off && e.bytes) e.off = true;` line add:

```js
      if (Number.isInteger(v.pair) && v.pair >= 0 && v.pair < 128 && v.pair !== +k) e.pair = v.pair;   // SOCD partner link
```

and after the first loop (before `return out;`):

```js
    for (const e of Object.values(out)) if (e.pair != null && !out[e.pair]) delete e.pair;   // a pair link must point at a real entry
```

After `groupPlan`, add:

```js
  // keys to restore when the user reverts `idx`: the key itself plus its SOCD partner — a
  // half-removed SOCD pair is undefined firmware behavior, so the pair always goes together.
  // Only keys with a known factory entry qualify (defaultEntry refuses Fn/unknown).
  function restoreTargets(mods, idx) {
    const e = mods[idx], t = [idx];
    if (e && Number.isInteger(e.pair) && e.pair !== idx) t.push(e.pair);
    return t.filter(v => defaultEntry(v));
  }
```

Add `restoreTargets` to the UMD return object.

- [ ] **Step 4: Verify pass**

Run: `node --check th108-binder.js && node --test th108-binder.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add th108-binder.js th108-binder.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: SOCD pair links in th108_key_mods + restoreTargets (a pair restores together)"
```

---

### Task 3: Batched `setMods` + pair-aware Restore Default

**Files:**
- Modify: `th108-binder.js` (inside `create()`: the mods block and `revert()`)

Why batched: SOCD must save BOTH entries in one localStorage write — two sequential `setMod` calls would let `normalizeMods` drop the first entry's `pair` (its partner doesn't exist yet between the calls).

- [ ] **Step 1: Replace `setMod` with `setMods` + a thin wrapper** (in the mods block inside `create()`)

```js
    // batched write: SOCD saves two linked entries at once — sequential single-entry saves would
    // let normalizeMods drop the first pair link (its partner doesn't exist yet between saves)
    function setMods(entries) {   // {idx: {label, bytes, pair?} | null}
      const m = loadMods();
      for (const [i, e] of Object.entries(entries)) {
        if (!e) { delete m[i]; if (board && board.unmark) board.unmark(+i); }
        else { m[i] = e; if (board && board.mark) board.mark(+i, e.label); }
      }
      saveMods(m);
      refresh();   // the group-toggle button mirrors the mods map
    }
    function setMod(idx, label, bytes) {
      setMods({ [idx]: label == null ? null : (bytes ? { label, bytes: bytes.slice() } : { label }) });
    }
```

(The old `setMod` body — including its `saveMods`/`refresh` calls — is replaced by these two; every existing call site keeps working.)

- [ ] **Step 2: Make `revert()` restore the SOCD partner too**

Replace the body of `revert()`:

```js
    async function revert() {
      const sel = selKey(); if (!bindable(sel)) return;
      const targets = restoreTargets(loadMods(), sel.idx);
      const ok = await keymapRMW(km => targets.forEach(v => setEntry(km, v, defaultEntry(v))),
                                 'Restoring ' + (sel.label || 'Space') + (targets.length > 1 ? ' + its SOCD partner' : '') + '…');
      if (!ok) return;
      setMods(Object.fromEntries(targets.map(v => [v, null])));
      log('✓ ' + (sel.label || 'Space') + (targets.length > 1 ? ' and its SOCD partner' : '') + ' restored to default', 'ok');
      if (board && board.clear) board.clear();   // restored = done with this key — drop the selection
    }
```

- [ ] **Step 3: Verify**

Run: `node --check th108-binder.js && node --test *.test.js`
Expected: full suite passes (no behavior change for non-SOCD paths).

- [ ] **Step 4: Commit**

```bash
git add th108-binder.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: batched setMods + Restore Default takes the SOCD partner with it"
```

---

### Task 4: Advanced Keys card — markup + UI wiring

**Files:**
- Modify: `th108-controller.html` (card markup after `#decoTogglesCard`, ~line 387)
- Modify: `th108-binder.js` (card logic inside `create()`, before `setConnected`)

- [ ] **Step 1: Add the card markup** (in `th108-controller.html`, immediately after the closing `</div>` of `#decoTogglesCard`)

```html
  <div class="card s4" id="advKeysCard" data-pages="hotkeys">
    <div class="cardbar"><span class="grip">⠿</span><h2>Advanced Keys</h2></div>
    <p class="hint" style="margin:4px 0 10px">Give one key a smarter behavior. Like everything on this tab it lives
       in the keyboard's keymap — works in every app, no software needed. Pick a key on the board, choose a behavior,
       Apply. Restore Default undoes it. (The official tool allows up to 40 advanced keys.)</p>
    <div class="bdtabs" id="akTabs"></div>
    <p class="hint" id="akDesc" style="margin:8px 0"></p>
    <div id="akForm" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"></div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
      <button id="akApply" disabled>Apply</button>
      <span class="hint" id="akState" style="margin:0"></span>
    </div>
  </div>
```

- [ ] **Step 2: Add the card logic** (in `th108-binder.js`, inside `create()`, after the backup/restore + group-toggle listeners, before the decorative-toggles IIFE)

```js
    // ---- Advanced Keys card: CB / MT / TGL / SOCD (entry types 0x07/0x09/0x0a/0x0b) ----
    const AK_TYPES = [
      { key: 'cb',   name: 'Combination', desc: 'One key presses a whole shortcut — e.g. M acts as L-Alt + R-Ctrl + C.' },
      { key: 'mt',   name: 'Mod-Tap',     desc: 'Tap = one key, hold = another — e.g. tap Y types Y, hold Y acts as Tab.' },
      { key: 'tgl',  name: 'Toggle',      desc: 'Tap toggles another key held down — e.g. K toggles R held (autorun in games). Tap again to release.' },
      { key: 'socd', name: 'SOCD',        desc: 'Pairs two opposing keys (like A and D): when both are physically down, the last one pressed wins.' }
    ];
    const KEY_ITEMS = [];   // palette basic+extended, deduped by HID — labels for every assignable key
    PALETTE.find(t => t.key === 'basic').items.concat(PALETTE.find(t => t.key === 'extended').items)
      .forEach(it => { if (!KEY_ITEMS.some(x => x.hid === it.hid)) KEY_ITEMS.push(it); });
    const HID_LABEL = {}; KEY_ITEMS.forEach(it => { HID_LABEL[it.hid] = it.label; });
    MODIFIERS.forEach(m => { if (!HID_LABEL[m.hid]) HID_LABEL[m.hid] = m.label; });
    const keyShort = hid => (HID_LABEL[hid] || ('HID ' + hid)).split(' ')[0];   // board marks are tiny — first word only
    let akType = 'cb';

    function akSelEl(id, items, selVal) {
      const s = document.createElement('select'); s.id = id;
      items.forEach(it => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; if (it.value === selVal) o.selected = true; s.appendChild(o); });
      return s;
    }
    const keyOpts = () => KEY_ITEMS.map(it => ({ value: it.hid, label: it.label }));
    const modOpts = () => MODIFIERS.map(m => ({ value: m.hid, label: m.label }));
    function akPartnerOpts(selIdx) {   // every board key except Fn and the selected key, labeled via its factory HID
      return Object.keys(DEFAULT_HID).map(Number)
        .filter(v => v !== selIdx && v !== FN_VAL)
        .map(v => ({ value: v, label: HID_LABEL[DEFAULT_HID[v]] || ('key ' + v) }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }
    function akLab(text) { const s = document.createElement('span'); s.className = 'hint'; s.style.margin = '0'; s.textContent = text; return s; }

    function akRenderTabs() {
      const host = $('akTabs');
      AK_TYPES.forEach(t => {
        const b = document.createElement('button');
        b.className = 'patbtn' + (t.key === akType ? ' sel' : ''); b.textContent = t.name; b.dataset.ak = t.key;
        b.addEventListener('click', () => { akType = t.key; host.querySelectorAll('.patbtn').forEach(x => x.classList.toggle('sel', x.dataset.ak === akType)); akRenderForm(); });
        host.appendChild(b);
      });
    }
    function akRenderForm() {   // re-rendered on type switch AND board-selection change (fresh defaults)
      const f = $('akForm'); f.textContent = '';
      $('akDesc').textContent = AK_TYPES.find(t => t.key === akType).desc;
      const sel = selKey(), ownHid = sel ? DEFAULT_HID[sel.idx] : null;
      if (akType === 'cb') {
        f.appendChild(akLab('presses')); f.appendChild(akSelEl('akMod1', modOpts(), 0xE0));
        f.appendChild(akLab('+')); f.appendChild(akSelEl('akMod2', modOpts(), 0xE1));
        f.appendChild(akLab('+')); f.appendChild(akSelEl('akKey', keyOpts(), 6));
      } else if (akType === 'mt') {
        f.appendChild(akLab('tap =')); f.appendChild(akSelEl('akClick', keyOpts(), ownHid != null ? ownHid : 4));
        f.appendChild(akLab('hold =')); f.appendChild(akSelEl('akHold', keyOpts(), 43));
        f.appendChild(akLab('threshold'));
        const n = document.createElement('input'); n.type = 'number'; n.id = 'akTime'; n.min = 1; n.max = 255; n.value = 40;
        n.style.width = '64px'; n.title = 'hold-time threshold — 40 is the official default (units unknown)';
        f.appendChild(n);
      } else if (akType === 'tgl') {
        f.appendChild(akLab('toggles')); f.appendChild(akSelEl('akKey', keyOpts(), 0x15)); f.appendChild(akLab('held on/off'));
      } else {
        f.appendChild(akLab('pairs with'));
        f.appendChild(akSelEl('akPartner', akPartnerOpts(sel ? sel.idx : -1)));
        f.appendChild(akLab('· Last Pressed Wins (mode 3 — the only wire-captured mode)'));
      }
      akRefresh();
    }
    function akRefresh() {   // called from refresh() so connect/busy changes flow through
      const sel = selKey(), ok = bindable(sel), en = connected && !busy && ok;
      $('akApply').disabled = !en;
      $('akApply').textContent = 'Apply to ' + (ok ? (sel.label || 'Space') : 'selected key');
      $('akState').textContent = !connected ? 'needs Connect' : (ok ? '' : 'pick a key on the board above');
    }
    async function akApply() {
      const sel = selKey(); if (!bindable(sel) || busy) return;
      const own = sel.label || 'Space';
      if (akType === 'socd') {
        const pv = +$('akPartner').value, a = DEFAULT_HID[sel.idx], b = DEFAULT_HID[pv];
        if (b == null || pv === sel.idx || pv === FN_VAL) return;
        const four = encodeSOCD(a, b);
        const ok = await keymapRMW(km => { setEntry(km, sel.idx, four); setEntry(km, pv, four); },
                                   'Pairing ' + own + ' + ' + keyShort(b) + ' (SOCD)…');
        if (!ok) return;
        setMods({ [sel.idx]: { label: 'SOCD ' + keyShort(a), bytes: four.slice(), pair: pv },
                  [pv]:      { label: 'SOCD ' + keyShort(b), bytes: four.slice(), pair: sel.idx } });
        log('✓ SOCD pair: ' + keyShort(a) + ' ⟷ ' + keyShort(b) + ' — last pressed wins. Restore Default on either key removes both.', 'ok');
        return;
      }
      let four, label;
      if (akType === 'cb') {
        const m1 = +$('akMod1').value, m2 = +$('akMod2').value, k = +$('akKey').value;
        four = encodeCB(m1, m2, k); label = keyShort(m1) + '+' + keyShort(m2) + '+' + keyShort(k);
      } else if (akType === 'mt') {
        const c = +$('akClick').value, h = +$('akHold').value;
        const t = Math.max(1, Math.min(255, parseInt($('akTime').value, 10) || 40));
        four = encodeMT(c, h, t); label = keyShort(c) + '⇄' + keyShort(h);
      } else {
        const k = +$('akKey').value;
        four = encodeTGL(k); label = 'TGL ' + keyShort(k);
      }
      const ok = await keymapRMW(km => setEntry(km, sel.idx, four), 'Assigning ' + own + ' → ' + label + '…');
      if (!ok) return;
      setMod(sel.idx, label, four);
      log('✓ ' + own + ' is now an advanced key: ' + label + ' — Restore Default to undo', 'ok');
    }
    $('akApply').addEventListener('click', akApply);
    if (board) board.onChange(akRenderForm);   // selection change re-renders (MT tap default, SOCD partner list)
    akRenderTabs(); akRenderForm();
```

Also: in `refresh()`, add `akRefresh();` as the last line (before `renderGrid()` is fine too, but last keeps it simple) — NOTE `akRefresh` is a hoisted function declaration in the same scope, so the call works even though it's defined later in the source.

- [ ] **Step 3: Syntax checks + tests**

Run:
```bash
node --check th108-binder.js
node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"
node --test *.test.js
```
Expected: OK + full suite passes.

- [ ] **Step 4: Commit**

```bash
git add th108-binder.js th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "feat: Advanced Keys card — Combination / Mod-Tap / Toggle / SOCD binding on the Hotkeys tab"
```

---

### Task 5: Playwright smoke on :8123

No hardware needed — the card must render, gate, and survive a reload with fake mods.

- [ ] **Step 1: Load `http://localhost:8123/th108-controller.html`** (daemon serves it; `node _serve.js` if the daemon is down), switch to the Hotkeys tab.

- [ ] **Step 2: Verify via `browser_evaluate`:**
  - the 4 type buttons render; clicking each swaps `#akDesc` + `#akForm` contents (CB: 3 selects; MT: 2 selects + number input value 40; TGL: 1 select; SOCD: partner select + "mode 3" text);
  - `#akApply` disabled with `#akState` = "needs Connect" (no device in the test browser);
  - clicking a board key updates `#akApply` text to "Apply to <key>"; MT re-render defaults tap = that key's own character;
  - inject a fake SOCD pair into `th108_key_mods` (`{88:{label:'SOCD ←',bytes:[11,3,80,81],pair:89},89:{label:'SOCD ↓',bytes:[11,3,80,81],pair:88}}`), reload → both keys marked, group-toggle info says "2 keys remapped";
  - zero console errors; clean up the injected localStorage afterwards.

- [ ] **Step 3: Screenshot `#advKeysCard`** for the session record.

---

### Task 6: Memory + wrap-up

- [ ] **Step 1: Update `th108-refactor.md` memory** — Advanced Keys UI DONE (commit hash, pending hw glance: one CB bind → chord → Restore Default; one SOCD pair → last-pressed-wins → Restore Default restores both). Update the keymap-binder memory's "Remaining" line (SOCD mode enum + scroll capture still open; advanced UI no longer pending).

- [ ] **Step 2: Report to the user** — what shipped, the two hw tests to run when at the keyboard, and that SOCD's other modes + single-mod CB stay blocked on captures.
