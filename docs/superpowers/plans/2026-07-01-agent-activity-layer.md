# AI/LLM Agent-Activity Lighting Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-composited `type:'agent'` lighting layer that visualizes Claude Code agent activity (subagent twinkles, a numpad loading spinner, a green ✓ on turn-end, a "!" attention state, a boot sweep), fed by Claude Code hooks that POST to the daemon.

**Architecture:** Claude Code hooks fire `curl` POSTs (raw hook JSON) to a new daemon endpoint `POST /agent/event`. A pure `agent-state.js` module routes each event (on `hook_event_name`) into an in-memory per-session map and exposes an aggregate. The daemon folds that aggregate into `state.agent` every render tick (exactly like `state.audio`), and a new pure engine renderer `renderAgent` draws it. All rendering is host-side over the existing ACK-gated `0x32` stream — no LCD/flash writes.

**Tech Stack:** Vanilla Node (daemon) + vanilla browser JS (page). No build step, no new dependencies. Tests via `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-01-agent-activity-layer-design.md` (read it first).

## Global Constraints

- Commits authored as `Beyon <you@example.com>`, **NO Claude/Co-Authored-By trailer**. Use: `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`.
- Never commit Epomaker vendor bundles (`app.*.js`, `chunk-*.js`, `*.js.txt`) — gitignored.
- American spelling. No new npm dependencies (vanilla only).
- After editing `th108-controller.html`, syntax-check the inline script (see spec §1 of `_HANDOFF.md`). After editing a `.js`, `node --check <file>`.
- `th108-engine.js` is SHARED by page and daemon and is UMD — keep it DOM-free and pure.
- **A long-running daemon must be restarted to pick up engine changes** (modules are `require`'d at startup; no hot reload). Note this when hardware-verifying.
- Pure lighting only — no `0x50`/LCD writes, so none of the brick-risk upload rules apply here.

---

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `th108-daemon/agent-state.js` | Create | Pure per-session agent-activity state: `ingest`, `aggregate`, `sessions`, TTL sweep |
| `th108-daemon/agent-state.test.js` | Create | `node --test` unit tests for agent-state |
| `th108-engine.js` | Modify | `renderAgent` + `applyAgentFeed` + phase helpers + `case 'agent'` in `renderLayer` + exports |
| `th108-engine.test.js` | Modify | Tests for `renderAgent` / phase helpers |
| `th108-daemon/server.js` | Modify | `POST /agent/event`, `GET /agent/sessions` routes |
| `th108-daemon/daemon.js` | Modify | Wire agent-state; fold `state.agent` per tick; expose sessions on `/status` |
| `th108-layers-ui.js` | Modify | The `agent` layer card UI |
| `docs/agent-hooks-setup.md` | Create | The 7 hook one-liners for `~/.claude/settings.json` + install notes |

---

## Task 1: `agent-state.js` — pure per-session state

**Files:**
- Create: `th108-daemon/agent-state.js`
- Test: `th108-daemon/agent-state.test.js`

**Interfaces:**
- Produces: `createAgentState({ ttlMs?, busyTtlMs? }) -> { ingest(hookJson, now), aggregate(filter, now), sessions(now) }`
  - `ingest(hookJson, now)`: routes on `hookJson.hook_event_name`; `now` is `Date.now()` ms.
  - `aggregate(filter, now)`: `filter` is `'all'` or a `session_id` string; returns `{ busy:boolean, subagentCount:number, checkmarkAt:number, notifyAt:number, attention:boolean, bootAt:number }` (timestamps are ms, `0` when never).
  - `sessions(now)`: returns `[{ id, label, busy, subagentCount, lastSeen }]`.

- [ ] **Step 1: Write the failing test**

Create `th108-daemon/agent-state.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentState } = require('./agent-state.js');

const ev = (name, extra = {}) => Object.assign({ hook_event_name: name, session_id: 's1', cwd: '/home/u/proj' }, extra);

test('UserPromptSubmit sets busy; Stop clears busy + fires checkmark', () => {
  const A = createAgentState();
  A.ingest(ev('UserPromptSubmit'), 1000);
  assert.equal(A.aggregate('all', 1000).busy, true);
  A.ingest(ev('Stop'), 2000);
  const a = A.aggregate('all', 2000);
  assert.equal(a.busy, false);
  assert.equal(a.checkmarkAt, 2000);
});

test('SubagentStart/Stop tracks live count; Stop resets it to 0', () => {
  const A = createAgentState();
  A.ingest(ev('SubagentStart', { agent_id: 'a1' }), 1000);
  A.ingest(ev('SubagentStart', { agent_id: 'a2' }), 1100);
  assert.equal(A.aggregate('all', 1100).subagentCount, 2);
  A.ingest(ev('SubagentStop', { agent_id: 'a1' }), 1200);
  assert.equal(A.aggregate('all', 1200).subagentCount, 1);
  A.ingest(ev('Stop'), 1300);
  assert.equal(A.aggregate('all', 1300).subagentCount, 0);   // reset-on-Stop heals a missed SubagentStop
});

test('SubagentStart without agent_id still counts (anon fallback)', () => {
  const A = createAgentState();
  A.ingest(ev('SubagentStart'), 1000);
  A.ingest(ev('SubagentStart'), 1100);
  assert.equal(A.aggregate('all', 1100).subagentCount, 2);
  A.ingest(ev('SubagentStop'), 1200);   // no id → removes one anon
  assert.equal(A.aggregate('all', 1200).subagentCount, 1);
});

test('Notification latches attention; next activity clears it', () => {
  const A = createAgentState();
  A.ingest(ev('Notification'), 1000);
  let a = A.aggregate('all', 1000);
  assert.equal(a.attention, true);
  assert.equal(a.notifyAt, 1000);
  A.ingest(ev('UserPromptSubmit'), 2000);
  assert.equal(A.aggregate('all', 2000).attention, false);
});

test('SessionStart sets bootAt; SessionEnd drops the session', () => {
  const A = createAgentState();
  A.ingest(ev('SessionStart'), 1000);
  assert.equal(A.aggregate('all', 1000).bootAt, 1000);
  A.ingest(ev('SessionEnd'), 2000);
  assert.equal(A.sessions(2000).length, 0);
});

test('aggregate across sessions: busy=any, count=sum; filter isolates one', () => {
  const A = createAgentState();
  A.ingest({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a' }, 1000);
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: '/a', agent_id: 'x' }, 1000);
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's2', cwd: '/b', agent_id: 'y' }, 1000);
  assert.equal(A.aggregate('all', 1000).busy, true);
  assert.equal(A.aggregate('all', 1000).subagentCount, 2);
  assert.equal(A.aggregate('s2', 1000).busy, false);
  assert.equal(A.aggregate('s2', 1000).subagentCount, 1);
});

test('TTL sweep drops stale sessions and clears a leaked busy', () => {
  const A = createAgentState({ ttlMs: 10000, busyTtlMs: 5000 });
  A.ingest(ev('UserPromptSubmit'), 1000);          // busy, lastSeen=1000
  assert.equal(A.aggregate('all', 7000).busy, false);   // busy older than busyTtlMs → cleared
  assert.equal(A.sessions(12000).length, 0);            // lastSeen older than ttlMs → dropped
});

test('sessions() returns a label from cwd basename + short id', () => {
  const A = createAgentState();
  A.ingest({ hook_event_name: 'SessionStart', session_id: 'abcdef123456', cwd: '/home/u/Epomaker Project' }, 1000);
  const s = A.sessions(1000)[0];
  assert.match(s.label, /Epomaker Project/);
  assert.equal(s.id, 'abcdef123456');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd th108-daemon && node --test agent-state.test.js`
Expected: FAIL — `Cannot find module './agent-state.js'`.

- [ ] **Step 3: Write the implementation**

Create `th108-daemon/agent-state.js`:

```js
// Pure, in-memory agent-activity state fed by Claude Code hooks (via daemon POST /agent/event).
// One entry per Claude Code session_id; aggregate() merges across sessions (or filters to one) for the
// engine's 'agent' layer. Deterministic — every method takes `now` (ms) so it's unit-testable.
'use strict';

function basename(p) { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }

function createAgentState(opts = {}) {
  const TTL = opts.ttlMs || 10 * 60 * 1000;        // drop a session with no events for this long
  const BUSY_TTL = opts.busyTtlMs || 10 * 60 * 1000; // clear a busy that never got its Stop
  const map = new Map();   // session_id -> entry
  let anon = 0;

  function ensure(id, cwd, now) {
    let e = map.get(id);
    if (!e) { e = { subs: new Set(), busy: false, busyAt: 0, checkmarkAt: 0, notifyAt: 0, attention: false, bootAt: 0, cwd: cwd || '', lastSeen: now }; map.set(id, e); }
    if (cwd) e.cwd = cwd;
    e.lastSeen = now;
    return e;
  }
  function sweep(now) {
    for (const [id, e] of map) {
      if (now - e.lastSeen > TTL) { map.delete(id); continue; }
      if (e.busy && now - e.busyAt > BUSY_TTL) { e.busy = false; }   // leaked busy (missed Stop)
    }
  }

  function ingest(hook, now) {
    if (!hook || !hook.session_id) return;
    const name = hook.hook_event_name;
    const id = hook.session_id;
    if (name === 'SessionEnd') { map.delete(id); return; }
    const e = ensure(id, hook.cwd, now);
    switch (name) {
      case 'UserPromptSubmit': e.busy = true; e.busyAt = now; e.attention = false; break;
      case 'Stop': e.busy = false; e.subs.clear(); e.attention = false; e.checkmarkAt = now; break;
      case 'SubagentStart': e.subs.add(hook.agent_id || ('anon:' + (++anon))); e.attention = false; break;
      case 'SubagentStop': {
        if (hook.agent_id && e.subs.has(hook.agent_id)) e.subs.delete(hook.agent_id);
        else { const first = e.subs.values().next().value; if (first !== undefined) e.subs.delete(first); }
        e.attention = false; break;
      }
      case 'Notification': e.notifyAt = now; e.attention = true; break;
      case 'SessionStart': e.bootAt = now; break;
      default: break;   // unhooked event types ignored
    }
  }

  function pick(filter) { return filter && filter !== 'all' ? (map.has(filter) ? [map.get(filter)] : []) : [...map.values()]; }

  function aggregate(filter, now) {
    sweep(now);
    const es = pick(filter);
    let busy = false, count = 0, checkmarkAt = 0, notifyAt = 0, attention = false, bootAt = 0;
    for (const e of es) {
      if (e.busy) busy = true;
      count += e.subs.size;
      if (e.checkmarkAt > checkmarkAt) checkmarkAt = e.checkmarkAt;
      if (e.bootAt > bootAt) bootAt = e.bootAt;
      if (e.attention) { attention = true; if (e.notifyAt > notifyAt) notifyAt = e.notifyAt; }
    }
    return { busy, subagentCount: count, checkmarkAt, notifyAt, attention, bootAt };
  }

  function sessions(now) {
    sweep(now);
    return [...map.entries()].map(([id, e]) => ({ id, label: (basename(e.cwd) || 'session') + ' ' + id.slice(0, 6), busy: e.busy, subagentCount: e.subs.size, lastSeen: e.lastSeen }));
  }

  return { ingest, aggregate, sessions };
}

module.exports = { createAgentState };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd th108-daemon && node --test agent-state.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add th108-daemon/agent-state.js th108-daemon/agent-state.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "agent layer: pure per-session agent-activity state module + tests"
```

---

## Task 2: engine `renderAgent` + `applyAgentFeed` + phase helpers

**Files:**
- Modify: `th108-engine.js` (add renderer near the other `render*` fns ~line 500–860; add `case 'agent'` in `renderLayer` ~line 1002; add to the exports object ~line 1205; add `'agent'` to the engine's known layer types / defaults if it gates on type)
- Test: `th108-engine.test.js` (append)

**Interfaces:**
- Consumes: `state.agent` = the object shape returned by `agent-state.aggregate` (Task 1), plus `state.agent` may be `null` (idle/no feed).
- Produces:
  - `applyAgentFeed(state, feed)` — sets `state.agent = feed` (or `null`); mirrors how `applyAudioFeatures` stages the audio frame.
  - `renderAgent(L, now, state)` — writes `L.rgb` (Uint8/number array length `NLED*` per existing renderers) and sets/clears `L._alpha` (Float32Array) for the emphasis masks. Transparent (all rgb 0, alpha 0) when idle.
  - `agentPhase(notifyAt, now, s)` — pure helper returning `{ level:0..1, blink:boolean }` for the "!" hold→breathe→reminder lifecycle, where `s` = `{ holdMs, breatheMs, reminderEnabled, reminderAfterMs, reminderBlinks }`.

**Key mapping:** resolve LED indices from the engine's internal board map (the same `KEYMAP` the engine builds `INDICES` from — confirm the variable name in `th108-engine.js`; the daemon reads `KEYMAP['Numpad1']` etc. via `th108-map.js`, so these `KeyboardEvent.code` strings are valid):
- Spinner corners: `['Numpad3','Numpad1','Numpad7','Numpad9']` (loop 3→1→7→9→3); optional smooth march interpolates through edge keys `Numpad2` (bottom), `Numpad4` (left), `Numpad8` (top), `Numpad6` (right).
- Checkmark: `['Numpad7','Numpad5','Numpad9','NumpadSubtract']`.
- Exclamation: `['NumpadMultiply','Numpad9','Numpad6','NumpadDecimal']`.
- Twinkle default region: the letter cluster `['KeyA'..'KeyZ']` → their LED indices (default; overridden by `L.settings.twinkleKeys`, an array of LED indices).

- [ ] **Step 1: Write the failing test**

Append to `th108-engine.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('./th108-engine.js');

test('agentPhase: hold is solid, then breathes, then blinks on reminder', () => {
  const s = { holdMs: 1000, breatheMs: 2000, reminderEnabled: true, reminderAfterMs: 4000, reminderBlinks: 2 };
  assert.equal(E.agentPhase(0, 500, s).level, 1);              // inside hold → solid
  const mid = E.agentPhase(0, 2000, s);                        // breathing
  assert.ok(mid.level >= 0 && mid.level <= 1);
  const rem = E.agentPhase(0, 5000, s);                        // past reminderAfterMs → blink window
  assert.equal(typeof rem.blink, 'boolean');
});

test('agentPhase: reminder disabled never blinks', () => {
  const s = { holdMs: 1000, breatheMs: 2000, reminderEnabled: false, reminderAfterMs: 4000, reminderBlinks: 2 };
  assert.equal(E.agentPhase(0, 9000, s).blink, false);
});

test('renderAgent idle → all keys dark', () => {
  const L = { type: 'agent', settings: {}, rgb: [] };
  const state = { agent: null };
  E.renderAgent(L, 1000, state);
  assert.ok(L.rgb.every(v => v === 0));
});

test('renderAgent with subagents lights at least one key orange-ish', () => {
  const L = { type: 'agent', settings: { twinkleColor: '#ff8c00' }, rgb: [] };
  const state = { agent: { busy: true, subagentCount: 2, checkmarkAt: 0, notifyAt: 0, attention: false, bootAt: 0 } };
  E.renderAgent(L, 1000, state);
  let lit = 0; for (let i = 1; i < L.rgb.length; i += 4) if (L.rgb[i] > 0 || L.rgb[i + 1] > 0 || L.rgb[i + 2] > 0) lit++;
  assert.ok(lit > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `E.agentPhase is not a function` / `E.renderAgent is not a function`.

- [ ] **Step 3: Implement in `th108-engine.js`**

Add these near the other renderers (before `renderLayer`). Use the engine's existing helpers (`hexToRgb`, `NLED`, the internal board `KEYMAP`). Resolve a code→index helper once:

```js
  // ---- agent-activity layer (Claude Code hooks → state.agent) ----
  const AGENT_SPIN = ['Numpad3','Numpad1','Numpad7','Numpad9'];
  const AGENT_CHECK = ['Numpad7','Numpad5','Numpad9','NumpadSubtract'];
  const AGENT_BANG = ['NumpadMultiply','Numpad9','Numpad6','NumpadDecimal'];
  const AGENT_LETTERS = ['KeyA','KeyB','KeyC','KeyD','KeyE','KeyF','KeyG','KeyH','KeyI','KeyJ','KeyK','KeyL','KeyM','KeyN','KeyO','KeyP','KeyQ','KeyR','KeyS','KeyT','KeyU','KeyV','KeyW','KeyX','KeyY','KeyZ'];
  const codeIdx = (code) => { const led = KEYMAP[code]; return led === undefined ? -1 : INDICES.indexOf(led); };   // → slot in the flat/rgb buffer
  const AGENT_SPIN_K = AGENT_SPIN.map(codeIdx).filter(k => k >= 0);
  const AGENT_CHECK_K = AGENT_CHECK.map(codeIdx).filter(k => k >= 0);
  const AGENT_BANG_K = AGENT_BANG.map(codeIdx).filter(k => k >= 0);
  const AGENT_LETTER_K = AGENT_LETTERS.map(codeIdx).filter(k => k >= 0);

  function applyAgentFeed(state, feed) { state.agent = feed || null; }

  // "!" lifecycle: solid for holdMs, then breathe (sin), with a reminder double/triple-blink every
  // reminderAfterMs. Returns {level:0..1, blink:bool}. Pure — driven by (now - notifyAt).
  function agentPhase(notifyAt, now, s) {
    const t = now - (notifyAt || 0);
    const hold = s.holdMs == null ? 1000 : s.holdMs;
    const breatheMs = s.breatheMs || 1600;
    if (t < hold) return { level: 1, blink: false };
    const level = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((t - hold) / breatheMs * Math.PI * 2));
    let blink = false;
    if (s.reminderEnabled) {
      const after = s.reminderAfterMs || 8000;
      const cyc = t % after;
      const blinks = s.reminderBlinks || 2;
      const blinkSpan = blinks * 240;            // 120ms on / 120ms off per blink, at the end of each cycle
      if (cyc > after - blinkSpan) blink = (Math.floor((cyc - (after - blinkSpan)) / 120) % 2) === 0;
    }
    return { level, blink };
  }

  function renderAgent(L, now, state) {
    const out = L.rgb, s = L.settings || {}, A = state.agent;
    for (let i = 0; i < out.length; i++) out[i] = 0;   // start transparent
    L._alpha = null; L._carve = null;
    if (!A) return;
    const put = (k, r, g, b) => { if (k < 0) return; const o = k * 4; out[o + 1] = r | 0; out[o + 2] = g | 0; out[o + 3] = b | 0; };
    // subagent twinkles
    if (A.subagentCount > 0) {
      const [tr, tg, tb] = hexToRgb(s.twinkleColor || '#ff8c00');
      const region = (Array.isArray(s.twinkleKeys) && s.twinkleKeys.length) ? s.twinkleKeys.map(led => INDICES.indexOf(led)).filter(k => k >= 0) : AGENT_LETTER_K;
      const n = Math.min(A.subagentCount, region.length);
      for (let i = 0; i < n; i++) { const tw = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 300 + i * 1.7)); put(region[i], tr * tw, tg * tw, tb * tw); }
    }
    // numpad: ! (attention) > ✓ (flash) > spinner
    if (A.attention) {
      const [br, bg, bb] = hexToRgb(s.bangColor || '#ff3b30');
      const ph = agentPhase(A.notifyAt, now, s);
      const f = ph.blink ? 1 : ph.level;
      for (const k of AGENT_BANG_K) put(k, br * f, bg * f, bb * f);
    } else if (A.checkmarkAt && now - A.checkmarkAt < (s.checkMs || 1000)) {
      const [cr, cg, cb] = hexToRgb(s.checkColor || '#22cc44');
      for (const k of AGENT_CHECK_K) put(k, cr, cg, cb);
    } else if (A.busy && AGENT_SPIN_K.length) {
      const [pr, pg, pb] = hexToRgb(s.spinColor || '#ffffff');
      const speed = s.spinMs || 600, tail = s.spinTail || 2;
      const lead = Math.floor(now / speed) % AGENT_SPIN_K.length;
      for (let t = 0; t <= tail; t++) { const k = AGENT_SPIN_K[(lead - t + AGENT_SPIN_K.length) % AGENT_SPIN_K.length]; const f = 1 - t / (tail + 1); put(k, pr * f, pg * f, pb * f); }
    }
    // boot sweep (own region, coexists)
    if (A.bootAt && now - A.bootAt < (s.bootMs || 1000)) {
      const [sr, sg, sb] = hexToRgb(s.twinkleColor || '#ff8c00');
      const p = (now - A.bootAt) / (s.bootMs || 1000);
      for (let k = 0; k < INDICES.length; k++) { const kp = k / INDICES.length; const d = 1 - Math.min(1, Math.abs(kp - p) * 6); if (d > 0) { const o = k * 4; out[o + 1] = Math.max(out[o + 1], sr * d); out[o + 2] = Math.max(out[o + 2], sg * d); out[o + 3] = Math.max(out[o + 3], sb * d); } }
    }
    // emphasis: silhouette numpad / dim below → per-key alpha mask for the compositor
    const anyActive = A.busy || A.attention || A.subagentCount > 0 || (A.checkmarkAt && now - A.checkmarkAt < 1200) || (A.bootAt && now - A.bootAt < 1200);
    if (anyActive && (s.silhouetteNumpad || s.dimBelow)) {
      const ab = L._alpha = (L._alphaBuf || (L._alphaBuf = new Float32Array(NLED))); ab.fill(s.dimBelow ? (1 - (s.dimBelowAmt == null ? 0.9 : s.dimBelowAmt)) : 1);
      // NOTE: how _alpha composites vs layers-below is set by renderLayer/composite; confirm the sign
      // (mask multiplies THIS layer's opacity). If a "carve below" is needed, use L._carve like renderBars.
    }
  }
