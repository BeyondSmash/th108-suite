// nowplaying.test.js — the pure state machine: debounce, pause-hold, dedupe, backoff.
// Run: node --test nowplaying.test.js   (no sidecar / hardware — decide() takes an injected clock)
const test = require('node:test');
const assert = require('node:assert');
const NP = require('./nowplaying.js');

test('track change uploads only after 2.5s stability; skip-spam collapses to one upload', () => {
  const st = NP.newState();
  assert.equal(NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0), null);
  assert.equal(NP.decide(st, null, 1000), null);                      // 1s: still settling
  assert.equal(NP.decide(st, { title: 'B', artist: 'x', status: 'playing' }, 1500), null);   // skip resets the clock
  assert.equal(NP.decide(st, null, 3000), null);                      // B only 1.5s old
  const act = NP.decide(st, null, 4100);                              // B stable 2.6s
  assert.deepEqual(act, { upload: { title: 'B', artist: 'x', status: 'playing' } });
  assert.equal(NP.decide(st, null, 5000), null, 'no duplicate upload for the same identity+status');
  // the same event arriving again (sidecar re-print) must not re-upload either
  assert.equal(NP.decide(st, { title: 'B', artist: 'x', status: 'playing' }, 6000), null);
  assert.equal(NP.decide(st, null, 9000), null);
});

test('pause must hold >5s; flapping costs nothing; a held pause re-uploads the paused variant', () => {
  const st = NP.newState();
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0);
  assert.ok(NP.decide(st, null, 2600), 'playing uploaded');
  NP.decide(st, { title: 'A', artist: 'x', status: 'paused' }, 3000);
  assert.equal(NP.decide(st, null, 6000), null);                      // only 3s paused
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 7000);   // flap back before 5s
  assert.equal(NP.decide(st, null, 13000), null, 'playing already shown — nothing to do');
  NP.decide(st, { title: 'A', artist: 'x', status: 'paused' }, 14000);
  const act = NP.decide(st, null, 19200);                             // 5.2s held
  assert.equal(act.upload.status, 'paused');
});

test('backoff suppresses uploads until it expires, then the pending item goes out', () => {
  const st = NP.newState();
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0);
  st.backoffUntil = 10000;
  assert.equal(NP.decide(st, null, 5000), null, 'inside backoff');
  const act = NP.decide(st, null, 10001);
  assert.equal(act.upload.title, 'A');
});
