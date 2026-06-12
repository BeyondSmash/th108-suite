// nowplaying-render.test.js — the 160×96 frame composer (no hardware, no canvas).
// Run: node --test nowplaying-render.test.js
const test = require('node:test');
const assert = require('node:assert');
const R = require('./nowplaying-render.js');

test('render returns one 30720-byte RGB565 frame; no art → flat background still has text pixels', () => {
  const f = R.render({ title: 'Song Name', artist: 'Artist', status: 'playing', thumb: '' });
  assert.equal(f.bytes.length, 160 * 96 * 2);
  assert.equal(f.delayMs, 1000);
  const first = f.bytes[0];
  assert.ok([...f.bytes].some(b => b !== first), 'not a uniform frame — text rendered');
});

test('paused variant differs from playing (the badge)', () => {
  const a = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: '' });
  const b = R.render({ title: 'T', artist: 'A', status: 'paused', thumb: '' });
  assert.notDeepEqual([...a.bytes], [...b.bytes]);
});

test('long titles are truncated, never overflow the frame', () => {
  const f = R.render({ title: 'X'.repeat(300), artist: 'Y'.repeat(300), status: 'playing', thumb: '' });
  assert.equal(f.bytes.length, 160 * 96 * 2);
});

test('garbage thumbnail falls back to the flat background instead of throwing', () => {
  const f = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: 'bm90IGFuIGltYWdl' });
  assert.equal(f.bytes.length, 160 * 96 * 2);
  assert.equal(R.decodeThumb('bm90IGFuIGltYWdl'), null);
  assert.equal(R.decodeThumb(''), null);
});

test('a real PNG thumbnail is decoded and cover-scaled into the frame', () => {
  const { PNG } = require('pngjs');
  const p = new PNG({ width: 20, height: 20 });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = 200; p.data[i + 1] = 40; p.data[i + 2] = 40; p.data[i + 3] = 255; }
  const b64 = PNG.sync.write(p).toString('base64');
  const f = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: b64 });
  // darkened red background → red-dominant pixels everywhere except text/badge.
  // bytes are little-endian on the wire (SWAP=true, hw-confirmed) — decode accordingly.
  let reddish = 0;
  for (let o = 0; o < f.bytes.length; o += 2) {
    const v = f.bytes[o] | (f.bytes[o + 1] << 8);
    const r8 = ((v >> 11) & 31) << 3, g8 = ((v >> 5) & 63) << 2, b8 = (v & 31) << 3;
    if (r8 > g8 + 16 && r8 > b8 + 16) reddish++;
  }
  assert.ok(reddish > (160 * 96) * 0.7, 'most pixels carry the art color (got ' + reddish + ')');
});

test('color-correction calibration applies (default profile shifts colors; neutral leaves them)', () => {
  const f0 = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: '' });
  const neutral = {}; for (const k in R.DEFAULT_CAL) neutral[k] = (k.endsWith('Black')) ? 0 : 100;
  const fn = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: '' }, null, neutral);
  assert.notDeepEqual([...f0.bytes], [...fn.bytes], 'default cal differs from neutral');
  assert.equal(f0.bytes.length, 160 * 96 * 2);
  // sanity on the math itself: neutral params are identity-ish on midtones
  const buf = new Uint8ClampedArray([128, 128, 128, 255]);
  R.applyCal(buf, neutral);
  assert.ok(Math.abs(buf[0] - 128) <= 2 && Math.abs(buf[1] - 128) <= 2 && Math.abs(buf[2] - 128) <= 2);
});
