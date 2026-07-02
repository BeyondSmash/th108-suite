# Arbitrated Device Lease — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cooperative "yield/resume + guess-from-traffic" keyboard handoff with a single daemon-authoritative device lease, so exactly one controller drives the board at a time, handoffs are atomic (no both-open overlap → no FIFO-desync mute), and a deprecated controller is told it lost the device and can reclaim it.

**Architecture:** A pure `device-lease.js` state machine owns `{ owner, epoch }` (`owner` = `'daemon'` | a page's `clientId` | `null` mid-handoff). The daemon derives its existing `paused` flag from `owner !== 'daemon'` (so all current `if (paused)` gates keep working) and executes the lease's side-effect decisions (close/open, traffic-probe, USB re-enumerate). New `POST /claim` blocks until the caller may open; `POST /release` confirms a handle closed; the existing 3s `/heartbeat` carries the owner's `clientId`; `/status` exposes `leaseOwner`/`leaseEpoch` so a losing tab closes its WebHID handle and shows a reclaim banner. Newest-wins.

**Tech Stack:** Vanilla Node (daemon) + vanilla browser JS (page). No build step, no new dependencies. Pure lease logic tested via `node --test`; daemon wiring and page WebHID hardware-verified.

**Spec:** `docs/superpowers/specs/2026-07-02-device-lease-arbitration-design.md` (read it first).

## Global Constraints

- Commits authored `Beyon <you@example.com>`, **NO Claude/Co-Authored-By trailer**. Use: `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`.
- American spelling. No new npm dependencies (vanilla only).
- After editing a `.js`, `node --check <file>`. After editing `th108-controller.html`'s inline script, extract + `node --check` the inline `<script>` body — but know `node --check` CANNOT catch a TDZ (a load-time init calling a `const`/`let` before its declaration silently halts the WHOLE page); verify the page loads in Chrome with no console errors.
- **This is the most regression-prone code in the project.** History logs repeated mute regressions from batching device-handoff changes. NEVER batch device-handoff changes: land one task, hardware-verify the board (spinner/lighting survives a handoff, no mute), then proceed. A long-running daemon must be **restarted** to pick up `daemon.js`/`device-lease.js` changes (no hot reload).
- Pure lighting only — no `0x50`/LCD writes here, so no brick-risk upload rules apply.
- The existing mute→reopen→USB-restart recovery ladder is the safety net and is **not** modified by this plan.

---

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `th108-daemon/device-lease.js` | Create | Pure single-owner arbitration: `owner`/`epoch`, claim/release/heartbeat/tick, stuck-owner escalation decision |
| `th108-daemon/device-lease.test.js` | Create | `node --test` unit tests for the lease |
| `th108-daemon/daemon.js` | Modify | Instantiate lease; derive `paused` from `owner!=='daemon'`; wire `claim/release/heartbeat`; gate `openIfPossible`; execute the fallback ladder; keep `/yield`+`/resume` as legacy aliases |
| `th108-daemon/server.js` | Modify | `POST /claim`, `POST /release` routes; `leaseOwner`/`leaseEpoch` on `/status`; pass `clientId` on `/heartbeat` |
| `th108-daemon-client.js` (page) | Modify | Generate `clientId`; `claim()`→open, `release()` on unload; heartbeat carries `clientId`; poll detects lease loss |
| `th108-hid.js` (page) | Modify | Open WebHID only after a granted claim; close-on-revoke |
| `th108-controller.html` (page) | Modify | Deprecated banner + Take-control-back button |

---

## Task 1: `device-lease.js` — pure arbitration state machine

**Files:**
- Create: `th108-daemon/device-lease.js`
- Test: `th108-daemon/device-lease.test.js`

**Interfaces:**
- Produces: `createLease({ settleMs?, releaseWaitMs?, heartbeatTtlMs? }) -> { owner(), epoch(), pending(), claim(id, now), release(id, now), heartbeat(id, now), tick(now), probeResult(quiet, now), forceGrant(now) }`
  - `owner()` → `'daemon'` | `clientId` | `null`. `epoch()` → int (bumped every grant).
  - `claim(id, now)` → `{ granted:boolean, revoke?:prevOwner }`. Grants instantly when the device is held by `'daemon'` or `null`; otherwise sets `pending` and returns `{ granted:false, revoke:prevPageId }`.
  - `release(id, now)` → `{ granted:owner|null }`. Grants a waiting `pending`; with no pending, a page handing back schedules a debounced daemon reclaim.
  - `heartbeat(id, now)` → refreshes the owner's liveness.
  - `tick(now)` → `null` | `{ action:'reclaim' }` | `{ action:'probe', id }` — time-driven transitions (settle reclaim, heartbeat-timeout reclaim, stuck-owner escalation to probe).
  - `probeResult(quiet, now)` → `{ action:'grant', id }` | `{ action:'reenumerate', id }` — daemon reports the probe outcome.
  - `forceGrant(now)` → `{ action:'grant', id }` — grant after a USB re-enumeration.

- [ ] **Step 1: Write the failing test**

Create `th108-daemon/device-lease.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createLease } = require('./device-lease.js');

test('starts owned by the daemon', () => {
  const L = createLease();
  assert.equal(L.owner(), 'daemon');
  assert.equal(L.epoch(), 1);
});

test('a page claiming from the daemon is granted instantly (daemon closes its own handle)', () => {
  const L = createLease();
  const r = L.claim('pageA', 1000);
  assert.equal(r.granted, true);
  assert.equal(L.owner(), 'pageA');
  assert.equal(L.epoch(), 2);
});

test('claiming from a live page is NOT instant — it must release first (newest-wins pending)', () => {
  const L = createLease();
  L.claim('pageA', 1000);                 // pageA owns
  const r = L.claim('pageB', 1100);       // pageB wants it
  assert.equal(r.granted, false);
  assert.equal(r.revoke, 'pageA');
  assert.equal(L.owner(), 'pageA');       // still pageA until it releases
  assert.equal(L.pending(), 'pageB');
});

test('release by the revoked page grants the pending claimer', () => {
  const L = createLease();
  L.claim('pageA', 1000);
  L.claim('pageB', 1100);
  const r = L.release('pageA', 1200);
  assert.equal(r.granted, 'pageB');
  assert.equal(L.owner(), 'pageB');
  assert.equal(L.pending(), null);
  assert.equal(L.epoch(), 3);             // grant A (2) then grant B (3)
});

test('idempotent re-claim by the current owner stays granted, no epoch bump', () => {
  const L = createLease();
  L.claim('pageA', 1000);
  const e = L.epoch();
  const r = L.claim('pageA', 1050);
  assert.equal(r.granted, true);
  assert.equal(L.epoch(), e);
});

test('a page releasing with no pending hands back to the daemon after the settle debounce', () => {
  const L = createLease({ settleMs: 500 });
  L.claim('pageA', 1000);
  L.release('pageA', 2000);               // handing back
  assert.equal(L.owner(), null);          // nobody drives during settle
  assert.equal(L.tick(2300), null);       // still within settle
  assert.deepEqual(L.tick(2600), { action: 'reclaim' });
  assert.equal(L.owner(), 'daemon');
});

test('owner heartbeat timeout reclaims to the daemon', () => {
  const L = createLease({ heartbeatTtlMs: 9000 });
  L.claim('pageA', 1000);
  L.heartbeat('pageA', 1000);
  assert.equal(L.tick(5000), null);              // still fresh
  assert.deepEqual(L.tick(11000), { action: 'reclaim' });   // >9s since last beat
  assert.equal(L.owner(), 'daemon');
});

test('stuck revoked owner escalates to a probe after releaseWaitMs, then grants on a quiet probe', () => {
  const L = createLease({ releaseWaitMs: 1500 });
  L.claim('pageA', 1000);
  L.claim('pageB', 2000);                 // revokes pageA; pageA never releases
  assert.equal(L.tick(3000), null);       // within the release wait
  assert.deepEqual(L.tick(3600), { action: 'probe', id: 'pageB' });   // >1.5s → probe
  const r = L.probeResult(true, 3700);    // board quiet → grant
  assert.deepEqual(r, { action: 'grant', id: 'pageB' });
  assert.equal(L.owner(), 'pageB');
});

test('a contended probe escalates to a USB re-enumeration, then forceGrant completes it', () => {
  const L = createLease({ releaseWaitMs: 1500 });
  L.claim('pageA', 1000);
  L.claim('pageB', 2000);
  L.tick(3600);                            // → probe
  const r = L.probeResult(false, 3700);    // still contended → re-enumerate
  assert.deepEqual(r, { action: 'reenumerate', id: 'pageB' });
  assert.equal(L.owner(), 'pageA');        // not granted yet
  const g = L.forceGrant(4200);            // after the re-enumeration drops all handles
  assert.deepEqual(g, { action: 'grant', id: 'pageB' });
  assert.equal(L.owner(), 'pageB');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd th108-daemon && node --test device-lease.test.js`
Expected: FAIL — `Cannot find module './device-lease.js'`.

- [ ] **Step 3: Write the implementation**

Create `th108-daemon/device-lease.js`:

```js
'use strict';
// Pure single-owner device arbitration. No I/O — every mutator takes `now` (ms) so it is unit-testable.
// This module decides WHO owns the keyboard and WHEN a stuck handoff should escalate; the daemon executes
// the side effects (open/close its own handle, traffic-probe, USB re-enumerate). See the spec for why the
// daemon can force-close only its OWN handle and must ask a page to close (and confirm) its WebHID handle.
function createLease(opts = {}) {
  const SETTLE = opts.settleMs || 500;               // debounce before the daemon reclaims after a page hands back
  const RELEASE_WAIT = opts.releaseWaitMs || 1500;   // how long to wait for a revoked page to confirm /release
  const HB_TTL = opts.heartbeatTtlMs || 9000;        // owner silent this long (missed heartbeats) → treat as crashed

  let owner = 'daemon';   // 'daemon' | clientId | null (null = mid-handoff, nobody drives)
  let epoch = 1;          // bumped on every grant; lets a page tell from /status if it is still the owner
  let pending = null;     // clientId awaiting a grant (a revoked live page must release first)
  let revokedAt = 0;      // when the pending claim revoked a live page (drives the stuck-owner ladder)
  let stage = 'wait';     // stuck-owner ladder: 'wait' -> 'probe' -> 'reenumerate'
  let reclaimAt = 0;      // when to hand back to the daemon after a page release (settle debounce)
  const seen = new Map(); // clientId -> last heartbeat ms

  function grant(id, now) {
    owner = id; epoch++; pending = null; revokedAt = 0; stage = 'wait'; reclaimAt = 0;
    if (id && id !== 'daemon') seen.set(id, now);
  }

  return {
    owner: () => owner,
    epoch: () => epoch,
    pending: () => pending,

    // A controller requests the device. { granted:true } means the caller may open NOW.
    claim(id, now) {
      if (!id) return { granted: false };
      if (id === owner) { seen.set(id, now); return { granted: true }; }   // idempotent re-claim, no epoch bump
      const prev = owner;
      if (prev === 'daemon' || prev === null) { grant(id, now); return { granted: true }; }  // instant: daemon/idle
      pending = id; revokedAt = now; stage = 'wait';   // a live page holds it → it must release first
      return { granted: false, revoke: prev };
    },

    // The revoked owner confirms it closed its handle → grant the pending claimer. With no pending, a page
    // is handing back to the daemon → schedule a debounced reclaim (nobody drives until it fires).
    release(id, now) {
      if (pending) { const p = pending; grant(p, now); return { granted: p }; }
      if (id === owner) { owner = null; reclaimAt = now + SETTLE; return { granted: null }; }
      return { granted: null };
    },

    heartbeat(id, now) { if (id) seen.set(id, now); },

    // Time-driven transitions. Returns an ACTION the daemon must execute, or null.
    tick(now) {
      if (owner === null && reclaimAt && now >= reclaimAt && !pending) { grant('daemon', now); return { action: 'reclaim' }; }
      if (owner && owner !== 'daemon' && !pending) {
        const ls = seen.get(owner) || 0;
        if (ls && now - ls > HB_TTL) { owner = null; grant('daemon', now); return { action: 'reclaim' }; }
      }
      if (pending && revokedAt && stage === 'wait' && now - revokedAt >= RELEASE_WAIT) {
        stage = 'probe';
        return { action: 'probe', id: pending };
      }
      return null;
    },

    // Daemon's traffic-probe finished: quiet=true means no other writer → grant; else escalate to re-enumerate.
    probeResult(quiet, now) {
      if (!pending) return null;
      if (quiet) { const p = pending; grant(p, now); return { action: 'grant', id: p }; }
      stage = 'reenumerate';
      return { action: 'reenumerate', id: pending };
    },

    // After the daemon USB-reenumerates (all OS handles dropped), force the grant.
    forceGrant(now) {
      if (!pending) return null;
      const p = pending; grant(p, now);
      return { action: 'grant', id: p };
    }
  };
}

module.exports = { createLease };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd th108-daemon && node --test device-lease.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: `node --check` and commit**

```bash
node --check th108-daemon/device-lease.js
git add th108-daemon/device-lease.js th108-daemon/device-lease.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "device lease: pure single-owner arbitration state machine + tests"
```

**Hardware note:** none — this task touches nothing live.

---

## Task 2: `server.js` — `/claim`, `/release`, lease fields on `/status`, `clientId` on `/heartbeat`

**Files:**
- Modify: `th108-daemon/server.js`

**Interfaces:**
- Consumes (from `control`, provided by daemon in Task 3): `control.claim(bodyObj)` → `Promise<{granted, epoch}>`; `control.release(bodyObj)` → void; `control.heartbeat(bodyObj)` → existing (extend to read `clientId`).
- The existing request handler reads the POST body into `b` (via `readBody(req)`), the parsed path into `u`, and replies with `sendJson(res, code, obj)` (confirm these names against the neighboring `/config` / `/agent/event` branches and match them).

- [ ] **Step 1: Add the routes**

Among the other route guards in the request handler (next to `/agent/event` from the prior feature), add:

```js
      if (req.method === 'POST' && u === '/claim') {          // a controller asks for the device (newest-wins)
        let ev; try { ev = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        const out = control.claim ? await control.claim(ev) : { granted: true, epoch: 0 };
        return sendJson(res, 200, out);   // BLOCKS in control.claim until the caller may open (or the fallback resolves)
      }
      if (req.method === 'POST' && u === '/release') {        // the revoked owner confirms it closed its handle
        let ev; try { ev = JSON.parse(b || '{}'); } catch { ev = {}; }   // sendBeacon may send text/plain; tolerate
        if (control.release) control.release(ev);
        return sendJson(res, 204, {});
      }
```

- [ ] **Step 2: Pass `clientId` through the existing `/heartbeat` branch**

Find the existing `/heartbeat` POST branch. It currently calls a heartbeat/npWants path. Parse the (possibly empty) JSON body and forward `clientId` to `control.heartbeat`:

```js
      if (req.method === 'POST' && u === '/heartbeat') {
        let ev = {}; try { ev = JSON.parse(b || '{}'); } catch {}
        const out = control.heartbeat ? control.heartbeat(ev) : {};   // control.heartbeat(ev) reads ev.clientId (Task 3)
        return sendJson(res, 200, out || {});
      }
```

(If the current `/heartbeat` branch has a different shape, preserve its existing response payload — e.g. `npWants` — and only add the parse + `clientId` forwarding. Do not drop existing fields.)

- [ ] **Step 3: `node --check` + run existing server tests**

Run: `cd th108-daemon && node --check server.js && node --test server.test.js`
Expected: PASS (existing tests green; `/status` lease fields are added in Task 3 via `control.status()`).

- [ ] **Step 4: Commit**

```bash
git add th108-daemon/server.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "device lease: /claim + /release routes; clientId on /heartbeat"
```

**Hardware note:** none yet — routes are inert until Task 3 supplies `control.claim`/`release` and the daemon derives `paused` from the lease.

---

## Task 3: `daemon.js` — lease as source of truth, derived `paused`, fallback ladder, legacy aliases

**Files:**
- Modify: `th108-daemon/daemon.js`

**Interfaces:**
- Consumes: `createLease` (Task 1). Provides to `server.js` (Task 2): `control.claim`, `control.release`, and an extended `control.heartbeat` reading `clientId`; `leaseOwner`/`leaseEpoch` on `control.status()`.
- Internal contract: **`paused` is DERIVED** — after any lease transition, `paused = (lease.owner() !== 'daemon')`. All existing `if (paused)` gates (`openIfPossible`, `runTick`, `sendOnboard`, `npWants`, `syncAudioCapture`) keep working unchanged.

- [ ] **Step 1: Instantiate the lease and a `syncPaused` helper (near the other requires/state, by `let paused = false`)**

```js
const { createLease } = require('./device-lease.js');
const lease = createLease();
// paused is now DERIVED from the lease so every existing `if (paused)` gate keeps working.
function syncPaused() {
  const held = lease.owner() !== 'daemon';
  if (held !== paused) { paused = held; syncAudioCapture(); }   // capture follows ownership, exactly as yield/resume did
}
```

- [ ] **Step 2: Gate `openIfPossible` on daemon ownership**

In `openIfPossible` (the `if (device || paused || probing) return;` guard), the derived `paused` already blocks opening while a page owns the device — no change needed to that line. Confirm `syncPaused()` runs before the tick's `openIfPossible()` call (Step 6 wires it into `runTick`). The `probeTraffic` backstop stays as-is.

- [ ] **Step 3: Wire `control.claim` (BLOCKS until the caller may open)**

Add to the `control` object (near `yield`/`resume`). This replaces the primary handoff path:

```js
  // A controller (page clientId) asks for the device. Blocks until it may open — through the full handoff:
  // revoke a live page → await its /release → or run the fallback ladder (probe → USB re-enumerate). Newest-wins.
  async claim(ev) {
    const id = ev && ev.clientId; if (!id) return { granted: false, epoch: lease.epoch() };
    const r = lease.claim(id, Date.now());
    if (r.granted) { closeDevice(); syncPaused(); return { granted: true, epoch: lease.epoch() }; }  // we held it (or idle) → drop our handle, page opens
    // a live page holds it: the revoked page sees leaseOwner change on its poll and POSTs /release; the
    // lease grants on that release, or tick() escalates (probe → re-enumerate). Wait up to 6s for a grant.
    const t0 = Date.now();
    while (lease.owner() !== id && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 40));
    syncPaused();
    return { granted: lease.owner() === id, epoch: lease.epoch() };
  },
```

- [ ] **Step 4: Wire `control.release` and extend `control.heartbeat`**

```js
  // A page confirms it closed its WebHID handle (or is handing back on unload). Grants a pending claimer,
  // or schedules the debounced daemon reclaim (tick() fires it).
  release(ev) { lease.release(ev && ev.clientId, Date.now()); syncPaused(); },
```

Find `control.heartbeat` (or the `/heartbeat` handler's target). Extend it to record the owner's liveness without dropping its existing return value (e.g. `npWants`):

```js
  heartbeat(ev) { if (ev && ev.clientId) lease.heartbeat(ev.clientId, Date.now()); return { npWants: this.npWants() }; },
```

(Match the existing heartbeat's real return payload — keep whatever fields it already returned; only add the `lease.heartbeat` call.)

- [ ] **Step 5: Keep `/yield` + `/resume` as legacy aliases (degrade safely for un-upgraded pages)**

An old cached page (pre-lease) still calls `/yield`/`/resume` with no `clientId`. Map them onto the lease under a fixed legacy id so those pages keep working:

```js
  // LEGACY: pages predating the lease call /yield//resume with no clientId. Map them to a fixed legacy owner
  // so an un-upgraded page still takes/releases the device through the same single-owner lease.
  async yield() {
    lease.claim('legacy-page', Date.now()); syncPaused();
    const tf = Date.now(); while (sendingFrame && Date.now() - tf < 1500) await new Promise(r => setTimeout(r, 25));
    closeDevice(); muteLogged = false;
    const t0 = Date.now(); while (lcdBusy && Date.now() - t0 < 25000) await new Promise(r => setTimeout(r, 100));
  },
  resume() { lease.release('legacy-page', Date.now()); syncPaused(); },   // reclaim is debounced by the lease's SETTLE + tick
```

(This preserves `yield()`'s in-flight-frame drain and the `lcdBusy` block; it drops the old `resumeTimer` debounce because the lease now owns the settle timing. Remove the now-unused `resumeTimer`/`HANDOFF_SETTLE_MS` only if nothing else references them — otherwise leave them.)

- [ ] **Step 6: Drive the lease clock + execute its actions in the tick**

At the top of `runTick`, before `openIfPossible()`, drive the lease and execute any action it returns:

```js
  syncPaused();
  const act = lease.tick(Date.now());
  if (act && act.action === 'probe') {
    // revoked page never released — probe on a throwaway handle; quiet ⇒ grant, else escalate to re-enumerate
    const p = T.findPath();
    if (p) { let d = null; try { d = T.openDevice(p); const traffic = await T.probeTraffic(d, 1500); try { d.close(); } catch {} lease.probeResult(traffic === 0, Date.now()); } catch { try { if (d) d.close(); } catch {} } }
  } else if (act && act.action === 'reenumerate') {
    fireUsbRestart();            // existing USB-restart path (the same one /usbfix triggers); drops all handles OS-side
    setTimeout(() => { lease.forceGrant(Date.now()); syncPaused(); }, 2500);   // grant after re-enumeration settles
  }
  // 'reclaim' needs no action here — owner is now 'daemon', so openIfPossible() (below) will reopen.
```

(Use the daemon's actual USB-restart function name in place of `fireUsbRestart()` — it is the routine behind the `/usbfix` route; confirm its name in `daemon.js` and call it directly.)

- [ ] **Step 7: Expose lease fields on `/status`**

In `control.status()`'s returned object, add:

```js
    leaseOwner: lease.owner(), leaseEpoch: lease.epoch(),
```

- [ ] **Step 8: `node --check` + smoke-test the daemon-only path**

```bash
cd th108-daemon && node --check daemon.js
```
Then **restart the daemon** and, with NO controller page open, confirm normal lighting drives the board (the daemon is `owner:'daemon'`, `paused:false`). Smoke-test the lease over HTTP:
```bash
curl -s http://127.0.0.1:8123/status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('leaseOwner',j.leaseOwner,'epoch',j.leaseEpoch,'paused',j.paused)})"
# expect: leaseOwner 'daemon', paused false, device driving
curl -s -X POST http://127.0.0.1:8123/claim -H "Content-Type: application/json" -d '{"clientId":"smoke1"}'
# expect: {"granted":true,...}; /status now shows leaseOwner 'smoke1', paused true, daemon closed its handle
curl -s -X POST http://127.0.0.1:8123/release -H "Content-Type: application/json" -d '{"clientId":"smoke1"}'
# after ~1s /status returns to leaseOwner 'daemon', paused false, lighting resumes
```

- [ ] **Step 9: Commit**

```bash
git add th108-daemon/daemon.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "device lease: daemon derives paused from the lease, wires claim/release/heartbeat + fallback ladder"
```

**Hardware checkpoint (REQUIRED before Task 4):** with the daemon restarted and no page open, verify the board lights normally and the curl claim/release cycle above hands the device off and back with **no mute**. This isolates the daemon side before the page changes.

---

## Task 4: page `th108-daemon-client.js` + `th108-hid.js` — claim-before-open, release, loss detection

**Files:**
- Modify: `th108-daemon-client.js` (the `DC` client), `th108-hid.js` (WebHID open/close)

**Interfaces:**
- Consumes: `POST /claim {clientId}` → `{granted, epoch}`; `POST /release {clientId}`; `/heartbeat` accepts `{clientId}`; `/status` returns `{leaseOwner, leaseEpoch}` (Tasks 2-3).
- Produces (for Task 5): `DC.onLeaseLost(cb)` — registers a callback fired when this page loses the lease (drives the banner); `DC.clientId` — this page's id; `DC.reclaim()` — re-claim (Take-control-back).

- [ ] **Step 1: Generate a per-page `clientId` and send it on the heartbeat**

In `th108-daemon-client.js`, near the `D` state object, add a stable per-load id and include it on the heartbeat POST:

```js
    const clientId = 'pg-' + Math.random().toString(36).slice(2) + '-' + (performance.now() | 0);
```

In `beat()`, send the id so the daemon can track this page's liveness (the heartbeat is the lease heartbeat):

```js
      fetch('/heartbeat', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) })