```

**Wire the dispatch** — in `renderLayer` (~line 1002), add a branch alongside the other types:

```js
      else if (L.type === 'agent') renderAgent(L, now, state);
```

**Export** — add to the returned module object (~line 1205):

```js
    applyAgentFeed, renderAgent, agentPhase,
```

If the engine gates known layer types anywhere (e.g. `ensureSettings`/`defaultLayers`), add default settings for `'agent'`: `{ twinkleColor:'#ff8c00', spinColor:'#ffffff', checkColor:'#22cc44', bangColor:'#ff3b30', session:'all', twinkleKeys:null, holdMs:1000, breatheMs:1600, reminderEnabled:true, reminderAfterMs:8000, reminderBlinks:2, silhouetteNumpad:false, dimBelow:false, dimBelowAmt:0.9 }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test th108-engine.test.js`
Expected: PASS (existing tests still green + 4 new).

- [ ] **Step 5: `node --check` and commit**

```bash
node --check th108-engine.js
git add th108-engine.js th108-engine.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "agent layer: engine renderAgent + applyAgentFeed + phase helpers"
```

> **Reviewer note:** confirm the `_alpha`/`_carve` compositing sign against `renderLayer` (~line 1021 reads `alpha=L._alpha`) and `renderBars` (uses `L._carve` for subtract). The emphasis mask math may need to match the carve pattern rather than the opacity pattern — verify visually against layers below.

---

## Task 3: `server.js` — `POST /agent/event` + `GET /agent/sessions`

**Files:**
- Modify: `th108-daemon/server.js` (add two route guards among the others ~line 82–211)
- Test: `th108-daemon/server.test.js` (append a route test if the existing harness supports it; otherwise the daemon integration test in Task 4 covers it)

**Interfaces:**
- Consumes (from `control`, provided by daemon in Task 4): `control.agentEvent(bodyObj)` → void; `control.agentSessions()` → array.
- The POST body is the raw hook JSON; parse it as JSON, tolerate non-JSON with a `400`.

- [ ] **Step 1: Add the routes**

In the request handler, next to the other `POST`/`GET` guards, add:

```js
      if (req.method === 'POST' && u === '/agent/event') {   // Claude Code hook posts raw hook JSON here
        let ev; try { ev = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.agentEvent) control.agentEvent(ev);
        return sendJson(res, 204, {});   // hooks are fire-and-forget; keep it cheap
      }
      if (req.method === 'GET' && u === '/agent/sessions') return sendJson(res, 200, { sessions: control.agentSessions ? control.agentSessions() : [] });
