# Music Layer (audio-reactive lighting) — Design

**Date:** 2026-06-16
**Status:** Approved design, pre-plan
**Author:** Beyon

## 1. Overview

A new host-composited **audio-reactive lighting layer** for the TH108 V2 PRO: the keys
visualize whatever audio is playing — system mix, a specific app, a browser tab, or a
mic/line-in — selectable at runtime. It plugs into the existing layer compositor as a new
`type:'audio'` layer, so it stacks and blends with Background / Reactive / Individual / etc.

Differentiator: stock keyboard software (Epomaker's included) has no per-app or per-source
audio visualizer. The suite's always-on daemon is the right place to do it, so the visualizer
runs ambiently (in games, tab closed) — not only inside the controller page.

## 2. Goals / non-goals

**Goals**
- Four visualizer **styles**, user-selectable, **default = Spectrum bars**:
  - **Bars** — bass-left → treble-right equalizer, columns light bottom-up (needs full FFT).
  - **Pulse** — whole-board breathe on loudness + flash on beat, hue drifts with brightness.
  - **Bloom** — energy rings bloom from center on each beat/kick.
  - **Wave** — oscilloscope trace of the waveform scrolling across the keys.
- A runtime **source selector** with four sources: **All system audio**, **Specific app**,
  **Single browser tab**, **Mic / line-in**.
- A **live tuner** (gain / smoothing / noise-floor / beat-sensitivity + per-style colors), every
  control with a surfaced *why* and a justified default (no arbitrary thresholds).
- Always-on for the daemon-captured sources; zero added device-wedge or brick risk.

**Non-goals (v1)**
- Multiple simultaneous audio layers (one active audio layer; one active style at a time).
- Non-Windows capture.
- Beat-matched effects beyond simple onset detection (no tempo/BPM tracking, key detection, etc.).

## 3. Architecture & data flow

**Principle: whoever captures also renders.** This reuses the existing dual-driver model
(daemon drives ambiently; the page drives when it owns the device) and avoids any new
high-rate cross-process stream.

- **Daemon sources** (system / app / mic): native capture sidecar → daemon engine
  (`renderAudio`) → daemon drives the keys via `node-hid`. Always-on.
- **Tab source**: page `AnalyserNode` → page engine (same `renderAudio`) → page drives WebHID.
  A tab you're capturing is by definition open/focused, so page-driving is acceptable here.

Consequences (both important after the 2026-06-16 wedge incident):
- **No new device writer.** The audio layer is just another compositor layer the *existing
  single owner* renders. It does not add a second HID writer, so it carries no new two-writer /
  FIFO-wedge risk.
- **No flash writes.** Unlike the LCD path, lighting is RAM-only `0x32` streaming — zero brick risk.

## 4. Audio feature model (capture → render contract)

Each frame, the active capturer produces one compact feature object:

```
{
  bands:    Float32Array(~32),  // log-spaced magnitudes 0..1 (mapped to 21 columns at render)
  level:    Number,             // RMS loudness 0..1 (smoothed); raw also available
  beat:     Number,             // onset/transient envelope 0..1 (sharp attack, decay)
  centroid: Number,             // spectral centroid 0..1 — "brightness" proxy, drives hue
  t:        Number              // capture timestamp (ms)
}
```

Identical shape whether produced by the .NET sidecar (newline-delimited JSON on stdout, the
`media-sidecar` pattern) or the page's Web Audio `AnalyserNode`. Band count is fixed (~32) so the
renderers are source-agnostic; the bars renderer down-samples 32 → 21 columns.

## 5. Engine layer (`th108-engine.js`)

Mirrors the existing `reactive` layer (which reads `state.react`):

- **State:** add `state.audio = { bands:Float32Array(N), level, beat, centroid, t }`, updated each
  frame by the driver from the active capture source. Decays to zero when audio is silent or the
  source is inactive (the layer goes dark).
- **Dispatch:** `renderLayer` gains a `type==='audio'` branch → `renderAudio(L, now, state)`, which
  switches on `L.settings.style` for the four renderers.
- **Settings (`ensureSettings`):** for `type:'audio'` add —
  - `style`: `'bars'|'pulse'|'bloom'|'wave'` (default `'bars'`)
  - `source`: `'system'|'app'|'tab'|'mic'` (default `'system'`) + `appId` / `deviceId` selectors
  - per-style colors / palette (defaults = the agreed mockup colors)
  - tuner: `gain`, `attackMs`, `decayMs`, `floor` (noise gate), `beatSens`
  - plus the common per-layer adjust fields (`bri/sat/con/gam/rot/spd/frozen`) backfilled for every type.
- **Compositing:** standard layer — default blend `add`, opacity 1; stacks with other layers.

## 6. Capture per source

- **All system audio (Phase 1):** native sidecar — **C#/.NET single-file using NAudio
  `WasapiLoopbackCapture`** on the default render endpoint → Hann-windowed FFT (e.g. 2048) → log
  bands + RMS + onset → stdout JSON at ~60 Hz. Daemon spawns/supervises it like `media-sidecar`,
  carrying the anti-stasis + periodic-GC lessons from the leak fix (`f78d66b`).
- **Specific app (Phase 2):** Windows 10 2004+ **process-loopback** via
  `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_PARAMS` `PROCESS_LOOPBACK`
  (include/exclude a process tree). Likely needs raw WASAPI interop beyond NAudio's helpers →
  **feasibility spike before committing.** Picking the browser as the app = "all web audio".
- **Mic / line-in (Phase 2):** WASAPI capture on a user-chosen input device (same sidecar, different
  endpoint).
- **Single tab (Phase 3):** page `getDisplayMedia({audio:true})` (share-this-tab) → `AnalyserNode`
  → page-driven render. A per-session share prompt is inherent to the browser API.

## 7. UI (`th108-layers-ui.js` audio-layer card)

- **Source bubbles:** ◉ All system · ○ App ▾ · ○ This tab (Share…) · ○ Mic ▾. App and Mic reveal a
  picker; Tab triggers the `getDisplayMedia` share.
- **Style selector:** four options, **bars default**, each with a small live preview (reuse the
  brainstorm mockup canvases).
- **Live tuner:** Gain, Smoothing (attack/decay), Noise floor, Beat sensitivity, per-style color
  pickers, and a "log current values" button. Each control has a one-line *why* tooltip and a
  justified default — no unexplained magic numbers (per the no-arbitrary-UX rule).

## 8. Phasing

- **Phase 1 (first plan / first shippable increment):** system-audio source + all 4 styles + tuner
  + source-selector UI + engine `type:'audio'` + the .NET loopback sidecar + daemon supervision.
  Delivers the entire visual experience on the easiest capture.
- **Phase 2:** app-specific (process-loopback, after a feasibility spike) + mic/line-in.
- **Phase 3:** single-tab (page-capture, page-driven render).

## 9. Performance & safety

- **Latency:** ~60–80 ms glass-to-key (FFT ≤ ~40 ms + 30 fps render). 30 fps engine cap stands.
- **CPU isolation:** FFT runs in the separate sidecar process, never blocking the daemon event loop.
  CPU is watched the way sidecar memory now is.
- **No device-handoff changes** introduced (respects "never batch device-handoff changes"; this adds
  none). **No flash writes** → no brick risk.

## 10. Testing

- **Engine (no hardware):** `renderAudio` per style over synthetic `state.audio` (deterministic);
  smoothing-envelope and onset-detection math unit-tested. Keep the existing engine suites green.
- **Sidecar:** stdout feature-format contract test (known WAV → expected band/level shape if feasible).
- **UI:** audio-card config round-trip (source/style/tuner persist and reload).
- **Hardware:** a visual glance per style on system audio (user-run).

## 11. Risks / open questions

- **Process-loopback feasibility** (Phase 2): NAudio may not expose `PROCESS_LOOPBACK` directly;
  raw interop needed. Spike before planning Phase 2.
- **Sidecar runtime:** confirm .NET/NAudio is the right stack vs a Node native addon
  (`naudiodon`/portaudio loopback support is patchier on Windows). Default assumption: .NET/NAudio.
- **Tab source while daemon is the usual owner:** selecting "single tab" must hand the device from
  daemon to page (normal `/yield`+`/resume` handoff) and back when the source changes. Reuse the
  existing handoff; do not add a new path.
- **Color calibration:** the keyboard LEDs use the existing per-key color path (no LCD-style RGB565
  calibration needed) — visualizer colors go through the same `0x32` pipeline as other layers.