```

(Preserve the existing handling of the heartbeat response — e.g. reading `npWants`.)

- [ ] **Step 2: Replace `yieldDevice()` with a lease `claim()` that resolves only when granted**

The current `yieldDevice()` tells the daemon to back off, then the caller opens WebHID. Change it to claim the lease and return whether the caller may open:

```js
    // Claim the device from the daemon/other tab (newest-wins). Resolves { granted } — the caller opens WebHID
    // only when granted. Replaces the old fire-and-forget /yield (kept as a fallback for a daemon predating /claim).
    let _claimInflight = null;
    async function claim() {
      if (_claimInflight) return _claimInflight;
      _claimInflight = (async () => {
        try {
          const r = await fetch('/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) });
          if (r.ok) { const j = await r.json(); D.yielded = j.granted; return { granted: !!j.granted }; }
        } catch (_) {}
        // daemon too old for /claim → fall back to the legacy yield so an old daemon still hands off
        try { await fetch('/yield', { method: 'POST' }); D.yielded = true; return { granted: true }; } catch (_) { return { granted: false }; }
      })().finally(() => { _claimInflight = null; });
      return _claimInflight;
    }
```

- [ ] **Step 3: `release()` sends the clientId (unload beacon)**

Update `resume()`/release to identify this page:

```js
    function release() {
      if (!D.yielded) return;
      D.yielded = false;
      const body = JSON.stringify({ clientId });
      if (navigator.sendBeacon) navigator.sendBeacon('/release', new Blob([body], { type: 'application/json' }));
      else fetch('/release', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body });
    }
