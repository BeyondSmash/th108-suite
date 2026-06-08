# TH108 Background Lighting Daemon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the user's configured controller lighting setup always-on in the background (reactive-anywhere), with all customization staying in the WebHID page, by sharing one rendering engine between the page and a Node daemon and handing the device back and forth automatically.

**Architecture:** Extract the controller's render/composite logic into a DOM-free `th108-engine.js` used by both the browser and the daemon. The daemon owns the keyboard, renders the saved config via the engine (ACK-gated `node-hid`), captures keys globally (uiohook), and serves the page + a tiny control API on `localhost:8123`. When the page opens it asks the daemon to release the device (`/yield`), customizes directly over WebHID, saves its config back, and on close the daemon re-grabs and runs it (`/resume`, with a heartbeat watchdog).

**Tech Stack:** Vanilla JS (UMD module, no build step), Node ≥18 (`node:test`, `node:http`), `node-hid`, `uiohook-napi`. Spec: [docs/superpowers/specs/2026-06-08-background-daemon-design.md](../specs/2026-06-08-background-daemon-design.md).

**Conventions for this repo (must follow):**
- Commits authored as `Beyon <you@example.com>`, **no Claude/Co-Authored-By** trailer. Use: `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "…"`.
- After editing `th108-controller.html`, syntax-check the script: `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const m=h.match(/<script>([\s\S]*)<\/script>/);new Function(m[1]);console.log('OK')"`.
- PowerShell host (win32); the Bash tool is available for POSIX commands. Don't commit Epomaker bundles.
- **Hardware steps can't be automated** — they're marked **[MANUAL/HW]** and require the physical keyboard. The executor pauses for the user to confirm these.

---

## File Structure

- **Create `th108-engine.js`** (repo root) — DOM-free engine: board map/geometry, renderers, compositor, state model. UMD (`window.TH108Engine` / `module.exports`). One responsibility: turn a layer config + reactive state + time into a frame.
- **Create `th108-engine.test.js`** (repo root) — `node --test` unit tests for the engine's pure functions.
- **Modify `th108-controller.html`** — load the engine via `<script src="th108-engine.js">`; delete the now-duplicated inline engine code; route rendering + reactive stamping through `TH108Engine`; keep all UI, WebHID transport, loop, and (new) the daemon handshake.
- **Create `th108-daemon/hid-transport.js`** — open the 0xFF68 interface, ACK-gated chunked `sendFrame`, reconnect loop. Injectable device for tests.
- **Create `th108-daemon/hid-transport.test.js`** — `node --test` for chunking + ACK-gating against a fake device.
- **Create `th108-daemon/server.js`** — `node:http` static file server + control API (`/status /yield /resume /heartbeat /config`) + heartbeat watchdog. Logic injectable for tests.
- **Create `th108-daemon/server.test.js`** — `node --test` for the control endpoints with a fake controller.
- **Rewrite `th108-daemon/daemon.js`** — orchestrator: wire engine + transport + server + uiohook + config persistence + render loop.
- **Modify `th108-daemon/th108-map.js`** — keep `UIOHOOK_TO_CODE`; re-export `KEYMAP`/`INDICES` from the engine so there's one source.
- **Modify `th108-daemon/package.json`** — add `"test": "node --test"`.
- **Modify `th108-daemon/start-hidden.vbs`, `install-autostart.ps1`, `README.md`** — autostart + docs for the new server/handshake.

---

## STAGE 1 — Extract the shared engine

### Task 1: Engine scaffold + board map + pure colour helpers

**Files:**
- Create: `th108-engine.js`
- Create: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**

