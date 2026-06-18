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