```

Wire `release()` to the existing unload handler (wherever the old `resume()` was called on `beforeunload`/`pagehide`).

- [ ] **Step 4: Detect lease loss on the existing `/status` poll → fire the callback**

The `/status` poll already reads the JSON. Track `leaseOwner`; when it stops being us (after we were the owner), fire a registered callback so the page closes its handle + shows the banner:

```js
    let _leaseCb = null;
    // in the /status handler, after parsing `s`:
        if (s.leaseOwner !== undefined) {
          const wasMine = D._owned;
          D._owned = (s.leaseOwner === clientId);
          if (wasMine && !D._owned && _leaseCb) _leaseCb();   // we just lost the device to another controller
        }
```

Expose the registration + reclaim + id on the returned `DC` object:

```js
      clientId,
      onLeaseLost(cb) { _leaseCb = cb; },
      reclaim: claim,
```

(Also rename the existing exported `yieldDevice`/`resume` references to `claim`/`release`, or keep the old names as thin aliases so existing callers in `th108-hid.js` still resolve — update those callers in Step 5.)

- [ ] **Step 5: `th108-hid.js` — open only after a granted claim; close on loss**

Where `th108-hid.js` currently calls `DC.yieldDevice()` then opens the device, change it to await the claim and open only if granted:

```js
      const { granted } = await DC.claim();
      if (!granted) { /* another controller holds it — stay hands-off; the banner (Task 5) offers Take control */ return; }
      if (!device.opened) await device.open();
