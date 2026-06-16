# HANDOFF — 2026-06-16

## Where things stand
Long session. Shipped the **Individual-keys color layer** (per-key paint as a `replace`-blend compositor layer, merged to `master`) plus polish, and fixed three real bugs found along the way: the **mute-recovery** (broken `findstr` device lookup), the **media-sidecar memory leak**, and **config edits resetting the daemon's animation**. The **daemon has NOT been restarted**, so it's still running the pre-feature engine — that's the gating next step.

## Ledger

### ✅ Solved (verified)
- **Mute auto-recovery never fired** — `restart-usb.bat`'s `findstr /c:"USB\VID_0C45&PID_8006\"` matched nothing (trailing `\"` mis-parsed); replaced with `Get-PnpDevice`. `14e2d17`. Verified end-to-end: re-enumerated a genuinely-wedged board → daemon logged `RECOVERED`. Reproducer: `th108-daemon/_wedge-inducer.js`.
- **media-sidecar.ps1 leaked to ~1.5 GB** (lagged the whole machine) — periodic `[GC]::Collect()` every ~20 loops. `f78d66b`. Live lag resolved (killed the 1.5 GB proc; fresh sidecar ~88 MB). Long-term boundedness still to watch (→ 🟡).
- **Daemon config edits reset all animations** — `saveConfig` did a full `createState` on every `/config` push while driving; now `E.applyConfig` updates settings in place when layer structure is unchanged. `d043f94`. **User-confirmed "works perfectly."** (Daemon-driving case takes effect only after a daemon restart — see 🟡.)
- **Individual-keys color layer** — `type:'individual'`, `replace` blend, canvas paint board (`th108-paint-board.js`), Show-Keyboard toggle above the layer card, paint/marquee/Shift/Ctrl/Alt model, key-face labels matched to Pick-a-Key, brightness capped at 100%. Merged `f2901a9` + polish (`bbd48a3`,`4c46ee8`,`8d46b1b`,`45b2d30`,`4baf395`,`2bf2832`,`1d111d0`,`e5d2c8d`). In-browser smoke verified (paint→persist→recolor→clear, 0 console errors). Hardware glance still pending (→ 🟡). Tests 21/21 engine+UI, 36/36 daemon.
- **LCD parity controls** (Rotate 90°, Speed, GIF stats) — `d8ebf51`, in-browser verified.

### 🟡 Open / in-progress
- **RESTART THE DAEMON** — it `require`'d the engine at startup, before `renderKeys` existed (no hot-reload). Until restarted it canNOT render Individual layers on handoff, and the `applyConfig` in-place fix won't apply on the daemon-driving path. **This is the next action.**
- **Daemon-side stuck-reactive keys** — a dropped global `uiohook` keyup mid-drive leaves keys stuck amber; only `resume()`/`rebuildState()` clears it. Page path fixed (`b252b20`, release-on-blur); daemon path OPEN. Manual clear: `POST /yield` then `/resume`. Fix idea: event-based reset on device reopen (avoid an arbitrary held-too-long threshold). See memory `th108-reactive-stuck-keys`.
- **Hardware glance** on Individual-keys: paint keys, confirm they light over a Background layer (the `replace` blend shows the background through unpainted keys).
- **Sidecar memory** — watch over a full session that `f78d66b` keeps it bounded; backstop if not = daemon-side periodic sidecar recycle.
- **Reactive page-blur fix (`b252b20`)** committed but not hardware-confirmed by the user.
- **Parked idea** (roadmap memory `th108-feature-roadmap`): isometric layer-stack visualizer + a "system layer" plane showing firmware-enforced lock keys.

### 🔴 Regressed / suspect (resolved, noted)
- Mid-session, the in-browser **layers-UI smoke test pushed `/config` to the live daemon** and overwrote the user's layer config (Background → empty Individual → "reactive only" lighting). Restored to defaults; user re-synced their custom config via a slider nudge. **Lesson: never smoke-test the layers UI against the daemon-served page** — stop the daemon or use a throwaway config.
- Stray untracked files (can delete; `rm` is blocked for the agent): `th108-daemon/_findstr-test.bat` (throwaway), root `_steam-hid-diag.js` (broken duplicate of the daemon one).

## Build / run
- Page served by the daemon at `http://localhost:8123/th108-controller.html` (or `node _serve.js` for static — but it conflicts with the daemon on port 8123, so only one).
- Tests: `node --test th108-engine.test.js th108-layers-ui.test.js` (21) · `cd th108-daemon && node --test` (36).
- After `.js` edits: `node --check <file>`. After `th108-controller.html` edits: the `new Function` inline-script check.
- Restart the daemon: Background-daemon panel → **Quit**, then relaunch (tray icon → start, or `setup.cmd`). It's tray-supervised (a `/quit` won't auto-respawn).

## Gotchas
- **Daemon has no hot-reload** — engine/module changes require a daemon restart.
- **The daemon-served page mutates the live daemon config** on any layer edit (`pushConfig` → `/config`). Don't test the layers UI against it.
- **One device owner at a time** (page WebHID vs daemon `node-hid`); handoff via `/yield`+`/resume`.
- **shift+right-click on the paint board → native menu is UN-suppressible** (Chromium/Brave escape hatch, by design — not a bug). Plain right-click is suppressed.
- Commits: author `Beyon <you@example.com>`, **NO** Claude/Co-Authored-By trailer.
- chrome-devtools MCP browser wedged on a profile lock this session; used the Playwright MCP instead.

## Next action
**Restart the daemon** (Quit via the Background-daemon panel, relaunch) so it loads the new engine — this is what makes Individual layers render on handoff AND activates the in-place `applyConfig` fix on the daemon-driving path. Then do the Individual-keys hardware glance.
