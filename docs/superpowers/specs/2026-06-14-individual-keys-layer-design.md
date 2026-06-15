# Individual-Keys Color Layer — Design

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Goal:** A new compositor layer type that lets the user paint **explicit per-key colors** by hand, edited on an interactive on-screen keyboard. It composites with the rest of the layer stack like any other layer (opacity / blend / adjust), persists with the config, and renders identically whether the page or the daemon drives.

---

## 1. Where it plugs in

The lighting compositor (`th108-engine.js`) renders a stack of layers, each `renderLayer(L, now, state)` writing into a per-key buffer `L.rgb` (`Uint8Array(NLED*3)`, slot `k` → LED `INDICES[k]`), then `composite()` blends them bottom-to-top into the flat `[idx,r,g,b,…]` frame. Layers are configured in `th108-layers-ui.js` (one card each) and persisted to `localStorage['th108_layers']`, mirrored to the daemon's `config.json` via the debounced `pushConfig()`.

The new layer is **`type: 'individual'`**. The engine already has a **`replace` blend mode** (per-key overlay: non-black keys replace the layers below, black keys are transparent) — exactly the semantics we want, so no new blend math is needed.

Three areas change:
1. **`th108-engine.js`** — the `individual` layer type: settings shape, `renderKeys`, default settings, a unit test.
2. **`th108-layers-ui.js`** — the layer-card body (controls) + the "Show Keyboard" board panel and its placement.
3. **A new interactive board component** — a fresh factory that reuses the Pick-a-Key board's *look + geometry* (not the binder's `KBOARD` instance), with the marquee/selection painting model.

The hardware-critical binder (`th108-binder.js` / `KBOARD`) is **not touched**.

---

## 2. Engine — the `individual` layer type

**Settings shape:**
```
settings: {
  keys: { [ledIndex:number]: '#rrggbb' },   // only PAINTED keys; absent = unpainted = transparent
  current: '#rrggbb'                         // the active paint/swatch color (persisted)
  // + the shared adjust block (bri/sat/con/gam/rot) and opacity/blend/fps like every layer
}
```

**`renderKeys(L)`** (new, dispatched from `renderLayer` for `type==='individual'`):
```
for k in 0..NLED-1:
  idx = INDICES[k]
  c = L.settings.keys[idx]
  if c: write hexToRgb(c) into L.rgb[k*3..k*3+2]
  else: L.rgb[k*3..+2] = 0,0,0        // transparent under the 'replace' blend
```
No time dependence — it's a static per-key paint (re-rendered each frame so edits show live; the engine's frame de-dupe keeps it cheap).

**Default layer / settings:** default `blend: 'replace'`, `opacity: 1`, `enabled: true`, name "Individual", `settings.keys = {}`, `settings.current = '#ff8c00'` (reuse the reactive default orange). Added to `ensureSettings` so a saved layer backfills `keys`/`current`.

**Why `replace`:** painted keys override whatever is below; unpainted (black) keys are transparent so the layers beneath show through. This makes an Individual layer a natural "accent" overlay (e.g., paint WASD red over a breathing background).

---

## 3. Layers-UI — the card body + the board panel

**Card body** (built in `buildLayerBody` for `individual`):
- **`⌨ Show Keyboard`** pill — toggles the board panel (below).
- **Current color** picker (bound to `settings.current`).
- **Selection count** readout ("N keys selected").
- Buttons: **Clear selection** (un-paint the selected keys), **Clear all** (empty `settings.keys`). (No "Fill selection" button — changing the **current color** while keys are selected *is* the apply-to-selection path, see §5.)

**Board panel placement:** toggling the pill reveals the interactive board **inserted directly above this layer's card** in the stack — a sibling block wedged in, so it's spatially tied to the layer it edits and moves with the layer if reordered. Hiding removes the panel. Each Individual layer owns its own pill + board, editing only its own `settings.keys`. (Mounting above the card avoids pushing the rest of the stack around mid-card.)

