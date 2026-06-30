# HANDOFF — 2026-06-29

> Durable rules / protocol / roadmap + rolling history: **`_HANDOFF.md`** (gitignored, local) + project memory. This file = the focused, scannable state of THIS session. The 2026-06-28 NumLock-RE brief that lived here is **done** (see below) and has been replaced.

## Where things stand
The NumLock white-LED RE is **conclusively dead** — full recon of the official web tool found no indicator/lock/LCD/display setting anywhere, so there's nothing to sniff. The host-side fallback shipped and was **hardware-tested by the user**: a one-click "Numpad → Digits" workaround in the Hotkeys binder. The rest of the session was UI polish (iso-view perf + visuals, numpad-control grouping, button centering/padding, status copy). HEAD = `d727d98` on **master**; working tree clean (before this doc).

## Ledger

### ✅ Solved (verified)
- **NumLock white-LED workaround — USER HARDWARE-TESTED.** One-click "Numpad → Digits (kill NumLock LED)" remaps 0–9 + decimal → top-row scancodes (operators already work NumLock-off, left alone), neutralizes the NumLock key (HID 0, freeing it to rebind), + **Revert Numpad** + a collapsible Explanation. `th108-binder.js` (`numpadWorkaround` / `numpadRevert` / `NUMPAD_REMAP`), commit `294822c`.
- **NumLock RE = dead end (confirmed by recon).** Official web tool (epomaker.driveall.cn) exposes no indicator/lock/LCD/display setting in any tab → nothing to capture. Memory `th108-numlock-re-handoff` marked RESOLVED.

### 🟡 Open / in-progress
- **iso-view changes committed but NOT visually confirmed** (`c35515e`): inactive System plane dims + reads "(inactive)"; off layers drop aura + particles; perf pass (cache `proj()` yaw/pitch/zoom trig — was recomputed ~1300×/frame; cache the body-font lookup; budget-cap supersampling on big pop-outs). **X-rotate: I flipped the HORIZONTAL (yaw) drag** in `th108-iso-view.js` pointermove (~line 282, `yaw=rot.y0 - dx*…`). If "inverted" meant the vertical/tilt axis instead, flip `pitch`. **Needs a user eyeball.**
- **UI-polish batch committed (`d727d98`), pending visual confirm:** numpad controls wrapped in one encompassing rectangle, description in its own flush box below (group box no longer grows on expand); Explanation / Revert / Explanation-toggle / row-shading-reset buttons re-centered (inline-flex) + padded; status copy reworded. All syntax-checked, not yet eyeballed.
- **Online-orb glow** (`294822c`): soft glow + hover-breathe replacing the ping ring — user-directed, final look not explicitly confirmed.

### 🔴 Regressed / suspect
- None known this session.

## Queued next (full detail in `_HANDOFF.md` §10 + roadmap memory)
- **NEXT: Audio-layer cleanup** — brainstorm→spec first (trim params, tighter audio sync, per-param undo/reset, "site domain" capture source). See memory `th108-music-layer`.
- Then **Advanced Keys sniff** (official tool HAS the tab; SOCD/MT/TGL/CB encodings partly RE'd — fruitful).
- Then **LCD "off" = dumb workaround** (true off is DEAD — no vendor display setting): one-click "LCD Off (black)" single all-black frame via the existing 0x50 engine, with a note that the backlight stays on (lit-black) + suggest a light-blocking sticker. Honor flash-upload safety (never-resend / 33-frame cap / pause lighting); deliberate button, not automatic.
- **PRE-SHIP, DO LAST** (before the GitHub Pages deploy): seed a curated default state for new visitors from the finalized state (strip personal/machine bits) + first-run seeding + a `?fresh=1` preview to tune it.
- **DROPPED:** UI redesign tooling (debug-wireframe / Arrange mode) — user call.

## Build / run
- Static page (page owns the device): `node _serve.js` → http://localhost:8123/
- Full daemon (always-on, owns the device): `node th108-daemon/daemon.js`
- **One device owner at a time** — page and daemon fight over the keyboard; stop one before starting the other.
- Static HTML → **reload** after edits (no hot reload). Engine changes → **restart the daemon** (modules are require'd at startup).
- Syntax checks: `node --check th108-binder.js` · `node --check th108-iso-view.js` · HTML inline script via `node -e "…new Function(b)…"` (full command in `_HANDOFF.md` §1).
- Unit tests: `node --test th108-binder.test.js` (20) · `node --test th108-engine.test.js`.

## Gotchas
- Commits authored as **Beyon <you@example.com>**, **NO** Claude / Co-Authored-By trailer.
- Never commit vendor bundles (`app.*.js`, `chunk-*.js`, `*.js.txt`, OpenRGB zip) — gitignored.
- Keymap writes need a FULL 512-byte read+rewrite — single-key writes ACK but don't commit.
- A half-applied edit to an inline `<script>` can TDZ-break the WHOLE page silently (`node --check` can't catch it) — reload and confirm the page is interactive after editing.
- LCD uploads write flash — never re-send a chunk, cap 33 frames / ~1 MB; don't hardware-test LCD uploads without the user present.

## Next action
Eyeball the just-committed UI batch + the iso-view changes — **especially confirm the iso X-rotate direction is the one you meant** (else flip yaw↔pitch ~`th108-iso-view.js:282`). Then start **Audio-layer cleanup** with a brainstorm→spec pass.
