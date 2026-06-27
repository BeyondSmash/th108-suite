# HANDOFF — 2026-06-27 (UI/UX polish + 1 daemon fix)

> Durable rules, protocol, and roadmap live in **`_HANDOFF.md`** (gitignored) + project memory. This is the session resume.

## Where things stand
Long UI/UX + Docs/FAQ polish session on top of the iso-view work. **One real hardware bug fixed AND user-verified** (lights-on mute). Everything else is committed but **only syntax/unit-verified — NOT browser-verified by me**: I stopped reloading the controller page because my repeated reloads churned the page↔daemon handoff and **wedged the board twice**. Working tree clean, HEAD `b4be89c` (+ this HANDOFF commit). The user fired ~15 rapid styling requests near the end; two are deferred (below).

## Ledger

### ✅ Solved (verified)
- **Lights-on board mute** — `setLighting` no longer `closeDevice()`s on lights-on; repaints the warm handle like the monitor-wake path. **User hardware-confirmed.** `914c50a` · [daemon.js:817](th108-daemon/daemon.js#L817). Memory `th108-mute-lightson-reopen.md`.
- **Grid/Fill card toggle** — header toggle; Fill = JS masonry packing bento + layer-compositor cards; scroll preserved; Connect renamed (fixes overlap). **Browser-verified by me in Chrome** (not user-eyeballed). `e019200`,`eed50d1`.
- **gitignore cleanup** + 10 dead scratch files deleted (git status clean). `41c8684`.
- **Adjust "changes keyboard not preview" note** — user confirmed accurate. `41a20e6`.

### 🟡 Open / in-progress — committed but USER MUST RELOAD + VERIFY (I did not browser-verify)
- **Individual layer: per-key Solid/Silhouette brush** — `s.keys[idx]` = `'#hex'` (solid) OR `'sub'` (silhouette carve); `s.brush` = active brush; legacy `s.fill==='subtract'` migrated in engine ensureSettings. 63 engine tests pass but **never rendered** (no individual layer existed at test time). `0e57120` · [renderKeys th108-engine.js:411](th108-engine.js#L411), UI [th108-layers-ui.js:275](th108-layers-ui.js#L275), paint-board slash marker [th108-paint-board.js:60](th108-paint-board.js#L60).
- **GIF panel quick-fix** — local preview animation w/o device (`prevTick`, never `sendFrame`) + `#gifConnectHint`. gif tests pass. `732aba5` · [th108-gif-panel.js:212](th108-gif-panel.js#L212).
- **Audio Live-pill** clamped inside compositor. `cf9cb26`.
- **Docs/FAQ pass** — Feature Guide zebra blocks + color-coded titles; brighter/larger body + softer bold (faqcard+doccard); dropped all `?` from titles; reset-FAQ links Home Toolbox. `093ffc5`.
- **Zebra/styling batch** — Changelog + Legal (`.fgsec`) + comparison-table rows zebra; per-card FAQ tones (`.fqz1-3` via JS, [restoreLayout area]); more FAQ/Keyboard paragraph spacing; `html{scrollbar-gutter:stable}` (fixes Profiles right-shift); higher-contrast dark theme-toggle knob. `b4be89c`.
- **DEFERRED (user asked, NOT done):** **zebra the Now Playing card** (`#npCard` [th108-controller.html:1062](th108-controller.html#L1062)) and the **GIF Screen card** (th108-lcd.js `LCD_HTML`). Both are control-heavy grids, not prose sections — need a careful group-wrapping pass; I would not rush them in unverified.
- **GIF as a compositor "Media" layer** — GREENLIT for "later" (the real fix for GIF-needs-Connect). Engine `renderMedia` is a no-op stub. Memory `th108-gif-as-layer.md`.
- **Profiles Export-next-to-Import** — RESOLVED: user chose keep per-row Export, no change.

### 🔴 Regressed / suspect
- **Board wedged 2× from MY chrome-devtools page reloads** churning the page↔daemon yield/resume handoff (log `16:18` yield→resume storm). Both self-recovered via USB-restart. **NOT the daemon fix.** Lesson: never rapid-reload the controller page while the daemon drives.
- **Daemon restart "slow" report** — investigated, NOT a bug: the restarted daemon correctly waits for the open controller tab to `/resume` (hand back the keyboard); 20–40s when the page is busy with now-playing LCD. Close the tab for fast restarts.

## Build / run
- **Daemon (always-on):** `node th108-daemon/daemon.js` → http://localhost:8123. **One device owner at a time.**
- **Static (page sole owner):** `node _serve.js` → :8123.
- **Tests:** `node --test th108-engine.test.js` (63) · `cd th108-daemon && node --test` (50) · `node --test th108-gif-panel.test.js th108-profiles.test.js`.
- **HTML inline check:** `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`

## Gotchas
- **DO NOT rapid-reload/navigate the controller page while the daemon drives** — handoff churn → two-writer wedge (bit me 2× this session). Have the USER reload once to verify, or do ≤1 careful reload.
- **TDZ trap:** a load-time ReferenceError blanks the whole page; `node --check` can't catch it — verify interactive in Chrome.
- **Per-key individual layer data:** `s.keys[idx]` is `'#rrggbb'` OR `'sub'`; legacy `s.fill` migrated + left inert.
- **Commits:** author `Beyon <you@example.com>`, **NO Claude/Co-Authored-By trailer.** `node --check`/inline-check before commit. American spelling.
- **Daemon has no hot-reload** — daemon.js/engine changes need a restart (restart is slow while the page holds the keyboard — close the tab first).

## Next action
**User: reload the controller and verify the unverified UI** — Individual layer (Show Keyboard → Solid/Silhouette brush, silhouette keys show a diagonal slash + carve below), GIF panel (paste URL → preview animates + Connect hint), Docs/FAQ zebra/spacing/colors, Profiles no-longer-shifted, theme-knob contrast. Then: finish the two deferred zebra cards (Now Playing, GIF Screen), and the headline build is **GIF-as-a-compositor-layer** (`th108-gif-as-layer.md`).