```

Register a loss handler that closes this page's WebHID handle the instant the daemon says another controller took over (this is the safety-critical close-before-the-winner-opens):

```js
      DC.onLeaseLost(async () => { try { if (device && device.opened) await device.close(); } catch (_) {} /* Task 5 shows the banner */ });
```

Confirm the existing `beforeAutoReconnect()` / wake-rebind path now goes through `DC.claim()` (await granted) rather than a bare yield, so a wake can't reopen over another owner.

- [ ] **Step 6: Syntax-check + hardware-verify tab-vs-daemon**

```bash
node --check th108-daemon-client.js && node --check th108-hid.js
```
Reload the controller in Chrome (cache-busted). With the daemon driving, open the page → confirm it **claims and takes over cleanly** (daemon yields, no mute), edits apply live. Close the page → daemon **reclaims** within ~1s, lighting resumes. Watch `daemon.log` for a clean single `leaseOwner` transition each way (no "another writer" / MUTE). No console errors.

- [ ] **Step 7: Commit**

```bash
git add th108-daemon-client.js th108-hid.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "device lease: page claims before opening, releases on unload, closes on loss"
```

**Hardware checkpoint (REQUIRED before Task 5):** tab-vs-daemon takeover and reclaim both clean, no mute, single lease transition in the log.

---

## Task 5: `th108-controller.html` — deprecated banner + Take-control-back

**Files:**
- Modify: `th108-controller.html`

**Guidance:** Add a small fixed banner element and wire it to `DC.onLeaseLost` / `DC.reclaim`. Keep logic in a small inline handler that runs AFTER `DC` is created (avoid the TDZ trap — declare/reference nothing before its definition; a load-time reference to a `const` before its line silently halts the whole page).

- [ ] **Step 1: Add the banner element** (hidden by default), near the top of the controller body:

```html
<div id="leaseBanner" style="display:none;position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;background:#3a2a2a;color:#ffd9d0;text-align:center;font:14px system-ui">
  Another controller took over the keyboard.
  <button id="leaseReclaim" style="margin-left:12px">Take control back</button>
