# Profile Cycling — Design Spec (2026-06-28)

## Context / what already exists

Most of the original "profile cycling" idea **already shipped** with the Host Actions feature (2026-06-25), after the planning memory was written — so the memory's "architectural hurdle" (live switch, daemon hotkey detection) is stale.

Already working today:
- Bind any key / chord / multi-tap / hold to **Profile → Next / Previous / Jump to profile N** in the Host Actions tab (`th108-binder.js`).
- The **daemon** detects the hotkey via `uiohook-napi` and switches profiles **live, no page reload** (`daemon.js applyProfile` → `E.applyConfig`), persists to `CONFIG_PATH`, and works **with the page closed**.
- Profiles sync to the daemon via `POST /profiles` (`th108-profiles.js` → `server.js` → `daemon.js setProfiles`).
- Profile storage: `localStorage th108_profiles` = `[{name, layers, order, savedAt}]`, max 10.
- A proven **transient-overlay pattern**: the now-playing track-change flash (`daemon.js` ~L463) lights `DIGIT_KS` / `NUMPAD_KS` for 150 ms in a color, injected into the flat frame after `composite()`. `DIGIT_KS` / `NUMPAD_KS` (LED indices for digit keys 1–0 on the number row / numpad) are precomputed at daemon startup.

## What this spec adds

1. **Profile types** — Lighting / Hotkey / Global, so a cycle can change lighting, hotkeys, or both.
2. **Per-profile color** + an **on-keyboard number flash** when a profile becomes active.
3. Making **manual Apply live** (drop the page reload).

## Decisions (locked in brainstorm)

- **Cycling model:** one mixed, ordered ring (approach A). The existing Profile→Next/Prev/Jump bindings traverse it; each profile applies only its type's aspect.
- **Hotkey profiles swap Host Actions only** — NOT the firmware keymap. Rationale: the daemon has no keymap-write capability, keymaps can only be written page-open over WebHID, a 512-byte firmware write per cycle is slow and has a history of scrambling keymaps. Host Actions are daemon-held and swap instantly, page-closed.
- **Scope boundary:** cycling + flash run in **daemon mode** (the normal always-on driver). While the page is Connected/driving (GIF/LCD/onboard tools), the daemon is paused, so a cycle only persists the choice for when the daemon resumes — no live drive, no flash. Page-open live cycling is explicitly out of scope.
- **Flash duration:** ~1000 ms (constant for v1).

## 1. Data model

Extend each `th108_profiles` entry:

```
{
  name, layers, order, savedAt,   // existing
  type:  'lighting' | 'hotkey' | 'global',   // default 'lighting' for pre-existing entries
  color: '#rrggbb',                           // flash color; auto-assigned distinct default, user-editable
  hostActions: [ ... ]            // captured Host Actions snapshot; present only for 'hotkey' | 'global'
}
```

Two **global** indicator settings (not per-profile), persisted on the page (`localStorage`, e.g. `th108_profileIndicator`) and pushed to the daemon:

```
{ indicatorOn: true,             // show the number flash on switch
  indicatorKeys: 'numberRow' }   // 'numberRow' | 'numpad'
```

Back-compat: a loaded profile with no `type` is treated as `'lighting'`; no `color` → assigned a default by index; no `hostActions` → empty.

## 2. Capture (Save / Update a profile)

When the user Saves or Updates a profile, capture per its `type`:

- **lighting** → `layers` + `order` (unchanged from today).
- **hotkey** → the current Host Actions (`localStorage th108_host_actions`), **excluding** any binding whose action is `profileNext` / `profilePrev` / `profileSelect`. (Layers not captured.)
- **global** → both the above.

**Why exclude cycle bindings:** so applying a Hotkey/Global profile can never overwrite the very key you cycle with. This exclusion is a pure function (`stripCycleBindings(actions)`), unit-tested.

## 3. Apply (cycle / jump / manual)

`daemon.js applyProfile(p)` branches on `p.type`:

