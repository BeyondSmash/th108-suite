# Now-Playing LCD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ambient now-playing (any media player) on the TH108 LCD, driven entirely by the daemon (spec: `docs/superpowers/specs/2026-06-12-nowplaying-lcd-design.md`).

**Architecture:** PowerShell media-session sidecar → daemon state machine (debounce/dedupe/ownership gates) → pure-JS renderer (album art + bitmap text → RGB565) → shared `th108-lcd-upload.js` extracted verbatim from the hardware-proven `th108-lcd.js` engine, driven by WebHID on the page and node-hid (screen iface 0xFF67) in the daemon.

**Tech Stack:** vanilla JS UMD (no build step), `node --test`, jpeg-js + pngjs (pure-JS, daemon only), PowerShell 5.1 sidecar (PURE ASCII — PS reads UTF-8-no-BOM as ANSI and smart-quote mojibake breaks parsing).

**Hard safety rules (from the brick incident — TH108 flash upload):** never re-send a chunk (abort on stall); cap 33 frames / ~1 MB; chunk-0 ACK window 20 s + 250 ms settle, other chunks 4 s; pause all 0x32 lighting during an upload; the daemon must never upload while yielded to the page or during a mute episode. Commits authored as `Beyon <you@example.com>`, NO Claude attribution.

---

### Task 1: `th108-lcd-upload.js` — pure protocol parts

**Files:**
- Create: `th108-lcd-upload.js` (repo root, UMD like th108-engine.js)
- Test: `th108-lcd-upload.test.js`

- [ ] **Step 1: Failing tests** — golden values transcribed from the proven code in `th108-lcd.js:445-529`:

```js
// th108-lcd-upload.test.js
const test = require('node:test');
const assert = require('node:assert');
const U = require('./th108-lcd-upload.js');

test('packRgb565 packs RGBA → RGB565 with optional byte swap', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255,  0, 255, 0, 255]);   // red, green
  const be = U.packRgb565(rgba, false);
  assert.deepEqual([...be], [0xF8, 0x00, 0x07, 0xE0]);     // R=11111 000.., G=..111111..
  const le = U.packRgb565(rgba, true);
  assert.deepEqual([...le], [0x00, 0xF8, 0xE0, 0x07]);
});

test('buildPktTFT matches the official framing (th108-lcd.js:457)', () => {
  const data = new Uint8Array(4096).fill(7);
  const pkt = U.buildPktTFT(2, 30720 * 3, data, 4104);
  assert.equal(pkt.length, 4104);
  assert.deepEqual([...pkt.slice(0, 8)], [0xAA, 0x50, 2, 0, 23, 0, 0x50, 0x06]);
  // totalChunks = ceil(92160/4096) = 23; ADDR/4096 = 6619136/4096 = 1616 = 0x0650 → lo 0x50, hi 0x06
  assert.equal(pkt[8], 7);
});

test('buildHeader: frameCount + per-frame delay bytes (ms/2), 0 terminator, 0xFF fill', () => {
  const h = U.buildHeader([{ delayMs: 100 }, { delayMs: 510 }, { delayMs: 100 }]);
  assert.equal(h.length, 256);
  assert.equal(h[0], 3);
  assert.equal(h[1], 50);       // 100/2
  assert.equal(h[2], 255);      // 510/2 clamped
  assert.equal(h[3], 0);        // terminator at header[frameCount]
  assert.equal(h[10], 255);     // fill
});

test('planUpload: even frame count gets the last frame duplicated (bottom-row glitch guard)', () => {
  const f = b => ({ bytes: new Uint8Array(30720).fill(b), delayMs: 100 });
  const odd = U.planUpload([f(1), f(2), f(3)]);
  assert.equal(odd.frameCount, 3);
  assert.equal(odd.totalSize, 3 * 30720);
  assert.equal(odd.chunkCount, Math.ceil((3 * 30720) / 4096));
  const even = U.planUpload([f(1), f(2)]);
  assert.equal(even.frameCount, 3);                          // duplicated to odd
  assert.equal(even.data.length, 3 * 30720);
  assert.equal(even.data[2 * 30720], 2);                     // dup of last frame
});

test('planUpload enforces the 33-frame region cap (overflow corrupts config flash)', () => {
  const f = { bytes: new Uint8Array(30720), delayMs: 100 };
  assert.throws(() => U.planUpload(new Array(34).fill(f)), /33/);
  assert.throws(() => U.planUpload([{ bytes: new Uint8Array(100), delayMs: 1 }]), /30720/);
});

test('chunkData: chunk 0 = 256B header + first 3840 data bytes; later chunks offset by -256', () => {
  const plan = U.planUpload([{ bytes: new Uint8Array(30720).map((_, i) => i & 0xFF), delayMs: 100 }]);
  const c0 = U.chunkData(plan, 0);
  assert.equal(c0.length, 4096);
  assert.equal(c0[0], 1);                                    // header[0] = frameCount
  assert.equal(c0[256], 0);                                  // data byte 0
  assert.equal(c0[257], 1);
  const c1 = U.chunkData(plan, 1);
  assert.equal(c1[0], 3840 & 0xFF);                          // continues at data offset 3840
});
```

