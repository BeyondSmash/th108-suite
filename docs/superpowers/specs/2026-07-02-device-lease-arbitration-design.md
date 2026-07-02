# Arbitrated Device Lease — Design

**Goal:** Replace the cooperative "yield/resume + guess-from-traffic" device handoff with a single **daemon-authoritative lease**, so the keyboard is only ever driven by one controller at a time, handoffs are atomic (no both-open overlap → no FIFO-desync mute), and a deprecated controller is told it lost the device and can reclaim it.

**Problem it solves:** The page (WebHID, in the browser) and the daemon (node-hid) can both hold an open handle to the keyboard at once — the OS allows shared HID opens. Today's `/yield`+`/resume` is a *polite request* with a 1.5s `probeTraffic` backstop; during a time-based handoff their writes can overlap, desyncing the board's report FIFO and muting it (`board went MUTE — no ACKs since open`). There is no single source of truth for "who owns the device" and no user-facing signal when ownership moves. Real incident 2026-07-01: daemon + an open controller tab tug-of-warred, the board muted, and recovery required a physical BT↔wired re-enumeration.

**Constraint that shapes everything:** The daemon **cannot** force the browser's WebHID handle closed. It can force-close *its own* node-hid handle instantly, but for a page it can only signal (via a value the page reads on its `/status` poll) and the page must close its handle and confirm. That confirmation is the missing atomicity. A non-cooperating owner (crashed tab, or an old cached page predating this protocol) is handled by a fallback ladder.

**Tech stack:** Vanilla Node (daemon) + vanilla browser JS (page). No build step, no new dependencies. Pure lease logic unit-tested via `node --test`; page-side WebHID + banner hardware-verified.

---

## Decisions (locked with the user)

1. **Takeover policy: newest-wins, automatic.** A new controller takes the device; the previous one is cleanly stood down and shown a reclaim banner. No "may I?" prompt on the common path.
2. **Stuck-owner fallback ladder: wait → probe → re-enumerate.** Bounded wait (~1.5s) for the loser's release confirmation; if none, run the existing traffic-probe and open only if the board is quiet; if *still* contended, fire a USB re-enumeration (drops all handles OS-side) as the guaranteed last resort. USB blip only on the worst-case path.
3. **Notification scope: page-only.** The losing tab shows a banner + Take-control-back. The tray may *reflect* the lease owner from the same `/status` field but gets no new popups (YAGNI).

---

## Architecture

### Lease model (the core)

The daemon holds one lease: `{ owner, epoch }`.

- `owner`: `'daemon'` (always-on baseline), a page's `clientId`, or `null` (transient, mid-handoff only).
- **Invariant: only the current lease-holder may open or write the device.**
- `clientId`: a random id each browser tab generates on load.
- `epoch`: monotonically increasing, bumped on every grant. Lets any page tell from `/status` whether it is still the owner.

This replaces the `paused` flag. The daemon's device-open gate changes from "open if `!paused`" to "open if `owner === 'daemon'`". A page opens its WebHID handle only while `owner === myClientId`. The 1.5s `probeTraffic` check survives, demoted from primary mechanism to a **backstop for the fallback path**.

### HTTP surface (extends the existing control API on `localhost:8123`)

- `POST /claim { clientId }` — request the device (newest-wins). The response **blocks until the caller may open**, returning `{ granted:true, epoch }` — through the full handoff (revoke current owner → await its `/release` → or run the fallback ladder). Blocking is fine: the existing `/yield` already blocks up to 25s for flash uploads. `/status` polling is *not* how the claimer learns it won — it is how *other* tabs learn they *lost* it (see below).
- `POST /release { clientId }` — the owner confirms it has **closed** its handle. Also sent best-effort via `navigator.sendBeacon` on page `unload`.
- `GET /status?clientId=<id>` — gains `{ leaseOwner, leaseEpoch }`. The `clientId` query param doubles as the **heartbeat**: when the poll's `clientId` equals `leaseOwner`, the daemon refreshes that owner's `lastSeen`.
- **Heartbeat timeout:** if the lease-holder's `/status` polls go silent past a timeout, the daemon treats it as crashed and reclaims (through the probe backstop). No separate endpoint — the owner's existing poll (now carrying its `clientId`) is the heartbeat.

### Handoff sequences

**Page claims from the daemon** (you open a controller tab):
1. Page `POST /claim` — does **not** open WebHID yet.
2. Daemon is current owner → force-closes its own node-hid handle instantly → `owner = null`.
3. Daemon grants: `owner = page`, `epoch++`, responds `granted`.
4. Page opens WebHID and drives. No overlap window.

**Page claims from another live page** (two tabs):
1. New page `POST /claim` → daemon sets `pendingOwner = newpage`, revokes the current owner.
2. Old page observes it is no longer owner → **closes its WebHID handle** → `POST /release`.
3. On `/release`, daemon grants `owner = newpage`, `epoch++`.
4. New page (awaiting the `/claim` response) opens WebHID.

