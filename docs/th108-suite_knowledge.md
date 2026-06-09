# th108-suite — Project Knowledge & Roadmap

A consolidated reference for the custom Epomaker TH108 V2 PRO lighting suite: what was reverse-engineered,
what the hardware can/can't do, what's built, what's planned, the design rationale, and open questions.
Intended to be handed to Claude Code as durable context.

---

## 1. Goal & origin
- Original spark: get keypress-reactive yellow-orange keys AND a simultaneously pulsing cyan background —
  a combination the stock Epomaker software cannot produce.
- That investigation revealed the board is a host-driven frame sink, which opened the door to a full
  host-side lighting suite (`th108-suite`, public GitHub repo) that now far exceeds the original ask.

## 2. Hardware / system architecture (reverse-engineered)
- **Board:** Epomaker TH108 V2 PRO. Proprietary web-driver board; **no VIA/QMK JSON exists** for this model.
- **Control model:** host computes lighting on the PC and streams it to the board. The keyboard is a frame sink.
- **WebHID streaming gotcha (our push path), root-caused 2026-06-08:** the control interface (usagePage **0xFF68 / usage 0x61**, 64-byte reports) **ACKs every output write** with an input report `0x55 <cmd> <len>` (e.g. `55 32 38` for a 56-byte 0x32 paint chunk). You **must wait for that ACK before the next write** (ACK-gated streaming). Firing chunks ungated overruns the board's command FIFO; it tolerates ~3-4 s, then the HID pipe **wedges** — `sendReport` hangs forever (no error) and only a replug clears it. Frame rate is *not* the lever (the limit is per-write, not per-second); draining input reports alone isn't either (Chrome reads them regardless). The official MusicPlug's `ReadFile` is doing exactly this gating.
- **Vendor app `MusicPlug.exe`** (native C++/MFC; ships with mfc140/msvcp140/vcruntime140):
  - Captures **system audio via WASAPI loopback** (string: "Default Loopback Device").
  - Drives the keyboard over **raw HID**: `SetupDi*` enumeration -> `CreateFile` -> `WriteFile`/`ReadFile`;
    `HidD_GetIndexedString` present. **Reports are 64 bytes** (`push 0x40`).
  - Runs a **CORS-enabled localhost HTTP/JSON server** (WS2_32 + statically-linked JsonCpp).
    CORS header: `Access-Control-Allow-Headers: Content-Type` -> any-origin page may call it.
  - Contains a `ScreenLight` class (hints at live screen-lighting control).
  - Bundles `HardwareMonitor\` (LibreHardwareMonitor) -> can also drive lighting from CPU/GPU sensors.
  - `Music.exe` as distributed is an **Inno Setup 6.1.0 installer**; the real app is inside (`MusicPlug.exe`).
- **Localhost API endpoints found in the binary (GET):**
  - `/api/audio/amplitude`
  - `/api/hardware/info`
  - `/api/keyboard/layout/base64`
  - `/api/keyboard/musiceffect`
  - `/api/keyboard/musiceffect/close`
  - `/api/keyboard/musiceffect/layout`  (takes `layout=`; responds `{"status":"layout received via GET"}`)
- **JSON field literals:** `keyIndex`, `keyCode`, `color`, `backmodebrightness`, `amplitude`, `layouts`.
  - `color` per `keyIndex` = per-key FOREGROUND layer; `backmodebrightness` = BACKGROUND layer brightness.
- **Web driver SPA:** https://epomaker.driveall.cn (Vue). Relevant bundles:
  - `static/js/chunk-keyboard.0ff72ea3.js`  = keyboard + music logic (endpoint construction, payload shapes)
  - `static/js/app.a59971f3.js`             = likely localhost base URL / port
  - (Skip chunk-vendors / chunk-elementUI / chunk-pintura.)
- **Live capture:** HID/API objects were also sniffed in browser devtools (F12) and ferried to Claude Code.

## 3. Profile config format (decoded by differential diffing of exported profiles)
- `effectCurrent` + `allledPack` packet = active effect (effect code, RGB bytes, speed/params).
- `allColorPack` = `[index, R, G, B]` per key (126 entries).
- `colourful` flag: when `1`, effect auto-cycles color and `RValue/GValue/BValue` (255,255,255) are ignored;
  set `colourful=0` to use a fixed color in `RValue/GValue/BValue` and `allledPack[1..3]`.
- `Profilecurrent` = profile slot index (board supports multiple slots).
- Observed effect codes: single-point reactive = `effectCurrent 1` / `0x02`; **point-off reactive** =
  `effectCurrent 2` / `0x03` (carries one background color); breathing/pulse = `effectCurrent 6` / `7`;
  row-sequential reactive = `effectCurrent 12` / `0x0d`.

## 4. Firmware boundaries (what the board will NOT do on its own)
- On-board lighting runs **one effect at a time**; reactive and breathing are mutually exclusive codes.
- A reactive "point-off" effect carries a single background color, but no independent animated background.
- The firmware CAN composite a static color over an animation (white Num Lock proves it), but it's locked
  to lock-key indicators and tied to live key state. Per-key `infoColor` exists in the profile but is always null.
- **Simultaneous keypress-reactive + pulsing background is only achievable host-side** (compositing on the PC,
  streaming frames) — which is what the suite does.
- **GIF push blanks the lighting**: the firmware appears to halt the effect engine while writing media to flash.

## 5. Implemented features
- 4-layer lighting with blending (4 layers is the working standard).
- 20+ patterns, custom patterns included.
- GIF -> key-lighting translation pipeline.
- GIF library for the TFT/LCD screen.
- Parameter sliders across everything: color correction, speed/scale, **per-layer FPS sliders**
  (for optimization/aesthetics even where performance impact is negligible), plus specific toggles.
- **Inverse-delta color calibration** for the LCD: reproduced the panel's color cast on the monitor,
  inverted the correction deltas, applied as a standard correction preset (eyeball display-calibration LUT).
- Onboard decorative lighting toggle bound to a key (temporary: spacebar) to engage cycling/toggling.
- **Punch-through effect** toggle (dims base layers so reactive/alert layers read as a spotlight, not a blank).
- URL-paste box (paste image links) + clipboard auto-push as the media input for GIF->key.

## 6. In progress / planned
- Hotkey assignment.
- GIF switching on command or scheduled (slideshow), and GIF change on app startup / app active.
- Profile cycling indicated by a reactive one-shot on the number key matching the profile;
  candidate binding: "Super" or FN+[key].
- Share the URL/clipboard media-input component with the GIF->LCD pipeline (one input layer, all targets consume it).

## 7. New ideas (from latest design pass)
- **Screen-capture → key ambient lighting ("Ambilight for keys")** (verified lead, 2026-06-08): the official
  MusicPlug `ScreenLight` turned out to be exactly this — a KEY-lighting visualizer (web-driver `visualizerScreenLight`,
  mode 100) that drives the keys from screen content, NOT an LCD path. We can replicate it host-side: capture the
  desktop, downscale to the 104-key grid, stream via cmd 0x32 as a new engine **layer type**. Distinct from the LCD.
- **Claude Code agent-status layer** (functional, not just decorative):
  - Detect activity via Claude Code **hooks** (not terminal scraping). Map events ->
    SessionStart = enter "working" ambient; subagent spawn (SubagentStart, or PreToolUse matched on the Task tool)
    = +1 agent key; SubagentStop = -1; Notification = "waiting on you"; Stop/SessionEnd = clear.
  - Use **HTTP-type hooks** to POST straight to the suite's local API (no shell glue). Config in `.claude/settings.json`.
  - Docs: https://code.claude.com/docs/en/hooks
- **1 key = 1 subagent** display:
  - Works cleanly for <=4-5 agents (subitizing limit); add a fallback for more (a fill meter, or render a number).
  - **Twinkle/shimmer with per-key phase offset** to (a) read as "working" and (b) temporally segment adjacent
    keys so they look like discrete squares, not one bar. Keep subtle and out of phase.
  - Vertical stacking reads cleanly only on the numpad (true grid); main alpha cluster is row-staggered.
- **Mascot:** put the animated Claude mascot on the **TFT** (has the resolution to read as the mascot);
  put the per-subagent meter on the **keys** (glanceable). Two assets, one engine each side.
- **Attention-model split:** keys for glanceable/urgent status (peripheral, no focus needed, instant pushes);
  LCD for rich/ambient content you choose to look at (and which has off-axis color shift + needs foveal focus).
- **Progress bar:** 1 through 0 = clean 10%/key; backspace flashes as the "done" flourish. Generalizes to
  builds/downloads/task %. Use a single-hue saturation ramp (pale->saturated blue), not red->green
  (red collides with "error", and red/green is colorblind-hostile).
- **USB plug/unplug:** flash the spacebar green on connect, red on disconnect (host listens for OS device events).
- **Audio-sync key-lighting layer**, plus a **mic/input level meter**: here green->amber->red IS correct
  (universal VU language; red = clipping). Stereo L/R across the main area is a richer default than a numpad VU,
  and doesn't assume a numpad — make the zone configurable.
  - **Motivation (2026-06-08):** the official MusicPlug audio mode **didn't even work** for us → build our own.
  - **Feasible as a new engine layer type:** capture system audio (WASAPI loopback) and/or mic in the daemon
    (Node main process), FFT/amplitude → drive a visualizer layer → composite + stream via cmd 0x32 (the existing
    pipeline). MusicPlug's own `/api/audio/amplitude` endpoint confirms the amplitude→lighting approach; we compute
    it ourselves instead of depending on their server. Pairs naturally with the daemon (already host-side + always-on).
- **JPG/still-sequence pseudo-dynamic LCD:** single images may upload near-instantly; stream a folder of
  compressed stills as frames (host-side frame player) with bitrate/quality/compression sliders as the
  framerate throttle. Viability test: does a SINGLE image push blank the lights? If not, it's viable;
  if it blanks even briefly, expect strobing at speed.
- **Clipboard event indicator:** flash a key one color on copy (Ctrl+C/Ctrl+X) and another on paste (Ctrl+V).
  Lighting the **C** and **V** keys themselves is self-documenting, or use a dedicated indicator key/zone;
  a brief flash with decay (like the reactive keys) reads as a confirmation, not a steady state.
  Detection asymmetry to note: copy/cut can be caught two ways (a Windows clipboard-update event,
  `WM_CLIPBOARDUPDATE`, OR the keystroke via the existing `WH_KEYBOARD_LL` hook), but **paste fires no
  clipboard event** (it doesn't change clipboard contents), so paste is keystroke-only. Same OS-event family
  as the USB plug/unplug flash. Pick colors from the legend so they don't collide with cyan/orange/red/green/blue.
  - **LCD variant:** a brief "Copied"/"Pasted" glyph or icon on the screen — but this is gated on the live
    screen-write path (see open question #2); via the upload-to-flash path it would blank the lights and be too slow.

## 8. Design principles in play
- **Color language / legend:** lock semantic colors into a small token set so layers compose predictably —
  e.g. red = problem (error/disconnect/clip), green = good (connected/done), blue = progress,
  cyan = typing feedback, orange = AI agent activity. Define once; otherwise features fight over a hue.
- **Layer arbitration:** decide priority up front — a critical alert (disconnect) should punch through the
  audio meter momentarily.
- **Accessibility:** colorblind-safe palette variants (swap red/green semantics for blue/orange, add position/
  pattern cues); multi-language localization (dropdown).
- **Subitizing, temporal segmentation, attention model** (see section 7) as the perceptual basis for the displays.

## 9. Open questions for Claude Code
1. **ANSWERED:** HTTP API is read-only for colors — per-key push is **WebHID cmd 0x32**, computed host-side
   (the `/api/keyboard/layout` is the one-time participation map; live colors are computed in MusicPlug from audio).
2. **ANSWERED (2026-06-08, no):** there is **no live screen-write path**. The LCD write is flash-only
   (`buildPkt_TFT(... , 0x650000)`, whole image/GIF in 4096B chunks). `ScreenLight` is a *key* visualizer
   (web-driver `visualizerScreenLight`, mode 100 = screen-capture → keys), **not** an LCD path.
3. **ANSWERED (yes):** a single image push is the same flash write as a GIF → it blanks the keys (firmware halts
   the effect engine during the flash write). So the JPG-sequence "video" approach is **not viable** (slow +
   strobes the keys + wears the flash) — and unnecessary: the firmware plays an uploaded multi-frame GIF from
   flash itself (header carries frame count + per-frame delays). Animated LCD = upload one good GIF.
4. **ANSWERED (no, on TH108):** single GIF slot. `0x51`/`changeBuiltIn` only fires `if(builtInCount>1)`; only the
   240×135 ALU85A/KD85A have 2 built-in slots. TH108 = single overwrite at 0x650000.
5. Wire the Claude Code **hooks -> local API** integration (HTTP hooks; event mapping in section 7). *(still open)*

## 10. Color / protocol constants
- Keys foreground (on press): yellow-orange ~ `255,140,0` (toward `255,165,0` for more yellow).
- Background pulse: pale cyan ~ `160,255,255` (toward `0,255,255` for truer cyan).
- HID reports: 64 bytes. Localhost API: see section 2.

## 11. Prior art (reference, not competitors in this lane)
- **InksPet** (inkspet.com): e-paper Claude Code monitor — 12 states, pixel-art, RGB LEDs
  (blue=thinking, green=working, red=error), hardware permission buttons. Closest analog; a dedicated gadget.
- **AgentsRoom**: web/mobile dashboard for monitoring Claude Code agents.
- Mature RGB platforms (Razer Chroma, Corsair iCUE, SteelSeries GameSense, SignalRGB, OpenRGB) do layered/
  reactive/event lighting; GameSense does game-state status on keys; SignalRGB has a community effect library.
- Nobody found is doing keyboard-native agent status on a reverse-engineered closed board with this full stack.

## 12. Portfolio / case-study framing
- Lead with the design story, not "RGB lighting": unmet need in a closed system -> AI-assisted reverse-engineering
  -> constraint discovery (firmware boundaries) -> design decisions with rationale (subitizing, attention model,
  temporal segmentation, color language, inverse-delta calibration) -> tradeoffs -> shipped tool.
- Use the **git log** as evidence of incremental craft; **show the dead-ends** (firmware wall, the corrected
  "coexistence is impossible" hypothesis) as evidence of rigor.
- State the **AI division of labor** plainly as a competency (directing tools, knowing what to ask, verifying),
  not something to hide. Tools did the mechanical decoding; direction/judgment/taste were the scarce inputs.
- Componentized input layer + the color-legend/design-system are clean sub-artifacts.
- This is a **hardware/physical-computing UX** case — rarer and harder to fake than another app flow.

## 13. IP / legal notes (not legal advice)
- Mascot: copyright covers the artwork (a low-res key blob is unlikely to be a recognizable reproduction);
  **trademark** covers the brand and does NOT depend on resolution — implying affiliation/endorsement is the risk.
- Prefer **functional/nominative naming** ("Claude Code agent status") over branding a feature as Anthropic's.
- Free + fan-style distribution lowers practical risk substantially, but "tolerated" != "licensed".
- A community upload marketplace makes you a content host: add terms of service, a content/IP policy, and a
  DMCA-style takedown process. Keep the OSS repo license separate from user-uploaded content.
- Safest mascot paths: ship an original orange-pixel sprite, or read a user-supplied local image; check
  Anthropic's brand guidelines before using the actual mascot in a public tool.

## 14. Packaging / distribution (DECISION 2026-06-08)
- **Primary = GitHub Pages (https web controller).** Lightweight, zero-install, no code-signing, https = secure
  context so WebHID works, instant shareable link (good for portfolio). Caveats: Chromium-only (WebHID isn't in
  Firefox/Safari — true of any host); free Pages needs a **public repo**; never publish the vendor bundles
  (`app.*.js`/`chunk-*.js` — gitignored). The hosted page is **controller-only** (direct WebHID): a hosted
  `https://` page can't talk to a local daemon (`http://localhost` = mixed-content/CORS), so the full always-on
  experience is the **daemon serving its own copy at localhost** (same origin). The page degrades gracefully
  off-localhost (daemon handshake no-ops).
