const test = require('node:test');
const assert = require('node:assert');
const Synth = require('./th108-audio-synth.js');

test('sample returns a well-formed, bounded feature frame', () => {
  const syn = Synth.createSynth();
  const f = syn.sample(1.5);
  assert.equal(f.bands.length, 32);
  for(const b of f.bands) assert.ok(b >= 0 && b <= 1, 'band in 0..1');
  assert.ok(f.level >= 0 && f.level <= 1);
  assert.ok(f.beat >= 0 && f.beat <= 1);
  assert.ok(f.centroid >= 0 && f.centroid <= 1);
});

test('sample is deterministic for a given time and bass-weighted', () => {
  const syn = Synth.createSynth();
  const a = syn.sample(2.0), b = syn.sample(2.0);
  assert.deepEqual(Array.from(a.bands), Array.from(b.bands));
  let bass=0, treble=0; for(let i=0;i<8;i++) bass+=a.bands[i]; for(let i=24;i<32;i++) treble+=a.bands[i];
  assert.ok(bass >= treble, 'synth is bass-weighted like real music');
});

test('beat peaks periodically (a kick every ~0.5s)', () => {
  const syn = Synth.createSynth();
  const onBeat = syn.sample(0.0).beat;     // phase 0 = kick attack
  const offBeat = syn.sample(0.25).beat;   // mid-period
  assert.ok(onBeat > offBeat, 'beat envelope is higher right on the kick');
});
