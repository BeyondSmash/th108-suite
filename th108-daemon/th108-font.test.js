// th108-font.test.js — the generated bitmap font's blitter (drawText) behaves at the edges.
// Run: node --test th108-font.test.js
const test = require('node:test');
const assert = require('node:assert');
const F = require('./th108-font.js');

test('drawText paints pixels for visible glyphs and returns the advance', () => {
  const w = 160, buf = new Uint8ClampedArray(w * 96 * 4);
  const end = F.drawText(buf, w, 2, 2, 'A', 1, [255, 0, 0]);
  assert.equal(end, 2 + F.CW);
  assert.ok([...buf].some(v => v === 255), 'A painted something');
});

test('off-canvas draws are clipped, not crashed', () => {
  const w = 160, buf = new Uint8ClampedArray(w * 96 * 4);
  const before = Buffer.from(buf).toString('hex');
  F.drawText(buf, w, 1000, 2, 'X', 1, [255, 0, 0]);     // starts past the row → loop breaks, no paint
  assert.equal(Buffer.from(buf).toString('hex'), before);
  F.drawText(buf, w, 2, 95, 'X', 2, [255, 0, 0]);       // bottom edge: clips, no throw
});

test('space glyph paints nothing; textWidth is per-glyph advance', () => {
  const w = 32, buf = new Uint8ClampedArray(w * 16 * 4);
  F.drawText(buf, w, 0, 0, ' ', 1, [255, 255, 255]);
  assert.ok([...buf].every(v => v === 0));
  assert.equal(F.textWidth('abc', 2), 3 * F.CW * 2);
});
