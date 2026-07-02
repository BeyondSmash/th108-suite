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