**Stuck owner** (crashed tab / old cached page that doesn't speak the protocol):
- Daemon waits ~1.5s for `/release`. If none → run `probeTraffic`; open only if the board is quiet. If **still** contended → USB re-enumeration (drops every handle OS-side), then grant. Guaranteed clean; ~1-2s typing blip only on this worst-case path.

**Reclaim when all tabs close:**
- Page `unload` → best-effort `POST /release` via `navigator.sendBeacon`. Daemon returns `owner = daemon` after the existing settle-debounce, reopens.
- Beacon missed → lease-holder heartbeat times out → daemon reclaims via the probe backstop.

**Coalescing:** the existing restart/refresh coalescing + settle-debounce are preserved, so a reload storm still nets out to one clean grant rather than an open-then-close thrash.

### Notification UX (the deprecated controller)

When a page detects `leaseOwner !== myClientId` (via poll or its `/claim` flow), in order:
1. **Immediately closes its WebHID handle** — the safety-critical half: the loser stops driving *before* the winner opens, which is what prevents the overlap wedge. Not cosmetic.
2. Shows a non-blocking banner: *"Another controller took over the keyboard."* + **[Take control back]** (re-runs `/claim`; newest-wins takes it back cleanly). Auto-dismisses if this tab regains the lease.

Revoke latency = poll interval. During a contested handoff the losing tab briefly tightens its poll (or a short dedicated lease-poll) so handle-close + banner land within a few hundred ms — a hardware-tuned knob.

### Device-open gating (summary)

- **Daemon:** `tryOpen` proceeds only when `owner === 'daemon'` (replaces the `!paused` gate). Probe backstop retained for the fallback path.
- **Page:** opens WebHID only when `owner === myClientId`; closes it the instant it loses the lease.

---

## Error handling & edge cases

- **Daemon restart:** lease resets to `owner = 'daemon'` (comes up as baseline owner). Pages that were driving re-`/claim` on their next poll.
- **Claim storm** (rapid claims): coalesced like the current resume/yield debounce; last claim wins.
- **Mute after a clean handoff:** the existing recovery ladder (closeDevice → 5s reopen → USB restart) still applies to whoever holds the lease — it is the safety net, unchanged.
- **Stale writes:** a revoked page cannot write (its handle is closed). `epoch` mainly disambiguates `/status`; a late `/release` for an old epoch is ignored.
- **Old cached page (pre-protocol):** never sends `/claim`/`/release`; it just opens WebHID like today. The daemon's probe + re-enumerate fallback still reclaims cleanly — the design degrades safely for un-upgraded clients.

---

## Testing

- **Pure lease state machine** — `th108-daemon/device-lease.js` (built like `agent-state.js`): `createLease()` exposing `claim / release / heartbeat / tick(now)` returning `{ owner, epoch }` transitions, deterministic via injected `now`. Unit tests (`device-lease.test.js`):
  - newest-wins grant; release-triggers-grant of the pending owner
  - stuck-owner fallback *decision* escalation (wait → probe → re-enumerate)
  - reclaim-on-release → `owner = daemon`; heartbeat-timeout reclaim
  - `epoch` monotonic; late/stale release ignored
- **Daemon wiring** — connects the pure module to real open/close + probe + USB-reenumerate actions; `node --check`, existing daemon/server tests stay green.
- **Page + banner** — hardware/manual-verified (WebHID doesn't unit-test cleanly): tab-vs-daemon and tab-vs-tab takeover, reclaim on close, banner + Take-back, stuck-owner fallback.

---

## Files

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `th108-daemon/device-lease.js` | Create | Pure lease state machine: claim/release/heartbeat/tick → `{owner, epoch}`, fallback-decision |
| `th108-daemon/device-lease.test.js` | Create | `node --test` unit tests |
| `th108-daemon/daemon.js` | Modify | Replace `paused`/`yield`/`resume` internals with lease-gated open + fallback ladder; wire lease module |
| `th108-daemon/server.js` | Modify | `/claim`, `/release` routes; `leaseOwner`/`leaseEpoch` on `/status` |
| `th108-hid.js` (page) | Modify | Claim-before-open, close-on-revoke, `sendBeacon` release on unload |
| page UI (controller) | Modify | Deprecated banner + Take-control-back |

---

## Risk & sequencing

This is the **most regression-prone code in the project** — its history logs repeated mute regressions caused by batching device-handoff changes ("never batch device-handoff changes"). The implementation plan MUST sequence so the board is verifiable after each step and never left half-migrated:

1. Land the **pure lease module + tests** first — touches nothing live.
2. Then the **daemon gate** (lease-gated open + routes + fallback ladder) — hardware-check the daemon-only path.
3. Then the **page** (claim/release/banner) — hardware-check tab-vs-daemon, then tab-vs-tab.

One hardware-checked step at a time, never batched. The existing mute→reopen→USB-restart recovery ladder stays as the safety net throughout. Pure lighting only — no `0x50`/LCD writes, so no brick-risk upload rules apply.

## Out of scope (YAGNI)

- New tray popups (the tray may read `leaseOwner` but gets no new UI).
- Any change to the mute-recovery ladder itself (it remains the safety net, untouched).
- Multi-keyboard / multi-device arbitration (single board).