- [ ] **Step 2: Run** `node --test th108-lcd-upload.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement** — the logic is MOVED from `th108-lcd.js` (same constants, same math):

```js
/* th108-lcd-upload.js — the TH108 LCD flash-upload engine (cmd 0x50), shared by the page
   (th108-lcd.js via WebHID) and the daemon (node-hid). Extracted from the hardware-proven
   th108-lcd.js uploader. SAFETY (a re-send once corrupted config flash and disabled typing):
   never re-send a chunk — abort on a missing ACK; hard cap 33 frames (~1 MB region). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108LcdUpload = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TFT_CMD = 0x50, ADDR = 6619136 /* 0x650000 */, CHUNK = 4096, FB = 160 * 96 * 2 /* 30720 */;
  const REGION_FRAMES = 33;          // official max; more overflows into config flash → bricks typing

  function packRgb565(rgba, swap) {
    const out = new Uint8Array((rgba.length / 4) * 2);
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 2) {
      const v = ((rgba[i] & 0xF8) << 8) | ((rgba[i + 1] & 0xFC) << 3) | (rgba[i + 2] >> 3);
      if (swap) { out[o] = v & 0xFF; out[o + 1] = v >> 8; } else { out[o] = v >> 8; out[o + 1] = v & 0xFF; }
    }
    return out;
  }
  function buildPktTFT(chunkIndex, totalSize, dataBuf, pktLen) {
    const pkt = new Uint8Array(pktLen || 4104);
    pkt[0] = 0xAA; pkt[1] = TFT_CMD;
    pkt[2] = chunkIndex & 0xFF; pkt[3] = (chunkIndex >> 8) & 0xFF;
    const totalChunks = Math.ceil(totalSize / CHUNK);   // firmware is sensitive to this exact formula
    pkt[4] = totalChunks & 0xFF; pkt[5] = (totalChunks >> 8) & 0xFF;
    pkt[6] = (ADDR / CHUNK) & 0xFF; pkt[7] = ((ADDR / CHUNK) >> 8) & 0xFF;
    pkt.set(dataBuf, 8);
    return pkt;
  }
  function buildHeader(frames) {
    const h = new Uint8Array(256).fill(255);
    h[0] = frames.length;
    for (let i = 0; i < frames.length - 1; i++) h[i + 1] = Math.min(255, Math.round((frames[i].delayMs || 100) / 2));
    h[frames.length] = 0;
    return h;
  }
  // frames = [{bytes: Uint8Array(30720) /* RGB565 */, delayMs}] → everything the chunk loop needs.
  // Even frame counts land the 256B header offset on a 4096B boundary and drop/under-erase the
  // bottom row — duplicate the last frame to force odd (protocol-safe, official totalChunks intact).
  function planUpload(frames) {
    if (!frames.length) throw new Error('no frames');
    if (frames.length > REGION_FRAMES) throw new Error('more than ' + REGION_FRAMES + ' frames would overflow the LCD flash region');
    for (const f of frames) if (f.bytes.length !== FB) throw new Error('frame must be exactly ' + FB + ' RGB565 bytes');
    let up = frames;
    if (up.length % 2 === 0) up = up.concat([up[up.length - 1]]);
    const data = new Uint8Array(up.length * FB);
    up.forEach((f, i) => data.set(f.bytes, i * FB));
    return { frameCount: up.length, data, header: buildHeader(up),
             totalSize: data.length, chunkCount: Math.ceil(data.length / CHUNK) };
  }
  function chunkData(plan, v) {
    if (v === 0) { const t = new Uint8Array(CHUNK); t.set(plan.header, 0); t.set(plan.data.slice(0, CHUNK - 256), 256); return t; }
    const a = CHUNK * v - 256;
    return plan.data.slice(a, Math.min(a + CHUNK, plan.data.length));
  }
  return { packRgb565, buildPktTFT, buildHeader, planUpload, chunkData,
           TFT_CMD, ADDR, CHUNK, FB, REGION_FRAMES, create: null /* Task 2 */ };
});
```

- [ ] **Step 4: Run** the test — PASS. `node --check th108-lcd-upload.js`.
- [ ] **Step 5: Commit** `feat: th108-lcd-upload.js — pure 0x50 protocol parts (packets, header, plan, chunks) with golden tests`

---

### Task 2: upload loop in the module + th108-lcd.js delegates

**Files:**
- Modify: `th108-lcd-upload.js` (replace `create: null`)
- Modify: `th108-lcd.js:445-590` (encodeFrame keeps calibration but packs via `TH108LcdUpload.packRgb565`; `upload()` keeps ALL UI/diag/caps/sampling and delegates the chunk loop)
- Modify: `th108-controller.html` (add `<script src="th108-lcd-upload.js"></script>` BEFORE th108-lcd.js)
- Test: `th108-lcd-upload.test.js` (append)

- [ ] **Step 1: Failing test** — fake transport, assert ACK gating, ordering, never-resend abort:

```js
test('create().upload sends each chunk once, ACK-gated, and aborts WITHOUT re-send on stall', async () => {
  const sent = [];
  let inputCb = null, ackAll = true;
  const eng = U.create({
    sendChunk: async (pkt) => { sent.push(pkt[2] | (pkt[3] << 8)); if (ackAll || sent.length < 3) setImmediate(() => inputCb(new Uint8Array([0x55, 0x41]))); },
    onInput: (cb) => { inputCb = cb; return () => { inputCb = null; }; },
    log: () => {},
    timeouts: { erase: 50, chunk: 50, settle: 1 },   // test-speed windows
  });
  const plan = U.planUpload([{ bytes: new Uint8Array(U.FB), delayMs: 100 }]);
  assert.equal((await eng.upload(plan, () => {})).ok, true);
  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7]);          // 30720B → 8 chunks, each exactly once

  sent.length = 0; ackAll = false;                            // ACKs stop after chunk 1
  const r = await eng.upload(plan, () => {});
  assert.equal(r.ok, false);
  assert.match(r.error, /no ACK/);
  assert.deepEqual(sent, [0, 1, 2], 'aborts cleanly: the stalled chunk is never re-sent');
});
```

- [ ] **Step 2: Run** — FAIL (`create` is null).
- [ ] **Step 3: Implement `create`** (moved loop from `th108-lcd.js:537-569`):

```js
  // transport-injected engine. sendChunk(pkt) resolves when the OS accepted the write;
  // onInput(cb) feeds raw input-report bytes and returns an unsubscribe.
  function create(opts) {
    const log = opts.log || function () {};
    const T = Object.assign({ erase: 20000, chunk: 4000, settle: 250 }, opts.timeouts);
    async function upload(plan, onProgress, onEvent) {
      const D = onEvent || function () {};
      let resolveAck = null;
      const off = opts.onInput(b => { D({ ev: 'in' }); if (b[0] === 0x55 && b[1] === 0x41 && resolveAck) resolveAck(); });
      const sendOne = (pkt, ms) => new Promise((resolve, reject) => {
        let settled = false;
        const to = setTimeout(() => { if (!settled) { settled = true; resolveAck = null; reject(new Error('ACK timeout')); } }, ms);
        resolveAck = () => { if (!settled) { settled = true; clearTimeout(to); resolveAck = null; resolve(); } };
        opts.sendChunk(pkt).catch(err => { if (!settled) { settled = true; clearTimeout(to); resolveAck = null; reject(err); } });
      });
      try {
        for (let v = 0; v < plan.chunkCount; v++) {
          const pkt = buildPktTFT(v, plan.totalSize, chunkData(plan, v), opts.pktLen);
          D({ ev: 'send', chunk: v });
          // NEVER re-send: a mid-flash-write re-send corrupted config flash once (typing died).
          try { await sendOne(pkt, v === 0 ? T.erase : T.chunk); D({ ev: 'ack', chunk: v }); }
          catch (err) {
            D({ ev: 'GIVEUP', chunk: v, err: err.message });
            return { ok: false, error: 'chunk ' + v + ': no ACK (' + err.message + ') — aborted WITHOUT re-sending (mid-write re-sends corrupt flash). Power-cycle the keyboard, then retry the whole upload.' };
          }
          if (v === 0) { D({ ev: 'settle' }); await new Promise(r => setTimeout(r, T.settle)); }
          if (onProgress) onProgress(Math.floor((v + 1) / plan.chunkCount * 100), v, plan.chunkCount);
        }
        D({ ev: 'complete' });
        return { ok: true };
      } finally { off(); }
    }
    return { upload };
  }
