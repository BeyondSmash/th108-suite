# Controller Decomposition — Module #1: th108-hid.js Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the WebHID transport (ACK-gated 0x32 streaming, interface binding, connect/auto-reconnect, sleep/wake re-bind) out of `th108-controller.html`'s inline script into `th108-hid.js`, behavior-identical.

**Architecture:** `th108-hid.js` is a UMD module (loadable by `<script src>` AND `require` for `node --test`, same as `th108-engine.js`). It exposes `TH108Hid.create(opts)` — a factory that owns the device handle / reportId / packLen / ACK-gating state and takes page callbacks (`log`, `setStatus`, `stopHost`, daemon-handshake hooks, UI hooks) so the module has zero DOM or daemon knowledge. Pure helpers `findWritable`/`findScreen` are also exported at module level for unit tests. The controller keeps its UI, loop, and daemon code and talks to the transport via the returned `HID` object.

**Tech Stack:** Vanilla JS (no build step), WebHID, `node --test` for the pure parts.

---

## Overall extraction sequence (context — this plan executes step 1 only)

Per `REFACTOR-GOALS.md`, one module per commit, verify between each:

1. **`th108-hid.js`** (this plan) — WebHID transport + reconnect. Most self-contained.
2. **`th108-daemon-client.js`** — `daemonPing`/`daemonYield`/heartbeat/`daemonPushConfig`/`daemonResume` + `__lcdHost` hook.
3. **`th108-layers-ui.js`** — `buildLayerCards`/`buildLayerBody`/`buildAdjustBlock` + layer reorder + save/restore/schedule-save.
4. **`th108-gif-panel.js`** — GIF→key loaders, crop/pan/zoom, sampling, playback, library wiring.
5. **`th108-onboard.js`** — onboard-effects panel (0x23).

Module boundary chosen for #1 (everything below moves; nothing else does):
- Constants `VENDOR`/`CMD`; state `device, reportId, packLen, _sendStalls, _ackWaiter, _inRpts`.
- `buildPkt`, `onInputReport`, `waitAck`, `noteStall`, `sendFrame`, `findWritable`, `findScreen`.
- `bindDevice`, `connect`, `autoReconnect`.
- The `navigator.hid` `disconnect`/`connect` listeners (sleep/wake re-bind), with `_wasRunning` staying page-side (it is layer-loop state).

Page⇄module contract (callbacks passed to `create`):
- `log(msg, cls)`, `setStatus(msg, cls)` — page logging UI.
- `ledCount` — for the connect log line (`INDICES.length`).
- `stopHost()` — module calls on board-unresponsive / fatal send error (was a direct `stop()` call).
- `beforeConnect()` — async; daemon ping+yield (used by `connect()` and the hotplug re-connect listener).
- `beforeAutoReconnect()` — async; yield-only (page-load silent reconnect; ping already done by the caller chain `daemonPing().then(...)`).
- `onBound({control, controlReportId, screen, screenReportId})` — page enables Start/Play buttons + `TH108LCD.setDevices`.
- `onConnected()` — `daemonHeartbeatStart()` after a successful `connect()`/`autoReconnect()`.
- `onDisconnected()` — page captures `_wasRunning`, stops the layer worker, clears LCD devices, disables buttons.
- `onReconnected()` — heartbeat + resume layers if `_wasRunning` + log lines.

