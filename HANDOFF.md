# HANDOFF — 2026-06-27 → next session: fold the GIF panel into the Media layer

> Durable rules/protocol/roadmap: **`_HANDOFF.md`** (gitignored) + project memory. This file = session resume.
> **The focused next task is at the bottom (## NEXT SESSION).** The rest is today's state.

## Where things stand
Huge UI/UX day on top of the iso-view work, plus the **headline feature shipped (v1): GIF-as-a-compositor Media layer** (engine-tested). HEAD `3c8f567`, working tree clean. **Almost everything today is committed but NOT browser/hardware-verified by me** — I stopped reloading the controller because my reloads churn the page↔daemon handoff and **wedged the board twice**. The user must **reload the page + restart the daemon** (no hot-reload) to exercise today's engine changes.

## Ledger

### ✅ Solved (verified)
- **Lights-on board mute** — user hardware-confirmed. `914c50a` · [daemon.js:817](th108-daemon/daemon.js#L817). Memory `th108-mute-lightson-reopen.md`.
- **Engine `renderMedia`** — Media layer plays stored per-key frames on the speed/freeze clock; **+2 unit tests, 65/65 green** (`node --test th108-engine.test.js`). `bd98f85` · [th108-engine.js renderMedia](th108-engine.js).
- **Layer 3↔4 swap + wrong-column** (Fill) — fixed by not masonry-packing layer cards. `3db0f25`. (User confirmed both modes.)

### 🟡 Open / committed but USER must reload + (for engine) restart daemon to verify
- **Media layer v1** — set a layer type=Media → Choose File → decodes + cover-samples per-key → `settings.frames=[{d,rgb[NLED*3]}]` (capped 30 to fit /config) → plays via engine (page+daemon), blends, no Connect. + Speed slider, Static freeze, **Release** button (offload). `d70420a`,`7e47f95`,`3c8f567`.
- **Add/remove layers** — "+ Add layer" + per-card circle-x remove; up to 7 (one per type); **undo toast ~6s** on removal; docs 4→7. `8e043d4`,`3c8f567`.
- **Bars Reverse** — swap-gradient-colors checkbox for the gradient Bar Color (engine swaps ends). `4b62d75`.
- **Card icons** — collapse=panel-bottom-open/close, remove=circle-x (matched size). `3c8f567`.
- **Fill-mode hardening** — pill hugs outside edge / hides past anchor; Show-pill lerp-scrolls to the dup; Show-Keyboard mounts above the row + scrolls to top; MutationObserver re-spans on content growth. `c1bf5bf`,`2381fe8`,`50a087b`,`40ef26f`,`05a172b`,`187bdae`,`ecf1ca7`.
- **Docs/FAQ/NowPlaying/GIF-Screen zebra + readability**, scrollbar-gutter (Profiles shift), theme-knob contrast, Individual per-key Solid/Silhouette brush, GIF-panel local preview + Connect hint. `093ffc5`,`b4be89c`,`7f9f52b`,`9c0a54a`,`91e949d`,`0e57120`,`732aba5`,`cf9cb26`,`e019200`,`eed50d1`.

### 🔴 Regressed / suspect
- **Board wedged ~3× today** — 2 from MY chrome-devtools reload storms (page↔daemon yield/resume churn), 1 environmental long-stream USB-power mute. All self-recovered. **NOT** any code change. Rule below.

## Build / run / test
- **Daemon (always-on):** `node th108-daemon/daemon.js` → http://localhost:8123. **ONE device owner at a time.** No hot-reload — **restart to load engine/daemon changes.**
- **Static (page sole owner):** `node _serve.js` → :8123.
- **Tests:** `node --test th108-engine.test.js` (65) · `cd th108-daemon && node --test` (50) · `node --test th108-gif-panel.test.js th108-profiles.test.js`.
- **HTML inline check:** `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`

## Gotchas
- **DO NOT rapid-reload the controller while the daemon drives** — handoff churn → two-writer wedge (bit me 2× today). Have the USER reload once; do ≤1 careful reload yourself.
- **Commits:** author `Beyon <you@example.com>`, **NO Claude/Co-Authored-By trailer.** `node --check`/inline-check before commit. American spelling.
- **TDZ trap:** load-time ReferenceError blanks the whole page; `node --check` can't catch it → verify interactive in Chrome.
- **Media frame format:** `settings.frames = [{ d:delayMs, rgb:[r,g,b,…] NLED*3 physical order }]`. Engine `renderMedia(L,tnow)` plays it; `tnow`=`layerNow` clock (speed=`s.spd`, freezes on Static). **Cap 30 frames** — per-key number-array data must fit the daemon's **64 KB /config POST cap** (`th108-daemon/server.js`). Persisted because `serializeLayers` (layers-ui:24) includes full `settings`.
- **One-layer-per-type** rule (`usedT`, layers-ui:84) caps layers at 7. To allow duplicates, drop `usedT`.

---

## NEXT SESSION — port the GIF→Keyboard framing + previews into the Media layer

**Goal (user request):** the Media layer should have *all* the **GIF → Keyboard Lighting** card's settings, **including the previews** — i.e. fold the standalone panel's capability into the compositor layer.

**Already present in the Media layer** (don't rebuild): Brightness/Saturation/Contrast/Gamma (shared **Adjust** block), **Speed**, **Static**, blend, opacity, fps, Release.

**Still to port from `th108-gif-panel.js` → Media layer (`th108-layers-ui.js` `L.type==='media'` branch, ~line 334):**
1. **Framing:** zoom / pan (drag) / **rotate**, **Map** (physical vs grid), **Sample** (average-area vs nearest), **Bars fill** for letterbox. The standalone panel's sampler is `sampleKeyColors` / `pushFrame` / the crop transform in `th108-gif-panel.js` — currently baked into its own UI/DOM.
2. **Two live previews:** the **position canvas** (image + blue crop box, drag-to-pan/zoom) and the **keyboard preview** (per-key result). See gif-panel `drawSrc()` / `drawKb()` / `refresh()`.

**Recommended approach:** extract the gif-panel's **decode + crop + sample** into a shared, DOM-light module (e.g. `th108-gif-decode.js`) that BOTH the standalone panel and the Media layer call, returning `frames=[{d,rgb[NLED*3]}]`. The Media layer's current `decodeMedia()` (cover-only, layers-ui ~line 345) is the seam to replace. Keep the **30-frame cap** + number-array `rgb` (or switch to base64 + an engine-side decode helper if you need more frames — note the /config 64 KB cap either way).

**Build/verify discipline:** pure decode/sample logic → unit-test it (no hardware). UI/previews → the USER reloads + restarts the daemon to verify (don't reload-churn). Commit per logical step. Consider whether to eventually retire the standalone "GIF → Keyboard Lighting" panel once the Media layer supersedes it (it needs Connect; the Media layer doesn't).

**Files:** `th108-gif-panel.js` (source of decode/sample/crop + previews), `th108-layers-ui.js` (Media branch + `decodeMedia`), `th108-engine.js` (`renderMedia`, `keyCell`, `NLED`/`INDICES`), `th108-engine.test.js`. Memory: `th108-gif-as-layer.md`.
