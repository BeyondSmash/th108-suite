const test = require('node:test');
const assert = require('node:assert');
const AC = require('./audio-capture.js');

test('parseLine accepts a well-formed frame and rejects junk', () => {
  const f = AC.parseLine('{"bands":[' + (('0.5,').repeat(31)) + '0.5],"level":0.4,"beat":0.1,"centroid":0.6,"t":12.3}');
  assert.equal(f.bands.length, 32);
  assert.equal(f.level, 0.4); assert.equal(f.beat, 0.1); assert.equal(f.centroid, 0.6);
  assert.equal(AC.parseLine('not json'), null);
  assert.equal(AC.parseLine('{"level":1}'), null);          // missing/!32 bands → reject
  assert.equal(AC.parseLine('{"bands":[1,2,3]}'), null);
});

test('freshOr returns the frame while fresh and null once stale', () => {
  const f = { bands: new Array(32).fill(0), level: 0, beat: 0, centroid: 0.5, t: 0, _at: 1000 };
  assert.equal(AC.freshOr(f, 1100, 500), f);     // 100ms old < 500ms → fresh
  assert.equal(AC.freshOr(f, 2000, 500), null);  // 1000ms old > 500ms → stale
  assert.equal(AC.freshOr(null, 2000, 500), null);
});

test('holdPeak lingers a transient across frames (decaying) so a slow/second reader still catches it', () => {
  const mk = (lvl, b0) => { const bands = new Array(32).fill(0.1); bands[0] = b0; return { bands, level: lvl, beat: 0.1, centroid: 0.4, t: 1, _at: 1 }; };
  let acc = AC.holdPeak(null, mk(0.2, 0.2));      // quiet
  acc = AC.holdPeak(acc, mk(0.9, 0.8));           // impulse
  acc = AC.holdPeak(acc, mk(0.05, 0.05));         // silent right after — the impulse must still be visible (held)
  assert.ok(acc.level > 0.6, 'level still high one frame after the impulse (0.9*0.75), not dropped to 0.05');
  assert.ok(acc.bands[0] > 0.55, 'band[0] held high after the impulse');
  acc = AC.holdPeak(acc, mk(0.05, 0.05));
  acc = AC.holdPeak(acc, mk(0.05, 0.05));
  acc = AC.holdPeak(acc, mk(0.05, 0.05));
  assert.ok(acc.level < 0.4, 'and it decays away over a few more frames (does not stick forever)');
});
