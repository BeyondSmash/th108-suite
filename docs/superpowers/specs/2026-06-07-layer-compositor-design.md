# Key-Lighting Layer Compositor — Design

**Date:** 2026-06-07
**File:** `th108-controller.html` (major redesign of the in-page engine)
**Decisions locked:** 4 fixed layers · types Media / Background / Reactive / Gradient · full blend modes · per-layer name + FPS.

## Goal
Turn the controller from "one mode at a time" (pulse effect **or** GIF) into a **4-layer compositor**: each
layer renders a 104-key RGB contribution; layers are composited bottom→top into the final frame and streamed
via `cmd 0x32`. Replaces the separate effect + GIF panels — both become layer *types*.

## Layer model
Fixed array of **4 layers**, index 0 = bottom … 3 = top. Each layer:
```
{ name:string, enabled:bool, type:'media'|'background'|'reactive'|'gradient',
  opacity:0..1, blend:'normal'|'add'|'screen'|'multiply'|'max', fps:int,
  rgb:Uint8Array(104*3),   // cached contribution, recomputed at the layer's own fps
  lastTick:number,         // perf time of last recompute
  settings:{ ...type-specific... } }
```

## Per-layer types
- **media** — the current GIF/image/video engine *per layer*: own loaded frames, position (zoom/pan/rotate),
  sampling mode, mapping (physical/grid), bars, color (sat/contrast/gamma/brightness), library pick. Heaviest.
- **background** — solid colour, or pulsing (period, min/max brightness). Uniform across keys.
- **reactive** — keypress flashes (colour + fade); per-key intensity from `keydown` (foreground-tab only).
- **gradient** — linear gradient across the board (2–3 colour stops, angle, optional scroll speed).

## Compositing (per key, per channel, normalized 0..1; dst starts at 0)
For each enabled layer bottom→top, with `a = opacity` and `s = layerColor`:
- **normal:** `out = s*a + dst*(1-a)`
- **add:** `out = min(1, dst + s*a)`
- **screen:** `sc = 1-(1-dst)*(1-s); out = dst*(1-a) + sc*a`
- **multiply:** `mu = dst*s; out = dst*(1-a) + mu*a`
- **max:** `mx = Math.max(dst, s); out = dst*(1-a) + mx*a`
Final `*255 |0` → flat `[idx,r,g,b,...]` → `sendFrame`.

## Timing (single master loop)
- One master loop driven by the existing **Web Worker timer** (background-safe).
- Master rate = **max fps among enabled layers**, clamped to the global FPS cap.
- Each master tick: for every enabled layer, if `now - lastTick >= 1000/layer.fps`, recompute `layer.rgb`
  (advance its animation) and set `lastTick`. Then composite all enabled layers' cached `rgb` → send.
- Static layers (solid background, paused media) recompute once; cost ≈ 0 thereafter.

## UI
Replace the effect + GIF panels with a **vertical stack of 4 Layer cards** (bottom layer listed last, or
top-listed with a "bottom↑top" hint). Each card:
- **Header:** enable checkbox · editable **name** input · **type** dropdown · **opacity** slider ·
  **blend** dropdown · **fps** slider (tick at a sensible default) · expand/collapse toggle.
- **Body (per type):**
  - media → the full existing GIF control set (loaders, library, position canvas, sampling/map/bars, colour).
  - background → colour + pulse (period, min/max).
  - reactive → colour + fade.
  - gradient → colour stops + angle + scroll.
- A single shared **keyboard preview** showing the **composited** result (not per-layer), plus each media
  layer keeps its own small position canvas inside its card.

## Migration / refactor notes
- The current globals (`gifFrames, czoom, cpanX/Y, crot, gifIdx, …`) move into each media layer's `settings`.
  The GIF functions (`sampleKeyColors, gifCrop, keyCell, decodeImage/Video, loadMedia, …`) get parameterized
  by a layer object instead of reading globals/DOM directly.
- The reactive `keydown` stamping and `buildEffectFrame` become the **reactive** and **background** layer
  renderers.
- Per-layer DOM ids become `L{n}-...` (or build cards from a template in JS).
- Keep the media engine's behaviour identical (this is the riskiest refactor) — port, don't rewrite.

## Defaults (out of the box, to match today)
- Layer 1 **Background** = pulsing cyan (enabled). Layer 2 **Reactive** = orange (enabled, blend Add).
  Layers 3–4 = Media / Gradient, disabled. So a fresh load looks like the current effect.

## Build order (staged — each its own commit)
1. **Engine:** layer array + compositor + master worker loop + the shared preview/send, with Background +
   Reactive layers only (reproduce today's effect through the new pipeline). Verify parity on hardware.
2. **Media layer:** port the entire GIF engine into a media layer (per-layer state + UI card).
3. **Gradient layer.**
4. **Polish:** per-layer FPS ticks, blend UI, naming persistence (ties into the future profiles feature).

## Out of scope (later)
- Saving layer stacks as **profiles** (the queued profiles feature will snapshot the whole layer array).
- LCD GIF FPS (separate, in `th108-screen.html`).
- Dynamic add/remove/reorder of layers (fixed 4 for now).

## Verification
- Stage 1: fresh load reproduces the current pulsing-cyan + reactive-orange exactly (on hardware).
- Each later stage: the layer renders correctly alone, and composites (blend/opacity) as expected in the
  shared preview and on the board.
