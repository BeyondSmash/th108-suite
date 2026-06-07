// TH108 V2 PRO always-on lighting daemon.
// Pulsing-cyan background + keypress-reactive yellow-orange, computed host-side and streamed
// over raw HID (node-hid) to the 0xFF68 control interface. A global keyboard hook (uiohook-napi)
// captures keypresses system-wide, so the reactive layer works in ANY app — no browser tab needed.

const HID = require('node-hid');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { KEYMAP, INDICES, UIOHOOK_TO_CODE } = require('./th108-map');

const VENDOR = 0x0C45, USAGE_PAGE = 0xFF68, USAGE = 0x61, CMD = 0x32, PACKLEN = 64;
const FPS = 30;
const DISCOVER = !!process.env.DISCOVER;

// ----- tunables (env-overridable) -----
const P = {
  periodMs: +(process.env.PERIOD || 2600),     // background pulse period
  bgMin:    +(process.env.BG_MIN || 0.12),     // background min brightness 0..1
  bgMax:    +(process.env.BG_MAX || 0.55),     // background max brightness 0..1
  fadeMs:   +(process.env.FADE   || 380),      // key flash fade time
  bg:  (process.env.BG  || '0,255,255').split(',').map(Number),   // background colour (cyan)
  key: (process.env.KEY || '255,140,0').split(',').map(Number),   // keypress colour (orange)
};

// ----- open the control interface -----
function openDevice() {
  const list = HID.devices();
  const match = list.find(d => d.vendorId === VENDOR && d.usagePage === USAGE_PAGE && d.usage === USAGE)
             || list.find(d => d.vendorId === VENDOR && d.usagePage === USAGE_PAGE);
  if (!match) {
    console.error('✗ TH108 control interface (vendor 0x0C45, usagePage 0xFF68) not found.');
    console.error('  Make sure the keyboard is plugged in and no other app (browser tab / stock software) is streaming to it.');
    process.exit(1);
  }
  console.log(`✓ opening "${match.product}"  path=${match.path}`);
  return new HID.HID(match.path);
}
const device = openDevice();

// ----- frame writer: cmd 0x32, 56-byte payload chunks, leading reportId 0 (Windows) -----
function sendFrame(flat) {
  const room = PACKLEN - 8;
  const n = Math.max(1, Math.ceil(flat.length / room));
  for (let c = 0; c < n; c++) {
    const off = c * room;
    const chunk = flat.slice(off, off + room);
    const last = c === n - 1;
    const pkt = Buffer.alloc(PACKLEN);
    pkt[0] = 0xAA; pkt[1] = CMD; pkt[2] = chunk.length;
    pkt[3] = off & 0xFF; pkt[4] = (off >> 8) & 0xFF; pkt[5] = 0; pkt[6] = last ? 1 : 0;
    for (let i = 0; i < chunk.length; i++) pkt[8 + i] = chunk[i];
    device.write([0x00, ...pkt]);
  }
}

// ----- effect state -----
const fg = new Float32Array(256);   // per-LED-index flash intensity (0..1), decays each frame
let last = Date.now(), t0 = Date.now();

function renderFrame() {
  const now = Date.now(), dt = now - last; last = now;
  const dec = dt / P.fadeMs;
  for (let i = 0; i < fg.length; i++) if (fg[i] > 0) { fg[i] -= dec; if (fg[i] < 0) fg[i] = 0; }

  const b = P.bgMin + (P.bgMax - P.bgMin) * (0.5 + 0.5 * Math.sin((now - t0) / P.periodMs * 2 * Math.PI));
  const [br, bgc, bb] = P.bg, [fr, fgc, fb] = P.key;
  const flat = new Array(INDICES.length * 4);
  for (let k = 0; k < INDICES.length; k++) {
    const idx = INDICES[k];
    let r = br * b, g = bgc * b, bl = bb * b;
    const it = fg[idx] || 0;
    if (it > 0) { r += (fr - r) * it; g += (fgc - g) * it; bl += (fb - bl) * it; }
    const o = k * 4; flat[o] = idx; flat[o + 1] = r | 0; flat[o + 2] = g | 0; flat[o + 3] = bl | 0;
  }
  sendFrame(flat);
}
const timer = setInterval(renderFrame, Math.round(1000 / FPS));

// ----- global keyboard hook: uiohook keycode -> LED index -----
const UIO2IDX = {};
let mapped = 0;
for (const [uioName, code] of Object.entries(UIOHOOK_TO_CODE)) {
  const kc = UiohookKey[uioName];
  const idx = KEYMAP[code];
  if (kc === undefined || idx === undefined) continue;
  UIO2IDX[kc] = idx; mapped++;
}
console.log(`✓ mapped ${mapped} keys to LEDs`);

uIOhook.on('keydown', (e) => {
  const idx = UIO2IDX[e.keycode];
  if (idx !== undefined) fg[idx] = 1;            // stamp full intensity; render loop fades it
  else if (DISCOVER) console.log('· unmapped keycode', e.keycode);
});
uIOhook.start();

console.log('▶ TH108 daemon running — pulsing cyan + reactive orange, type anywhere. Ctrl+C to stop.');
if (DISCOVER) console.log('  DISCOVER mode: unmapped keycodes will be logged — press the keys that don\'t react and send me the numbers.');

// ----- clean shutdown: black-out the board, release hook -----
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  try { clearInterval(timer); } catch {}
  try { const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0)); sendFrame(off); } catch {}
  try { device.close(); } catch {}
  try { uIOhook.stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
