# Advanced Keys UI — design (2026-06-11)

Add the official driver's four "advanced key" behaviors — Combination, Mod-Tap, Toggle, SOCD —
to the controller's Hotkeys tab, using the keymap entry types wire-captured on 2026-06-11
(`CB_ex1.txt` / `MT_ex1.txt` / `Tgl_ex1.txt` / `SOCD_ex1.txt`, parsed with `_parse_sniff.js`).
No new wire commands: all four are 4-byte entries in the same 512-byte keymap the binder
already reads + rewrites via `keymapRMW`.

## What each type does (this copy also goes in the card UI)

| Type | Entry | Plain English |
|---|---|---|
| Combination (CB) | `[0x07, modHID, modHID, keyHID]` | One key presses a whole shortcut — e.g. M acts as L-Alt + R-Ctrl + C. |
| Mod-Tap (MT) | `[0x09, clickHID, holdHID, time]` | Tap = one key, hold = another — e.g. tap Y types Y, hold Y acts as Tab. |
| Toggle (TGL) | `[0x0a, keyHID, 0, 0]` | Tap toggles another key held down — e.g. K toggles R held (autorun in games). Tap again to release. |
| SOCD | `[0x0b, mode, hidA, hidB]` on **both** keys | Pairs two opposing keys (A/D, ←/→): when both are physically down, the rule decides which wins. Mode 3 = last pressed wins. |

Wire ground truth (from the captures):
- CB on M: `07 e2 e4 06` = L-Alt(0xe2) + R-Ctrl(0xe4) + C(0x06).
- MT on Y: `09 1c 2b 28` = click Y(0x1c), hold Tab(0x2b), time 0x28=40 (the official default; units unknown).
- TGL on K: `0a 15 00 00` = R(0x15).
- SOCD on ←/↓: `0b 03 50 51` written **identically to both key slots**; second capture U/I `0b 03 18 0c` confirms. Mode byte = 3 in every capture; the other official mode options are **uncaptured** — only mode 3 ships, labeled "Last Pressed Wins (the only wire-captured mode)".

## UI

New `Advanced Keys` card (`#advKeysCard`, `data-pages="hotkeys"`) beside Decorative Light Toggles.

- Target key = the existing Pick-a-Key board selection (`KBOARD`), same gating as the binder:
  needs Connect, needs a selection, Fn excluded, disabled while a keymap pass runs.
- Four type buttons (`patbtn` style). Selecting one shows its one-line description + form + Apply:
  - **Combination**: [Mod1 ▾] + [Mod2 ▾] + [Key ▾]. Mod dropdowns = the 8 modifier HIDs
    (L/R Ctrl, Shift, Alt, Win). Both mods required — that is the captured shape; a single-mod
    variant (0x00 in a mod byte) is plausible but untested, deferred until a hw test.
  - **Mod-Tap**: Tap [Key ▾, defaults to the selected key's own character] · Hold [Key ▾] ·
    threshold [number 1–255, default 40] with hint "40 = official default; units unknown".
  - **Toggle**: Toggles [Key ▾] held on/off.
  - **SOCD**: Partner [board-key ▾ — every key with a default HID except Fn and the selected key].
    Mode shown as fixed text "Last Pressed Wins (mode 3 — the only captured mode)".
    Apply writes the SAME entry `[0x0b, 3, selHID, partnerHID]` to BOTH key slots in ONE keymap pass.
- Key dropdowns reuse the binder palette's basic + extended lists (label → HID).
- Hint mentions the official tool caps advanced keys at 40; we do not enforce it.

## Persistence, marks, removal

- Applied keys get `th108_key_mods` entries `{label, bytes, pair?}` — `pair` = the other key's
  value, present only on SOCD pairs (both directions). Board marks use compact labels:
  "Alt+Ctl+C", "Y⇄Tab", "TGL R", "SOCD ←" / "SOCD ↓".
- Because bytes are stored, **Restore Default, Backup/Restore, and the group toggle work on
  advanced keys with zero changes** — except SOCD pairing:
  - `normalizeMods` preserves a valid `pair` (integer key value; dropped if the partner entry
    is missing).
  - **Restore Default on a paired key restores BOTH keys in one pass** (a half-removed SOCD is
    undefined firmware behavior). The confirmation copy on the button/hint says so.
  - The group toggle needs no pair logic: both keys carry their own bytes entries, so a
    `→ Typing` pass parks both and `Back to Custom` restores both in the same pass.
- Re-assigning either SOCD key via the normal palette overwrites that key's entry and drops the
  partner's `pair` link the next time mods are saved — acceptable; the partner keeps working as
  a (now unpaired) SOCD entry the user can restore normally. (Cheap to revisit if it annoys.)

## Code shape

- Extend `th108-binder.js` (it owns keymapRMW / mods / marks; a separate module would widen a
  private contract). New pure exports: `encodeCB(mod1, mod2, key)`, `encodeMT(click, hold, time)`,
  `encodeTGL(key)`, `encodeSOCD(hidA, hidB)`, plus `MODIFIER_HIDS` and the advanced-type constants.
- Card UI lives in `create()` like the decorative toggles; Apply paths call the existing
  `keymapRMW` + `setMod` (extended with the optional `pair` argument).
- `th108-controller.html`: the card markup only; no new module loads.

## Testing & verification

- Unit tests assert encoder output **byte-for-byte against the four captures**, SOCD pair
  round-trips through `normalizeMods`/`groupPlan` (pair preserved, both keys park + return),
  and the pair-restore plan touches both slots.
- `node --check`, the HTML `<script>` syntax check, full `node --test` suite.
- Playwright smoke on :8123: card renders, forms gate correctly disconnected, no console errors.
- First hardware test (user): one CB bind → verify chord → Restore Default; then a SOCD pair on
  A/D → verify last-pressed-wins → Restore Default (confirms both slots restored).

## Out of scope (queued)

- SOCD modes other than 3 (needs one capture per official mode option, same key pair).
- Single-modifier CB (needs one capture or a deliberate hw test of a 0x00 mod byte).
- Mouse scroll up/down (not mask-based; needs a capture).
- DKS / RS types seen in the vendor bundle's advanced map (not in the TH108 official UI).
