const test = require('node:test');
const assert = require('node:assert');
const E = require('./th108-engine.js');

// ===== Task 1: board map + colour helpers =====
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

// ===== Task 2: geometry + state model =====
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
  assert.equal(E.patParams(s).speed, 50);    // fresh pattern → default (PAT_DEFAULTS.speed), not 80
});

// ===== Task 3: renderers + compositor + orchestrators =====
test('flatEq compares frames', () => {
  assert.equal(E.flatEq([0,1,2], [0,1,2]), true);
  assert.equal(E.flatEq([0,1,2], [0,1,3]), false);
  assert.equal(E.flatEq([0,1,2], null), false);
});

test('composeFrame returns a flat [idx,r,g,b,…] frame for all LEDs', () => {
  // background fields are color/period/bgMin/bgMax (confirmed from th108-controller.html)
  const st = E.createState([{ name:'BG', enabled:true, type:'background', opacity:1, blend:'normal', fps:30,
                              settings:{ color:'#00ff00', period:2600, bgMin:50, bgMax:100 } }]);
  const flat = E.composeFrame(st, 1000);
  assert.equal(flat.length, E.NLED * 4);
  assert.equal(flat[0], E.INDICES[0]);            // first entry is an LED index
  // a solid green background → some channel non-zero somewhere
  assert.ok(flat.some((v, i) => i % 4 !== 0 && v > 0));
});

test('stampKey lights its LED in a reactive layer; releaseKey lets it fade', () => {
  // reactive fields are color/fade/mode (NOT fadeMs) — confirmed from th108-controller.html
  const st = E.createState([{ name:'RX', enabled:true, type:'reactive', opacity:1, blend:'normal', fps:60,
                             settings:{ color:'#ff0000', fade:300, mode:'single' } }]);
  E.stampKey(st, E.KEYMAP.KeyA);
  // pass a non-zero `now` so the per-layer fps interval gate fires (it never fires at now===lastTick===0,
  // exactly as in the controller). The key is held (down) so intensity is full regardless of `now`.
  const lit = E.composeFrame(st, 100);
  const o = E.INDICES.indexOf(E.KEYMAP.KeyA) * 4;
  assert.ok(lit[o+1] > 0, 'A key red channel should be lit right after press');
});

test('composeFrame applies global brightness (state.bri) without compounding', () => {
  const E = require('./th108-engine.js');
  // a pre-rendered layer with lastTick in the future skips renderLayer — composite reads L.rgb as-is
  const L = { enabled: true, type: 'pattern', opacity: 1, blend: 'normal', fps: 30, lastTick: 1e15,
              rgb: new Uint8Array(E.NLED * 3).fill(200), settings: {} };
  const state = { layers: [L] };
  const f1 = E.composeFrame(state, 0);
  assert.equal(f1[1], 200, 'no bri → untouched');
  state.bri = 0.5;
  const f2 = E.composeFrame(state, 0);
  assert.equal(f2[1], 100, 'bri 0.5 halves the output');
  const f3 = E.composeFrame(state, 0);
  assert.equal(f3[1], 100, 'second frame identical — no compounding');
  state.bri = 1;
  assert.equal(E.composeFrame(state, 0)[1], 200, 'bri 1 = untouched');
});

// ===== Individual-keys layer =====
test('individual layer paints chosen keys; replace blend keeps unpainted transparent', () => {
  const idxA = E.KEYMAP.KeyA, idxB = E.KEYMAP.KeyB;
  const st = E.createState([
    { name:'BG',   enabled:true, type:'background', opacity:1, blend:'normal',  fps:30,
      settings:{ color:'#00ff00', period:2600, bgMin:100, bgMax:100 } },
    { name:'Keys', enabled:true, type:'individual', opacity:1, blend:'replace', fps:30,
      settings:{ keys:{ [idxA]:'#ff0000' }, current:'#ff0000' } },
  ]);
  const flat = E.composeFrame(st, 100);
  const oA = E.INDICES.indexOf(idxA) * 4, oB = E.INDICES.indexOf(idxB) * 4;
  assert.ok(flat[oA+1] > 200 && flat[oA+2] < 60 && flat[oA+3] < 60, 'painted A is red over the background');
  assert.ok(flat[oB+2] > 0, 'unpainted B reveals the green background');
});

test('ensureSettings backfills individual fields', () => {
  const L = { type:'individual', settings:{} };
  E.ensureSettings(L);
  assert.deepEqual(L.settings.keys, {});
  assert.equal(L.settings.current, '#ff8c00');
});