**Persistence:** all of this lives in `settings`, so the existing `serializeLayers()` → `th108_layers` → `pushConfig()` path saves it automatically. No schema/daemon changes.

---

## 4. The interactive board component (fresh, reusable)

A small factory `createPaintBoard(host, { getColor, onPaint })` (or similar) that:
- Renders the 104-key board into `host` using `INDICES` + `keyCell(idx)` for geometry and the same `.kbkey` CSS look as the Pick-a-Key card (extract the shared styles; the binder's `KBOARD` is left as-is).
- Draws each key filled with its current `settings.keys[idx]` color (unpainted = a dim neutral).
- Implements the selection + painting model (Section 5), calling back to mutate `settings.keys` / `settings.current` and trigger a layer re-render + save.

It is a **read/write** board (vs. the binder's single-select read board). Reusing only the geometry/CSS — not the instance — keeps the keymap path isolated.

---

## 5. Painting + selection model

A single **current color** (`settings.current`) drives both painting and selection-fill. Selection is a transient set of highlighted keys (not persisted).

| Gesture | Effect |
|---|---|
| **Click** a key | Paint it `current`; selection becomes just that key |
| **Drag a marquee** | Select the enclosed keys; fill them with `current` live |
| **Shift**+click / Shift+drag | Add key(s) to the selection and paint them |
| **Ctrl**+click / Ctrl+drag (box) | Remove key(s) from the selection (color kept) |
| **Alt**+drag (box) | Erase/un-paint keys in the region (delete from `settings.keys`) |
| Change the **color picker** | Recolor the live selection; with nothing selected, just set the next paint color |
| **Clear all** button | Empty `settings.keys` |

Notes:
- "Selected" keys track the current color live (selecting == painting with `current`), which matches "set these keys to one shared color." Ctrl-deselect commits them at their current color and drops them from the active set.
- Marquee = a drag rectangle hit-tested against each key's `keyCell` rect.
- Every mutation updates `settings.keys`, re-renders the layer (preview + hardware if driving), and schedules the debounced save.

---

## 6. Sub-task — suppress the browser's bare-Alt menu

Alt-box-select needs the Alt key not to focus the browser's menu/hamburger. Scope a guard to the board canvas: on `keydown`, `if (e.key === 'Alt' || e.altKey) e.preventDefault()` while the pointer/interaction is over the board — narrow enough that legitimate Alt+letter shortcuts elsewhere are unaffected (confirmed-doable per the roadmap).

---

## 7. Edge cases / out of scope (v1)

- **Pure black = transparent** (it's the `replace` rule). An explicit "force this key OFF / opaque black" is **out of scope v1**; revisit with a near-black sentinel or a per-key flag if needed.
- **Multiple Individual layers** each independent (own board, own `settings.keys`).
- **Eyedropper / copy-paint between keys** — not in v1.
- **Daemon parity:** `settings.keys` is plain JSON; the daemon's shared engine renders it identically — no daemon code. (The board UI itself is page-only, like every layer editor.)

---

## 8. Testing

- **Engine unit test** (`th108-engine.test.js`, `node --test`): an `individual` layer with a couple of painted keys renders those LEDs and leaves the rest black; under `replace` blend over a solid background, painted keys override and unpainted keys reveal the background.
- **HTML syntax check** after editing `th108-controller.html` (the `new Function` inline-script check).
- **In-browser smoke** (served at `:8123`): the pill reveals/hides the board; click paints; marquee selects+fills; Shift/Ctrl/Alt modifiers behave; Clear all empties; reload restores the painted keys from `th108_layers`; zero console errors.
- **Hardware glance** (user): painted keys show on the board and composite correctly with a layer beneath.

---

## 9. Build order (for the plan)

1. Engine: `individual` type + `renderKeys` + defaults + unit test.
2. Extract the shared `.kbkey` board CSS/geometry into a reusable paint-board factory.
3. Layers-UI: the `individual` card body (pill, color, buttons, selection readout).
4. The board panel: mount above the layer card on pill-toggle; wire the selection/painting model.
5. Alt-suppress on the board.
6. Smoke test + hardware glance.
