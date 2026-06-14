# HANDOFF — 2026-06-14

## Where things stand
The **mute / lighting-safety arc is complete**: all four reverted stability fixes are re-added and verified one-at-a-time, plus the page↔daemon handoff was redesigned into one legible model (a driver toggle + a WebHID/Daemon pill + a Connect/Disconnect button + automatic blur/hide handoff). 7 commits on `master` (HEAD `86ffcca`). Working tree clean except two intentionally-untracked machine-specific `.ps1` audio scripts. Next work is feature-side (LCD/visualizer/UI), not stability.

> Deep background lives in `_HANDOFF.md` (older) + project memory. This file is the current-state snapshot.

## Ledger

### ✅ Solved (verified)
- **Stop hands board to daemon + driver pill** — `cb4d3bf`. Stop no longer blackouts; daemon takes over, pill shows WebHID(blue)/Daemon(orange). User-confirmed, no mutes.
- **Start/Stop → one `#driveToggle` + GIF-vs-daemon fix** — `ae25f4f`. `stop(handToDaemon)`: only the deliberate toggle hands off; GIF's internal stop blackouts (no two-writer fight). Also fixed a boot TDZ that halted init. User-confirmed.
- **Auto-grab deference** (the #1 villain) — `9877241`. Page defers to a driving daemon on wake/replug; reclaims only if it was driving. HW-verified (wake+replug both directions).
- **Single-flight bind guard** — `b89ca6e`. `_binding` flag in all 4 bind paths → replug-while-driving = one clean re-bind, no dark board. HW-verified.
- **Auto-release on blur/hide** — `86ffcca`. Hands to daemon on window blur too (not just hidden), so reactive works typing in VSCode on a 2nd monitor; 1.2s debounce; reclaim on focus. HW-verified **seamless, no mute blink**.
- **FAQ: rapid churn wedges the board** — `aba8451` (faq4). Documents Connect/Disconnect/replug/tab-switch churn as a wedge trigger + BT↔wired recovery.
- **Connect⇄Disconnect button + status polish** — `91b79e2`. Connect flips to "Disconnect Keyboard" when the tab holds the handle (`HID.disconnect()` closes it + hands to daemon); "Keyboard Connected" (capital C); defer-log debounced to one per replug. **HW-verified** (Disconnect confirmed working 2026-06-14).

### 🟡 Open / in-progress
- **Feature queue** (none started): Clear LCD button (black-image push, lit-black ≠ true off); LCD parity controls (Rotate/Gamma/Speed + GIF stats); audio-reactive visualizer layer (the "music layer", design-first); UI tooling (wireframe toggle / Edit-layout / Arrange); driver sniffs incl. **true LCD screen-OFF** command.
- **Two untracked `.ps1`** (`th108-daemon/install-audio-wake-fix.ps1`, `wake-audio-recovery-test.ps1`) — machine-specific audio-on-wake fix, intentionally NOT committed.

### 🔴 Regressed / suspect
- **None outstanding.** The board deep-wedged twice during testing — that's the firmware/hardware churn behavior (recovered via BT↔wired), NOT a code regression; now documented in faq4.
- **History note:** `cb4d3bf` in isolation is broken on load (latent GIF-vs-daemon two-writer + a boot TDZ halt) — **both fixed in `ae25f4f`**. Only matters if someone checks out `cb4d3bf` alone.

## Build / run
- **Static (page = sole device owner):** `node _serve.js` → http://localhost:8123/
- **Full daemon (always-on, reactive-anywhere):** `node th108-daemon/daemon.js` (serves the page + control API on :8123)
- **Only ONE device owner at a time** (page OR daemon). Static HTML → edits need a page reload.
- **Tests:** `node --test th108-engine.test.js th108-hid.test.js` (17) · `node --test th108-gif-panel.test.js` (7) · `cd th108-daemon && node --test`
- **HTML syntax check:** `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`

## Gotchas
- **Commits authored `Beyon <you@example.com>`, NO Claude/Co-Authored-By trailer.** American spelling.
- **Never commit Epomaker's bundles** (`app.*.js`, `chunk-*.js`, `*.js.txt`, OpenRGB zip) — reference-only.
- **LCD upload = flash write (brick risk):** never re-send a chunk (abort on stall), cap 33 frames / ~1 MB. Don't HW-test LCD uploads unless the user is present to recover.
- **Board wedge recovery = flip the mode switch BT↔wired** (battery MCU — replug/USB-restart can't reboot it; the in-app factory reset needs a working connection, so it's useless when muted).
- **Rapid handoff churn wedges the board** — Connect/Disconnect/replug/tab-switch in quick succession; let it settle between switches. (Now in faq4.)
- **Reactive-anywhere is DAEMON-only** (uiohook system-wide); page-driving reactive only fires while the tab is focused (WebHID design).
- **`refreshDriverUI()` must not run before `let running` (~`th108-controller.html:1002`) / `const GIF` (~`:1087`)** — TDZ throws and halts init (the `cb4d3bf` boot bug; fixed by placing the boot call after both).
- **Never batch device-handoff changes** — re-add/verify ONE at a time on hardware (the rule that broke the earlier batch → full revert `e010bab`).

## Next action
Build the **Clear LCD button** (black-image push: all-black 160×96 via `0x50` using `th108-lcd-upload` + `openScreen`) — small, self-contained, no handoff risk, pairs with the now-playing-off GIF-revert. (Or, in passing, click the new **Disconnect button** once to close out its hardware verification.)
