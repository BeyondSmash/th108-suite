# TH108 Live Lighting Controller

Host-driven, per-frame RGB control for the **Epomaker TH108 V2 PRO** straight from a web browser
over **WebHID** — no firmware mod, no vendor software running.

Its signature trick is something the stock firmware **cannot** do: it composites **two independent
live layers every frame** —

- a **pulsing cyan background** (animated host-side), and
- a **keypress-reactive yellow-orange foreground** (each pressed key flashes and fades),

— and pushes the combined per-key frame to the keyboard ~30–60 times a second.

> Status: working on hardware. The signature two-layer controller is the headline, but the
> repo has since grown into a small **host-side suite** for the board (lighting, the LCD screen,
> key remapping, and an always-on background service).

## What's in here

| File | What it does |
|---|---|
| **`th108-controller.html`** | The headline effect controller — pulsing-cyan background + keypress-reactive orange, composited per-frame and streamed over WebHID. |
| **`th108-screen.html`** | LCD uploader for the on-board 160×96 screen — push a custom image/GIF with colour calibration, Crop/Fit framing, and letterbox bar fills. |
| **`webhid-test.html`** | Bring-up / diagnostic page, plus a **key-binder**: remap a physical key to a lighting function (the only way to reach the decorative LEDs — see below), with a spacebar focus-overlay mode. |
| **`th108-daemon/`** | Always-on Node service (`node-hid` + `uiohook-napi`) that runs the reactive lighting as a background process so it works in **any** app, no browser tab required. Includes login-autostart scripts. |

## Setup (Windows)

