# TH108 Suite — Screen-Recording Play-by-Play

A shot list for a ~3-minute feature reel. Two sources cut together:

- **A — Screen capture** of the controller (`http://localhost:8123/`), 1080p, browser at ~90% zoom so cards aren't cramped.
- **B — Real keyboard**, phone/DSLR on a small tripod, top-down or 30° angle, room lit but not washing out the RGB. Use B for anything where the *board itself* is the payoff (reactive, audio, agent, media, song progress).

Record A and B **simultaneously in one take per section** so the on-screen change and the physical light line up — you'll sync them in the edit by a clap/keypress at the top of each take.

**Before you roll:** daemon running (tray = salmon keyboard), Spotify open with a punchy track queued, one loud audio source ready, and a fresh browser so the language dropdown reads English. Hide desktop clutter. Set the theme you want on camera (top-right toggle) once, up front.

---

## 0. Cold open — 6s (B, then A)
- **B:** board sitting dark, then you tap a few keys → reactive flashes ripple out. No talking.
- Hard cut to **A:** the controller, Home tab. This is the "what is this" hook.

## 1. The tour — Home + tabs — 15s (A)
- Slow pan across the tab bar: **Home · Hotkeys · Lighting · LCD Screen · Profiles · Docs · FAQ**.
- Click each tab once, ~1.5s dwell, so the viewer sees the breadth. End on **Lighting**.
- *Optional overlay text:* "Host-driven. Nothing installed on the keyboard."

## 2. Layer Compositor — the headline — 25s (A + B split-screen)
- **A:** Lighting tab, Layer Compositor. Start with one **Background** layer (cyan pulse). 
- Add a **Reactive** layer on top → **B:** type in any window, keys flash yellow-orange over the pulse.
- Show a **blend mode** dropdown change on one layer (e.g. Screen → Multiply) so the composite visibly shifts — **B** confirms it on the board.
- Drag a layer card to reorder → note the stack updates live.
- Tap **Isometric View** → the 3D floating key-planes. Rotate once by dragging. Close it.

## 3. Audio-reactive layer — 25s (B primary, A inset)
- **A:** add an **Audio** layer. Show the source selector: **System / App / Tab / Mic**.
- Pick **System**, start the loud track.
- **B (full frame):** the board dances to the music — hold on this, it's the money shot. Let a beat drop land.
- Quick **A** cut: switch source to **Mic**, then clap/talk → **B** reacts to your voice. Cut back.

## 4. Agent layer — 20s (A + B)
- **A:** add the **Agent** layer; enable **follow the focused session**.
- Trigger some agent activity (a running task) → **B:** the board shows the agent-status lighting shift as state changes.
- *Overlay text:* "The keyboard becomes an ambient status light."

## 5. Media / GIF layer — 20s (A + B)
- **A:** add a **Media** layer, load a GIF (pick something with motion + color).
- Show the framing controls briefly (zoom/pan, crop box) and a sample mode.
- **B (full frame):** the GIF plays *across the keys*, blended with the layers underneath.

## 6. LCD + Now Playing — 18s (B primary)
- **A:** LCD Screen tab — upload an image/GIF, show Crop/Fit framing.
- Toggle **Now Playing** on.
- **B (tight on the LCD):** Spotify track title/art on the little screen; **skip a track** and hold on the **song-progress bar advancing** — great detail shot.

## 7. Hotkeys / Host Actions — 15s (A + B)
- **A:** Hotkeys tab. Bind a key to an action (e.g. **toggle mic lighting** or **cycle profile**).
- **B:** press that physical key → the bound action fires (lighting flips / profile changes on the board).

## 8. Profiles — 12s (A + B)
- **A:** Profiles tab. Switch profiles → **B:** whole-board look changes instantly (no reload).
- Mention app-auto-switch in one line of overlay text if you don't want to stage a focus change.

## 9. Localization flex — 8s (A)
- Top of the page, click the **🌐 language dropdown**. Pick **日本語**, then **العربية** (watch the layout flip RTL), then back to **English**.
- Short, but it sells "polished, global."

## 10. Close — 8s (A → B)
- **A:** Docs tab, scroll the **th108 vs. Epomaker WebHID** compare table into frame (the honest one).
- End on **B:** board doing the full composite (background + reactive + audio), lights up, fade out.

---

## Sync & edit notes
- Top each combined take with a single **spacebar press** — the reactive flash on B and the (optional) on-screen keypress give you a frame-accurate sync point.
- Keep **B in full frame** for sections 3, 5, 6, 10 — those are the ones a screen capture can't convey.
- Total run ~2:50. For a 60s cut, keep 2 (compositor), 3 (audio), 6 (Now Playing progress), 9 (localization).
- Capture at 60fps if you can — the reactive fade and audio bars read much better than 30fps.
