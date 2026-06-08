# LCD Clock Control — Design

**Date:** 2026-06-07
**File touched:** `th108-screen.html` (single-page, self-contained)
**Status:** approved approach (Part A + probe for B)

## Goal

Let the user manage the TH108 V2 PRO's built-in clock from the host:

- **Part A (confirmed):** push the PC's current time to the keyboard's clock — same as the official
  "Time Correction" button.
- **Part B (experimental):** discover whether the LCD can be switched between the GIF and the
  built-in clock screen from software (instead of the physical FN+knob menu), via `cmd 0x51`.

## Background / protocol (wire-captured 2026-06-07)

"Time Correction" sends one 64-byte report (report id 0) on the **vendor control interface**
(`usagePage 0xFF68`, `usage 0x61`), using the same `buildPkt_final` framing as the per-key paint:

```
aa 34 38 00 00 00 01 00 | 5a 01 5a | 1a 06 07 14 07 13 | 00…
^prefix
   ^cmd 0x34 (set time)
      ^payloadLen 0x38=56
                  ^isLast=1 (byte[6])
                          payload@byte[8]: 5a 01 5a = fixed preamble
                                           then [yy, mm, dd, hh, mi, ss] in PLAIN BINARY
                                           (yy = year-2000; e.g. 1a 06 07 14 07 13 = 2026-06-07 20:07:19)
```
Device ACKs with `55 34 …` echoing the bytes = success.

The clock is a **built-in firmware screen** (physically: FN+knob press → scroll right 1–2 → click to
select). `0x34` only keeps that screen's time accurate; it does **not** overlay the clock on the GIF.

## Implementation note (2026-06-07, as built)

The "two interfaces" assumption below turned out to be unnecessary: the existing `switchSlot()`
already sends `cmd 0x51` successfully on the **screen interface** (the big-report one), so control
commands are accepted there. The clock `0x34` is therefore sent on the same screen interface
(`reportId`, `reportLen`-byte packet) as `switchSlot`, with no second interface opened. If hardware
testing shows no `55 34` ACK, the fallback (open the `0xFF68` control interface) is logged as a hint.
Part B's probe was already present as the `switchSlot` control — so only Part A (the time-sync) was new.

## Key architectural point: two interfaces (superseded — see implementation note above)

`th108-screen.html` currently binds only the **screen interface** (the one with the ~4104-byte output
report) for GIF uploads (`cmd 0x50`). The clock (`0x34`) and slot-switch (`0x51`) are 64-byte control
commands that belong on the **`0xFF68` / usage `0x61` control interface**. So:

- `connect()` must additionally locate and open the control interface (vendorId `0x0C45`,
  usagePage `0xFF68`, usage `0x61`, 64-byte output report) alongside the screen interface.
- Store it as e.g. `ctrlDevice` (separate from the existing screen `device`).
- If the control interface can't be found/opened, disable the clock + probe controls and show why
  (GIF upload still works on the screen interface alone).

## Components

### Part A — "Sync clock to PC time"
- New "Clock & screen" section in the page UI, near the upload controls.
- `buildTimePkt(date)` → 64-byte `Uint8Array`: `aa 34 38 00 00 00 01 00`, then payload `5a 01 5a` +
  `[yy, mm, dd, hh, mi, ss]` (all plain binary, `yy = year-2000`), rest zero-padded to 64.
- `syncClock()` → `ctrlDevice.sendReport(0, pkt.slice(1))` *(report id 0; mirror how the existing
  send path slices the prefix — match the working `0x50`/`0x32` send convention in the file)*, wait
  for the `55 34` ACK (reuse the existing ACK-wait helper), log success/failure.
- Show the value being sent (formatted local time) in the log for transparency.

### Part B — experimental screen probe (`cmd 0x51`)
- Small "experimental" sub-row: a number input (slot index 0–7, default 0) + "Switch screen (0x51)"
  button.
- `buildSlotPkt(idx)` → 64-byte: `aa 51 <len> 00 00 00 01 00` + payload `[idx]` (exact preamble TBD —
  start from the documented `AA 51 … [8]=slotIndex` note; the probe itself confirms the format).
- `switchScreen(idx)` → send on `ctrlDevice`, wait for `55 51` ACK, log.
- Usage: with a GIF showing, step the index 0,1,2,… and watch the LCD. Note which index switches to
  the clock. Slot-switch is non-destructive (no flash write/wear).
- **Outcome decides next step:** if an index reaches the clock, a follow-up change promotes this into
  a clean "Show GIF / Show clock" toggle. If nothing switches to the clock, remove the probe and keep
  Part A only (clock stays reachable via FN+knob, time stays synced).

## Data flow

```
[Sync clock]  → buildTimePkt(new Date()) → ctrlDevice.sendReport → await 55 34 ACK → log ok
[Switch (n)]  → buildSlotPkt(n)          → ctrlDevice.sendReport → await 55 51 ACK → watch LCD
```

## Error handling

- No control interface → disable both buttons, log a clear reason; GIF upload unaffected.
- ACK timeout (reuse existing timeout helper) → log failure; do not wedge the upload state machine
  (clock/probe sends are independent of the GIF chunk loop).
- Guard against sending while a GIF upload is in progress (reuse the existing upload-in-progress lock)
  to avoid interleaving reports on the device.

## Out of scope (later)

- Auto-sync on connect / periodic resync (and a daemon resync) — add after Part A is confirmed.
- Promoting Part B to a real toggle — depends on probe outcome.
- Any clock face / pixel compositing (the clock is firmware-rendered; we don't draw it).

## Outcome (2026-06-07, hardware-tested)

- **Part A — DONE & confirmed.** Clock time-sync works once `0x34` is sent on the `0xFF68` control
  interface (the screen interface ACKs nothing). Verified: synced time matched the PC on the FN+knob
  clock screen.
- **Part B — CLOSED (negative result).** `0x51` ACKs (`55 51`) but does not change the LCD for slot
  indices 0–4. The board holds one GIF (single flash slot) and the clock is a firmware display *mode*
  reached only via the FN+knob menu — not a `0x51` slot. The official tool has no screen-switch button
  to capture either. No software Show-GIF/Show-clock toggle is possible with current knowledge; the
  `0x51` control is kept as an experimental/recovery primitive. Only remaining lead for a future
  attempt: a key-bindable "screen/watchface switch" function code (capture from the official tool's
  Custom/Advanced Keys assignment, then bind via the keymap).
- **12/24h format** is not in the `0x34` packet — separate firmware setting (FN+knob menu or official
  Settings page); pending a quick check.

## Verification

- Part A: click Sync, confirm `55 34` ACK in the log; switch the LCD to the clock (FN+knob) and verify
  the displayed time matches the PC.
- Part B: probe indices, record which (if any) shows the clock; report findings before promoting.