Known-acceptable micro-reorderings (no observable difference):
- Start/Play button enable + `TH108LCD.setDevices` now happen together in `onBound` *after* the screen-iface open (was: buttons enabled between the control log and the screen open). No await depends on it.
- In the disconnect handler, LCD-clear/buttons run *before* `device=null` instead of after (none of them read `device`).
- `navigator.hid` listeners attach at `create()` time (top of script) instead of near the end, and only when `navigator.hid` exists (also makes the module `require`-able in Node 22, where `navigator` exists but `navigator.hid` doesn't).

---

### Task 1: Failing unit tests for the pure transport helpers

**Files:**
- Create: `th108-hid.test.js` (repo root, next to `th108-engine.test.js`)

- [ ] **Step 1: Write the failing tests**

```js
// th108-hid.test.js — unit tests for the pure parts of th108-hid.js (packet framing + interface selection).
// Run: node --test th108-hid.test.js   (no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const TH108Hid = require('./th108-hid.js');

// --- buildPkt (via a created instance; default packLen 64) ---
test('buildPkt frames the 64-byte packet: AA cmd len offLo offHi aux last 0, payload at byte 8', () => {
  const h = TH108Hid.create({});
  const pkt = h.buildPkt(0x32, 56, 0x1234, new Uint8Array([1, 2, 3]), 7, true);
  assert.equal(pkt.length, 64);
  assert.equal(pkt[0], 0xAA);
  assert.equal(pkt[1], 0x32);
  assert.equal(pkt[2], 56);
  assert.equal(pkt[3], 0x34);        // offset low byte
  assert.equal(pkt[4], 0x12);        // offset high byte
  assert.equal(pkt[5], 7);           // aux (amplitude)
  assert.equal(pkt[6], 1);           // isLast flag
  assert.equal(pkt[7], 0);
  assert.deepEqual([pkt[8], pkt[9], pkt[10]], [1, 2, 3]);
});

test('buildPkt: last=false → byte6 is 0; rest of packet zero-padded', () => {
  const h = TH108Hid.create({});
  const pkt = h.buildPkt(0x32, 3, 0, new Uint8Array([9, 9, 9]), 0, false);
  assert.equal(pkt[6], 0);
  assert.equal(pkt[63], 0);
});

// --- findWritable: must bind 0xFF68/0x61 explicitly, NOT the first output report ---
const mkCol = (usagePage, usage, reportId, reportCount) =>
  ({ usagePage, usage, outputReports: [{ reportId, items: [{ reportCount, reportSize: 8 }] }] });

test('findWritable picks 0xFF68/0x61 even when a screen iface (0xFF67) comes first', () => {
  const screen = { collections: [mkCol(0xFF67, 0x61, 0, 4104)] };
  const ctrl = { collections: [mkCol(0xFF68, 0x61, 0, 64)] };
  const w = TH108Hid.findWritable([screen, ctrl]);
  assert.equal(w.d, ctrl);
  assert.equal(w.packLen, 64);       // reportCount verbatim — do NOT +1
  assert.equal(w.usagePage, 0xFF68);
  assert.equal(w.usage, 0x61);
});

test('findWritable falls back: any 0xFF68, then any output report; null when none', () => {
  const ff68other = { collections: [mkCol(0xFF68, 0x99, 0, 64)] };
  assert.equal(TH108Hid.findWritable([ff68other]).d, ff68other);
  const anyOut = { collections: [mkCol(0x0001, 0x02, 0, 32)] };
  assert.equal(TH108Hid.findWritable([anyOut]).d, anyOut);
  const noOut = { collections: [{ usagePage: 0xFF68, usage: 0x61, outputReports: [] }] };
  assert.equal(TH108Hid.findWritable([noOut]), null);
});

// --- findScreen: largest output report wins (the 4104-byte screen iface) ---
test('findScreen picks the largest output report across devices', () => {
  const ctrl = { collections: [mkCol(0xFF68, 0x61, 0, 64)] };
  const screen = { collections: [mkCol(0xFF67, 0x61, 0, 4104)] };
  const best = TH108Hid.findScreen([ctrl, screen]);
  assert.equal(best.d, screen);
  assert.equal(best.bytes, 4104);
});

test('findScreen returns null with no output reports anywhere', () => {
  assert.equal(TH108Hid.findScreen([{ collections: [{ outputReports: [] }] }]), null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test th108-hid.test.js`
Expected: FAIL — `Cannot find module './th108-hid.js'`

---

### Task 2: Create `th108-hid.js` and make the tests pass

**Files:**
- Create: `th108-hid.js` (repo root)

- [ ] **Step 1: Write the module** (bodies copied verbatim from `th108-controller.html` lines 233–342 + 1057–1082, with `stop()`/daemon/DOM touchpoints replaced by the injected callbacks)

```js
/* th108-hid.js — WebHID transport for the Epomaker TH108 V2 PRO.
   Owns the control-interface handle (usagePage 0xFF68 / usage 0x61 — NEVER "the first output report",
   which can be the screen iface 0xFF67 that ACKs but doesn't drive LEDs) and the ACK-gated 0x32 frame
   streaming: the board ACKs every output write with a 0x55 input report, and the next write MUST wait
   for it or the command FIFO overruns and the HID pipe wedges (replug to recover).
   Extracted unchanged from th108-controller.html's inline script. UMD so the pure helpers
   (findWritable / findScreen / buildPkt) are unit-testable under node --test.

   Usage: const HID = TH108Hid.create({log, setStatus, ledCount, stopHost,
            beforeConnect, beforeAutoReconnect, onBound, onConnected, onDisconnected, onReconnected});
   The module knows nothing about the DOM or the daemon — all of that arrives via these callbacks. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108Hid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VENDOR = 0x0C45, CMD = 0x32;

  function findWritable(devs) {
    const grab = col => { const or = (col.outputReports || [])[0]; if (!or) return null; const it = (or.items || [])[0] || {}; return { reportId: or.reportId || 0, packLen: it.reportCount || 64, usagePage: col.usagePage, usage: col.usage }; };
    const pick = test => { for (const d of devs) for (const col of d.collections || []) { if (test(col)) { const g = grab(col); if (g) return Object.assign({ d }, g); } } return null; };
    // the per-key control interface is 0xFF68 usage 0x61 — pick it explicitly, NOT just the first output report (which can be the screen iface 0xFF67)
    return pick(c => c.usagePage === 0xFF68 && c.usage === 0x61) || pick(c => c.usagePage === 0xFF68) || pick(() => true);
  }
  function findScreen(devs) {
    let best = null;
    for (const d of devs) for (const col of d.collections || []) {
      for (const or of col.outputReports || []) {
        const bytes = (or.items || []).reduce((n, it) => n + (it.reportCount || 0) * ((it.reportSize || 8) / 8), 0);
        if (!best || bytes > best.bytes) best = { d, reportId: or.reportId || 0, bytes };
      }
    }
    return best;
  }

  function create(opts) {
    opts = opts || {};
    const noop = function () {};
    const log = opts.log || noop, setStatus = opts.setStatus || noop,
          stopHost = opts.stopHost || noop,
          beforeConnect = opts.beforeConnect || noop, beforeAutoReconnect = opts.beforeAutoReconnect || noop,
          onBound = opts.onBound || noop, onConnected = opts.onConnected || noop,
          onDisconnected = opts.onDisconnected || noop, onReconnected = opts.onReconnected || noop;
    let device = null, reportId = 0, packLen = 64;
    let _sendStalls = 0, _ackWaiter = null, _inRpts = 0;

    function buildPkt(cmd, len, off, chunk, aux, last) {
      const s = new Uint8Array(packLen);
      s[0] = 0xAA; s[1] = cmd; s[2] = len; s[3] = off & 0xFF; s[4] = (off >> 8) & 0xFF; s[5] = aux & 0xFF; s[6] = last ? 1 : 0; s.set(chunk, 8);
      return s;
    }
    function onInputReport(e) {                          // the board replies with a 0x55 ACK per write on this iface — read it AND gate the next write on it
      _inRpts++;
      const b = new Uint8Array(e.data.buffer);
      if (_inRpts === 1) log('board input reports: id=' + e.reportId + ' first=[' + Array.from(b.slice(0, 8)).map(x => x.toString(16).padStart(2, '0')).join(' ') + '…]', 'dim');
      if (b[0] === 0x55 && _ackWaiter) { const w = _ackWaiter; _ackWaiter = null; w(true); }
    }
    function waitAck(ms) { return new Promise(res => { _ackWaiter = res; setTimeout(() => { if (_ackWaiter === res) { _ackWaiter = null; res(false); } }, ms); }); }
    function noteStall() {
      if (++_sendStalls === 1 || _sendStalls % 20 === 0) log('board not keeping up (no ACK) — pacing/dropping to keep the loop alive', 'dim');
      if (_sendStalls >= 15) { log('board unresponsive — stopping. Unplug/replug it, then Connect → Start layers.', 'err'); stopHost(); }
    }
    async function sendFrame(flat, aux = 0) {
      if (!device) return false;
      const room = packLen - 8, n = Math.max(1, Math.ceil(flat.length / room));
      for (let c = 0; c < n; c++) {
        const off = c * room, chunk = flat.slice(off, off + room);
        const ack = waitAck(800);                         // arm the ACK waiter BEFORE the write so we can't miss it
        let timer; const wto = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__wstall__')), 800); });
        try {
          await Promise.race([device.sendReport(reportId, buildPkt(CMD, chunk.length, off, chunk, aux, c === n - 1)), wto]);
          clearTimeout(timer);
        } catch (e) {
          clearTimeout(timer);
          if (e && e.message === '__wstall__') { noteStall(); return false; }    // the write itself hung — drop frame, keep loop alive
          log('send failed: ' + e.message, 'err'); stopHost(); return false;     // genuine error (e.g. unplugged)
        }
        // WAIT for the board's 0x55 ACK before sending the next chunk. This pacing matches the board's FIFO drain
        // rate, which is the actual fix: firing chunks without waiting overran the FIFO and wedged the pipe.
        if (!(await ack)) { noteStall(); return false; }
        _sendStalls = 0;
      }
      return true;
    }

    async function bindDevice(devs, silent) {
      const w = findWritable(devs);
      if (!w) { if (!silent) setStatus('no FF68 control interface found — re-pick the 0xff68 entry', 'err'); return false; }
      device = w.d; reportId = w.reportId; packLen = w.packLen;
      if (!device.opened) await device.open();
      if (!device._inHooked) { device._inHooked = true; device.addEventListener('inputreport', onInputReport); }   // read the board's ACK/status reports + gate sends on them
      setStatus('connected: ' + device.productName + ' · reportId=' + reportId + ' · packLen=' + packLen, 'ok');
      log('connected: ' + device.productName + ' · iface 0x' + (w.usagePage || 0).toString(16) + '/0x' + (w.usage || 0).toString(16) + ' · reportId=' + reportId + ' · packLen=' + packLen + ' · ' + opts.ledCount + ' LEDs', 'ok');
      let screenDev = null, screenRid = 0;
      const sc = findScreen(devs);
      if (sc && sc.bytes >= 4096) {
        screenDev = sc.d; screenRid = sc.reportId; if (!screenDev.opened) await screenDev.open();
        log('screen interface bound (report ' + sc.bytes + 'B) — LCD upload available', 'ok');
      }
      else log('screen interface not in this grant — LCD upload disabled until you re-pick the keyboard', 'dim');
      onBound({ screen: screenDev, screenReportId: screenRid, control: device, controlReportId: reportId });
      return true;
    }
    async function connect() {
      if (!('hid' in navigator)) { setStatus('WebHID needs Chrome/Edge', 'err'); return; }
      try {
        await beforeConnect();   // daemon holds the device — make it release BEFORE we open, or the open fails
        const picked = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR }] });   // grant the whole keyboard so BOTH the control (0xFF68/0x61) AND screen (large report) interfaces are available (LCD upload needs the screen iface)
        if (!picked || !picked.length) { setStatus('connection cancelled', 'dim'); return; }   // respect Cancel — don't silently fall back to a previously-granted device
        const ok = await bindDevice(picked, false);
        if (ok) onConnected();   // tell the daemon's watchdog we're alive & holding the device
      } catch (e) { setStatus('connect failed: ' + e.message, 'err'); log('connect error: ' + e.message, 'err'); }
    }
    async function autoReconnect() {   // on page load: if the keyboard was granted in a past session, reconnect silently (keeps the convenience, without Cancel-means-connect)
      try { if (!('hid' in navigator)) return; const known = await navigator.hid.getDevices(); if (known && known.length) { await beforeAutoReconnect(); const ok = await bindDevice(known, true); if (ok) onConnected(); } } catch (_) { }
    }

    // Survive sleep/wake + unplug/replug: WebHID invalidates the device handle when the keyboard re-enumerates,
    // so the old handle goes stale (Start layers silently hits a dead device). Auto re-bind the fresh handle and
    // let the host resume layers if they were running — no manual reconnect/Start needed.
    if (typeof navigator !== 'undefined' && navigator.hid) {
      navigator.hid.addEventListener('disconnect', e => {
        if (!device || e.device !== device) return;            // only react to OUR control interface going away
        onDisconnected();                                      // host: capture running state, stop the loop, clear LCD handles, disable buttons
        device = null; reportId = 0;
        setStatus('keyboard disconnected (sleep/unplug) — reconnecting automatically…', 'dim');
        log('keyboard disconnected — waiting for it to come back…', 'dim');
      });
      navigator.hid.addEventListener('connect', async e => {
        if (device) return;                                     // already bound
        if (e.device && e.device.vendorId !== VENDOR) return;   // not our keyboard
        try { await beforeConnect(); } catch (_) { }
        const known = await navigator.hid.getDevices();
        const ok = await bindDevice(known, true);               // re-open the FRESH handle (control + screen)
        if (ok) onReconnected();
      });
    }

    return {
      connect, autoReconnect, bindDevice, sendFrame, buildPkt, findWritable, findScreen,
      resetStalls() { _sendStalls = 0; },
      get device() { return device; },
      get reportId() { return reportId; },
      get packLen() { return packLen; }
    };
  }

  return { create, findWritable, findScreen };
});
```

- [ ] **Step 2: Syntax-check**

Run: `node --check th108-hid.js`
Expected: no output (clean)

- [ ] **Step 3: Run the tests, verify they pass**

Run: `node --test th108-hid.test.js`
Expected: 6 pass, 0 fail

---

### Task 3: Rewire `th108-controller.html` onto the module

**Files:**
- Modify: `th108-controller.html`

- [ ] **Step 1: Load the module** — after the `th108-lcd.js` script tag:

```html
<script src="th108-lcd.js"></script>
<script src="th108-hid.js"></script>
```

- [ ] **Step 2: Replace the transport block (old lines 233–297)** — keep `log`/`setStatus` (page UI), delete `VENDOR/USAGE_PAGE/CMD`, `device/reportId/packLen`, `buildPkt`, `_sendStalls/_ackWaiter/_inRpts`, `onInputReport`, `waitAck`, `noteStall`, `sendFrame`, `findWritable`, `findScreen`; create the transport instance:

```js
// ===== WebHID transport — extracted to th108-hid.js (binds 0xFF68/0x61 + ACK-gated 0x32 streaming) =====
const out=document.getElementById('log');
function log(m,c=''){ const d=document.createElement('div'); if(c)d.className=c;
  d.textContent='['+new Date().toISOString().substr(11,12)+'] '+m; out.appendChild(d);
  while(out.childNodes.length>200) out.removeChild(out.firstChild); out.scrollTop=out.scrollHeight; }
function setStatus(s,c=''){ const e=document.getElementById('status'); e.textContent=s; e.className=c; }

let _wasRunning=false;   // layers were running when the keyboard went away (sleep/unplug) → resume on re-bind
const HID=TH108Hid.create({
  log, setStatus, ledCount:INDICES.length,
  stopHost:()=>{ stop(); },                                                                  // board unresponsive / fatal send error
  beforeConnect:async()=>{ await daemonPing(); if(DAEMON.present) await daemonYield(); },    // daemon holds the device — make it release BEFORE we open
  beforeAutoReconnect:async()=>{ if(DAEMON.present) await daemonYield(); },                  // page-load path: daemonPing() already ran
  onBound:devs=>{
    document.getElementById('start').disabled=false;
    if(gifFrames.length) document.getElementById('gifPlay').disabled=false;
    TH108LCD.setDevices(devs);
  },
  onConnected:()=>daemonHeartbeatStart(),   // tell the daemon's watchdog we're alive & holding the device
  onDisconnected:()=>{
    _wasRunning=running;
    if(running){ running=false; if(layerW) layerW.postMessage({stop:true}); }
    try{ TH108LCD.setDevices({}); }catch(_){ }          // the screen handle is stale too
    document.getElementById('start').disabled=true; document.getElementById('stop').disabled=true;
  },
  onReconnected:()=>{
    daemonHeartbeatStart();
    if(_wasRunning){ _wasRunning=false; start(); log('keyboard reconnected — layers resumed','ok'); }
    else log('keyboard reconnected','ok');
  }
});
```

- [ ] **Step 3: Delete `bindDevice`/`connect`/`autoReconnect` (old lines 312–342)** — now in the module. The daemon-handshake block (DAEMON const + helpers + beforeunload) stays.

- [ ] **Step 4: Delete the `navigator.hid` disconnect/connect listeners (old lines 1057–1082)** — now in the module (page side lives in `onDisconnected`/`onReconnected`).

- [ ] **Step 5: Point every remaining reference at `HID`** (exact substitutions):

| Site | Old | New |
|---|---|---|
| `layerTick` | `await sendFrame(flat)` | `await HID.sendFrame(flat)` |
| `start()` | `if(running\|\|!device) return;` | `if(running\|\|!HID.device) return;` |
| `start()` | `_sendStalls=0;` | `HID.resetStalls();` |
| `stop()` | `disabled=!device` | `disabled=!HID.device` |
| `stop()` | `await sendFrame(off)` | `await HID.sendFrame(off)` |
| `installFrames` | `gifPlay').disabled=!device` | `gifPlay').disabled=!HID.device` |
| `gifTick` | `await sendFrame(gifFlat(fr.rgb))` | `await HID.sendFrame(gifFlat(fr.rgb))` |
| `gifPlay()` | `if(!device\|\|...` | `if(!HID.device\|\|...` |
| `gifStopFn` | `disabled=!device` ×2, `await sendFrame(off)` | `!HID.device` ×2, `HID.sendFrame(off)` |
| connect button | `addEventListener('click',connect)` | `addEventListener('click',()=>HID.connect())` |
| boot | `daemonPing().then(autoReconnect)` | `daemonPing().then(()=>HID.autoReconnect())` |
| `applyOnboard` | `if(!device)` / `device.sendReport(reportId, buildPkt(0x23,…))` | `if(!HID.device)` / `HID.device.sendReport(HID.reportId, HID.buildPkt(0x23,…))` |
| `obBack` | `if(!device)` | `if(!HID.device)` |
| `__lcdHost.resumeLighting` | `device && !running` | `HID.device && !running` |
| reset button | `if(!device)` / `new Uint8Array(packLen)` / `device.sendReport(reportId, pkt)` | `if(!HID.device)` / `new Uint8Array(HID.packLen)` / `HID.device.sendReport(HID.reportId, pkt)` |

- [ ] **Step 6: Syntax-check the inline script** (the §1 one-liner)

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`
Expected: `OK`

- [ ] **Step 7: Grep for stragglers** — `sendFrame(`, `buildPkt(`, `bindDevice`, `findWritable`, `findScreen`, bare `device`/`reportId`/`packLen`/`_sendStalls` must have no remaining unqualified uses in the inline script.

---

### Task 4: Verify

- [ ] **Step 1: Full test suite**

Run: `node --test th108-engine.test.js th108-hid.test.js` → 16 pass.
Run: `cd th108-daemon; node --test` → 8 pass.

- [ ] **Step 2: Page smoke test (no hardware)** — start `node _serve.js`, open `http://localhost:8123/` in a browser (playwright/chrome-devtools MCP), confirm: page renders (layer cards, GIF panel, onboard panel), console shows no errors (a failed `/status`-style daemon probe is fine; WebHID connect is not exercised — no device grant in a fresh automation profile).

- [ ] **Step 3: Hardware parity glance** — user-side after commit: Connect → Start layers → type (reactive) → GIF play → onboard apply → LCD overlay opens → sleep/wake replug reconnect. Must look identical.

---

### Task 5: Commit

- [ ] **Step 1: Stage exactly the three files**

```powershell
git add th108-hid.js th108-hid.test.js th108-controller.html docs/superpowers/plans/2026-06-09-extract-th108-hid.md
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "refactor: extract WebHID transport from th108-controller.html into th108-hid.js (module #1 of the controller decomposition) — behavior-identical; adds node --test coverage for buildPkt/findWritable/findScreen"
```

(No Claude/Co-Authored-By trailer — hard user rule.)