```

(`body` is already read for POSTs in this handler — confirm the variable name used by the existing `/config`/`/host-actions` POST branches and match it.)

- [ ] **Step 2: `node --check` + run existing server tests**

Run: `cd th108-daemon && node --check server.js && node --test server.test.js`
Expected: PASS (no regressions; existing 8 tests green).

- [ ] **Step 3: Commit**

```bash
git add th108-daemon/server.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "agent layer: POST /agent/event + GET /agent/sessions routes"
```

---

## Task 4: `daemon.js` — wire agent-state, feed `state.agent`, expose sessions

**Files:**
- Modify: `th108-daemon/daemon.js`

**Interfaces:**
- Consumes: `createAgentState` (Task 1), `applyAgentFeed`/aggregate shape (Task 2), the `control` object (extend it) consumed by `server.js` (Task 3).

- [ ] **Step 1: Instantiate agent-state (top, near the other requires/state)**

```js
const { createAgentState } = require('./agent-state.js');
const agentState = createAgentState();
```

- [ ] **Step 2: Fold `state.agent` into the render tick**

In `runTick`, right where the audio frame is folded in (the `if (acHandle) { ... applyAudioFeatures ... }` block, ~line 431), add — only meaningful when an `agent` layer is enabled:

```js
    const agL = state.layers.find(L => L.enabled && L.type === 'agent');
    E.applyAgentFeed(state, agL ? agentState.aggregate(agL.settings && agL.settings.session || 'all', Date.now()) : null);
