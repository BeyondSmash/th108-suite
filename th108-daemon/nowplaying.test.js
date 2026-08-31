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

test('TRACK-CHANGE-ONLY: play/pause/resume of the SAME song never triggers another upload (brick safety)', () => {
  const st = NP.newState();
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0);
  assert.ok(NP.decide(st, null, 2600), 'the new song uploaded once');
  NP.decide(st, { title: 'A', artist: 'x', status: 'paused' }, 3000);   // pause — same title/artist
  assert.equal(NP.decide(st, null, 9000), null, 'pause does NOT re-upload');
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 10000);  // resume
  assert.equal(NP.decide(st, null, 16000), null, 'resume does NOT re-upload');
  // only a genuinely new song writes again
  NP.decide(st, { title: 'B', artist: 'x', status: 'playing' }, 17000);
  assert.equal(NP.decide(st, null, 19000), null, 'still settling (2s < 2.5s)');
  assert.equal(NP.decide(st, null, 19700).upload.title, 'B');           // new track → one upload after settle
});

test('backoff suppresses uploads until it expires, then the pending item goes out', () => {
  const st = NP.newState();
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0);
  st.backoffUntil = 10000;
  assert.equal(NP.decide(st, null, 5000), null, 'inside backoff');
  const act = NP.decide(st, null, 10001);
  assert.equal(act.upload.title, 'A');
});

test('isSpotifySource: Spotify variants pass, browsers/others blocked (the safety default)', () => {
  assert.equal(NP.isSpotifySource('Spotify.exe'), true);
  assert.equal(NP.isSpotifySource('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), true);
  assert.equal(NP.isSpotifySource('Chrome'), false);
  assert.equal(NP.isSpotifySource('MSEdge'), false);
  assert.equal(NP.isSpotifySource('Brave.Brave'), false);
  assert.equal(NP.isSpotifySource(''), false);
  assert.equal(NP.isSpotifySource(undefined), false);
});