- **Optional later = Electron app download ("v2").** A one-click installable for the full always-on experience
  with no terminal. In Electron the **main process owns the device** (`node-hid` + `uiohook` + `th108-engine.js`)
  and the renderer is the UI over **IPC** — which *removes* the localhost server, the CSRF/DNS hardening, the
  auto-yield handshake, the heartbeat watchdog, and the two-owner conflict (single device owner, no WebHID).
  **The current code ports cleanly** — engine, `hid-transport.js`, and the uiohook wiring are reused as-is; only
  the controller's WebHID layer is swapped for IPC. Costs: ~100–150 MB bundle (ships Chromium), native-module
  rebuilds (`electron-rebuild` for node-hid/uiohook), and optional code-signing.
- **Code signing is OPTIONAL** — only for *wide* native distribution (unsigned → Windows SmartScreen "unknown
  publisher", user clicks *More info → Run anyway*; a cert is ~$100–400/yr). Not needed for personal/hobby use,
  and the web path needs none at all. Leaner native alternatives if Electron's size bothers you: a packaged Node
  binary (Node SEA / `pkg`, ~50–80 MB, browser as UI) or Tauri (~5–10 MB, but WebView2's WebHID is unreliable →
  HID via Rust/sidecar = more porting).
- **Plan:** ship the GitHub Pages controller now; add the Electron download later only if a one-click,
  no-terminal app becomes a hard requirement.

## 15. Why a host daemon at all (vs Epomaker's "no daemon" persistence)
- **Epomaker's site persists WITHOUT a running app because it writes ONBOARD firmware effects** (cmd `0x23`,
  persistent flash) that the keyboard runs **standalone** — it's *configuring the firmware*, not streaming. The
  site only needs to be open the moment you change an effect. (Their audio/"music" mode is the one exception that
  needs the app live — it streams host-computed colors, same as our daemon.)
- **Our daemon exists because our differentiators are NOT firmware-storable:** host-composited multi-layer
  blending, reactive-anywhere, and custom animated patterns via cmd `0x32` full-frame streaming. The firmware runs
  exactly **one** onboard effect at a time (no compositing, no host-reactive-plus-background) — see §4. Anything
  the firmware can't hold/run itself requires a **live host**.
- **The spectrum (both already supported):** *persist with nothing running* = set an onboard effect (`0x23`, the
  controller's onboard panel — Epomaker-style, limited to the 19 firmware effects, one at a time); *rich always-on*
  (layers / reactive-anywhere / custom patterns) = live host = the daemon (or, later, the Electron app). So the
  daemon isn't a workaround for something Epomaker solved more elegantly — it's the price of doing things their
  firmware fundamentally cannot.
