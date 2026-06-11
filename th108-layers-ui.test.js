// th108-layers-ui.test.js — unit tests for the pure parts of th108-layers-ui.js
// (layer persist serialization + the saved-settings overlay used by restore).
// Run: node --test th108-layers-ui.test.js   (no DOM / no hardware needed)
const test = require('node:test');
const assert = require('node:assert');
const LUI = require('./th108-layers-ui.js');

const mkLayer = over => Object.assign({
  name: 'L', enabled: true, type: 'background', opacity: 1, blend: 'normal', fps: 12,
  settings: { color: '#ffffff' },
  lastTick: 123, buf: new Uint8Array(3)            // runtime-only fields — must NOT persist
}, over);

// --- serializeLayers: exactly the 8 persisted fields, runtime state dropped ---
test('serializeLayers keeps exactly name/enabled/type/opacity/blend/fps/settings/collapsed', () => {
  const out = LUI.serializeLayers([mkLayer({ name: 'top', opacity: 0.5, fps: 24 })]);
  assert.deepEqual(out, [{ name: 'top', enabled: true, type: 'background', opacity: 0.5, blend: 'normal', fps: 24, settings: { color: '#ffffff' }, collapsed: false }]);
  assert.equal('lastTick' in out[0], false);
  assert.equal('buf' in out[0], false);
});

test('card collapse persists: serialize round-trips through overlayLayers', () => {
  const out = LUI.serializeLayers([mkLayer({ collapsed: true }), mkLayer()]);
  assert.equal(out[0].collapsed, true);
  assert.equal(out[1].collapsed, false);
  const layers = [mkLayer(), mkLayer({ collapsed: true })];
  LUI.overlayLayers(layers, out);
  assert.equal(layers[0].collapsed, true);            // restored from save
  assert.equal(layers[1].collapsed, false);           // saved false clears a stale flag
});

// --- serializeOrder: the th108_layerOrder "type:name" shape ---
test('serializeOrder emits type:name per layer, bottom→top array order', () => {
  const out = LUI.serializeOrder([mkLayer({ type: 'pattern', name: 'waves' }), mkLayer({ type: 'reactive', name: 'keys' })]);
  assert.deepEqual(out, ['pattern:waves', 'reactive:keys']);
});

// --- overlayLayers: in-place overlay of saved settings onto the default layers ---
test('overlayLayers overlays saved fields in place, preserving layer object identity', () => {
  const L = mkLayer();
  const layers = [L];
  LUI.overlayLayers(layers, [{ name: 'mine', enabled: false, type: 'gradient', opacity: 0.25, blend: 'add', fps: 9, settings: { colorA: '#ff0000' } }]);
  assert.equal(layers[0], L);                       // same object — restore overlays, never replaces
  assert.equal(L.name, 'mine');
  assert.equal(L.enabled, false);
  assert.equal(L.type, 'gradient');
  assert.equal(L.opacity, 0.25);
  assert.equal(L.blend, 'add');
  assert.equal(L.fps, 9);
  assert.deepEqual(L.settings, { colorA: '#ff0000' });
});

test('overlayLayers clamps any pre-cap saved fps to 30', () => {
  const layers = [mkLayer()];
  LUI.overlayLayers(layers, [{ fps: 60 }]);
  assert.equal(layers[0].fps, 30);
});

test('overlayLayers: opacity 0 is honored; missing enabled coerces false; falsy type/blend/fps keep defaults; non-object settings ignored', () => {
  const layers = [mkLayer()];
  LUI.overlayLayers(layers, [{ opacity: 0, type: '', blend: '', fps: 0, settings: 'junk' }]);
  const L = layers[0];
  assert.equal(L.opacity, 0);                       // o.opacity!=null → 0 is a real value
  assert.equal(L.enabled, false);                   // !!undefined — saved entries without enabled disable the layer (existing behavior)
  assert.equal(L.type, 'background');
  assert.equal(L.blend, 'normal');
  assert.equal(L.fps, 12);
  assert.deepEqual(L.settings, { color: '#ffffff' });
});

test('overlayLayers: non-array is a no-op; null entries skipped; extra saved entries beyond the layer count ignored', () => {
  const layers = [mkLayer({ name: 'a' }), mkLayer({ name: 'b' })];
  LUI.overlayLayers(layers, null);
  LUI.overlayLayers(layers, 'nope');
  assert.equal(layers[0].name, 'a');
  LUI.overlayLayers(layers, [null, { name: 'B2' }, { name: 'ghost' }]);
  assert.equal(layers[0].name, 'a');                // null entry → untouched (incl. enabled)
  assert.equal(layers[0].enabled, true);
  assert.equal(layers[1].name, 'B2');
  assert.equal(layers.length, 2);
});
