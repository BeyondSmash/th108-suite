# TH108 Live Lighting Controller

Host-driven, per-frame RGB control for the **Epomaker TH108 V2 PRO** straight from a web browser
over **WebHID** — no firmware mod, no vendor software running.

Its signature trick is something the stock firmware **cannot** do: it composites **two independent
live layers every frame** —

- a **pulsing cyan background** (animated host-side), and
- a **keypress-reactive yellow-orange foreground** (each pressed key flashes and fades),

— and pushes the combined per-key frame to the keyboard ~30–60 times a second.

> Status: working proof-of-concept. `webhid-test.html` is the bring-up/diagnostic page;
> `th108-controller.html` is the actual effect controller.

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
- [ ] **Side / edge LED strips** and the **ring LED** by the screen (extra LED indices — discovery in progress)
- [ ] **LCD screen**: custom image/GIF with a **live time overlay** (separate pixel-streaming command)
- [ ] **Always-on native host** (no browser tab): tray daemon with a global keyboard hook so the
      reactive layer works type-anywhere, not just while a tab is focused

## Legal / IP

This is an independent interoperability project. The HID protocol is documented from observed device
behaviour (clean-room). No vendor firmware, software, or bundled assets are included or redistributed.
"Epomaker" and product names are trademarks of their respective owners; this project is not affiliated
with or endorsed by Epomaker.

## Requirements

- A Chromium browser (Chrome/Edge) — WebHID isn't available in Firefox/Safari.
- The keyboard connected via USB. The vendor software does **not** need to be running.
