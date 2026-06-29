# HANDOFF — 2026-06-28 — NumLock / System white-LED RE (fresh chat)

> Durable rules/protocol/roadmap: **`_HANDOFF.md`** (gitignored) + project memory. This file = the focused next-task brief.
> Start a **NEW chat** on this; deeper context auto-loads from the `th108-numlock-re-handoff` memory. Read this whole file, then [[th108-numlock-re-handoff]], [[th108-lighting-protocol]], [[th108-keymap-binder]].

## The mission
Suppress the white LED the firmware forces on a **lock key** (NumLock / CapsLock / ScrollLock) while that lock is ON. The user keeps **NumLock ON** (uses the numpad), so its key is permanently white and overrides custom lighting. **NumLock is the priority** (Caps off, Scroll already rebound). User-flagged **"major"** want.

## ✅ Proven dead — DO NOT REDO
- Our full-frame `0x32` paint **does reach** the lock keys (INDICES: NumLock=33, CapsLock=58, ScrollLock=14).
- **Paint-over is DEAD.** A 30fps hardware diagnostic (forcing true 30fps sends, well above the engine's 1fps static keepalive) ran on all three lock keys: a lock key with its lock **ON stays SOLID WHITE** even at 30fps; **OFF** keys take our color fine. The firmware asserts the USB-HID lock-LED state **below** where `0x32` per-key paint reaches. The diagnostic was reverted. **Do not try to beat it with lighting.**

## The RE plan (recon-first, clean-room, NEVER fuzz)
1. **Tooling already at repo root:** `_hid-sniff.js` (paste into the OFFICIAL Epomaker tool's DevTools console — hooks `HIDDevice.prototype.sendReport` + `inputreport`; `__hidlog_dump()` auto-copies) and `_parse_sniff.js` (`node _parse_sniff.js capture.txt` — census of OUT cmds, reassembles `0x22` keymaps, prints unknown cmds in full). User has sniffed the official tool before (LCD work).
2. **Recon FIRST:** open the official Epomaker software and hunt the UI for ANY setting touching lock/indicator lights ("indicator", "lock light", Caps/Num/Scroll light, "indicator color", Lighting→indicators). RE can only succeed if such a setting EXISTS — the white may be hardwired firmware behavior the vendor's own software can't disable either.
3. If a setting exists: `__hidlog_clear()` → toggle ONLY that setting once → `__hidlog_dump()` → `node _parse_sniff.js` → replicate the captured command safely.
4. If NO setting exists: RE is a dead end → use the fallback.
5. **CONFIRM WITH USER AT START:** is their official Epomaker tool the **WEB** one (browser WebHID — DevTools paste works as-is) or a **DESKTOP** app (needs DevTools access via its webview)?

## 🛑 CRITICAL SAFETY
**NEVER blind-fuzz command bytes.** The board **soft-bricked once** from a bad flash write and not even the in-app factory reset recovered it — only Epomaker's official site reset did. **Only send commands captured verbatim from the official software.** Known cmds: `0x32` full-frame paint · `0x22` keymap write · `0x23` onboard effect · `0x50` LCD · `0x0F` reset.

## Fallback (host-side, no RE, tools we already have)
Keep **NumLock OFF** (→ no white) and **remap the numpad keys → top-row digit scancodes** via the keymap binder (`0x22`, see [[th108-keymap-binder]]) so the numpad still types 1-0 with NumLock off.
**Caveats (get user buy-in):** numpad keys become top-row digits → Shift gives symbols not digits, and the NumLock-off nav-cluster funcs (Home/End/arrows) are lost. Likely acceptable since the user only uses it as a number pad.

## Repo state right now
- **Branch `profile-cycling`** holds the just-finished **Profile Cycling** feature (types lighting/hotkey/global · per-profile color + ~1s blinking number-flash · live Apply (no reload) · Duplicate / Add-New / Copy-from with undo · indicator on/off + numpad toggle · iso-view default zoom scales −11%/layer). It is **NOT yet merged to `master`** — user said it "seems finished"; awaiting an explicit "merge it." The white-LED work is unrelated and can start from `master` (merge profile-cycling first if you want a clean line).
- Unit suites green at last check: `node --test profile-cycle.test.js th108-engine.test.js th108-layers-ui.test.js th108-profiles.test.js` + `cd th108-daemon && node --test`.
- Daemon is running/supervised — **ONE controller at a time** ([[th108-daemon]]). For the RE you'll drive the OFFICIAL tool, so **quit/yield our daemon first** to avoid two device owners fighting.

## Hard rules (project-wide)
- Commits authored as `Beyon <you@example.com>`, **NO Claude / Co-Authored-By trailer**: `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "..."`
- Never commit Epomaker's copyrighted bundles (`app.*.js`, `chunk-*.js`, `*.js.txt`) — reference-only, clean-room.
- American spelling. PowerShell host (win32). After editing an HTML page, syntax-check its inline `<script>`; after editing a `.js`, `node --check`.

## Next action
Confirm with the user whether their official Epomaker tool is **web or desktop**, then **recon the official software's UI for a lock/indicator-light setting** before any sniff. If such a setting exists, sniff that ONE toggle and replicate it; if not, present the NumLock-off + numpad-remap fallback for buy-in. **Do not fuzz.**
