/* th108-lcd-upload.js — the TH108 LCD flash-upload engine (cmd 0x50), shared by the page
   (th108-lcd.js via WebHID) and the daemon (node-hid on the 0xFF67 screen interface).
   Extracted from the hardware-proven th108-lcd.js uploader — same constants, same math.

   SAFETY (a re-send once corrupted config flash and disabled typing — recovered only via the
   official "Reset all settings"): NEVER re-send a chunk — abort on a missing ACK; HARD cap
   33 frames (~1 MB = the screen-flash region; more overflows into config flash).
   Chunk 0 = flash erase (window scales with size, up to ~15s for ~1 MB; we allow 20s) and
   needs a 250ms settle before streaming; other chunks ACK in ~0.14s (4s window). */
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
    for (let i = 0; i < frames.length - 1; i++) h[i + 1] = Math.min(255, Math.round((frames[i].delayMs || 100) / 2)); // delay byte = ms/2
    h[frames.length] = 0;
    return h;
  }
  // frames = [{bytes: Uint8Array(30720) /* RGB565 */, delayMs}] → everything the chunk loop needs.
  // An EVEN frame count lands the 256B header offset on a 4096B boundary, which drops/under-erases
  // the bottom row (stale-flash glitch) — duplicate the last frame to force ODD. Protocol-safe:
  // the official totalChunks formula stays intact.
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

  // transport-injected engine. sendChunk(pkt) resolves when the OS accepted the write;
  // onInput(cb) feeds raw input-report bytes and returns an unsubscribe.
  function create(opts) {
    const log = opts.log || function () {};
    const T = Object.assign({ erase: 20000, chunk: 4000, settle: 250 }, opts.timeouts);
    async function upload(plan, onProgress, onEvent) {
      const D = onEvent || function () {};
      let resolveAck = null;
      const off = opts.onInput(b => { D({ ev: 'in' }); if (b[0] === 0x55 && b[1] === 0x41 && resolveAck) resolveAck(); });
      // arm the ACK resolver BEFORE sending so an early ACK isn't missed
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
          if (v === 0) { D({ ev: 'settle' }); await new Promise(r => setTimeout(r, T.settle)); }   // let the flash erase fully settle
          if (onProgress) onProgress(Math.floor((v + 1) / plan.chunkCount * 100), v, plan.chunkCount);
        }
        D({ ev: 'complete' });
        return { ok: true };
      } finally { off(); }
    }
    return { upload };
  }

  return { packRgb565, buildPktTFT, buildHeader, planUpload, chunkData, create,
           TFT_CMD, ADDR, CHUNK, FB, REGION_FRAMES };
});
