// th108-profiles.test.js — unit tests for the pure parts of th108-profiles.js
// (name sanitizing, the 10-profile cap, collision-free default names, import normalizing).
// Run: node --test th108-profiles.test.js   (no DOM needed)
const test = require('node:test');
const assert = require('node:assert');
const P = require('./th108-profiles.js');

test('sanitizeName trims, collapses whitespace, caps length, falls back when empty', () => {
  assert.equal(P.sanitizeName('  My   Desk \n Setup  '), 'My Desk Setup');
  assert.equal(P.sanitizeName('x'.repeat(80)).length, 40);
  assert.equal(P.sanitizeName('', 'Old Name'), 'Old Name');
  assert.equal(P.sanitizeName(null), 'Profile');
});

test('canAdd enforces the 10-profile cap', () => {
  assert.equal(P.MAX_PROFILES, 10);
  assert.equal(P.canAdd(new Array(9).fill({})), true);
  assert.equal(P.canAdd(new Array(10).fill({})), false);
});

test('defaultName picks the first free "Profile N"', () => {
  assert.equal(P.defaultName([]), 'Profile 1');
  assert.equal(P.defaultName([{ name: 'Profile 1' }, { name: 'Profile 3' }]), 'Profile 2');
  assert.equal(P.defaultName([{ name: 'Gaming' }]), 'Profile 1');
});

test('normalizeImport accepts a profile file or a bare layer array, rejects junk', () => {
  const bare = P.normalizeImport([{ type: 'static' }]);
  assert.deepEqual(bare, { name: null, type: 'lighting', color: '', layers: [{ type: 'static' }], order: null, hostActions: [] });
  const full = P.normalizeImport({ name: 'Desk', layers: [], order: [2, 0, 1, 3] });
  assert.deepEqual(full, { name: 'Desk', type: 'lighting', color: '', layers: [], order: [2, 0, 1, 3], hostActions: [] });
  const noName = P.normalizeImport({ layers: [], order: 'bogus' });
  assert.deepEqual(noName, { name: null, type: 'lighting', color: '', layers: [], order: null, hostActions: [] });
  const hk = P.normalizeImport({ name: 'Keys', type: 'hotkey', color: '#0a84ff', layers: [], hostActions: [{ trigger: { type: 'key', led: 4 }, action: { type: 'micToggle' } }] });
  assert.deepEqual(hk, { name: 'Keys', type: 'hotkey', color: '#0a84ff', layers: [], order: null, hostActions: [{ trigger: { type: 'key', led: 4 }, action: { type: 'micToggle' } }] });
  assert.throws(() => P.normalizeImport({ foo: 1 }), /not a profile/);
  assert.throws(() => P.normalizeImport('nope'), /not a profile/);
});

test('fileSlug makes safe download names', () => {
  assert.equal(P.fileSlug('My Desk Setup!'), 'my-desk-setup');
  assert.equal(P.fileSlug('***'), 'profile');
});