**Prerequisites:** Windows 10/11 · a Chromium browser (Chrome / Edge / Brave) · [Node.js LTS](https://nodejs.org).

1. **Run `setup.cmd`** (double-click it). It is the one-time installer and does everything:
   1. installs the daemon's dependencies (`npm install`),
   2. enables **auto-start at login** (per-user, no admin),
   3. adds a **Start-menu shortcut** ("TH108 Lighting"),
   4. installs two **optional admin helpers** behind a *single* UAC prompt — click **Yes** to get them, **No** to skip (the suite works either way):
      - **Auto-Fix Lighting Wedge** — a hidden recovery task that software-replugs the keyboard if its lighting ever stalls,
      - **WebHID pre-grant** — skips the browser's keyboard picker permanently,
   5. starts the **tray app** (which starts and supervises the daemon),
   6. opens the controller at `http://localhost:8123/`.
2. In the page, click **Connect Keyboard** once and pick your keyboard — the browser requires this click to grant WebHID (unless you accepted the pre-grant helper above and restarted the browser).

That's it. Lighting now runs in the background in every app, survives closing the tab, and starts at login.

**The tray icon** (salmon keyboard) is the suite's home — right-click for **Open Controller / Start / Restart / Quit Daemon**. Closed the tray? Re-open it from **Start menu → TH108 Lighting**.

**Starting it from the page:** the daemon registers a `th108://` protocol on first run, so the page's **Start Daemon** button (shown only when the daemon is down) can relaunch it via a browser prompt — no command line needed.

**Updating:** after pulling new code, restart the daemon to load it — **tray → Restart Daemon**, or the **↻ Restart Daemon** button on the page. (Skipped the admin helpers and want them later? Run, as admin: `powershell -ExecutionPolicy Bypass -File th108-daemon\install-admin-extras.ps1`.)

**Uninstall:** run `uninstall.cmd` (removes auto-start + the shortcut; leaves your saved layers). The admin helpers, if installed, are removed with their own scripts' `-Remove` flag / `Unregister-ScheduledTask`.

## Why the stock software can't do this

The TH108's on-board lighting runs **one** effect at a time. A reactive effect can carry a single
static background colour, but not an *independently animated* one. The vendor's "Musical Rhythm"
plugin does run two layers, but its foreground is **audio**-reactive (not keypress) and it isn't
persisted. There is no QMK/VIA firmware for this board — it's a proprietary web-driver model.

The opening: the lighting is ultimately just a **per-key RGB frame** the host streams over HID.
If the host computes the frame, the host decides what every key shows — so two layers, keypress
reactivity, anything, becomes possible.

## How it works

- The keyboard exposes a vendor HID interface (**usage page `0xFF68`, usage `0x61`**) with a
  **64-byte output report** (report ID 0). This is the control channel; the keyboard/consumer/mouse
  interfaces are read-only and irrelevant here.
- A **full-frame paint command** carries, for every LED, an `index, R, G, B` tuple. One frame =
  the whole board's colours. The host rebuilds and resends this frame each animation tick.
- No "enter custom mode" handshake is required — the board renders the streamed frame immediately
  and acknowledges each report.
- The controller maps browser `KeyboardEvent.code` → physical LED index (a table captured from the
  device), so a `keydown` lights exactly the key you pressed.

### Protocol summary (clean-room, observed behaviour)

The frame command writes a small header followed by a payload of `index,R,G,B` quads, split across
as many 64-byte reports as needed (payload ~56 bytes per report). Each report's header carries the
command id, this report's payload length, the running byte-offset into the frame, an auxiliary byte,
and a "last report" flag. The keyboard echoes each report back as an acknowledgement. That's the
entire mechanism for live per-key colour — everything else (the pulse, the reactive decay, layer
compositing) is ordinary host-side maths before the frame is sent.

This repository documents the protocol **in our own words from observed behaviour**; it does **not**
include or redistribute any of the vendor's JavaScript, firmware, or assets.

## Closest existing projects (and how this differs)

| Project | Board(s) | Transport | What it does | Gap vs. this project |
|---|---|---|---|---|
| [OpenRGB](https://openrgb.org) (`EpomakerController`) | TH80 Pro, Attack Shark K86 (**VID 0x3151**) | native (hidapi) | Selects an **on-board effect mode** + one global colour | Doesn't support the TH108 V2 PRO (**VID 0x0C45**) at all; no per-key, no host compositing, no reactivity |
| [strodgers/epomaker-controller](https://github.com/strodgers/epomaker-controller) | Epomaker **RT100** (screen model) | Python CLI, USB-HID | Static per-key colours, system-monitor daemon, screen images | Different board; not browser-based; **not keypress-reactive**; no animated 2-layer composite |
| [agustinmista/qmk-rgb-live](https://github.com/agustinmista/qmk-rgb-live) | **QMK** keyboards | browser, WebHID | Live RGB-matrix control via QMK raw-HID | TH108 isn't QMK, so it can't drive this board; single-layer |
| [vinc3m1/kludgeknight](https://github.com/vinc3m1/kludgeknight) | Royal Kludge | browser, WebHID | Remap + select **on-board** lighting modes | Different vendor; mode-selection, not host-composited per-frame reactive lighting |

**The unoccupied niche this fills:** the TH108 V2 PRO specifically, in the browser, with **host-side
per-frame compositing of an animated background + keypress-reactive foreground** — a combination none
of the above provide.

## Roadmap

- [x] Reverse-engineer the per-key frame protocol; prove live per-key push over WebHID
- [x] Pulsing-cyan background + keypress-reactive orange controller
- [x] **LCD screen**: upload a custom image/GIF (160×96, RGB565) with colour calibration and framing
- [x] **Always-on host** (no browser tab): Node daemon with a system-wide keyboard hook so the
      reactive layer works type-anywhere, plus login-autostart
- [x] **Key remapping** to lighting functions via a full-keymap read-modify-write (`webhid-test.html`)
- [ ] **LCD live overlays** (e.g. a clock on top of the uploaded image) and a multi-slot GIF slideshow
- [ ] Normal-key / macro remapping and broader on-board-feature parity (profiles, advanced keys)
- [x] ~~Side / edge LED strips and the ring LED~~ — **investigated and sealed: these decorative LEDs
      are firmware-controlled and cannot be set or triggered from software.** The firmware only runs
      them in response to a physical matrix scan, and they expose no host-readable state. The one
      software-adjacent path is to *remap a physical key* to the decorative light function so a tap
      cycles it (e.g. the ring = Ambient zone → bind to the Super/Menu key) — done via the key-binder.

## Legal / IP

This is an independent interoperability project. The HID protocol is documented from observed device
behaviour (clean-room). No vendor firmware, software, or bundled assets are included or redistributed.
"Epomaker" and product names are trademarks of their respective owners; this project is not affiliated
with or endorsed by Epomaker. The name is used only to describe the hardware this software works with.

## License

Copyright © 2026 Beyon. Licensed under the **GNU General Public License v3.0** — see [`LICENSE`](LICENSE).

In short: you're free to use, study, modify, and share this software, but derivative works must
also be released under the GPL-3.0 (they can't be taken closed-source). As the copyright holder,
the author retains the right to offer the software under other terms as well.

## Requirements

- A Chromium browser (Chrome/Edge) — WebHID isn't available in Firefox/Safari.
- The keyboard connected via USB. The vendor software does **not** need to be running.

## Compatibility

- ✅ **Verified:** Epomaker **TH108 V2 PRO** — the only hardware this has been tested on.
- 🟡 **Possibly partial (untested):** the code matches on vendor id `0x0C45` + the vendor HID
  interface (usage page `0xFF68`, usage `0x61`), **not** a specific product id. `0x0C45` is
  **SONiX Technology**, a vendor id shared across many budget keyboards (several Epomaker models
  and other brands built on the same MCU), so the keymap + per-key paint protocol is likely a
  **SONiX-family** protocol that *may* carry over to siblings. Three things are board-specific
  and would need per-model work: the **LED index map** is hardcoded for the TH108 V2 PRO layout
  (a different layout paints the wrong keys), the **LCD** commands assume this board's exact
  160×96 screen, and the calibration profile / decorative-LED findings are this board's firmware.
- ❌ Not a guaranteed drop-in for arbitrary `0x0C45` keyboards.

If you have a sibling board, re-capturing the `KeyboardEvent.code → LED index` map is the main
porting step — contributions welcome.