```
(and export `create` in the return object instead of `create: null`.)

- [ ] **Step 4: th108-lcd.js delegates.** In `upload()` (lines 499-590): keep UI, caps, sampling, even-dup
  message, diag report — but build frames as `{bytes: encodeFrame(fr.rgba), delayMs: fr.delayMs}`,
  call `const plan = TH108LcdUpload.planUpload(upFrames)` and
  `TH108LcdUpload.create({ sendChunk: p => scrDev.sendReport(scrId, p), onInput: cb => { const h = e => cb(new Uint8Array(e.data.buffer)); scrDev.addEventListener('inputreport', h); return () => scrDev.removeEventListener('inputreport', h); }, log, pktLen: scrLen || 4104 }).upload(plan, pct => { $('#lcdProg').value = pct; setOverlay(pct); }, D)`.
  `encodeFrame` keeps `transformFrame` (calibration) and ends with `return TH108LcdUpload.packRgb565(data, $('#lcdSwap').checked);`.
  Delete the now-duplicated `buildPktTFT`/header/chunk-loop code from th108-lcd.js. Map a `{ok:false}` result to the old thrown-error log path (copy-report message intact).
- [ ] **Step 5: Verify** `node --check th108-lcd.js && node --check th108-lcd-upload.js && node --test *.test.js` all green; HTML script-tag added + `new Function` HTML check; playwright smoke: LCD tab loads, picking a small image still shows frame stats (no device needed).
- [ ] **Step 6: Commit** `refactor: th108-lcd.js uploads through the shared th108-lcd-upload engine (verbatim protocol move + transports injected)`

---

### Task 3: daemon screen-interface transport

**Files:**
- Modify: `th108-daemon/hid-transport.js` (add `findScreenPath` + `openScreen`)
- Test: `th108-daemon/hid-transport.test.js` (append)

- [ ] **Step 1: Failing test** (pure filter over a fake `devices()` list):

```js
test('findScreenPath picks the 0xFF67 screen interface, control finder is unchanged', () => {
  const list = [
    { vendorId: 0x0C45, usagePage: 0xFF68, usage: 0x61, path: 'ctrl' },
    { vendorId: 0x0C45, usagePage: 0xFF67, usage: 0x61, path: 'screen' },
    { vendorId: 0x9999, usagePage: 0xFF67, usage: 0x61, path: 'other' },
  ];
  assert.equal(T.pickScreenPath(list), 'screen');
  assert.equal(T.pickScreenPath([list[0]]), null);
});
```

- [ ] **Step 2-3: Implement** in hid-transport.js (mirroring the existing control-path finder style):

```js
// screen interface (cmd 0x50 LCD upload) = usagePage 0xFF67 on the same vendor
function pickScreenPath(list) {
  const d = list.find(d => d.vendorId === VENDOR && d.usagePage === 0xFF67);
  return d ? d.path : null;
}
function findScreenPath() { try { return pickScreenPath(HID.devices()); } catch { return null; } }
function openScreen() {   // caller owns close(); node-hid write needs the report id prepended
  const p = findScreenPath(); if (!p) return null;
  const d = new HID.HID(p);
  d.on('error', () => {});   // a vanished handle must not crash the daemon
  return {
    raw: d,
    send: (pkt) => new Promise((res, rej) => { try { d.write([0, ...pkt]); res(); } catch (e) { rej(e); } }),
    onInput: (cb) => { const h = buf => cb(new Uint8Array(buf)); d.on('data', h); return () => d.removeListener('data', h); },
    close: () => { try { d.close(); } catch {} },
  };
}
```
Export `pickScreenPath, findScreenPath, openScreen`.

- [ ] **Step 4: Run** daemon tests green. **Step 5: Commit** `feat: hid-transport screen-interface (0xFF67) finder + open for daemon LCD uploads`

---

### Task 4: bitmap font

**Files:**
- Create: `_make-font.html` (one-time generator, gitignored-ok but commit it for regeneration)
- Create: `th108-daemon/th108-font.js` (generated output + drawText)
- Test: `th108-daemon/th108-font.test.js`

- [ ] **Step 1: Generator** — `_make-font.html` rasterizes printable ASCII 32-126 from `bold 13px "Segoe UI"` into a 9×14-cell packed bit array via canvas, and emits the JS module text into a `<textarea>`:

```html
<!doctype html><meta charset="utf-8"><textarea id="out" style="width:100%;height:90vh"></textarea>
<script>
const CW = 9, CH = 14, c = document.createElement('canvas');
c.width = CW; c.height = CH; const g = c.getContext('2d', { willReadFrequently: true });
let rows = [];
for (let ch = 32; ch <= 126; ch++) {
  g.clearRect(0, 0, CW, CH); g.font = 'bold 13px "Segoe UI"'; g.textBaseline = 'top';
  g.fillStyle = '#fff'; g.fillText(String.fromCharCode(ch), 0, 0);
  const d = g.getImageData(0, 0, CW, CH).data, bits = [];
  for (let y = 0; y < CH; y++) { let v = 0; for (let x = 0; x < CW; x++) if (d[(y * CW + x) * 4 + 3] > 96) v |= (1 << x); bits.push(v); }
  rows.push('[' + bits.join(',') + ']');
}
document.getElementById('out').value =
  '// th108-font.js - GENERATED by _make-font.html (9x14 cells, ASCII 32-126, bold 13px Segoe UI)\n' +
  'const CW = ' + CW + ', CH = ' + CH + ';\nconst GLYPHS = [\n' + rows.join(',\n') + '\n];\n' + `
function drawText(buf, w, x, y, text, scale, rgb) {   // buf = RGBA Uint8ClampedArray, w = row width
  let cx = x;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0), gl = GLYPHS[code - 32];
    if (gl) for (let gy = 0; gy < CH; gy++) for (let gx = 0; gx < CW; gx++) {
      if (!(gl[gy] & (1 << gx))) continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px = cx + gx * scale + sx, py = y + gy * scale + sy;
        if (px < 0 || py < 0 || px >= w) continue;
        const o = (py * w + px) * 4;
        if (o + 3 < buf.length) { buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255; }
      }
    }
    cx += CW * scale;
    if (cx >= w) break;
  }
  return cx;
}
function textWidth(text, scale) { return String(text).length * CW * scale; }
module.exports = { drawText, textWidth, CW, CH };
`;
</script>
```

- [ ] **Step 2:** Open `_make-font.html` via playwright on the static server, copy the textarea into `th108-daemon/th108-font.js`. `node --check` it.
- [ ] **Step 3: Test** (`th108-daemon/th108-font.test.js`):

```js
const test = require('node:test');
const assert = require('node:assert');
const F = require('./th108-font.js');
test('drawText paints pixels for visible glyphs and respects bounds', () => {
  const w = 160, buf = new Uint8ClampedArray(w * 96 * 4);
  const end = F.drawText(buf, w, 2, 2, 'A', 1, [255, 0, 0]);
  assert.equal(end, 2 + F.CW);
  assert.ok([...buf].some(v => v === 255), 'A painted something');
  const before = buf.slice();
  F.drawText(buf, w, 1000, 2, 'X', 1, [255, 0, 0]);     // fully off-canvas → no change
  assert.deepEqual(buf, before);
});
test('space glyph paints nothing', () => {
  const w = 32, buf = new Uint8ClampedArray(w * 16 * 4);
  F.drawText(buf, w, 0, 0, ' ', 1, [255, 255, 255]);
  assert.ok([...buf].every(v => v === 0));
});
```

- [ ] **Step 4: Commit** `feat: th108-font.js bitmap font (generated) + drawText, with generator tool`

---

### Task 5: renderer

**Files:**
- Create: `th108-daemon/nowplaying-render.js`
- Modify: `th108-daemon/package.json` (deps: `jpeg-js`, `pngjs` — run `npm install jpeg-js pngjs --no-audit --no-fund` in th108-daemon)
- Test: `th108-daemon/nowplaying-render.test.js`

- [ ] **Step 1: Failing tests:**

```js
const test = require('node:test');
const assert = require('node:assert');
const R = require('./nowplaying-render.js');

