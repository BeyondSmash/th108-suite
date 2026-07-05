# Defaults Authoring Test-Env + First-Run Seeding — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorm) — pending spec review
**Related:** `th108-defaults-test-env` memory, `th108-packaging-exclusions` memory, roadmap item 11 (pre-ship, do last)

## Problem

Before the TH108 controller ships on GitHub Pages, new visitors need a curated **default lighting state** on first run instead of the generic `TH108Engine.defaultLayers()` (background/reactive/gradient/media). Beyon should author those defaults by tuning a real setup — but the authoring must **never modify his personal config** (the non-negotiable constraint).

Two pieces:
1. **Authoring test-env** — an in-app sandbox, seeded from Beyon's current setup, where he tunes the look and exports it.
2. **First-run seeding** — a brand-new visitor (empty storage) auto-loads the exported defaults as their starting state.

## What ships vs. what's stripped

The shipped product is the **GitHub Pages site (page-only)** plus an *optional* daemon. A first-run web visitor has no daemon, so the authored default is the **page-side localStorage state**. Daemon settings (now-playing, LCD) are a separate concern and are NOT part of `defaults.json` (a new visitor has no daemon; defaulting now-playing on would look broken).

**SHIP** (a new visitor inherits these):
- `th108_layers` + `th108_layerOrder` — the tuned lighting layer stack (the core look)
- `th108_bri` + `th108_lightsOn` — brightness / lights-on
- `th108_theme` — color theme

**STRIP** (personal/machine — removed at export):
- `th108_profiles` — Beyon's personal profile collection (a new visitor gets only the single default state, no profile list)
- `th108_host_actions` — personal key→action bindings
- `th108_keymap_backup` + `th108_key_mods` — personal keymap remaps
- `th108_rgb_calibration` — machine/board-specific color calibration
- `th108.autoConnectFocus` + `th108.hideYieldBanner` — personal connect prefs
- `th108_layout2` + `th108_cardfill` + `th108Zebra` + `th108_page` + `th108_space_restore_pending` — card arrangement / UI state / transient
- `th108_iso_view` / `th108iso` — iso-view settings (new visitors get the baked-in code defaults)
- IndexedDB `th108media` — personal media library (GIFs/images)

The ship/strip split is a **hardcoded manifest** in the export logic — Beyon does not curate it by hand each time. (Adjustable in code if the key set changes.)

## Architecture

Three cohesive units, each independently testable:

### 1. `th108-defaults.js` (new module, UMD — page + testable)

Pure, DOM-free logic. No side effects; operates on plain objects.

- `DEFAULTS_PREFIX = 'th108_DEFAULTS_'`
- `SHIP_KEYS` / `STRIP_KEYS` manifest (the lists above).
- `snapshotFrom(readFn)` → collect the current `th108_*` values into a plain object (deep copy). `readFn(key)` abstracts the storage read so it's testable.
- `stripForExport(snapshot)` → return a new object with only the SHIP keys (drop STRIP keys). This is what becomes `defaults.json`.
- `isDefaultsMode()` → reads the URL flag (`?defaults=1`) — the single source of truth for "are we authoring."

Unit tests: `snapshotFrom` copies all keys; `stripForExport` keeps exactly the ship set and drops every strip key (guard against a new key silently shipping); round-trip stability.

### 2. Storage shim (in `th108-controller.html`, at the very top of page init)

Runs **before any other script reads storage**. When `isDefaultsMode()`:
- Monkey-patch `localStorage.getItem/setItem/removeItem`: for any key starting with `th108`, transparently rewrite to the `th108_DEFAULTS_` prefix. All other keys pass through untouched.
- On first entry (no `th108_DEFAULTS_th108_layers` yet), **seed**: copy each live `th108_*` value into its prefixed counterpart (deep copy via the raw, un-patched accessors). This is the "start from your current setup."
- IndexedDB media (`th108media`) is left shared read-only in the sandbox (authoring rarely re-tunes media; not prefixed to avoid a second IDB). Export strips it regardless.

Because every existing call site already goes through `localStorage.getItem('th108_...')`, the shim redirects the **entire UI** with zero call-site changes. This is the crux that makes the sandbox cheap.

### 3. Sandbox UI (banner + Export, in the controller)

- A persistent **banner** while in defaults mode: "⚑ Authoring Defaults — your personal config is untouched" + an **Exit** link (drops `?defaults=1`).
- An **Export Defaults** button: `stripForExport(snapshotFrom(...))` → download `defaults.json` (and/or write to the repo path the build bundles). 
- Board preview: the normal **Drive from this Tab** path already renders the active (scratch) config over WebHID; nothing special needed beyond the banner making clear the board now shows the sandbox.

### 4. First-run seeding (consumer side, in the controller boot)

- On normal boot (NOT defaults mode), if `th108_layers` is absent/empty (brand-new visitor), fetch the bundled `defaults.json`, write its keys into real localStorage, then proceed with the normal restore path.
- Guard: only seeds once, only when truly empty (never clobbers a returning user). A `th108_seeded` flag prevents re-seeding if the user later clears just their layers.

## Data flow

```
Author:  ?defaults=1  ->  shim seeds th108_DEFAULTS_* from live config
         tune in normal UI (writes go to th108_DEFAULTS_*)
         Drive-from-Tab -> scratch look on the board
         Export -> stripForExport() -> defaults.json  (personal keys dropped)

Ship:    defaults.json bundled with the GitHub Pages site

New visitor:  empty th108_layers -> fetch defaults.json -> seed real localStorage
              -> normal restore -> sees the curated default look
```

## Isolation guarantees (the hard constraint)

- The shim only activates on `?defaults=1`; a normal load never touches scratch keys.
- In defaults mode, **every** `th108*` read/write is prefixed, so the real keys are never read or written.
- The daemon's `config.json` is never touched by authoring (the page drives the board directly via WebHID; the daemon keeps running the real config).
- Seeding copies FROM real → scratch (one-way); export copies FROM scratch → file. Real config is only ever a read source, never a write target.

## Error handling

- `defaults.json` missing/malformed at first-run seeding → fall back to `TH108Engine.defaultLayers()` (current behavior); log a warning; do not block boot.
- Export with an empty scratch (no tuning yet) → still valid (exports the seeded copy); no special case.
- Shim applied but `?defaults=1` removed mid-session → the flag is read once at boot; exiting reloads without the flag (clean state swap).

## Testing

- **Unit** (`th108-defaults.test.js`): `stripForExport` keeps exactly SHIP, drops every STRIP key (fails if a new unlisted key appears — a tripwire against accidentally shipping personal data); `snapshotFrom` deep-copies; `isDefaultsMode` parses the flag.
- **Manual** (documented steps): enter `?defaults=1` → confirm banner + that real `th108_layers` is unchanged in devtools; tune + Drive-from-Tab → board shows scratch look; Export → inspect `defaults.json` has no stripped keys; simulate first-run (clear localStorage, remove flag, reload) → curated look loads.

## Out of scope

- Daemon-side default seeding (the daemon's `config.json` for installed-daemon users) — separate follow-on if needed.
- Curating multiple shipped themes/profiles — a single default state ships.
- Any change to the existing personal-config formats.

## Open items for spec review

- Confirm the ship/strip manifest (esp. theme=ship, iso-view=strip, profiles=strip).
- Confirm `defaults.json` location/format the GitHub Pages build will bundle.
