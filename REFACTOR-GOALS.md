# Refactor Goals — TH108 Suite

Companion to `_HANDOFF.md` (lay of the land). This file is the **target**: what to change and what NOT to.
Read `_HANDOFF.md` first, then the memory files it lists, then follow this.

---

## The goal (one sentence)
**Decompose the monolithic `th108-controller.html` inline `<script>` into focused, zero-build modules — preserving exact behavior — so the codebase is easier to work in.**

## What "refactor" means here (read this)
Change **structure**, not **behavior**. After every step the app must look and work **identically**. This is *not* a rewrite, and it is *not* the place to add features or fix bugs — those are separate, tracked work (see "Out of scope"). If behavior changes, you went too far; revert and re-do smaller.

The bar for "preserved behavior": unit tests stay green (`node --test` for the engine + daemon) **and** a hardware parity glance by the user (lighting/LCD must look + act the same). It's a static HTML app → reload to test.

## Why this goal (context)
`th108-controller.html` is ~1130 lines with a ~900-line inline script doing *everything*: WebHID transport, layer-compositor UI, GIF→key panel, onboard-effects panel, the LCD overlay wiring, the daemon handshake, Export/Import, reset buttons, sleep/wake reconnect. It's the hardest file to change and the bottleneck for every queued feature. The project already proved this extraction pattern works: `th108-engine.js` and `th108-lcd.js` were cleanly pulled out of this same file. This goal **finishes that job**.

## Scope — Phase 1 (the refactor)
Extract these out of the controller's inline script, **one module per commit**, in roughly this order (each is self-contained → lower risk first):
1. **`th108-hid.js`** — WebHID transport: `findWritable` / `findScreen` / `connect` / `bindDevice` / ACK-gated `sendFrame` + the connect/disconnect (sleep-wake) reconnect handling. (Most self-contained; great first extraction.)
2. **`th108-daemon-client.js`** — the daemon handshake: `daemonPing` / `daemonYield` / heartbeat / `daemonPushConfig` / `daemonResume` + the `__lcdHost` pause/resume hook.
3. **Layer-cards UI** (`buildLayerCards` / `buildLayerBody` / `buildAdjustBlock` + reorder/edit-layout) → its own module.
4. **GIF→key panel** (loaders, crop/position, sampling, playback) → its own module.
5. **Onboard-effects panel** (`0x23`) → its own module.

…leaving `th108-controller.html` as mostly markup + thin wiring that imports the modules.

Use the **same conventions as the existing modules**: UMD/IIFE, attach to a `window.TH108*` namespace, **no build step**, no TypeScript/bundler. Pass state in explicitly (mirror how `th108-engine.js` takes a `state` object) rather than reaching into globals.

Optional tidy-ups (only if low-risk and clearly behavior-neutral): retire the superseded `th108-screen.html`; consistent naming; remove dead code; add JSDoc. **Flag, don't fix**, deeper structural issues like the two GIF-decode paths (engine vs LCD) — note them for a later dedicated pass.

## Guardrails (especially for a first refactor)
1. **One extraction → run tests → user hardware-glance → commit.** Never batch extractions.
2. **Behavior identical.** Any visible/functional difference = stop, you changed too much.
3. **Zero-build vanilla** — keep it openable-in-a-browser; no TS/bundlers unless the user explicitly opts in.
4. **Keep tests green; add tests** for any pure logic you isolate (the engine pattern).
5. **Never mix refactor with bug-fixes or features** in one commit.
6. **HARDWARE SAFETY still applies** (`_HANDOFF.md` §1): never re-send an LCD chunk; don't hardware-test LCD uploads without the user present.
7. Commit author `Beyon <you@example.com>`, no Claude trailer. Syntax-check HTML/JS after each edit.

## Out of scope (do NOT do these as "refactor" — separate work)
- **Bug fixes:** the daemon auto-yield "fight" (daemon + page both grab the device). *(The sleep/wake reconnect bug is already fixed, commit `b830aa3`.)*
- **Features (queued in `th108-feature-roadmap.md`):** LCD adjustments (Rotate/Gamma/Speed) + GIF stats; the redesign tooling (debug-wireframe toggle, enhanced Edit-Layout, new Arrange mode); LCD↔key media-input unification; Advanced Keys / Profiles / Macros from sniffs.
- **Merging `gif-lcd-merge` → master:** do this (with the user's OK) BEFORE starting, so you refactor from one stable line.

## Success criteria
- The controller's inline script is meaningfully smaller; logic lives in focused modules with clear responsibilities.
- `node --test` (engine + daemon) green; HTML syntax-checks clean.
- User confirms lighting, GIF→key, onboard effects, LCD upload, Export/Import, reset buttons, and sleep/wake reconnect all behave **exactly** as before.
- No new features, no behavior changes, no build step introduced.

## First steps for the new model
1. Read `_HANDOFF.md`, then the memory files in its §9.
2. Confirm with the user: merge `gif-lcd-merge` → master first? (it's verified, just needs the go-ahead.)
3. Propose the extraction plan (use the superpowers brainstorming → writing-plans flow), then extract module #1 (`th108-hid.js`), verify, commit — and only then move to #2.