Create `th108-engine.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const E = require('./th108-engine.js');

test('exposes the canonical board map', () => {
  assert.equal(E.NLED, E.INDICES.length);
  assert.equal(E.INDICES.length, 104);
  assert.equal(E.KEYMAP.Escape, 0);
  assert.equal(E.KEYMAP.Space, 83);
});

test('hexToRgb parses #RRGGBB', () => {
  assert.deepEqual(E.hexToRgb('#ff8f33'), [255, 143, 51]);
  assert.deepEqual(E.hexToRgb('#000000'), [0, 0, 0]);
});

test('hsv2rgb wraps hue and clamps', () => {
  const [r, g, b] = E.hsv2rgb(0, 1, 1);   // pure red
  assert.deepEqual([r, g, b], [255, 0, 0]);
});

test('patColorize c1 mode scales colour 1 by brightness', () => {
  const c1 = [200, 100, 50];
  assert.deepEqual(E.patColorize('c1', 0, 0.5, c1, [0,0,0], [0,0,0]), [100, 50, 25]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `Cannot find module './th108-engine.js'`.

- [ ] **Step 3: Create the engine scaffold with map + helpers**

Create `th108-engine.js`. Copy `KEYMAP` and `INDICES` **verbatim** from `th108-daemon/th108-map.js` (they are the canonical capture). Move `hexToRgb`, `hsv2rgb`, `patHash`, `patColorize` out of `th108-controller.html` (search the inline `<script>` for each `function`) into here unchanged.

```js
// th108-engine.js — DOM-free TH108 lighting engine, shared by the controller page and the daemon.
(function (root) {
  const KEYMAP = {/* paste verbatim from th108-daemon/th108-map.js */};
  const INDICES = [/* paste verbatim from th108-daemon/th108-map.js */];
  const NLED = INDICES.length;

  function hexToRgb(h){ return [parseInt(h.substr(1,2),16),parseInt(h.substr(3,2),16),parseInt(h.substr(5,2),16)]; }
  // … paste hsv2rgb, patHash, patColorize verbatim from the controller …

  const TH108Engine = { KEYMAP, INDICES, NLED, hexToRgb, hsv2rgb, patHash, patColorize };
  if (typeof module !== 'undefined' && module.exports) module.exports = TH108Engine;
  else root.TH108Engine = TH108Engine;
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS (4 tests). If `patColorize`/`hsv2rgb` signatures differ from the test, fix the **test** to match the real signatures copied from the controller (don't change working engine logic), then re-run.

- [ ] **Step 5: Commit**

```bash
git add th108-engine.js th108-engine.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "engine: scaffold th108-engine.js (board map + colour helpers) with node:test"
```

### Task 2: Geometry + state model (createState, ensureSettings, patParams, layers)

**Files:**
- Modify: `th108-engine.js`
- Modify: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**

Append to `th108-engine.test.js`:

```js
test('createState builds per-layer rgb buffers + reactive buffers', () => {
  const st = E.createState(E.defaultLayers());
  assert.ok(Array.isArray(st.layers) && st.layers.length >= 1);
  assert.equal(st.layers[0].rgb.length, E.NLED * 3);
  assert.equal(st.react.fg.length, 256);   // per-LED-index reactive buffers
  assert.equal(st.react.t.length, 256);
});

test('ensureSettings backfills missing pattern fields', () => {
  const L = { type:'pattern', settings:{} };
  E.ensureSettings(L);
  assert.equal(L.settings.pattern, 'rainbow');
  assert.equal(L.settings.scale, 10);
});

test('patParams namespaces per pattern and migrates flat values once', () => {
  const s = { pattern:'wave', speed:80 };
  const p = E.patParams(s);
  assert.equal(p.speed, 80);                 // migrated into the active pattern
  s.pattern = 'rainbow';
  assert.equal(E.patParams(s).speed, 50);    // fresh pattern → default, not 80
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `E.createState is not a function`.

- [ ] **Step 3: Move geometry + state model into the engine**

From `th108-controller.html` move (verbatim, then adapt globals→params): `keyCell`, `layerCell`, `PAT_DEFAULTS`, `patParams`, `ensureSettings`, and the default-layers array literal (turn it into a factory `defaultLayers()` returning fresh objects). Add `createState`:

```js
function defaultLayers(){
  return [ /* the 4 layer objects from the controller, WITHOUT rgb/lastTick (createState adds them) */ ];
}
function createState(configLayers){
  const layers = configLayers.map(L => {
    ensureSettings(L);
    return Object.assign({}, L, { rgb:new Uint8Array(NLED*3), lastTick:0, _clk:0, _lastNow:undefined });
  });
  return {
    layers,
    react: { fg:new Float32Array(256), t:new Float64Array(256).fill(-1e12),
             down:new Uint8Array(256), up:new Float64Array(256).fill(-1e12) },
    lastFlat:null, lastSent:0,
  };
}
```

Add all new names to the exported `TH108Engine` object: `keyCell, layerCell, PAT_DEFAULTS, patParams, ensureSettings, defaultLayers, createState`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS (7 tests). Adjust the test's expected defaults to match the controller's real `PAT_DEFAULTS` if they differ.

- [ ] **Step 5: Commit**

```bash
git add th108-engine.js th108-engine.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "engine: geometry + state model (createState/defaultLayers/patParams/ensureSettings)"
```

### Task 3: Renderers + compositor + composeFrame + reactive stamping

**Files:**
- Modify: `th108-engine.js`
- Modify: `th108-engine.test.js`

- [ ] **Step 1: Write the failing test**

Append to `th108-engine.test.js`:

```js
test('flatEq compares frames', () => {
  assert.equal(E.flatEq([0,1,2], [0,1,2]), true);
  assert.equal(E.flatEq([0,1,2], [0,1,3]), false);
  assert.equal(E.flatEq([0,1,2], null), false);
});

test('composeFrame returns a flat [idx,r,g,b,…] frame for all LEDs', () => {
  const st = E.createState([{ name:'BG', enabled:true, type:'background', opacity:1, blend:'normal', fps:30,
                              settings:{ color:'#00ff00', pulse:false } }]);
  const flat = E.composeFrame(st, 1000);
  assert.equal(flat.length, E.NLED * 4);
  assert.equal(flat[0], E.INDICES[0]);            // first entry is an LED index
  // a solid green background → some channel non-zero somewhere
  assert.ok(flat.some((v, i) => i % 4 !== 0 && v > 0));
});

test('stampKey lights its LED in a reactive layer; releaseKey lets it fade', () => {
  const st = E.createState([{ name:'RX', enabled:true, type:'reactive', opacity:1, blend:'normal', fps:60,
                             settings:{ color:'#ff0000', fadeMs:300, mode:'single' } }]);
  E.stampKey(st, E.KEYMAP.KeyA);
  const lit = E.composeFrame(st, 0);
  const o = E.INDICES.indexOf(E.KEYMAP.KeyA) * 4;
  assert.ok(lit[o+1] > 0, 'A key red channel should be lit right after press');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test th108-engine.test.js`
Expected: FAIL — `E.composeFrame is not a function`.

- [ ] **Step 3: Move renderers + compositor into the engine**

Move from `th108-controller.html` (verbatim, then thread `state` instead of module globals — replace references to the global `layers`, `reactFg/reactT/reactDown/reactUp`, `acc`, and `fpsCap()` with `state.layers`, `state.react.*`, a local accumulator, and the constant cap 30): `renderBackground`, `renderReactive`, `renderGradient`, `renderPattern`, `applyAdjust`, `layerNow`, `composite`, `renderLayer`, `flatEq`. Then add the orchestrators:

```js
const SEND_FPS_CAP = 30;
function composeFrame(state, now){
  for (const L of state.layers){
    if (L.enabled && now - L.lastTick >= 1000 / Math.max(1, Math.min(SEND_FPS_CAP, L.fps))){
      renderLayer(L, now, state);   // renderLayer/renderReactive read state.react; layerNow uses L._clk/_lastNow
      L.lastTick = now;
    }
  }
  return composite(state);          // composite reads state.layers → returns flat [idx,r,g,b,…]
}
function stampKey(state, ledIndex){ state.react.down[ledIndex]=1; state.react.t[ledIndex]=performance.now?performance.now():now(); state.react.up[ledIndex]=-1e12; }
function releaseKey(state, ledIndex){ state.react.down[ledIndex]=0; state.react.up[ledIndex]=(performance.now?performance.now():Date.now()); }
```

Note: `renderReactive` uses real wall-clock time. In the browser that's `performance.now()`; in Node there's no DOM `performance` global before Node 16, but Node ≥18 has a global `performance`. Use `performance.now()` directly in the engine (available in both). Add `composeFrame, stampKey, releaseKey, flatEq` to exports.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test th108-engine.test.js`
Expected: PASS (10 tests). Fix test inputs to match the real `settings` field names used by each renderer (open the controller to confirm e.g. background's pulse/color field names, reactive's `fadeMs`/`mode`).

- [ ] **Step 5: Commit**

```bash
git add th108-engine.js th108-engine.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "engine: renderers + compositor + composeFrame/stampKey/releaseKey (unit-tested)"
```

### Task 4: Refactor the controller to use the engine — **parity gate**

**Files:**
- Modify: `th108-controller.html`

- [ ] **Step 1: Load the engine and delete the inline duplicates**

Add before the inline `<script>`: `<script src="th108-engine.js"></script>`. Delete from the inline script every function now in the engine (map consts, `hexToRgb`, `hsv2rgb`, `patHash`, `patColorize`, `keyCell`, `layerCell`, `PAT_DEFAULTS`, `patParams`, `ensureSettings`, renderers, `applyAdjust`, `layerNow`, `composite`, `renderLayer`, `flatEq`, the default-layers literal). Replace internal references with `TH108Engine.*` (e.g. `const {KEYMAP, INDICES, NLED, hexToRgb} = TH108Engine;` near the top; build the layer state via `TH108Engine.createState`/`defaultLayers`; the loop calls `TH108Engine.composeFrame(state, now)`).

- [ ] **Step 2: Rewire the loop + reactive listeners to the engine state**

The controller's worker loop keeps its scheduling, ACK-gated WebHID `sendFrame`, and suppression — but now: `const flat = TH108Engine.composeFrame(state, now); if(!TH108Engine.flatEq(flat, state.lastFlat) || now-state.lastSent>=1000){ if(await sendFrame(flat)){ state.lastFlat=flat; state.lastSent=now; } }`. Change the DOM key handlers to `window.addEventListener('keydown', e=>{ const i=TH108Engine.KEYMAP[e.code]; if(i!==undefined && !e.repeat) TH108Engine.stampKey(state,i); })` and the keyup equivalent → `releaseKey`. Layer-card UI reads/writes `state.layers[n].settings` (unchanged shapes).

- [ ] **Step 3: Syntax-check**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const m=h.match(/<script>([\s\S]*)<\/script>/);new Function(m[1]);console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: [MANUAL/HW] Parity verification (the gate)**

Serve and open the page (`node _serve.js` → `http://localhost:8123/th108-controller.html`). Connect, Start layers. Confirm on the physical keyboard, identical to before the refactor: color-fountain renders the same; reactive keypresses light + fade; blend modes/opacity/adjust behave the same; switching patterns keeps per-pattern values; no `send stalled`. **Do not proceed to Stage 2 until this matches.** If anything differs, the extraction changed behavior — diff against the previous commit and fix in the engine.

- [ ] **Step 5: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "controller: route rendering through shared th108-engine.js (parity-verified on hardware)"
```

---

## STAGE 2 — Daemon core (engine + ACK-gated HID + reactive)

### Task 5: ACK-gated HID transport with reconnect

**Files:**
- Create: `th108-daemon/hid-transport.js`
- Create: `th108-daemon/hid-transport.test.js`

- [ ] **Step 1: Write the failing test (fake device, no hardware)**

Create `th108-daemon/hid-transport.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { makeSender } = require('./hid-transport.js');

// fake node-hid device: records writes, fires a 0x55 ACK 'data' event after each write
function fakeDevice(){
  const handlers = {};
  return {
    writes: [],
    on(ev, cb){ (handlers[ev] ||= []).push(cb); },
    write(arr){ this.writes.push(arr); queueMicrotask(()=>(handlers.data||[]).forEach(cb=>cb(Buffer.from([0x55, arr[2]||0x32])))); return arr.length; },
    close(){ this.closed = true; },
  };
}

test('sendFrame chunks into 56-byte payloads and waits for each ACK', async () => {
  const dev = fakeDevice();
  const send = makeSender(dev, { packLen:64, cmd:0x32, ackTimeoutMs:200 });
  const flat = []; for (let k=0;k<104;k++) flat.push(k,1,2,3);   // 416 entries
  const ok = await send(flat);
  assert.equal(ok, true);
  assert.equal(dev.writes.length, Math.ceil(416/56));            // 8 chunks
  assert.equal(dev.writes[0][1], 0x00);                          // leading reportId 0 (Windows)
});

test('sendFrame returns false (no throw) when ACK never arrives', async () => {
  const dev = { on(){}, write(){ return 0; }, close(){} };       // never ACKs
  const send = makeSender(dev, { packLen:64, cmd:0x32, ackTimeoutMs:50 });
  const ok = await send([0,1,2,3]);
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd th108-daemon && node --test hid-transport.test.js`
Expected: FAIL — `Cannot find module './hid-transport.js'`.

- [ ] **Step 3: Implement the transport**

Create `th108-daemon/hid-transport.js`:

```js
const HID = require('node-hid');
const VENDOR = 0x0C45, USAGE_PAGE = 0xFF68, USAGE = 0x61;

function findPath(){
  const list = HID.devices();
  const m = list.find(d => d.vendorId===VENDOR && d.usagePage===USAGE_PAGE && d.usage===USAGE)
         || list.find(d => d.vendorId===VENDOR && d.usagePage===USAGE_PAGE);
  return m ? m.path : null;
}

// ACK-gated sender for one open device. Resolves false on stall (never throws → loop survives).
function makeSender(device, { packLen=64, cmd=0x32, ackTimeoutMs=800 } = {}){
  let ackWaiter = null;
  device.on('data', (buf) => { if (buf && buf[0]===0x55 && ackWaiter){ const w=ackWaiter; ackWaiter=null; w(true); } });
  const waitAck = () => new Promise(res => { ackWaiter = res; setTimeout(()=>{ if(ackWaiter===res){ ackWaiter=null; res(false); } }, ackTimeoutMs); });
  return async function sendFrame(flat){
    const room = packLen - 8, n = Math.max(1, Math.ceil(flat.length/room));
    for (let c=0;c<n;c++){
      const off=c*room, chunk=flat.slice(off, off+room), last=c===n-1;
      const pkt = Buffer.alloc(packLen);
      pkt[0]=0xAA; pkt[1]=cmd; pkt[2]=chunk.length; pkt[3]=off&0xFF; pkt[4]=(off>>8)&0xFF; pkt[5]=0; pkt[6]=last?1:0;
      for (let i=0;i<chunk.length;i++) pkt[8+i]=chunk[i];
      const ack = waitAck();
      try { device.write([0x00, ...pkt]); } catch { return false; }
      if (!(await ack)) return false;     // stalled → drop frame, caller keeps looping / reconnects
    }
    return true;
  };
}

module.exports = { findPath, openDevice: (p)=>new HID.HID(p), makeSender, VENDOR, USAGE_PAGE, USAGE };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd th108-daemon && node --test hid-transport.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add th108-daemon/hid-transport.js th108-daemon/hid-transport.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "daemon: ACK-gated node-hid transport (chunking + ACK gate, fake-device tested)"
```

### Task 6: Daemon render loop + config + uiohook reactive

**Files:**
- Rewrite: `th108-daemon/daemon.js`
- Modify: `th108-daemon/th108-map.js`
- Modify: `th108-daemon/package.json`

- [ ] **Step 1: Make `th108-map.js` re-export the engine's map (one source)**

Edit `th108-daemon/th108-map.js` — replace the inline `KEYMAP`/`INDICES` definitions with a re-export, keep `UIOHOOK_TO_CODE`:

```js
const { KEYMAP, INDICES } = require('../th108-engine.js');
const UIOHOOK_TO_CODE = { /* unchanged */ };
module.exports = { KEYMAP, INDICES, UIOHOOK_TO_CODE };
```

- [ ] **Step 2: Add the test script to package.json**

Edit `th108-daemon/package.json` `scripts` → add `"test": "node --test"`.

- [ ] **Step 3: Rewrite `daemon.js` (engine + transport + uiohook + reconnect + config)**

```js
const fs = require('fs');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const E = require('../th108-engine.js');
const T = require('./hid-transport.js');
const { KEYMAP, UIOHOOK_TO_CODE } = require('./th108-map.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FPS = 30;

function loadConfig(){
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}

let state = null, device = null, send = null, paused = false, timer = null;
function rebuildState(){ const cfg = loadConfig(); state = cfg ? E.createState(cfg) : null; }
rebuildState();

// uiohook keycode -> LED index, via UIOHOOK_TO_CODE -> KeyboardEvent.code -> KEYMAP
const UIO2IDX = {};
for (const [name, code] of Object.entries(UIOHOOK_TO_CODE)){ const kc = UiohookKey[name], idx = KEYMAP[code]; if (kc!==undefined && idx!==undefined) UIO2IDX[kc] = idx; }
uIOhook.on('keydown', e => { if (state){ const i = UIO2IDX[e.keycode]; if (i!==undefined) E.stampKey(state, i); } });
uIOhook.on('keyup',   e => { if (state){ const i = UIO2IDX[e.keycode]; if (i!==undefined) E.releaseKey(state, i); } });
uIOhook.start();

function openIfPossible(){
  if (device || paused) return;
  const p = T.findPath(); if (!p) return;
  try { device = T.openDevice(p); send = T.makeSender(device, { ackTimeoutMs:800 }); console.log('✓ device open'); }
  catch (e){ device = null; send = null; }
}

async function tick(){
  if (!paused){
    openIfPossible();
    if (device && send && state){
      const now = performance.now();
      const flat = E.composeFrame(state, now);
      if (!E.flatEq(flat, state.lastFlat) || now - state.lastSent >= 1000){
        const ok = await send(flat);
        if (ok){ state.lastFlat = flat; state.lastSent = now; }
        else { try { device.close(); } catch {} device = null; send = null; }   // stall → reconnect next tick
      }
    }
  }
}
timer = setInterval(() => { tick().catch(()=>{}); }, Math.round(1000/FPS));

// control hooks used by the server (Stage 3) + clean shutdown
const control = {
  yield(){ paused = true; if (device){ try { device.close(); } catch {} device = null; send = null; } },
  resume(){ rebuildState(); paused = false; },
  saveConfig(cfg){ fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg)); if (paused) {} else rebuildState(); },
  status(){ return { running:true, paused, deviceConnected: !!device, fps: FPS }; },
};
module.exports = { control };

function shutdown(){ try { clearInterval(timer); } catch {} try { if (device){ const off=[]; E.INDICES.forEach(i=>off.push(i,0,0,0)); send && send(off); device.close(); } } catch {} try { uIOhook.stop(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

console.log('▶ TH108 daemon running (config:', loadConfig() ? 'loaded' : 'none yet', ')');
```

- [ ] **Step 4: [MANUAL/HW] Verify with a hand-written config**

Copy a config: in the browser console on the controller page run `copy(localStorage.getItem('th108_layers'))`, paste into `th108-daemon/config.json`. Then `cd th108-daemon && node daemon.js`. Expected: the board shows your exact setup; **focus another app (VSCode) and type — keys light**; unplug/replug → lighting resumes within a couple seconds; runs for minutes with no stall. Ctrl+C → board clears.

- [ ] **Step 5: Commit**

```bash
git add th108-daemon/daemon.js th108-daemon/th108-map.js th108-daemon/package.json
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "daemon: full-parity background runtime via shared engine (config.json, reconnect, uiohook reactive)"
```

---

## STAGE 3 — Control server + page handshake

### Task 7: Control API + static server + watchdog

**Files:**
- Create: `th108-daemon/server.js`
- Create: `th108-daemon/server.test.js`

- [ ] **Step 1: Write the failing test (fake control, no hardware)**

Create `th108-daemon/server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');

function fakeControl(){ return { calls:[], _paused:false,
  yield(){ this.calls.push('yield'); this._paused=true; },
  resume(){ this.calls.push('resume'); this._paused=false; },
  saveConfig(c){ this.calls.push('save'); this.saved=c; },
  status(){ return { running:true, paused:this._paused, deviceConnected:true, fps:30 }; } }; }

async function call(server, method, path, body){
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers:{'content-type':'application/json'}, body: body && JSON.stringify(body) });
  return { code: res.status, json: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}

test('control endpoints drive the controller + watchdog auto-resumes', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: __dirname, port: 0, watchdogMs: 120 });
  await server.listening;
  assert.equal((await call(server,'GET','/status')).json.running, true);
  await call(server,'POST','/yield'); assert.equal(ctl._paused, true);
  await call(server,'POST','/config', [{ name:'X' }]); assert.deepEqual(ctl.saved, [{ name:'X' }]);
  await new Promise(r => setTimeout(r, 200));            // no heartbeats → watchdog fires
  assert.ok(ctl.calls.includes('resume'), 'watchdog should auto-resume after silence');
  server.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd th108-daemon && node --test server.test.js`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 3: Implement the server**

Create `th108-daemon/server.js`:

```js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml' };

function createServer({ control, root, port = 8123, watchdogMs = 5000 }){
  let lastBeat = Date.now(), yielded = false, wd = null;
  function armWatchdog(){ clearInterval(wd); wd = setInterval(() => { if (yielded && Date.now()-lastBeat > watchdogMs){ control.resume(); yielded=false; } }, Math.max(50, watchdogMs/4)); }
  function readBody(req){ return new Promise(res => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>res(b)); }); }
  const send = (res, code, obj) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); };

  const srv = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
    try {
      if (req.method==='GET' && u==='/status') return send(res, 200, control.status());
      if (req.method==='POST' && u==='/yield'){ control.yield(); yielded=true; lastBeat=Date.now(); armWatchdog(); return send(res, 200, {ok:true}); }
      if (req.method==='POST' && u==='/resume'){ control.resume(); yielded=false; return send(res, 200, {ok:true}); }
      if (req.method==='POST' && u==='/heartbeat'){ lastBeat=Date.now(); return send(res, 200, {ok:true}); }
      if (req.method==='POST' && u==='/config'){ const b=await readBody(req); let cfg; try{ cfg=JSON.parse(b); }catch{ return send(res,400,{error:'bad json'}); } control.saveConfig(cfg); return send(res, 200, {ok:true}); }
      // static
      const rel = u==='/' ? '/th108-controller.html' : u;
      const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (req.method==='GET' && fs.existsSync(file) && fs.statSync(file).isFile()){
        res.writeHead(200, {'content-type': MIME[path.extname(file)] || 'application/octet-stream'});
        return fs.createReadStream(file).pipe(res);
      }
      send(res, 404, { error:'not found' });
    } catch (e){ send(res, 500, { error: String(e&&e.message||e) }); }
  });

  const server = { port, close: () => { clearInterval(wd); srv.close(); } };
  server.listening = new Promise(r => srv.listen(port, '127.0.0.1', () => { server.port = srv.address().port; r(); }));
  srv.on('error', e => { if (e.code==='EADDRINUSE'){ console.error(`✗ port ${port} in use (stale _serve.js or another daemon?). Stop it and retry.`); process.exit(1); } });
  return server;
}
module.exports = { createServer };
```

The daemon page is served from `root` = the **repo root** (one level up from `th108-daemon/`) so `th108-controller.html`, `th108-engine.js`, `th108-media-lib.js` resolve.

- [ ] **Step 4: Run to verify it passes**

Run: `cd th108-daemon && node --test server.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add th108-daemon/server.js th108-daemon/server.test.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "daemon: control API + static server + heartbeat watchdog (tested)"
```

### Task 8: Wire the server into the daemon

**Files:**
- Modify: `th108-daemon/daemon.js`

- [ ] **Step 1: Start the server with the control object**

At the end of `daemon.js`, after `module.exports = { control }`, add:

```js
const { createServer } = require('./server.js');
const server = createServer({ control, root: path.join(__dirname, '..'), port: 8123 });
server.listening.then(() => console.log(`✓ serving controller + control API on http://localhost:${server.port}`));
```

Update `control.saveConfig` so that when **not** paused it also `rebuildState()` (already does) — confirm yielded/paused stays correct across yield→save→resume.

- [ ] **Step 2: [MANUAL/HW] Verify the daemon serves the page and holds the device**

Run `cd th108-daemon && node daemon.js`. Browse `http://localhost:8123/` → controller loads. Board shows your config; reactive works in other apps. Leave it running for Task 9.

- [ ] **Step 3: Commit**

```bash
git add th108-daemon/daemon.js
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "daemon: serve controller + control API on :8123"
```

### Task 9: Controller-side auto-yield handshake

**Files:**
- Modify: `th108-controller.html`

- [ ] **Step 1: Add the daemon-handshake helper**

In the inline script add a small client. On load, `GET /status`; remember `daemonPresent`. The connect path: **if** the daemon is present, `await fetch('/yield',{method:'POST'})` **before** `navigator.hid` open; while connected, `setInterval(()=>fetch('/heartbeat',{method:'POST'}),3000)`; whenever layers change (reuse the existing debounced save) also `fetch('/config',{method:'POST',headers:{'content-type':'application/json'},body:localStorage.getItem('th108_layers')})`; on disconnect/`beforeunload`, `navigator.sendBeacon('/resume')` (and clear the heartbeat interval). Endpoints are same-origin when the page is opened from `http://localhost:8123` (served by the daemon), so no CORS.

```js
const DAEMON = { present:false, hb:null };
async function daemonPing(){ try{ const r=await fetch('/status',{cache:'no-store'}); DAEMON.present = r.ok; }catch{ DAEMON.present=false; } }
async function daemonYield(){ if(DAEMON.present){ try{ await fetch('/yield',{method:'POST'}); }catch{} } }
function daemonHeartbeatStart(){ if(DAEMON.present && !DAEMON.hb) DAEMON.hb=setInterval(()=>{ navigator.sendBeacon ? navigator.sendBeacon('/heartbeat') : fetch('/heartbeat',{method:'POST'}); },3000); }
function daemonHeartbeatStop(){ clearInterval(DAEMON.hb); DAEMON.hb=null; }
function daemonPushConfig(){ if(DAEMON.present){ try{ fetch('/config',{method:'POST',headers:{'content-type':'application/json'},body:localStorage.getItem('th108_layers')||'[]'}); }catch{} } }
function daemonResume(){ if(DAEMON.present){ navigator.sendBeacon ? navigator.sendBeacon('/resume') : fetch('/resume',{method:'POST',keepalive:true}); } }
window.addEventListener('beforeunload', ()=>{ daemonHeartbeatStop(); daemonResume(); });
```

- [ ] **Step 2: Hook it into connect/disconnect + config save**

In `connect()`: `await daemonPing(); await daemonYield();` **before** `navigator.hid.requestDevice`/`bindDevice`; after a successful connect call `daemonHeartbeatStart()`. In `scheduleSaveLayers` (the existing debounced saver), after writing localStorage also call `daemonPushConfig()`. Add a "Hand back to daemon" affordance: when disconnecting (or on the existing stop/disconnect path) call `daemonHeartbeatStop(); daemonResume();`. Call `daemonPing()` once on load to set `DAEMON.present` (so `autoReconnect()` knows to yield first if the daemon holds the device).

- [ ] **Step 3: Syntax-check**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const m=h.match(/<script>([\s\S]*)<\/script>/);new Function(m[1]);console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: [MANUAL/HW] Verify the full handoff**

With the daemon running and serving, open `http://localhost:8123/`: the board hands to the page (Connect works — no conflict), edit a layer → close the tab → within ~1 s the daemon resumes showing your edit. Kill the page abruptly (close window) → daemon re-grabs within ~5 s (watchdog). Reopen → yields again cleanly.

- [ ] **Step 5: Commit**

```bash
git add th108-controller.html
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "controller: auto-yield handshake with the daemon (yield/heartbeat/config/resume)"
```

---

## STAGE 4 — Autostart + docs

### Task 10: Autostart scripts + daemon README

**Files:**
- Modify: `th108-daemon/start-hidden.vbs`, `th108-daemon/install-autostart.ps1`, `th108-daemon/README.md`

- [ ] **Step 1: Confirm the hidden launcher runs `daemon.js` from the daemon dir**

`start-hidden.vbs` should `cd` to the daemon folder and run `node daemon.js` with no window. Verify the path is correct post-rewrite (it already launches the daemon; only confirm the working dir so `../th108-engine.js` and `config.json` resolve).

```vbs
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node daemon.js", 0, False
```

- [ ] **Step 2: Update the README**

Document: what the daemon does (always-on parity + reactive-anywhere), `npm install` once, that it now **serves the controller at `http://localhost:8123`** (use that instead of `_serve.js`), the auto-yield behavior (just open the page to customize; close it to hand back), `config.json` is written by the page automatically, `npm test` runs the unit tests, and `install-autostart.ps1` for login startup.

- [ ] **Step 3: [MANUAL/HW] Verify autostart**

Run `install-autostart.ps1`, reboot/re-login. Expected: lighting + reactive live with no manual step; `http://localhost:8123/` opens the controller.

- [ ] **Step 4: Commit**

```bash
git add th108-daemon/start-hidden.vbs th108-daemon/install-autostart.ps1 th108-daemon/README.md
git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "daemon: autostart launcher + README for the server/handshake workflow"
```

---

## Self-Review notes (for the executor)
- **Field-name accuracy:** the engine tests use representative `settings` field names (`color`, `pulse`, `fadeMs`, `mode`). Before running each engine test, open `th108-controller.html` and confirm the real field names each renderer reads; fix the **test** to match (never weaken working render logic to satisfy a guessed test).
- **`performance.now()` in Node:** available as a global in Node ≥18 — the engine uses it directly for reactive timing on both sides. If targeting older Node, add `const { performance } = require('node:perf_hooks')` at the top of the engine's Node branch.
- **Parity gate (Task 4 Step 4) is a hard stop** — Stages 2-4 assume the engine renders identically to the old controller.
- **Media layers:** the daemon's `composeFrame` will skip `type:'media'` (engine `renderMedia` can be a no-op in Node) — that's intended for v1.