</div>
```

- [ ] **Step 2: Wire it (after `DC` is created — same block that starts the client)**

```html
<script>
  (function () {
    var banner = document.getElementById('leaseBanner');
    var btn = document.getElementById('leaseReclaim');
    if (!banner || !btn || !window.DC) return;
    DC.onLeaseLost(function () { banner.style.display = 'block'; });   // th108-hid.js already closed our handle
    btn.addEventListener('click', async function () {
      const r = await DC.reclaim();
      if (r && r.granted) { banner.style.display = 'none'; /* th108-hid.js reopens on the next drive path */ }
    });
  })();
</script>
```

(Place this AFTER the script that assigns `window.DC`. If `DC` is module-scoped rather than global, add a tiny `window.DC = DC;` export where it is created, or call the wiring from inside that module — do NOT reference `DC` before it exists.)

- [ ] **Step 3: Reopen on reclaim**

Ensure clicking Take-control-back not only re-claims the lease but also re-opens WebHID and resumes driving — reuse the page's existing "connect / start driving" entry point (the same one used on first open) so a reclaim fully restores control, not just the lease. If that entry point is a function in `th108-hid.js`, expose it and call it from the reclaim handler after a granted `DC.reclaim()`.

- [ ] **Step 4: Syntax-check + hardware-verify tab-vs-tab**

Extract + `node --check` the inline `<script>` body. Reload in Chrome. Open the controller in **two tabs**: opening/claiming in tab B must make tab A **show the banner and go hands-off** (tab A's board control drops cleanly, no mute), and tab A's **Take control back** must return control to tab A (bumping the epoch, tab B then shows the banner). Confirm the page still loads with no console errors (TDZ check). Close both tabs → daemon reclaims.

- [ ] **Step 5: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "device lease: deprecated-controller banner + Take control back"
```