test('render returns one 30720-byte RGB565 frame; no art → flat background still has text pixels', () => {
  const f = R.render({ title: 'Song Name', artist: 'Artist', status: 'playing', thumb: '' });
  assert.equal(f.bytes.length, 160 * 96 * 2);
  assert.equal(f.delayMs, 1000);
  assert.ok([...f.bytes].some(b => b !== f.bytes[0]), 'not a uniform frame — text rendered');
});
test('paused variant differs from playing (the badge)', () => {
  const a = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: '' });
  const b = R.render({ title: 'T', artist: 'A', status: 'paused', thumb: '' });
  assert.notDeepEqual([...a.bytes], [...b.bytes]);
});
test('long titles are truncated with an ellipsis, never overflow the row', () => {
  const f = R.render({ title: 'X'.repeat(300), artist: 'Y'.repeat(300), status: 'playing', thumb: '' });
  assert.equal(f.bytes.length, 160 * 96 * 2);
});
test('garbage thumbnail falls back to the flat background instead of throwing', () => {
  const f = R.render({ title: 'T', artist: 'A', status: 'playing', thumb: 'bm90IGFuIGltYWdl' });
  assert.equal(f.bytes.length, 160 * 96 * 2);
});
```

- [ ] **Step 2-3: Implement** `nowplaying-render.js`:

```js
// nowplaying-render.js — compose the 160×96 now-playing frame (album art + title/artist + ⏸).
// Pure JS: jpeg-js/pngjs decode, nearest-neighbor cover-scale, manual RGBA buffer, bitmap font.
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
  return null;
}
function render(info) {
  const buf = new Uint8ClampedArray(W * H * 4);
  const art = decodeThumb(info.thumb);
  if (art) {                                  // cover-scale, then darken ~45% for text contrast
    const s = Math.max(W / art.w, H / art.h), ox = (art.w - W / s) / 2, oy = (art.h - H / s) / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.min(art.w - 1, Math.floor(ox + x / s)), sy = Math.min(art.h - 1, Math.floor(oy + y / s));
      const si = (sy * art.w + sx) * 4, di = (y * W + x) * 4;
      buf[di] = art.data[si] * 0.55; buf[di + 1] = art.data[si + 1] * 0.55; buf[di + 2] = art.data[si + 2] * 0.55; buf[di + 3] = 255;
    }
  } else {                                    // suite-navy flat background
    for (let i = 0; i < buf.length; i += 4) { buf[i] = 13; buf[i + 1] = 17; buf[i + 2] = 23; buf[i + 3] = 255; }
  }
  const fit = (text, scale) => {              // ellipsis-truncate to the row
    const max = Math.floor((W - 8) / (F.CW * scale));
    text = String(text || '');
    return text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…'.replace('…', '...').slice(0, 3) && text.slice(0, max - 2) + '..' : text;
  };
  F.drawText(buf, W, 4, H - 44, fit(info.title, 1.0 * 1) , 1, [255, 255, 255]);   // title (9×14 base)
  F.drawText(buf, W, 4, H - 22, fit(info.artist, 1), 1, [255, 217, 140]);          // artist in suite yellow
  if (info.status === 'paused') {            // ⏸ badge top-right: two white bars on a dark pill
    for (let y = 6; y < 22; y++) for (let x = W - 26; x < W - 6; x++) { const o = (y * W + x) * 4; buf[o] = 30; buf[o + 1] = 34; buf[o + 2] = 40; buf[o + 3] = 255; }
    for (let y = 9; y < 19; y++) for (const xs of [W - 21, W - 14]) for (let x = xs; x < xs + 3; x++) { const o = (y * W + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 255; }
  }
  return { bytes: packRgb565(buf, false), delayMs: 1000 };
}
module.exports = { render, decodeThumb };
```
NOTE for implementer: clean up `fit()` to a plain `text.length > max ? text.slice(0, max - 2) + '..' : text` — no clever one-liners; title at scale 1 is 14px tall which reads well at 160px wide (scale 2 fits only ~8 chars, too few). The byte-order swap flag for the daemon path is decided in Task 7's hardware test (start `false`, flip if colors look wrong — the page's checkbox default).

- [ ] **Step 4: Run** daemon tests green. **Step 5: Commit** `feat: now-playing renderer (album art + bitmap text + paused badge → RGB565)`

---

### Task 6: media sidecar + state machine

**Files:**
- Create: `th108-daemon/media-sidecar.ps1` (PURE ASCII)
- Create: `th108-daemon/nowplaying.js`
- Test: `th108-daemon/nowplaying.test.js`

- [ ] **Step 1: Sidecar** — polls the WinRT session manager 1×/s, prints one JSON line per change:

```powershell
# media-sidecar.ps1 - prints {"title","artist","status","thumb"} JSON lines on media changes.
# Pure ASCII. Spawned/killed by the daemon (nowplaying.js); exits when stdin closes.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(2000) | Out-Null
  return $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$last = ''