```

- [ ] **Step 3: Extend the `control` object** (the object passed to `createServer`, ~line 900–931) with:

```js
  agentEvent: (ev) => agentState.ingest(ev, Date.now()),
  agentSessions: () => agentState.sessions(Date.now()),
```

- [ ] **Step 4: Expose sessions on `/status`** — in `control.status()` (so the page's session picker can read them without a separate call), add:

```js
    agentSessions: agentState.sessions(Date.now()),
```

- [ ] **Step 5: `node --check` + smoke test the endpoint**

```bash
cd th108-daemon && node --check daemon.js
# with the daemon running (see _HANDOFF.md §7):
curl -s -X POST http://127.0.0.1:8123/agent/event -H "Content-Type: application/json" -d '{"hook_event_name":"UserPromptSubmit","session_id":"t1","cwd":"/tmp/x"}'
curl -s http://127.0.0.1:8123/agent/sessions
```
Expected: the second curl lists a session `t1` with `busy:true`. Then POST a `Stop` and confirm `busy:false`.

- [ ] **Step 6: Commit**

```bash
git add th108-daemon/daemon.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "agent layer: daemon wires agent-state into the tick + control API"
```

---

## Task 5: `th108-layers-ui.js` — the agent layer card

**Files:**
- Modify: `th108-layers-ui.js`

**Guidance:** Follow the existing per-type card builders in this file (study the `audio` and `individual`/`media` cases — they show the color-picker, slider, toggle, and paint-board patterns). Add a `type:'agent'` case that renders:

- Color pickers: **Twinkle** (`twinkleColor`), **Spinner** (`spinColor`), **Checkmark** (`checkColor`), **Exclamation** (`bangColor`) — reuse the shared color-input helper.
- **Session filter** dropdown (`settings.session`): options `All sessions` + one per entry from `/status`'s `agentSessions` (value = `id`, label = `label`). Refresh the list when the card opens / on the `/status` poll.
- **Twinkle region** selector: reuse `th108-paint-board.js` (as the `individual` layer does) to select LED indices — **both marquee box-select AND individual add/remove** (Shift+click add, Ctrl+click remove) are already supported by the paint board. Store the chosen LED indices in `settings.twinkleKeys` (null = default letter cluster). Add a "Default (letters)" reset.
- **Emphasis** toggles: `silhouetteNumpad` (carve the numpad from layers below) and `dimBelow` (+ `dimBelowAmt` slider, default 0.9 = dim to 10%).
- **Exclamation animation** controls: `holdMs` slider, `reminderEnabled` toggle, `reminderAfterMs` slider, `reminderBlinks` (2/3 selector). Follow the existing lockable/collapsible boxed-section pattern used across the other layer cards.
- **Preview** toggle (`settings.preview`, page-side only): when on, the page injects a synthetic `state.agent` (fake `busy`, a couple of fake subagents, a periodic `checkmarkAt`, and a held `attention` with `notifyAt`) so colors/region/animation tune live without a daemon feed. Mirror the audio layer's synthetic-feed toggle.

- [ ] **Step 1: Add the `agent` case + settings defaults**, mirroring the audio card structure. Persist settings through the same layer-config path the other types use (so it round-trips to `config.json` and the daemon).

- [ ] **Step 2: Wire the twinkle-region paint-board** exactly as the `individual` layer does (same open/size/selection API), writing `settings.twinkleKeys`.

- [ ] **Step 3: Wire the Preview synthetic feed** — when `settings.preview` and the page is driving, set `state.agent` each frame from a small synthetic generator; otherwise leave it to the daemon.

- [ ] **Step 4: Syntax-check + browser-verify**

```bash
node -e "require('fs')"   # (HTML inline-script check per _HANDOFF.md §1 if you touched the HTML)
node --check th108-layers-ui.js
```
Then reload the controller in Chrome (cache-busted), add an `agent` layer, toggle **Preview**, and confirm: twinkles animate on the selected region, the spinner marches the numpad, ✓ flashes, and the "!" holds→breathes→blinks. Confirm no console errors (a half-applied inline-script edit silently breaks the whole page — see `th108-inline-script-tdz` memory).

- [ ] **Step 5: Commit**

```bash
git add th108-layers-ui.js th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "agent layer: layer card UI (colors, session filter, region cropper, emphasis, ! animation, preview)"
```

---

## Task 6: Claude Code hooks — install doc

**Files:**
- Create: `docs/agent-hooks-setup.md`

**Interfaces:** none (documentation + a copy-paste `settings.json` block).

- [ ] **Step 1: Write the setup doc**

Create `docs/agent-hooks-setup.md` with the 7 hooks for `~/.claude/settings.json`. Each runs the same one-liner; the daemon routes on `hook_event_name`. Body is the raw hook JSON piped through.

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }]
  }
}
```