**Hardware checkpoint:** tab-vs-tab takeover shows the banner, hands off cleanly with no mute, and Take-control-back works both directions.

---

## Self-Review

- **Spec coverage:** lease model + `owner`/`epoch` (Task 1) · newest-wins (Task 1 `claim`, Task 4 `claim()`) · atomic handoff via release-confirm (Task 1 `release`, Task 3 `claim` wait, Task 4 release + close-on-loss) · stuck-owner fallback ladder wait→probe→re-enumerate (Task 1 `tick`/`probeResult`/`forceGrant`, Task 3 Step 6) · `/claim` blocks until granted (Task 2, Task 3 Step 3) · `/status` lease fields + heartbeat via `/heartbeat`+clientId (Tasks 2-4) · deprecated banner + Take-back (Task 5) · reclaim-on-all-tabs-closed (Task 1 release→settle reclaim, Task 4 unload beacon + Task 3 tick) · derived `paused` keeps existing gates (Task 3) · legacy `/yield`+`/resume` degrade path (Task 3 Step 5) · restart-to-reload + never-batch handoff notes (Global Constraints, per-task hardware checkpoints).
- **Placeholders:** none — Task 1 carries full module + 9 tests; Tasks 2-5 carry the exact snippets grounded in the real `daemon.js`/`server.js`/`th108-daemon-client.js`/`th108-hid.js`, with the two "confirm the real name" points (the USB-restart function; the heartbeat's existing return payload) called out explicitly rather than assumed.
- **Type consistency:** `createLease` return shape (Task 1) is consumed verbatim by the daemon (Task 3). `{granted, epoch}` from `/claim` (Task 2) is produced by `control.claim` (Task 3) and consumed by `DC.claim()` (Task 4). `clientId` flows page→`/heartbeat`/`/claim`/`/release`→`lease` (Tasks 2-4). `leaseOwner`/`leaseEpoch` produced in `control.status()` (Task 3), read by the poll (Task 4) to fire `onLeaseLost` (Task 5).

## Open items for the implementer
- Confirm the daemon's real USB-restart function name (behind the `/usbfix` route) and call it in Task 3 Step 6.
- Confirm the existing `/heartbeat` response payload and preserve it while adding `clientId` handling (Task 2 Step 2, Task 3 Step 4).
- Confirm whether `DC` is a global (`window.DC`) or module-scoped, and expose the minimum needed for the Task 5 banner + reclaim-reopen without introducing a load-time TDZ.
- Tune on hardware: the lease's `releaseWaitMs` (probe escalation), `heartbeatTtlMs` (crash reclaim), and the losing tab's poll tightening for snappy banner/handle-close latency.