while ($true) {
  Start-Sleep -Milliseconds 1000
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if (-not $mgr) { continue }
  $s = $mgr.GetCurrentSession()
  if (-not $s) { continue }
  $info = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if (-not $info) { continue }
  $play = $s.GetPlaybackInfo().PlaybackStatus
  $status = if ("$play" -eq 'Playing') { 'playing' } else { 'paused' }
  $key = $info.Title + '|' + $info.Artist + '|' + $status
  if ($key -eq $last) { continue }
  $last = $key
  $thumb = ''
  if ($info.Thumbnail) {
    try {
      $stream = Await ($info.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $size = [int]$stream.Size
      if ($size -gt 0 -and $size -lt 2000000) {
        $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
        $loadOp = $reader.LoadAsync($size)
        $task = $asTaskGeneric.MakeGenericMethod([uint32]).Invoke($null, @($loadOp)); $task.Wait(2000) | Out-Null
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        $thumb = [Convert]::ToBase64String($bytes)
      }
    } catch { $thumb = '' }
  }
  $obj = @{ title = "$($info.Title)"; artist = "$($info.Artist)"; status = $status; thumb = $thumb }
  Write-Output (ConvertTo-Json $obj -Compress)
}
```

- [ ] **Step 2: state machine tests** (pure `decide()` with injected clock):

```js
const test = require('node:test');
const assert = require('node:assert');
const NP = require('./nowplaying.js');

test('track change uploads only after 2.5s stability; skip-spam collapses to one', () => {
  const st = NP.newState();
  assert.equal(NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0), null);
  assert.equal(NP.decide(st, null, 1000), null);                      // 1s: still settling
  assert.equal(NP.decide(st, { title: 'B', artist: 'x', status: 'playing' }, 1500), null);   // skip resets
  assert.equal(NP.decide(st, null, 3000), null);                      // B only 1.5s old
  const act = NP.decide(st, null, 4100);                              // B stable 2.6s
  assert.deepEqual(act, { upload: { title: 'B', artist: 'x', status: 'playing' } });
  assert.equal(NP.decide(st, null, 5000), null, 'no duplicate upload for the same identity+status');
});
test('pause must hold >5s; flapping costs nothing; resume re-uploads playing', () => {
  const st = NP.newState();
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 0);
  assert.ok(NP.decide(st, null, 2600));                               // playing uploaded
  NP.decide(st, { title: 'A', artist: 'x', status: 'paused' }, 3000);
  assert.equal(NP.decide(st, null, 6000), null);                      // only 3s paused
  NP.decide(st, { title: 'A', artist: 'x', status: 'playing' }, 7000);   // flap back
  assert.equal(NP.decide(st, null, 13000), null, 'playing already shown — nothing to do');
  NP.decide(st, { title: 'A', artist: 'x', status: 'paused' }, 14000);
  const act = NP.decide(st, null, 19200);
  assert.equal(act.upload.status, 'paused');
});
```

- [ ] **Step 3: Implement `nowplaying.js`:** pure `newState()/decide(state, event, nowMs)` (event = parsed
  sidecar line or null tick; returns `{upload: info}` or null; tracks `lastShown` identity+status,
  `pending` with `sinceMs`, debounce 2500 ms playing / 5000 ms paused) + an impure `start(opts)`
  that spawns the sidecar (`child_process.spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', sidecarPath])`),
  parses stdout lines (try/catch JSON), ticks every 500 ms calling `decide`, and on an upload action:
  - gates: `if (opts.isYielded() || opts.isMute() || busy) skip (retry next tick — keep pending)`;
  - `opts.pauseRender()` → open screen via `hid-transport.openScreen()` → `TH108LcdUpload.create({sendChunk: scr.send, onInput: scr.onInput, log, pktLen: 4104}).upload(plan)` → `scr.close()` → `opts.resumeRender()`;
  - plan = `planUpload([render(info)])`; failure → log + 30 s backoff (`state.backoffUntil`).
  `stop()` kills the sidecar. Restart the sidecar with 10 s backoff if it exits while enabled.