Include notes: `async:true` means a down daemon never blocks Claude Code; Git Bash is the default hook shell on this machine (PowerShell fallback command in the spec §4); these are user-global (`~/.claude/settings.json`) so every session drives the lights.

- [ ] **Step 2: Install + end-to-end verify**

Merge the block into `~/.claude/settings.json`. In a Claude Code session, submit a prompt that spawns a subagent, and watch `th108-daemon/daemon.log` for `POST /agent/event` hits and the board animating (spinner while busy, ✓ on turn end). Verify `SubagentStop` actually carries `agent_id` (spec §4 open item) — if not, the counter fallback already handles it.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-hooks-setup.md
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "agent layer: Claude Code hooks setup doc (7 hooks → POST /agent/event)"
```

---

## Self-Review

- **Spec coverage:** data source (Tasks 1,3,4,6) · engine layer + all five visuals (Task 2) · session filter (Tasks 1,4,5) · croppable+individual twinkle region (Task 5) · emphasis silhouette/dim (Tasks 2,5) · "!" persistent lifecycle (Task 2) · preview (Task 5) · daemon-driven + restart note (Global Constraints, Task 4). Optional/future cues intentionally excluded (spec §7b).
- **Placeholders:** none — pure-logic tasks (1,2) carry full code + tests; integration tasks (3,4) carry the exact snippets; UI task (5) gives the concrete settings/keys and points at the exact existing patterns to mirror (the card's visual layout is legitimately pattern-matched to `audio`/`individual`, not inventable blind).
- **Type consistency:** `aggregate()` return shape (`{busy,subagentCount,checkmarkAt,notifyAt,attention,bootAt}`) is produced in Task 1 and consumed verbatim by `renderAgent`/`applyAgentFeed` in Task 2 and the daemon fold in Task 4. `control.agentEvent`/`control.agentSessions` defined in Task 4, consumed in Task 3. `settings.twinkleKeys` (LED-index array) written in Task 5, read in Task 2.

## Open items for the implementer (carried from spec §12)
- Verify `SubagentStop` carries `agent_id` (counter fallback already handles absence).
- Confirm the engine's internal board-map variable name (`KEYMAP`) and that `NumpadSubtract`/`NumpadMultiply`/`NumpadDecimal` code strings resolve (the daemon uses `Numpad0..9` already).
- Confirm the `_alpha`/`_carve` compositing sign for the emphasis masks against `renderLayer`/`renderBars`.
- Tune on hardware: spinner speed/tail, twinkle shimmer rate, checkmark duration, "!" hold/breathe/reminder timings.