- **lighting** → `state = E.applyConfig(state, p.layers)` (today's path) + persist `CONFIG_PATH`.
- **hotkey** → `setHostActions( mergeKeepingCycle(p.hostActions, currentActions) )` — apply the profile's non-cycle bindings while **preserving the live profile-cycle bindings** from the current set. Persist. Do NOT touch layers.
- **global** → both.

`mergeKeepingCycle(profileActions, liveActions)` = `profileActions` (already cycle-free from capture) **plus** the cycle bindings extracted from `liveActions`. Pure function, unit-tested.

Persistence happens regardless of `paused` (as today: `applyProfile` writes config before the `if (!paused)` live-apply guard), so a switch made while the page drives takes effect when the daemon resumes. The host-actions swap likewise persists (`saveHostActions`).

The page must mirror a hotkey/global apply into its own `localStorage th108_host_actions` so the Host Actions tab reflects the active set after a manual Apply. (For daemon-fired cycles while the page is closed, the page re-reads on next load.)

**Manual Apply (Profiles tab) becomes live — no `location.reload()`:** the page (a) updates itself in place — write `th108_layers` / `th108_layerOrder` (lighting/global), rebuild the layer cards (`LUI.restore()` + `LUI.buildCards()`), mirror host-actions into `localStorage th108_host_actions` (hotkey/global); and (b) tells the daemon to run the same switch by calling a new **`POST /apply-profile { index }`** endpoint → `control.applyProfileByIndex(i)` → the daemon's `selectProfile(i)` (live apply + flash). Using the explicit index (not a raw `/config` push) is what lets the daemon render the flash and stay in sync on `curProfile`. In daemon mode this drives + flashes the board; while the page is Connected/driving, the daemon is paused so it only persists the choice (no flash — consistent with the scope boundary). This removes the long-standing reload hurdle.

## 4. Number flash (daemon-rendered overlay)

Mirror the now-playing flash:

- State: `profileFlashAt` (ms timestamp), `profileFlashColor` (hex), `profileFlashLed` (one LED index).
- On any profile switch (`cycleProfile` / `selectProfile` / manual apply path), if `indicatorOn`: set `profileFlashAt = now`, `profileFlashColor = p.color`, and `profileFlashLed = (indicatorKeys === 'numpad' ? NUMPAD_KS : DIGIT_KS)[curProfile]`.
  - Mapping: profile index `curProfile` (0-based) → digit key. `DIGIT_KS[0]` = "1" key … `DIGIT_KS[9]` = "0" key, so profile 10 → "0". (Max profiles = 10 = exactly the 10 digit keys.)
- In the frame loop, after `composite()` builds `flat`: if `profileFlashAt` and `now - profileFlashAt < 1000`, overwrite that one key's RGB in `flat` with `profileFlashColor`. At `>= 1000`, clear `profileFlashAt`.
- No-op when `indicatorOn` is false.

## 5. UI (Profiles tab, `th108-profiles.js`)

Per-profile card additions:
- **Type** dropdown: Lighting / Hotkey / Global.
- **Color** swatch (`<input type=color>`) + a small color chip shown on the card.
- Update/Save respects the selected type for capture.

A small **Indicator** settings row (once, top or bottom of the Profiles tab):
- On/off toggle (`indicatorOn`).
- Number-row / Numpad toggle (`indicatorKeys`).

A one-line hint: cycling is bound on the **Host Actions** tab (Profile → Next / Previous / Jump to profile N).

Push path: `POST /profiles` body extended to carry `type`, `color`, `hostActions` per profile; indicator settings pushed too (extend `/profiles` body or a sibling field). `server.js` + `daemon.js setProfiles` updated to store them.

## 6. Testing (pure, no hardware)

Add to the daemon unit tests (`node --test`):
- `stripCycleBindings(actions)` removes only profileNext/Prev/Select, keeps the rest.
- `mergeKeepingCycle(profileActions, liveActions)` yields the profile's non-cycle bindings plus the live cycle bindings, with no duplicate cycle bindings.
- profile-index → LED mapping: index `i` → `DIGIT_KS[i]` / `NUMPAD_KS[i]`; index 9 → the "0" key.
- flash time-window: active for `[0, 1000)` ms, cleared at `>= 1000`.

Keep the existing engine (76) + daemon suites green.

## 7. Files touched

- `th108-profiles.js` — schema (type/color/hostActions), per-profile type+color UI, indicator settings row, capture-by-type, push to daemon, live manual-Apply (no reload).
- `th108-daemon/daemon.js` — `applyProfile` apply-by-type with cycle-binding preservation; `profileFlash*` overlay in the frame loop; store indicator settings; reuse `DIGIT_KS`/`NUMPAD_KS`.
- `th108-daemon/server.js` — carry the new `/profiles` fields + indicator settings.
- `th108-controller.html` — live Apply wiring (`applyData` without reload), indicator settings wiring.
- A small **pure helper** for `stripCycleBindings` / `mergeKeepingCycle` (in `th108-daemon/host-actions.js` or a new tiny module), unit-tested.

## 8. Out of scope (v1)

- Keymap remaps in profiles (Host Actions only).
- Page-open live cycling / flash (daemon mode only).
- Separate per-type cycle rings (single mixed ring only).
- A configurable flash duration (fixed ~1 s).

## Hardware-safety note

No new firmware-flash writes. Host-actions swaps are in-memory + JSON persistence. The flash is an in-frame RGB overlay (same class as the existing now-playing flash). Daemon must be **restarted** to pick up the new engine/daemon code (standard for daemon changes).
