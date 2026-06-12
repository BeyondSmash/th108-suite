// nowplaying-render.js — compose the 160×96 now-playing frame (album art + title/artist + ⏸ badge).
// Pure JS: jpeg-js/pngjs decode, nearest-neighbor cover-scale, manual RGBA buffer, bitmap font.
// Output = one RGB565 frame in the shared upload engine's format.
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const F = require('./th108-font.js');
const { packRgb565 } = require('../th108-lcd-upload.js');
const W = 160, H = 96;

function decodeThumb(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf[0] === 0xFF && buf[1] === 0xD8) { const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 }); return { w: j.width, h: j.height, data: j.data }; }
    if (buf[0] === 0x89 && buf[1] === 0x50) { const p = PNG.sync.read(buf); return { w: p.width, h: p.height, data: p.data }; }
  } catch (_) { }
  return null;   // junk/unknown format → flat background, never throw
}

function fit(text, scale) {   // ellipsis-truncate to the drawable row width
  const max = Math.floor((W - 8) / (F.CW * scale));
  text = String(text || '');
  return text.length > max ? text.slice(0, Math.max(1, max - 2)) + '..' : text;
}

// byte-order: false matches the page's default (#lcdSwap unchecked) — flip here if the first
// hardware test shows wrong colors (Task 8 of the plan).
const SWAP = false;

function render(info) {
  const buf = new Uint8ClampedArray(W * H * 4);
  const art = decodeThumb(info.thumb);
  if (art) {                                  // cover-scale, darkened ~45% so the text reads
    const s = Math.max(W / art.w, H / art.h), ox = (art.w - W / s) / 2, oy = (art.h - H / s) / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.min(art.w - 1, Math.floor(ox + x / s)), sy = Math.min(art.h - 1, Math.floor(oy + y / s));
      const si = (sy * art.w + sx) * 4, di = (y * W + x) * 4;
      buf[di] = art.data[si] * 0.55; buf[di + 1] = art.data[si + 1] * 0.55; buf[di + 2] = art.data[si + 2] * 0.55; buf[di + 3] = 255;
    }
  } else {                                    // suite-navy flat background
    for (let i = 0; i < buf.length; i += 4) { buf[i] = 13; buf[i + 1] = 17; buf[i + 2] = 23; buf[i + 3] = 255; }
  }
  F.drawText(buf, W, 4, H - 42, fit(info.title, 1), 1, [255, 255, 255]);     // title, white
  F.drawText(buf, W, 4, H - 22, fit(info.artist, 1), 1, [255, 217, 140]);   // artist, suite yellow
  if (info.status === 'paused') {             // ⏸ badge top-right: two white bars on a dark pill
    for (let y = 6; y < 22; y++) for (let x = W - 26; x < W - 6; x++) { const o = (y * W + x) * 4; buf[o] = 30; buf[o + 1] = 34; buf[o + 2] = 40; buf[o + 3] = 255; }
    for (let y = 9; y < 19; y++) for (const xs of [W - 21, W - 14]) for (let x = xs; x < xs + 3; x++) { const o = (y * W + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 255; }
  }
  return { bytes: packRgb565(buf, SWAP), delayMs: 1000 };
}
module.exports = { render, decodeThumb };
