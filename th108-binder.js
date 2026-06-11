/* th108-binder.js — key binder for the TH108 controller (ported from webhid-test.html, palette
   layout mirroring the official driver's key-assignment page).
   Pick a key on the board, then click what it should do: Basic Characters / Extended Characters /
   Special Characters (media) / Function Keys (the firmware's decorative-light cycle functions).
   Plus the Decorative Light Toggles: one click binds the SPACEBAR to a light function and opens a
   focus overlay; Esc/✕ exits and restores the Spacebar.

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
    { label: 'Left Mouse Button', bytes: [0x01, 0x01, 0x01, 0x00] }
  ];

  // decorative-light cycle functions (codes hardware-confirmed on the TH108 V2 PRO).
  // code 46 ("Knob Mode") just toggles MUTE on this board — labeled for what it really does.
  const funcs = [
    { label: 'Side Light Effect Switch', code: 23 }, { label: 'Side Light Color Switch', code: 24 },
    { label: 'Side Light Brightness', code: 25 }, { label: 'Side Light Speed', code: 26 },
    { label: 'Front Strip Effect Switch', code: 27 }, { label: 'Front Strip Color Switch', code: 29 },
    { label: 'Front Strip Speed', code: 28 },
    { label: 'Ambient Effect Switch', code: 165 }, { label: 'Ambient Color Switch', code: 164 },
    { label: 'Ambient Brightness', code: 162 }, { label: 'Ambient Speed', code: 163 },
    { label: 'Turn Off Side Lights', code: 83 }, { label: 'Knob — Mute Toggle', code: 46 },
    { label: 'Lock Win', code: 22 }, { label: 'Bluetooth Channel 1', code: 2 }   // wire-captured 2026-06-11; BT2/3 etc. pending the official tool's function list
  ];

  const PALETTE = [
    { key: 'basic', name: 'Basic Characters', items: basics },
    { key: 'extended', name: 'Extended Characters', items: extended },
    { key: 'special', name: 'Special Characters', items: special },
    { key: 'function', name: 'Function Keys', items: funcs }
  ];

  // decorative toggles — one click binds the SPACEBAR to the function + opens the focus overlay
  const SPACE_FUNCS = [
    { code: 24,  name: 'Side Light Color',   desc: "cycle the side strips' color" },
    { code: 23,  name: 'Side Light Effect',  desc: "cycle the side strips' effect" },
    { code: 29,  name: 'Front Strip Color',  desc: "cycle the front strip's color" },
    { code: 27,  name: 'Front Strip Effect', desc: "cycle the front strip's effect" },
    { code: 164, name: 'Ambient Color',      desc: "cycle the circle light's color" },
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
    function kmShow(label) { $('kmProgLbl').textContent = label || 'Updating keyboard…'; setKm(0); $('kmProg').classList.add('open'); }
    function setKm(pct) { $('kmProgFill').style.width = pct + '%'; $('kmProgPct').textContent = Math.round(pct) + '%'; }
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
        const r = await readChunkAt(off);
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
      $('bdHint').textContent =
        !connected ? 'Assigning rewrites the keyboard\'s keymap over WebHID, so this page must hold the device — click Connect Keyboard on the Home tab first.' :
        !sel       ? 'Pick a key on the board above, then click what it should do. The change lives in the keyboard\'s flash — it works in every app, no software needed.' :
        !ok        ? 'The Fn key is handled by the firmware and can\'t be reassigned — pick another key.' :
                     'Click an assignment — the full 512-byte keymap is rewritten (single-key writes don\'t commit), takes about 2 seconds. Restore Default brings the key back.';
      renderGrid();
    }
    if (board) board.onChange(refresh);

    async function assign(item) {
      const sel = selKey(); if (!bindable(sel)) return;
      const four = entryBytes(item); if (!four) return;
      const ok = await keymapRMW(km => setEntry(km, sel.idx, four), 'Assigning ' + item.label + ' → ' + (sel.label || 'Space') + '…');
      if (ok) log('✓ ' + (sel.label || 'Space') + ' now does "' + item.label + '" — Restore Default to undo', 'ok');
    }
    async function revert() {
      const sel = selKey(); if (!bindable(sel)) return;
      const d = defaultEntry(sel.idx);
      const ok = await keymapRMW(km => setEntry(km, sel.idx, d), 'Restoring ' + (sel.label || 'Space') + '…');
      if (ok) log('✓ ' + (sel.label || 'Space') + ' restored to its default', 'ok');
    }
    $('bdRevert').addEventListener('click', revert);

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
    async function enterSpace(f) {
      if (!connected || busy) return;
      const ok = await keymapRMW(km => setEntry(km, SPACE_VAL, encodeFunc(f.code)), 'Binding Spacebar → ' + f.name + '…');
      if (!ok) return;
      $('spaceTitle').textContent = f.name;
      setSpaceDesc(f);
      $('spaceOverlay').classList.add('open');
      spaceActive = true; window.addEventListener('keydown', spaceEsc);
      log('⎵ Spacebar → ' + f.name + ' (overlay open)', 'in');
    }
    async function exitSpace() {
      if (!spaceActive) return;
      spaceActive = false; window.removeEventListener('keydown', spaceEsc);
      $('spaceOverlay').classList.remove('open');
      const ok = await keymapRMW(km => setEntry(km, SPACE_VAL, encodeNormal(SPACE_HID)), 'Restoring Spacebar…');
      if (ok) log('✓ Spacebar restored to normal', 'ok');
      else log('Spacebar is still bound to the light function — reconnect, select Space on the board and Restore Default', 'err');
    }
    $('spaceExit').addEventListener('click', exitSpace);

    function setConnected(v) { connected = !!v; refresh(); }
    renderTabs();
    refresh();

    return { setConnected, exitSpace, get busy() { return busy; } };
  }

  return { create, PALETTE, SPACE_FUNCS, DEFAULT_HID, SPACE_VAL, SPACE_HID, FN_VAL,
           encodeNormal, encodeMedia, encodeFunc, entryBytes, defaultEntry, setEntry, keymapChunks, keymapLooksValid };
});
