// th108-font.test.js — the generated bitmap font's blitter (drawText) behaves at the edges.
// Run: node --test th108-font.test.js
const test = require('node:test');
const assert = require('node:assert');
const F = require('./th108-font.js');

test('drawText paints pixels for visible glyphs and returns the proportional advance', () => {
  const w = 160, buf = new Uint8ClampedArray(w * 96 * 4);
  const end = F.drawText(buf, w, 2, 2, 'A', 1, [255, 0, 0]);
  assert.equal(end, 2 + F.charWidth('A', 1));
  assert.ok([...buf].some(v => v === 255), 'A painted something');
  assert.ok(F.charWidth('M', 1) > F.charWidth('i', 1), 'M is wider than i (proportional)');
});

test('fitText truncates to a pixel budget with an ellipsis', () => {
  const long = 'A very long song title that overflows the screen';
  const out = F.fitText(long, 152, 1);
  assert.ok(out.endsWith('..'));
  assert.ok(F.textWidth(out, 1) <= 152);
  assert.equal(F.fitText('Short', 152, 1), 'Short');
});

test('off-canvas draws are clipped, not crashed', () => {
  const w = 160, buf = new Uint8ClampedArray(w * 96 * 4);
  const before = Buffer.from(buf).toString('hex');
  F.drawText(buf, w, 1000, 2, 'X', 1, [255, 0, 0]);     // starts past the row → loop breaks, no paint
  assert.equal(Buffer.from(buf).toString('hex'), before);
  F.drawText(buf, w, 2, 95, 'X', 2, [255, 0, 0]);       // bottom edge: clips, no throw
});

test('space glyph paints nothing; textWidth sums per-glyph advances', () => {
  const w = 32, buf = new Uint8ClampedArray(w * 16 * 4);
  F.drawText(buf, w, 0, 0, ' ', 1, [255, 255, 255]);
  assert.ok([...buf].every(v => v === 0));
  assert.equal(F.textWidth('abc', 2), F.charWidth('a', 2) + F.charWidth('b', 2) + F.charWidth('c', 2));
});