- [ ] **Step 4:** tests green; `node --check`; PS parse-check + ASCII-check the sidecar (same commands as install-webhid-grant.ps1 used).
- [ ] **Step 5: Commit** `feat: media-session sidecar + now-playing state machine (debounce, dedupe, ownership/mute gates, 30s failure backoff)`

---

### Task 7: daemon wiring + endpoint + page checkbox

**Files:**
- Modify: `th108-daemon/daemon.js` (settings.nowPlaying default false; instantiate nowplaying with `{isYielded: () => paused, isMute: () => muteLogged, pauseRender, resumeRender, log}` where pauseRender/resumeRender flip a `lcdBusy` flag the tick() loop respects alongside `paused`; control.setNowPlaying(on) start/stop + saveSettings; status() gains `nowPlaying`)
- Modify: `th108-daemon/server.js` (`GET/POST /nowplaying` exactly like `/usbreset` — POST body `{on}`)
- Modify: `th108-controller.html` (LCD tab: `<label class="sl"><input type="checkbox" id="lcdNowPlaying"> Show now-playing on the LCD (daemon)</label>` + hint "overwrites the current LCD GIF while enabled; the LCD keeps the last song when music stops"; wired in the daemon-client panel refresh like `dmnUsbFix`: state rides `/status.nowPlaying`, change POSTs `/nowplaying`, disabled when the daemon predates the field)
- Test: `th108-daemon/server.test.js` (append, clone of the `/usbreset` test with `setNowPlaying`)

