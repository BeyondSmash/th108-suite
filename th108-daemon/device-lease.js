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
