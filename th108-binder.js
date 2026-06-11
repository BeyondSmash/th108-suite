/* th108-binder.js — key binder for the TH108 controller (ported from webhid-test.html, palette
   layout mirroring the official driver's key-assignment page).
   Pick a key on the board, then click what it should do: Basic Characters / Extended Characters /
   Special Characters (media) / Function Keys (the firmware's decorative-light cycle functions).
   Plus the Decorative Light Toggles: one click binds the SPACEBAR to a light function and opens a
   focus overlay; Esc/✕ exits and restores the Spacebar.
   Plus the group toggle (generalized from webhid-test.html's "' ; H J K L → TYPING" button): the
   th108_key_mods entries store the exact 4 bytes each bind wrote, so ONE button can park every
   remapped key on its factory character in a single keymap pass and re-apply the lot afterwards.

   THE critical protocol fact (hardware-confirmed 2026-06-07): single-key keymap writes (cmd 0x22,
   4 bytes at offset 4·keyValue) are ACK'd by the board but DO NOT take effect. Every edit must
   read + rewrite the WHOLE 512-byte keymap: read = cmd 0x12 in 56-byte chunks (payload at byte 8),
   write = cmd 0x22 in 56-byte chunks, each gated on the 0x55 0x22 ACK. The full pass takes ~2 s,
   hence the progress overlay. Safety added in the port: the read is validated (no missed chunks,
   plausibly populated) before anything is written — a zeroed write would dead-key the board.

   Keymap encoding (4 bytes per key, indexed by key value = the engine's LED index; the
   single-key-binding wire captures of 2026-06-11 confirmed the full entry-type family):
     normal char     [0x02, 0x00, <HID usage>, 0x00]
     media/consumer  [0x03, <usageLo>, <usageHi>, 0x00]   (16-bit LE — Calculator=0x0192 captured)
     light/function  [0x0d, 0x00, 0x00, <function code>]  (Lock Win=22, BT Channel 1=2 captured)
     mouse           [0x01, …] — left button = [0x01,0x01,0x01,0x00]; the other buttons stay
                     un-shipped until one more capture disambiguates the byte order (left is
                     0x01 under every hypothesis)
     advanced keys   live in the SAME keymap, no separate command: CB=[0x07,mod,mod,key],
                     MT=0x09, TGL=[0x0a,hid,0,0], SOCD=[0x0b,mode,hidA,hidB] on both keys —
                     UI pending confirmed byte semantics (which byte is hold vs click, mode enum)
   Knob bonus: key values 13/14/15 = knob rotate+/rotate-/press (factory Vol+/Vol-/mute 46) —
   rebindable like any key.

   Usage: const BINDER = TH108Binder.create({hid, log, board, gifPlaying, stopGif,
            pauseLighting, resumeLighting});
   hid = the TH108Hid instance (device/reportId/buildPkt); board = the Pick-a-Key board's selection
   surface {sel, onChange, clear}; lighting/GIF are paused around every keymap pass so the 0x12/0x22
   traffic never interleaves with the 0x32 paint stream (their 0x55 ACKs would cross). UMD so the
   pure helpers are unit-testable under node --test. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108Binder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CMD_READ = 0x12, CMD_WRITE = 0x22, KEYMAP_BYTES = 512, CHUNK = 56;
  const SPACE_VAL = 83, SPACE_HID = 0x2c;
  const FN_VAL = 85;   // Fn stays non-bindable: overwriting it loses the whole FN layer (its factory entry is 02 00 af 00 — restorable, but the lockout isn't worth it)

  // ---- pure keymap-entry encoders ----
  function encodeNormal(hid)  { return [0x02, 0x00, hid & 0xFF, 0x00]; }
  function encodeMedia(usage) { return [0x03, usage & 0xFF, (usage >> 8) & 0xFF, 0x00]; }   // 16-bit LE (Calculator capture: 03 92 01 00)
  function encodeFunc(code)   { return [0x0d, 0x00, 0x00, code & 0xFF]; }
  function entryBytes(item) {
    if (item.bytes) return item.bytes.slice();          // raw wire-captured entry (e.g. left mouse button)
    if (item.hid != null) return encodeNormal(item.hid);
    if (item.usage != null) return encodeMedia(item.usage);
    if (item.code != null) return encodeFunc(item.code);
    return null;
  }

  // ---- advanced-key entry encoders (types 0x07/0x09/0x0a/0x0b, wire-captured 2026-06-11) ----
  const MODIFIERS = [
    { label: 'L-Ctrl', hid: 0xE0 }, { label: 'L-Shift', hid: 0xE1 }, { label: 'L-Alt', hid: 0xE2 }, { label: 'L-Win', hid: 0xE3 },
    { label: 'R-Ctrl', hid: 0xE4 }, { label: 'R-Shift', hid: 0xE5 }, { label: 'R-Alt', hid: 0xE6 }, { label: 'R-Win', hid: 0xE7 }
  ];
  function encodeCB(mod1, mod2, key)   { return [0x07, mod1 & 0xFF, mod2 & 0xFF, key & 0xFF]; }            // one key = a whole chord
  function encodeMT(click, hold, time) { return [0x09, click & 0xFF, hold & 0xFF, (time == null ? 0x28 : time) & 0xFF]; }   // tap/hold; 0x28=40 = official default
  function encodeTGL(key)              { return [0x0a, key & 0xFF, 0x00, 0x00]; }                          // tap toggles <key> held
  function encodeSOCD(hidA, hidB)      { return [0x0b, 0x03, hidA & 0xFF, hidB & 0xFF]; }                  // mode 3 (last-pressed-wins) = the only captured mode; write to BOTH keys

  // ---- the assignment palette (official-driver tab layout; only hardware-confirmed encodings) ----
  const basics = [];
  for (let i = 0; i < 26; i++) basics.push({ label: String.fromCharCode(65 + i), hid: 4 + i });        // A..Z = 4..29
  const SHIFTED = ['1 !', '2 @', '3 #', '4 $', '5 %', '6 ^', '7 &', '8 *', '9 (', '0 )'];
  SHIFTED.forEach((lbl, i) => basics.push({ label: lbl, hid: 30 + i }));                               // 1..0 = 30..39
  [['` ~', 53], ['- _', 45], ['= +', 46], ['[ {', 47], ['] }', 48], ['\\ |', 49], ['; :', 51], ["' \"", 52], [', <', 54], ['. >', 55], ['/ ?', 56]]
    .forEach(([lbl, hid]) => basics.push({ label: lbl, hid }));

  const extended = [
    ['Esc', 41], ['Tab', 43], ['Caps', 57], ['Backspace', 42], ['Enter', 40], ['Spacebar', 44],
    ['L-Ctrl', 224], ['R-Ctrl', 228], ['L-Shift', 225], ['R-Shift', 229], ['L-Alt', 226], ['R-Alt', 230],
    ['L-Win', 227], ['Super', 101], ['↑', 82], ['↓', 81], ['←', 80], ['→', 79],
    ['Home', 74], ['End', 77], ['Ins', 73], ['Del', 76], ['PgUp', 75], ['PgDn', 78],
    ['Print', 70], ['Scroll', 71], ['Pause', 72],
    ['F1', 58], ['F2', 59], ['F3', 60], ['F4', 61], ['F5', 62], ['F6', 63],
    ['F7', 64], ['F8', 65], ['F9', 66], ['F10', 67], ['F11', 68], ['F12', 69],
    ['Num Lock', 83], ['Num 1', 89], ['Num 2', 90], ['Num 3', 91], ['Num 4', 92], ['Num 5', 93],
    ['Num 6', 94], ['Num 7', 95], ['Num 8', 96], ['Num 9', 97], ['Num 0', 98],
    ['Num /', 84], ['Num *', 85], ['Num -', 86], ['Num +', 87], ['Num Enter', 88], ['Num .', 99], ['Intl \\', 100]
  ].map(([label, hid]) => ({ label, hid }));

  // consumer usages (16-bit LE encoding wire-confirmed via the Calculator capture) + the one
  // mouse entry whose bytes are unambiguous; remaining mouse buttons/scroll need one more capture
  const special = [
    { label: 'Play / Pause', usage: 0xCD }, { label: 'Stop Playback', usage: 0xB7 },
    { label: 'Previous Track', usage: 0xB6 }, { label: 'Next Track', usage: 0xB5 },
    { label: 'Volume +', usage: 0xE9 }, { label: 'Volume -', usage: 0xEA }, { label: 'Mute', usage: 0xE2 },
    { label: 'Multi Media', usage: 0x183 }, { label: 'My Computer', usage: 0x194 },
    { label: 'Calculator', usage: 0x192 }, { label: 'Email', usage: 0x18A },
    { label: 'Browser Home', usage: 0x223 }, { label: 'Refresh', usage: 0x227 },
    { label: 'Forward', usage: 0x225 }, { label: 'Backward', usage: 0x224 },
    { label: 'Favorites', usage: 0x22A }, { label: 'Search', usage: 0x221 },
    // mouse = [0x01, 0x01, buttonMask, 0] — masks 1/2/4 wire-captured (left/right/middle);
    // back/forward use the next standard HID masks (8/16), same proven layout
    { label: 'Left Mouse Button', bytes: [0x01, 0x01, 0x01, 0x00] },
    { label: 'Right Mouse Button', bytes: [0x01, 0x01, 0x02, 0x00] },
    { label: 'Middle Mouse Button', bytes: [0x01, 0x01, 0x04, 0x00] },
    { label: 'Mouse Backward Button', bytes: [0x01, 0x01, 0x08, 0x00] },
    { label: 'Mouse Forward Button', bytes: [0x01, 0x01, 0x10, 0x00] }
    // mouse scroll up/down are NOT mask-based (wheel motion) — need a capture before shipping
  ];

  // firmware function codes — the light-cycle codes are hardware-confirmed from the live keymap
  // dump; the rest come from the official tool's Fn-layer table (fnlistarray.txt, 2026-06-11),
  // cross-validated by three wire captures (Lock Win=22, BT Ch.1=2, Ambient=165 all matched).
  // Code 46 ("Knob Mode") just toggles MUTE on this board — labeled for what it really does.
  const funcs = [
    { label: 'Light Effect Switch', code: 11 }, { label: 'Light Color Switch', code: 12 },
    { label: 'Light Brightness +', code: 13 }, { label: 'Light Brightness -', code: 14 },
    { label: 'Light Speed +', code: 15 }, { label: 'Light Speed -', code: 16 },
    { label: 'Turn Off Lights', code: 17 },
    { label: 'Side Light Effect Switch', code: 23 }, { label: 'Side Light Color Switch', code: 24 },
    { label: 'Side Light Brightness', code: 25 }, { label: 'Side Light Speed', code: 26 },
    { label: 'Turn Off Side Lights', code: 83 },
    { label: 'Front Strip Effect Switch', code: 27 }, { label: 'Front Strip Color Switch', code: 29 },
    { label: 'Front Strip Speed', code: 28 },
    { label: 'Ambient Effect Switch', code: 165 }, { label: 'Ambient Color Switch', code: 164 },
    { label: 'Ambient Brightness', code: 162 }, { label: 'Ambient Speed', code: 163 },
    { label: 'Knob — Mute Toggle', code: 46 }, { label: 'Lock Win', code: 22 },
    { label: 'Bluetooth Channel 1', code: 2 }, { label: 'Bluetooth Channel 2', code: 3 },
    { label: 'Bluetooth Channel 3', code: 4 }, { label: 'Wireless Reconnect', code: 5 },
    { label: 'Check Battery', code: 7 },
    { label: 'Restore Factory Settings', code: 1 }   // careful: a bare tap of the bound key factory-resets the board
  ];

  const PALETTE = [
    { key: 'basic', name: 'Basic Characters', items: basics },
    { key: 'extended', name: 'Extended Characters', items: extended },
    { key: 'special', name: 'Special Characters', items: special },
    { key: 'function', name: 'Function Keys', items: funcs }
  ];

  // decorative toggles — one click binds the SPACEBAR to the function + opens the focus overlay.
  // `note` renders as a caveat inside the overlay; `swapTo` adds an inline button that rebinds
  // the Spacebar to the sibling function and swaps the overlay over to it.
  const SPACE_FUNCS = [
    { code: 24,  name: 'Side Light Color',   desc: "cycle the side strips' color",
      note: "If your side lights are currently on a rainbow or animated effect, cycling the color won't visibly change anything — the side lights need to be cycled to the static-color effect first. To cycle the effect instead:",
      swapTo: 23 },
    { code: 23,  name: 'Side Light Effect',  desc: "cycle the side strips' effect" },
    { code: 29,  name: 'Front Strip Color',  desc: "cycle the front strip's color",
      note: "If your front strip is currently on a rainbow or animated effect, cycling the color won't visibly change anything — the front strip needs to be cycled to the static-color effect first. To cycle the effect instead:",
      swapTo: 27 },
    { code: 27,  name: 'Front Strip Effect', desc: "cycle the front strip's effect" },
    { code: 164, name: 'Ambient Color',      desc: "cycle the circle light's color",
      note: "If the circle light is currently on a rainbow or animated effect, cycling the color won't visibly change anything — it needs to be cycled to the static-color effect first. To cycle the effect instead:",
      swapTo: 165 },
    { code: 165, name: 'Ambient Effect',     desc: 'cycle the ambient lighting effect' }
  ];

  // default HID usage (normal character) for every key value — used by Restore Default.
  // Captured from the live board's factory keymap; key value = the engine's LED index.
  const DEFAULT_HID = { 0: 41, 1: 58, 2: 59, 3: 60, 4: 61, 5: 62, 6: 63, 7: 64, 8: 65, 9: 66, 10: 67, 11: 68, 12: 69, 99: 70, 100: 71, 102: 72, 16: 53, 17: 30, 18: 31, 19: 32, 20: 33, 21: 34, 22: 35, 23: 36, 24: 37, 25: 38, 26: 39, 27: 45, 28: 46, 92: 42, 103: 73, 104: 74, 105: 75, 29: 83, 30: 84, 31: 85, 109: 86, 32: 43, 33: 20, 34: 26, 35: 8, 36: 21, 37: 23, 38: 28, 39: 24, 40: 12, 41: 18, 42: 19, 43: 47, 44: 48, 60: 49, 106: 76, 107: 77, 108: 78, 45: 95, 46: 96, 47: 97, 110: 87, 48: 57, 49: 4, 50: 22, 51: 7, 52: 9, 53: 10, 54: 11, 55: 13, 56: 14, 57: 15, 58: 51, 59: 52, 76: 40, 61: 92, 62: 93, 63: 94, 64: 225, 65: 29, 66: 27, 67: 6, 68: 25, 69: 5, 70: 17, 71: 16, 72: 54, 73: 55, 74: 56, 75: 229, 90: 82, 77: 89, 78: 90, 79: 91, 95: 88, 80: 224, 81: 227, 82: 226, 83: 44, 84: 230, 85: 175, 86: 101, 87: 228, 88: 80, 89: 81, 91: 79, 93: 98, 94: 99 };

  // ---- pure keymap helpers (unit-tested) ----
  function defaultEntry(keyValue) {
    if (keyValue === FN_VAL) return null;
    const hid = DEFAULT_HID[keyValue];
    return hid == null ? null : encodeNormal(hid);
  }
  function setEntry(km, keyValue, four) { const o = keyValue * 4; km[o] = four[0]; km[o + 1] = four[1]; km[o + 2] = four[2]; km[o + 3] = four[3]; }
  // split the 512-byte keymap into the cmd-0x22 write chunks (56-byte payloads, last flag on the final one)
  function keymapChunks(data) {
    const out = [];
    for (let off = 0; off < KEYMAP_BYTES; off += CHUNK) {
      const len = Math.min(CHUNK, KEYMAP_BYTES - off);
      out.push({ off, len, last: (off + CHUNK) >= KEYMAP_BYTES, payload: Array.from(data.slice(off, off + len)) });
    }
    return out;
  }
  // a real TH108 keymap has 104 populated 4-byte entries (type byte 0x02/0x0d/0x03, never 0) —
  // a near-empty read means the read failed, and writing it back would dead-key the board
  function keymapLooksValid(km) {
    let n = 0;
    for (let v = 0; v < 128; v++) if (km[v * 4] !== 0) n++;
    return n >= 80;
  }
  // stored backup → Uint8Array(512) or null. Same plausibility gate as a live read: a restore
  // writes these bytes straight to the board, so junk must never pass.
  function validateBackup(obj) {
    if (!obj || !Array.isArray(obj.bytes) || obj.bytes.length !== KEYMAP_BYTES) return null;
    if (!obj.bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
    const km = new Uint8Array(obj.bytes);
    return keymapLooksValid(km) ? km : null;
  }

  // ---- group toggle (ONE button flips every remapped key ⇄ its typing default) ----
  // mods = the persisted th108_key_mods map: keyValue → {label, bytes:[4], off?:true}.
  // `bytes` is the exact entry we wrote (so the toggle can re-apply it later); `off` means the key
  // is currently parked on its factory character. Sessions before 2026-06-11 stored a bare label
  // string — normalize keeps the board mark but such keys can't round-trip (no bytes), so the
  // toggle skips them until they're re-assigned once.
  function normalizeMods(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') { out[k] = { label: v }; continue; }
      if (!v || typeof v !== 'object' || typeof v.label !== 'string') continue;
      const e = { label: v.label };
      if (Array.isArray(v.bytes) && v.bytes.length === 4 && v.bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) e.bytes = v.bytes.slice();
      if (v.off && e.bytes) e.off = true;   // `off` without bytes can't be brought back — treat as active so the mark stays honest
      if (Number.isInteger(v.pair) && v.pair >= 0 && v.pair < 128 && v.pair !== +k) e.pair = v.pair;   // SOCD partner link
      out[k] = e;
    }
    for (const e of Object.values(out)) if (e.pair != null && !out[e.pair]) delete e.pair;   // a pair link must point at a real entry
    return out;
  }
  function modsOff(mods) { return Object.values(mods).some(e => e.off); }
  // plan one toggle pass without mutating anything: toTyping=true parks every active remapped key
  // on its factory character; false re-applies the stored custom bytes of every parked key.
  // Returns {writes:[{idx,bytes}], next} — the keymap writes plus the mods map to persist after.
  function groupPlan(mods, toTyping) {
    const writes = [], next = {};
    for (const [k, v] of Object.entries(mods)) {
      const idx = +k, e = Object.assign({}, v);
      if (toTyping && v.bytes && !v.off) {
        const d = defaultEntry(idx);                       // no default known (Fn) → never park what we can't restore
        if (d) { writes.push({ idx, bytes: d }); e.off = true; }
      } else if (!toTyping && v.bytes && v.off) {
        writes.push({ idx, bytes: v.bytes.slice() });
        delete e.off;
      }
      next[k] = e;
    }
    return { writes, next };
  }
  // keys to restore when the user reverts `idx`: the key itself plus its SOCD partner — a
  // half-removed SOCD pair is undefined firmware behavior, so the pair always goes together.
  // Only keys with a known factory entry qualify (defaultEntry refuses Fn/unknown).
  function restoreTargets(mods, idx) {
    const e = mods[idx], t = [idx];
    if (e && Number.isInteger(e.pair) && e.pair !== idx) t.push(e.pair);
    return t.filter(v => defaultEntry(v));
  }

  function create(opts) {
    opts = opts || {};
    const noop = function () {};
    const hid = opts.hid, log = opts.log || noop, board = opts.board || null,
          gifPlaying = opts.gifPlaying || (() => false), stopGif = opts.stopGif || noop,
          pauseLighting = opts.pauseLighting || noop, resumeLighting = opts.resumeLighting || noop;
    const $ = id => document.getElementById(id);
    let connected = false, busy = false, spaceActive = false, curTab = 'basic';
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---- progress overlay (the full read+write takes ~2 s) ----
    let kmLast = 0;   // monotonic within one pass — a retried chunk must never walk the bar backward
    function kmShow(label) { kmLast = -1; $('kmProgLbl').textContent = label || 'Updating keyboard…'; setKm(0); $('kmProg').classList.add('open'); }
    function setKm(pct) { if (pct < kmLast) return; kmLast = pct; $('kmProgFill').style.width = pct + '%'; $('kmProgPct').textContent = Math.round(pct) + '%'; }
    function kmHide() { $('kmProg').classList.remove('open'); }

    // ---- wire ops ----
    // read one 56-byte keymap chunk (cmd 0x12); the response is the 0x55 0x12 input report, payload at byte 8.
    // Fixed window per chunk (no early resolve): a late response must never be attributed to the NEXT offset.
    function readChunkAt(off, ms) {
      return new Promise(res => {
        const dev = hid.device;
        if (!dev) { res(null); return; }
        let got = null;
        const onIn = e => { const b = new Uint8Array(e.data.buffer); if (b[0] === 0x55 && b[1] === CMD_READ) got = b; };
        dev.addEventListener('inputreport', onIn);
        dev.sendReport(hid.reportId, hid.buildPkt(CMD_READ, CHUNK, off, [], 0, true)).catch(() => {});
        setTimeout(() => { dev.removeEventListener('inputreport', onIn); res(got); }, ms || 170);
      });
    }
    async function readFullKeymap(p0, p1) {
      const data = new Uint8Array(KEYMAP_BYTES);
      let misses = 0;
      for (let off = 0; off < KEYMAP_BYTES; off += CHUNK) {
        let r = null;
        for (let a = 0; a < 3 && !r; a++) r = await readChunkAt(off);   // a chunk's window can lose to straggler lighting ACKs — re-ask THAT chunk, don't fail the pass
        if (r) { for (let i = 0; i < CHUNK && off + i < KEYMAP_BYTES; i++) data[off + i] = r[8 + i] || 0; }
        else misses++;
        if (p1 != null) setKm(p0 + (p1 - p0) * Math.min(1, (off + CHUNK) / KEYMAP_BYTES));
      }
      return { data, misses };
    }
    // read with validation + one retry — NOTHING is ever written from a bad read
    async function readKeymapValidated(p0, p1) {
      for (let att = 0; att < 2; att++) {
        const r = await readFullKeymap(p0, p1);
        if (!r.misses && keymapLooksValid(r.data)) return r.data;
        log('keymap read looked incomplete (' + r.misses + ' missing chunk(s))' + (att ? '' : ' — retrying…'), att ? 'err' : 'dim');
      }
      return null;
    }
    // write the WHOLE 512-byte keymap back (cmd 0x22, 56-byte chunks, each gated on its 0x55 0x22 ACK) —
    // this full rewrite is what actually COMMITS edits; single-key writes ACK but don't take effect
    async function writeFullKeymap(data, p0, p1) {
      const dev = hid.device;
      for (const ch of keymapChunks(data)) {
        const ack = new Promise(res => {
          const onIn = e => { const b = new Uint8Array(e.data.buffer); if (b[0] === 0x55 && b[1] === CMD_WRITE) { dev.removeEventListener('inputreport', onIn); res(true); } };
          dev.addEventListener('inputreport', onIn);
          setTimeout(() => { dev.removeEventListener('inputreport', onIn); res(false); }, 500);
        });
        await dev.sendReport(hid.reportId, hid.buildPkt(CMD_WRITE, ch.len, ch.off, ch.payload, 0, ch.last));
        await ack;
        if (p1 != null) setKm(p0 + (p1 - p0) * Math.min(1, (ch.off + CHUNK) / KEYMAP_BYTES));
      }
    }
    // read → modify(km) → bulk write, with the progress overlay; lighting/GIF paused so the keymap
    // traffic never interleaves with 0x32 paint (their 0x55 ACKs would cross-trigger each other).
    // Returns true when the write landed, false when nothing was written.
    async function keymapRMW(modify, label) {
      if (!hid.device) { log('connect the keyboard first (Home tab) — keymap writes need this page to hold the device', 'err'); return false; }
      if (busy) return false;
      busy = true; kmShow(label);
      if (gifPlaying()) stopGif();   // GIF playback streams 0x32 frames too — same interleave hazard
      pauseLighting();
      refresh();
      try {
        await sleep(250);            // let the in-flight lighting frame finish ACKing — its 0x32 traffic crowds the first 0x12 responses past their windows
        const km = await readKeymapValidated(0, 55);     // read = first 55% of the bar
        if (!km) { log('keymap read failed — nothing was written, the keyboard is unchanged', 'err'); return false; }
        modify(km);
        await writeFullKeymap(km, 55, 100);              // write = last 45%
        setKm(100); await sleep(140);
        return true;
      } catch (e) {
        log('keymap update failed: ' + (e && e.message || e), 'err');
        return false;
      } finally { kmHide(); resumeLighting(); busy = false; refresh(); }
    }

    // ---- palette UI (tabs + button grid, data-driven from PALETTE) ----
    function renderTabs() {
      const host = $('bdTabs');
      PALETTE.forEach(tab => {
        const b = document.createElement('button');
        b.className = 'patbtn' + (tab.key === curTab ? ' sel' : '');
        b.textContent = tab.name; b.dataset.tab = tab.key;
        b.addEventListener('click', () => { curTab = tab.key; host.querySelectorAll('.patbtn').forEach(x => x.classList.toggle('sel', x.dataset.tab === curTab)); renderGrid(); });
        host.appendChild(b);
      });
    }
    function renderGrid() {
      const host = $('bdGrid');
      host.textContent = '';
      const tab = PALETTE.find(t => t.key === curTab);
      const en = connected && !busy && bindable(selKey());
      tab.items.forEach(item => {
        const b = document.createElement('button');
        b.className = 'patbtn'; b.textContent = item.label; b.disabled = !en;
        b.addEventListener('click', () => assign(item));
        host.appendChild(b);
      });
    }

    // modified-key marks: what OUR binder wrote, persisted so the board shows it across reloads
    // (bindings live in the keyboard's flash, so they outlive the page; an out-of-band change —
    // official tool, factory reset — can desync the marks until the next bind/restore here).
    // Each entry also stores the 4 written bytes, which is what makes the group toggle possible.
    const MODS_KEY = 'th108_key_mods';
    function loadMods() { try { return normalizeMods(JSON.parse(localStorage.getItem(MODS_KEY) || '{}')); } catch (_) { return {}; } }
    function saveMods(m) { try { localStorage.setItem(MODS_KEY, JSON.stringify(m)); } catch (_) { } }
    // batched write: SOCD saves two linked entries at once — sequential single-entry saves would
    // let normalizeMods drop the first pair link (its partner doesn't exist yet between saves)
    function setMods(entries) {   // {idx: {label, bytes, pair?} | null}
      const m = loadMods();
      for (const [i, e] of Object.entries(entries)) {
        if (!e) { delete m[i]; if (board && board.unmark) board.unmark(+i); }
        else { m[i] = e; if (board && board.mark) board.mark(+i, e.label); }
      }
      saveMods(m);
      refresh();   // the group-toggle button mirrors the mods map
    }
    function setMod(idx, label, bytes) {
      setMods({ [idx]: label == null ? null : (bytes ? { label, bytes: bytes.slice() } : { label }) });
    }
    function clearMods() {
      Object.keys(loadMods()).forEach(i => { if (board && board.unmark) board.unmark(+i); });
      try { localStorage.removeItem(MODS_KEY); } catch (_) { }
    }
    // parked keys (off) currently type their factory character — no mark, that's the truth
    if (board && board.mark) Object.entries(loadMods()).forEach(([i, e]) => { if (!e.off) board.mark(+i, e.label); });

    function selKey() { return board && board.sel; }
    function bindable(sel) { return !!sel && sel.idx !== FN_VAL && DEFAULT_HID[sel.idx] != null; }
    // enable/disable everything + keep the readout and the why-disabled hint honest
    function refresh() {
      const sel = selKey(), ok = bindable(sel);
      $('bdKey').textContent = sel ? 'Key: ' + (sel.label || 'Space') + ' (value ' + sel.idx + ')' : 'no key selected';
      $('bdState').textContent = !connected ? 'needs Connect' : (ok ? 'ready' : 'pick a key');
      const en = connected && !busy;
      $('bdRevert').disabled = !(en && ok);
      document.querySelectorAll('#spaceBtns [data-space]').forEach(b => { b.disabled = !en; });
      let bk = null; try { bk = JSON.parse(localStorage.getItem('th108_keymap_backup') || 'null'); } catch (_) { }
      const bkOk = validateBackup(bk);
      $('bdBackup').disabled = !en;
      $('bdRestore').disabled = !(en && bkOk);
      $('bdBackupInfo').textContent = bkOk ? 'backup from ' + new Date(bk.savedAt).toLocaleString() : 'no backup yet — take one while your keymap is healthy';
      // group toggle: label + enablement track the mods map (suspended = some keys are parked)
      const mods = loadMods(), nMods = Object.keys(mods).length, suspended = modsOff(mods);
      const plan = groupPlan(mods, !suspended);
      const noBytes = Object.values(mods).filter(e => !e.bytes).length;
      $('bdToggleLbl').textContent = suspended ? 'Remapped Keys → Back to Custom' : 'All Remapped Keys → Typing';
      $('bdToggleAll').disabled = !(en && plan.writes.length);
      $('bdToggleInfo').textContent =
        !nMods    ? 'no keys remapped yet' :
        suspended ? plan.writes.length + ' key' + (plan.writes.length === 1 ? '' : 's') + ' parked on typing defaults' :
                    nMods + ' key' + (nMods === 1 ? '' : 's') + ' remapped' +
                    (noBytes ? ' (' + noBytes + ' from an older session — re-assign once to include in the toggle)' : '');
      $('bdHint').textContent =
        !connected ? 'Assigning rewrites the keyboard\'s keymap over WebHID, so this page must hold the device — click Connect Keyboard on the Home tab first.' :
        !sel       ? 'Pick a key on the board above, then click what it should do. The change lives in the keyboard\'s flash — it works in every app, no software needed.' :
        !ok        ? 'The Fn key is handled by the firmware and can\'t be reassigned — pick another key.' :
                     'Click an assignment — the full 512-byte keymap is rewritten (single-key writes don\'t commit), takes about 2 seconds. Restore Default brings the key back.';
      renderGrid();
      akRefresh();   // hoisted — the Advanced Keys card gates exactly like the palette
    }
    if (board) board.onChange(refresh);

    async function assign(item) {
      const sel = selKey(); if (!bindable(sel)) return;
      const four = entryBytes(item); if (!four) return;
      const ok = await keymapRMW(km => setEntry(km, sel.idx, four), 'Assigning ' + (sel.label || 'Space') + ' → ' + item.label + '…');   // key → action, like every other arrow in the suite
      if (!ok) return;
      const isDefault = four[0] === 0x02 && four[2] === DEFAULT_HID[sel.idx];   // re-assigning the key's own character = back to stock, no mark
      setMod(sel.idx, isDefault ? null : item.label, four);
      log('✓ ' + (sel.label || 'Space') + ' now does "' + item.label + '" — Restore Default to undo', 'ok');
    }
    // restore one key (and its SOCD partner — half a pair is undefined firmware behavior) to the
    // factory character. Shared by the Restore Default button and the board's right-click Reset.
    async function revertKey(idx, name) {
      if (idx === FN_VAL || DEFAULT_HID[idx] == null) return false;
      name = name || keyShort(DEFAULT_HID[idx]);
      const targets = restoreTargets(loadMods(), idx);
      const ok = await keymapRMW(km => targets.forEach(v => setEntry(km, v, defaultEntry(v))),
                                 'Restoring ' + name + (targets.length > 1 ? ' + its SOCD partner' : '') + '…');
      if (!ok) return false;
      setMods(Object.fromEntries(targets.map(v => [v, null])));
      log('✓ ' + name + (targets.length > 1 ? ' and its SOCD partner' : '') + ' restored to default', 'ok');
      return true;
    }
    async function revert() {
      const sel = selKey(); if (!bindable(sel)) return;
      const ok = await revertKey(sel.idx, sel.label || 'Space');
      if (ok && board && board.clear) board.clear();   // restored = done with this key — drop the selection
    }
    $('bdRevert').addEventListener('click', revert);

    // ---- keymap backup / restore: recovery for a scrambled board (the official tool is known
    // to jumble keymaps — see project memory). Backup = validated read → localStorage + a JSON
    // download; Restore = write the known-good 512 bytes straight back (no read first — the
    // board's current map is exactly what we don't trust). ----
    const BK_KEY = 'th108_keymap_backup';
    function loadBackup() {
      try { const o = JSON.parse(localStorage.getItem(BK_KEY) || 'null'); return validateBackup(o) ? o : null; }
      catch (_) { return null; }
    }
    async function backup() {
      if (!hid.device || busy) return;
      busy = true; kmShow('Reading keymap…');
      if (gifPlaying()) stopGif();
      pauseLighting(); refresh();
      try {
        await sleep(250);            // same drain as keymapRMW — straggler 0x32 ACKs crowd the read windows
        const km = await readKeymapValidated(0, 100);
        if (!km) { log('keymap read failed — no backup written', 'err'); return; }
        setKm(100); await sleep(140);
        const o = { bytes: Array.from(km), savedAt: Date.now() };
        try { localStorage.setItem(BK_KEY, JSON.stringify(o)); } catch (_) { }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(o)], { type: 'application/json' }));
        a.download = 'th108-keymap-backup.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        log('✓ keymap backed up (512 B) — stored on this page + downloaded. Restore Keymap writes it back any time.', 'ok');
      } finally { kmHide(); resumeLighting(); busy = false; refresh(); }
    }
    async function restoreBackup() {
      const o = loadBackup();
      if (!o || !hid.device || busy) return;
      const when = new Date(o.savedAt).toLocaleString();
      if (!confirm('Write the backed-up keymap (saved ' + when + ') to the keyboard?\n\nThis replaces ALL current key bindings with the backup — the cure for a scrambled keymap.')) return;
      busy = true; kmShow('Restoring keymap…');
      if (gifPlaying()) stopGif();
      pauseLighting(); refresh();
      try {
        await writeFullKeymap(validateBackup(o), 0, 100);
        setKm(100); await sleep(140);
        clearMods();   // the backup is the healthy baseline — board marks from later binds no longer apply
        log('✓ keymap restored from the ' + when + ' backup', 'ok');
      } catch (e) { log('keymap restore failed: ' + (e && e.message || e), 'err'); }
      finally { kmHide(); resumeLighting(); busy = false; refresh(); }
    }
    $('bdBackup').addEventListener('click', backup);
    $('bdRestore').addEventListener('click', restoreBackup);

    // ---- group toggle: one keymap pass flips every remapped key ⇄ its typing default ----
    // (generalizes webhid-test.html's fixed "' ; H J K L → TYPING" button to whatever is bound)
    async function toggleAll() {
      const mods = loadMods();
      const toTyping = !modsOff(mods);
      const plan = groupPlan(mods, toTyping);
      if (!plan.writes.length) return;
      const ok = await keymapRMW(km => plan.writes.forEach(w => setEntry(km, w.idx, w.bytes)),
        toTyping ? 'Switching remapped keys to typing…' : 'Re-applying custom assignments…');
      if (!ok) return;
      // a parked Spacebar default IS the interrupted-overlay restore, completed — drop both
      if (toTyping && pendingRestore() && plan.next[SPACE_VAL]) { delete plan.next[SPACE_VAL]; setPending(false); }
      saveMods(plan.next);
      plan.writes.forEach(w => {
        const e = plan.next[w.idx];
        if (board) { if (!e || e.off) { if (board.unmark) board.unmark(w.idx); } else if (board.mark) board.mark(w.idx, e.label); }
      });
      refresh();
      log(toTyping ? '✓ remapped keys type normally now — the same button brings the custom assignments back'
                   : '✓ custom assignments re-applied', 'ok');
    }
    $('bdToggleAll').addEventListener('click', toggleAll);

    // ---- Advanced Keys card: CB / MT / TGL / SOCD (entry types 0x07/0x09/0x0a/0x0b) ----
    const AK_TYPES = [
      { key: 'cb',   name: 'Combination', desc: 'One key presses a whole shortcut — e.g. M acts as L-Alt + R-Ctrl + C.' },
      { key: 'mt',   name: 'Mod-Tap',     desc: 'Tap = one key, hold = another — e.g. tap Y types Y, hold Y acts as Tab.' },
      { key: 'tgl',  name: 'Toggle',      desc: 'Tap toggles another key held down — e.g. K toggles R held (autorun in games). Tap again to release.' },
      { key: 'socd', name: 'SOCD',        desc: 'Pairs two opposing keys (like A and D): when both are physically down, the last one pressed wins.' }
    ];
    const KEY_ITEMS = [];   // palette basic+extended, deduped by HID — labels for every assignable key
    PALETTE.find(t => t.key === 'basic').items.concat(PALETTE.find(t => t.key === 'extended').items)
      .forEach(it => { if (!KEY_ITEMS.some(x => x.hid === it.hid)) KEY_ITEMS.push(it); });
    const HID_LABEL = {}; KEY_ITEMS.forEach(it => { HID_LABEL[it.hid] = it.label; });
    MODIFIERS.forEach(m => { if (!HID_LABEL[m.hid]) HID_LABEL[m.hid] = m.label; });
    const keyShort = hid => (HID_LABEL[hid] || ('HID ' + hid)).split(' ')[0];   // board marks are tiny — first word only
    let akType = 'cb';

    function akSelEl(id, items, selVal) {
      const s = document.createElement('select'); s.id = id;
      items.forEach(it => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; if (it.value === selVal) o.selected = true; s.appendChild(o); });
      return s;
    }
    const keyOpts = () => KEY_ITEMS.map(it => ({ value: it.hid, label: it.label }));
    const modOpts = () => MODIFIERS.map(m => ({ value: m.hid, label: m.label }));
    function akPartnerOpts(selIdx) {   // every board key except Fn and the selected key, labeled via its factory HID
      return Object.keys(DEFAULT_HID).map(Number)
        .filter(v => v !== selIdx && v !== FN_VAL)
        .map(v => ({ value: v, label: HID_LABEL[DEFAULT_HID[v]] || ('key ' + v) }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }
    function akLab(text) { const s = document.createElement('span'); s.className = 'hint'; s.style.margin = '0'; s.textContent = text; return s; }

    function akRenderTabs() {
      const host = $('akTabs');
      AK_TYPES.forEach(t => {
        const b = document.createElement('button');
        b.className = 'patbtn' + (t.key === akType ? ' sel' : ''); b.textContent = t.name; b.dataset.ak = t.key;
        b.addEventListener('click', () => { akType = t.key; host.querySelectorAll('.patbtn').forEach(x => x.classList.toggle('sel', x.dataset.ak === akType)); akRenderForm(); });
        host.appendChild(b);
      });
    }
    function akRenderForm() {   // re-rendered on type switch AND board-selection change (fresh defaults)
      const f = $('akForm'); f.textContent = '';
      $('akDesc').textContent = AK_TYPES.find(t => t.key === akType).desc;
      const sel = selKey(), ownHid = sel ? DEFAULT_HID[sel.idx] : null;
      if (akType === 'cb') {
        f.appendChild(akLab('presses')); f.appendChild(akSelEl('akMod1', modOpts(), 0xE0));
        f.appendChild(akLab('+')); f.appendChild(akSelEl('akMod2', [{ value: 0, label: '(none)' }].concat(modOpts()), 0xE1));   // middle slot is officially optional (the driver only validates slots 1+3)
        f.appendChild(akLab('+')); f.appendChild(akSelEl('akKey', keyOpts(), 41));   // Esc: the default chord Ctrl+Shift+Esc pops Task Manager — instantly verifiable
      } else if (akType === 'mt') {
        f.appendChild(akLab('tap =')); f.appendChild(akSelEl('akClick', keyOpts(), ownHid != null ? ownHid : 4));
        f.appendChild(akLab('hold =')); f.appendChild(akSelEl('akHold', keyOpts(), 43));
        f.appendChild(akLab('threshold (ms)'));
        const n = document.createElement('input'); n.type = 'number'; n.id = 'akTime'; n.min = 10; n.max = 2550; n.step = 10; n.value = 400;
        n.style.width = '70px'; n.title = 'tap-vs-hold threshold in milliseconds — 400 ms is the official default (the wire byte is ms/10)';
        f.appendChild(n);
      } else if (akType === 'tgl') {
        f.appendChild(akLab('toggles')); f.appendChild(akSelEl('akKey', keyOpts(), 0x15)); f.appendChild(akLab('held on/off'));
      } else {
        f.appendChild(akLab('pairs with'));
        f.appendChild(akSelEl('akPartner', akPartnerOpts(sel ? sel.idx : -1)));
        f.appendChild(akLab('· Last Pressed Wins (mode 3 — the only wire-captured mode)'));
      }
      akRefresh();
    }
    function akRefresh() {   // called from refresh() so connect/busy changes flow through
      const sel = selKey(), ok = bindable(sel), en = connected && !busy && ok;
      $('akApply').disabled = !en;
      $('akApply').textContent = 'Apply to ' + (ok ? (sel.label || 'Space') : 'selected key');
      $('akState').textContent = !connected ? 'needs Connect' : (ok ? '' : 'pick a key on the board above');
    }
    async function akApply() {
      const sel = selKey(); if (!bindable(sel) || busy) return;
      const own = sel.label || 'Space';
      if (akType === 'socd') {
        const pv = +$('akPartner').value, a = DEFAULT_HID[sel.idx], b = DEFAULT_HID[pv];
        if (b == null || pv === sel.idx || pv === FN_VAL) return;
        const four = encodeSOCD(a, b);
        const ok = await keymapRMW(km => { setEntry(km, sel.idx, four); setEntry(km, pv, four); },
                                   'Pairing ' + own + ' + ' + keyShort(b) + ' (SOCD)…');
        if (!ok) return;
        setMods({ [sel.idx]: { label: 'SOCD ' + keyShort(a), bytes: four.slice(), pair: pv },
                  [pv]:      { label: 'SOCD ' + keyShort(b), bytes: four.slice(), pair: sel.idx } });
        log('✓ SOCD pair: ' + keyShort(a) + ' ⟷ ' + keyShort(b) + ' — last pressed wins. Restore Default on either key removes both.', 'ok');
        return;
      }
      let four, label;
      if (akType === 'cb') {
        const m1 = +$('akMod1').value, m2 = +$('akMod2').value, k = +$('akKey').value;
        four = encodeCB(m1, m2, k);   // m2 may be 0 — the official driver allows an empty middle slot
        label = [m1, m2, k].filter(Boolean).map(keyShort).join('+');
      } else if (akType === 'mt') {
        const c = +$('akClick').value, h = +$('akHold').value;
        const ms = parseInt($('akTime').value, 10) || 400;
        const t = Math.max(1, Math.min(255, Math.round(ms / 10)));   // wire byte = ms/10 (vendor getSendMT: time/10; 400 ms default → 0x28)
        four = encodeMT(c, h, t); label = keyShort(c) + '⇄' + keyShort(h);
      } else {
        const k = +$('akKey').value;
        four = encodeTGL(k); label = 'TGL ' + keyShort(k);
      }
      const ok = await keymapRMW(km => setEntry(km, sel.idx, four), 'Assigning ' + own + ' → ' + label + '…');
      if (!ok) return;
      setMod(sel.idx, label, four);
      log('✓ ' + own + ' is now an advanced key: ' + label + ' — Restore Default to undo', 'ok');
    }
    $('akApply').addEventListener('click', akApply);
    if (board) board.onChange(akRenderForm);   // selection change re-renders (MT tap default, SOCD partner list)

    // chord check: live readout of what Windows actually receives — verifies a Combination/Mod-Tap
    // without hunting for an app that visibly reacts to the shortcut
    let akv = false;
    function akvShow(e) {
      const mods = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.metaKey && 'Win'].filter(Boolean);
      const main = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key) ? [] : [e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key)];
      $('akVerifyOut').textContent = 'received: ' + (mods.concat(main).join(' + ') || '—');
      e.preventDefault(); e.stopPropagation();   // keep page hotkeys out of the test (browser/OS-level shortcuts still win)
    }
    $('akVerify').addEventListener('click', () => {
      akv = !akv;
      if (akv) { window.addEventListener('keydown', akvShow, true); $('akVerify').textContent = '⏹ Stop checking'; $('akVerifyOut').textContent = 'listening — tap the key you bound…'; }
      else { window.removeEventListener('keydown', akvShow, true); $('akVerify').textContent = '⌨ Chord check'; $('akVerifyOut').textContent = ''; }
    });
    akRenderTabs(); akRenderForm();

    // ---- decorative light toggles: bind Space to a light, hold the overlay open, Esc/✕ restores ----
    (function () {
      const c = $('spaceBtns');
      SPACE_FUNCS.forEach(f => {
        const b = document.createElement('button'); b.textContent = f.name; b.disabled = true; b.style.margin = '0';
        b.dataset.space = '1'; b.addEventListener('click', () => enterSpace(f));
        c.appendChild(b);
      });
    })();
    function spaceEsc(e) { if (e.key === 'Escape') { e.preventDefault(); exitSpace(); } }
    function setSpaceDesc(f) {   // "Tap <kbd>Space</kbd> to <desc>." without innerHTML
      const d = $('spaceDesc'); d.textContent = 'Tap ';
      const k = document.createElement('kbd'); k.textContent = 'Space'; d.appendChild(k);
      d.appendChild(document.createTextNode(' to ' + f.desc + '.'));
    }
    // note area: a function's own caveat (+ swap-over button), or — when we arrived here VIA a
    // swap from a color toggle — the way back to it once the zone is on its static-color effect
    function setSpaceNote(f, backTo) {
      const n = $('spaceNote'); if (!n) return;
      n.textContent = '';
      const addBtn = (tgt, title, onClick) => {
        n.appendChild(document.createElement('br'));
        const b = document.createElement('button');
        b.textContent = tgt.name; b.style.margin = '10px 0 0'; b.title = title;
        b.addEventListener('click', onClick);
        n.appendChild(b);
      };
      if (f.note) {
        n.appendChild(document.createTextNode(f.note));
        const tgt = f.swapTo != null && SPACE_FUNCS.find(x => x.code === f.swapTo);
        if (tgt) addBtn(tgt, 'rebind the Spacebar to ' + tgt.name + ' — this overlay swaps over to it',
                        () => enterSpace(tgt, f));   // remember where we came from, for the way back
      } else if (backTo) {
        n.appendChild(document.createTextNode('Cycled to the static color you wanted? Switch back to:'));
        addBtn(backTo, 'rebind the Spacebar back to ' + backTo.name, () => enterSpace(backTo));
      } else { n.style.display = 'none'; return; }
      n.style.display = 'block';
    }
    // if a Spacebar restore fails mid-mute, remember it and finish automatically on the next connect —
    // the alternative was the user's replug → refresh → reopen-overlay → ✕ dance (2026-06-11 incident)
    const PENDING_KEY = 'th108_space_restore_pending';
    function setPending(v) { try { if (v) localStorage.setItem(PENDING_KEY, '1'); else localStorage.removeItem(PENDING_KEY); } catch (_) { } }
    function pendingRestore() { try { return localStorage.getItem(PENDING_KEY) === '1'; } catch (_) { return false; } }
    async function restoreSpace() {
      const ok = await keymapRMW(km => setEntry(km, SPACE_VAL, encodeNormal(SPACE_HID)), 'Restoring Spacebar…');
      if (ok) { setMod(SPACE_VAL, null); setPending(false); }
      return ok;
    }
    async function enterSpace(f, backTo) {
      if (!connected || busy) return;
      const ok = await keymapRMW(km => setEntry(km, SPACE_VAL, encodeFunc(f.code)), 'Binding Spacebar → ' + f.name + '…');
      if (!ok) return;
      setPending(false);   // a fresh deliberate binding supersedes any interrupted restore
      setMod(SPACE_VAL, f.name, encodeFunc(f.code));
      $('spaceTitle').textContent = f.name;
      setSpaceDesc(f); setSpaceNote(f, backTo);
      $('spaceOverlay').classList.add('open');
      spaceActive = true; window.addEventListener('keydown', spaceEsc);   // double-add on a swap-over is safe — same listener ref dedupes
      log('⎵ Spacebar → ' + f.name + ' (overlay open)', 'in');
    }
    async function exitSpace() {
      if (!spaceActive) return;
      spaceActive = false; window.removeEventListener('keydown', spaceEsc);
      $('spaceOverlay').classList.remove('open');
      if (await restoreSpace()) log('✓ Spacebar restored to normal', 'ok');
      else {
        setPending(true);
        log('Spacebar is still bound — the board didn\'t answer (mute?). The restore will finish by itself on the next successful Connect (replug if it stays mute).', 'err');
      }
    }
    $('spaceExit').addEventListener('click', exitSpace);

    function setConnected(v) {
      connected = !!v; refresh();
      if (v && pendingRestore()) setTimeout(async () => {   // let the connect/auto-start settle first
        if (!connected || busy || !pendingRestore()) return;
        log('finishing the interrupted Spacebar restore…', 'in');
        if (await restoreSpace()) log('✓ Spacebar restored to normal', 'ok');
      }, 1500);
    }
    renderTabs();
    refresh();

    return { setConnected, exitSpace, revertKey, get busy() { return busy; } };
  }

  return { create, PALETTE, SPACE_FUNCS, DEFAULT_HID, SPACE_VAL, SPACE_HID, FN_VAL,
           encodeNormal, encodeMedia, encodeFunc, entryBytes, defaultEntry, setEntry,
           keymapChunks, keymapLooksValid, validateBackup, normalizeMods, modsOff, groupPlan,
           restoreTargets, MODIFIERS, encodeCB, encodeMT, encodeTGL, encodeSOCD };
});