- [ ] **Step 1:** server test (fakeControl gains `setNowPlaying(on){ this.calls.push('setNowPlaying:' + on); this._np = !!on; }` and `status()` returns `nowPlaying: this._np`) → implement endpoint → green.
- [ ] **Step 2:** daemon.js + page wiring; `node --check` everything; HTML check; full suites.
- [ ] **Step 3: Commit** `feat: /nowplaying toggle end to end (daemon setting + sidecar lifecycle + LCD-tab checkbox)`

---

### Task 8: deploy + supervised hardware verification (USER PRESENT)

- [ ] Restart the daemon (quit via tray menu or `/quit`, relaunch via the tray) — heartbeat auto-yield makes this safe.
- [ ] With the page NOT holding the device (daemon driving): enable the LCD-tab checkbox → play a song in Spotify → expect one upload in daemon.log (~8 chunks, ~2 s) and the song on the LCD. **If colors are wrong, flip the renderer's swap flag** (Task 5 note) and re-test.
- [ ] Skip 5 songs fast → exactly ONE upload after settling. Pause >5 s → ⏸ variant. Resume → playing.
- [ ] Click Connect on the page (page owns device) → change songs → NO uploads (gate respected); close the tab → daemon resumes → next change uploads.
- [ ] LCD tab regression: upload a GIF through the page (shared-module path) — must behave exactly as before.
- [ ] Typing unaffected throughout. Memory updated (roadmap: now-playing DONE; daemon memory: module extraction).
