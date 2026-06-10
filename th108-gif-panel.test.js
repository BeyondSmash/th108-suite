// th108-gif-panel.test.js — unit tests for the pure parts of th108-gif-panel.js
// (output color adjustment, frame edge-color average, crop/zoom/pan math).
// Run: node --test th108-gif-panel.test.js   (no DOM / no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const GIF = require('./th108-gif-panel.js');

// --- adjustRgb(r,g,b, sat, con, gam, bri) — the LED output-conditioning chain ---
test('adjustRgb is identity at all-default settings (1,1,1,1)', () => {
  assert.deepEqual(GIF.adjustRgb(100, 150, 200, 1, 1, 1, 1), [100, 150, 200]);
});

test('adjustRgb saturation 0 collapses to luma gray', () => {
  const y = Math.floor(0.299 * 255);                 // pure red → Rec.601 luma
  assert.deepEqual(GIF.adjustRgb(255, 0, 0, 0, 1, 1, 1), [y, y, y]);
});

test('adjustRgb contrast pushes dark pixels to the 0 clamp', () => {
  assert.deepEqual(GIF.adjustRgb(10, 10, 10, 1, 2, 1, 1), [0, 0, 0]);   // (10-128)*2+128 = -108 → 0
});

test('adjustRgb gamma 2 crushes midtones; brightness scales output', () => {
  assert.deepEqual(GIF.adjustRgb(128, 128, 128, 1, 1, 2, 1), [64, 64, 64]);   // 255*(128/255)^2
  assert.deepEqual(GIF.adjustRgb(100, 150, 200, 1, 1, 1, 0.5), [50, 75, 100]);
});

// --- edgeAvg(data,dw,dh) — border-pixel average used as the "sampled" bar-fill color ---
test('edgeAvg averages the border pixels of an RGBA buffer', () => {
  const dw = 2, dh = 2, D = new Uint8ClampedArray(dw * dh * 4);
  for (let i = 0; i < dw * dh; i++) { D[i * 4] = 10; D[i * 4 + 1] = 20; D[i * 4 + 2] = 30; D[i * 4 + 3] = 255; }
  assert.deepEqual(GIF.edgeAvg(D, dw, dh), [10, 20, 30]);
});

// --- computeCrop(SW,SH, targetRatio, zoom, panX, panY) — board-aspect crop with clamped pan ---
test('computeCrop cover-fits a square source to a wide target and clamps pan to the source', () => {
  // 100×100 source, 4:1 target → crop 100×25; vertical slack ±37.5, no horizontal slack
  const c = GIF.computeCrop(100, 100, 4, 1, 999, 1000);
  assert.equal(c.cw, 100);
  assert.equal(c.ch, 25);
  assert.equal(c.panX, 0);                            // mX=0 → pan forced to 0
  assert.equal(c.panY, 37.5);                         // clamped to the slack
  assert.equal(c.cy, 37.5 + 37.5);                    // (SH-ch)/2 + clamped pan
});

test('computeCrop zoomed out past cover (crop exceeds source) centers and zeroes pan', () => {
  const c = GIF.computeCrop(100, 100, 1, 0.5, 50, -50); // crop 200×200 > source
  assert.equal(c.cw, 200);
  assert.equal(c.panX, 0);
  assert.equal(c.panY, 0);
  assert.equal(c.cx, -50);                            // (100-200)/2 — centered overhang
  assert.equal(c.cy, -50);
});
