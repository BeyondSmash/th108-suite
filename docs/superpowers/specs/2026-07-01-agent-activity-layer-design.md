# AI/LLM Agent-Activity Lighting Layer — Design

**Date:** 2026-07-01
**Status:** Design approved; implementation to follow in a fresh session.
**Roadmap:** item 10 in `th108-feature-roadmap` memory.

## 1. Purpose

A new host-composited lighting layer (`type:'agent'`) that visualizes **Claude Code agent activity** on the keyboard, driven by the always-on daemon:

- **Subagent twinkles** — each running subagent lights an orange, shimmering key (more agents → more lit keys).
- **Loading spinner** — while Claude is working on a turn, a dot marches around the numpad perimeter with a fading tail.
- **Completion checkmark** — when Claude finishes a turn, a green ✓ flashes on the numpad.
- **Attention exclamation** — when Claude needs you (permission / waiting for input / idle), a "!" appears on the numpad and breathes (with an optional reminder blink) until you act.
- **Boot sweep** — when a Claude Code session opens/resumes, a brief "AI online" sweep.

The rendering is cheap (the engine already emits per-key RGB buffers). **The hard part, and the reason this needed design, is the data source** — how the daemon learns agent state. That is solved here with Claude Code hooks.

## 2. Scope decisions (from brainstorming)

- **Machine-wide by default:** any Claude Code session on the machine (any project, terminal or IDE) drives the lights. Hooks are installed once in the global `~/.claude/settings.json`.
- **Optional session filter:** the layer has a source setting — **All sessions** (default, aggregated) or a **specific active session** picked from a live list. Every hook payload carries `session_id`, so filtering is a one-field match.
- **Checkmark granularity:** fires **once per turn**, when the main agent stops (Claude Code `Stop` hook) — "done, your turn." Not per-subagent.
- **Spinner and checkmark are mutually exclusive in time:** the spinner runs while the turn is in progress; the moment the turn ends the spinner clears and the checkmark flashes. Both own the numpad, sequentially. Subagent twinkles live on a *different* region (default alpha cluster) and DO coexist with the spinner.

## 3. Data flow

```
Claude Code hook fires
  → curl POST http://127.0.0.1:8123/agent/event   (async, fire-and-forget; raw hook JSON piped as the body)
  → daemon /agent/event routes on hook_event_name → updates an in-memory per-session map
  → each render tick, the daemon folds that map into state.agent  (exactly like state.audio for the audio layer)
  → engine renderAgent(L, state, now) emits per-key RGB + alpha
  → composited + streamed over the existing ACK-gated 0x32 stream
```

No files, no polling, no persistence — the state is ephemeral and event-driven. This reuses the daemon's existing HTTP server rather than the `_focusreq.txt` file-poll pattern (that pattern only exists because the focus *PowerShell host* couldn't be an HTTP server; the daemon can).

## 4. The hooks (installed in `~/.claude/settings.json`)

Five events, each running the **same** one-liner (no per-event payload construction — the daemon reads the native hook JSON):

| Hook event | Matcher | Daemon effect |
|---|---|---|
| `UserPromptSubmit` | — | session **busy = true** → spinner starts |
| `Stop` | — | busy = false; **subagents cleared**; **checkmark flashes** |
| `SubagentStart` | — (all agent types) | add `agent_id` to the session's subagent set → +1 twinkle |
| `SubagentStop` | — | remove `agent_id` (or decrement) → −1 twinkle |
| `Notification` | — | **exclamation "!" flashes** (Claude needs attention) |
| `SessionStart` | — | **boot sweep** ("AI online") |
| `SessionEnd` | — | drop the session entirely (cleanup) |

Seven hooks total. All run the identical one-liner below.

**Hook command (Git Bash — the default when Git Bash is installed, which this machine has):**

```json
{
  "type": "command",
  "async": true,
  "timeout": 5,
  "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1"
}
```

- `"async": true` — documented fire-and-forget; a stopped/absent daemon can never block or slow Claude Code (a failed `curl` on a blockable event won't matter because async detaches it).
- `--data-binary @-` — pipe stdin (the raw hook JSON) straight through; the daemon parses it.
- **PowerShell fallback** (if Git Bash is ever absent): `powershell -NoProfile -Command "$in=[Console]::In.ReadToEnd(); try { Invoke-RestMethod -Uri http://127.0.0.1:8123/agent/event -Method Post -Body $in -ContentType application/json -TimeoutSec 2 } catch {}"`.

**Implementation-time verifications (do NOT assume):**
1. Confirm `SubagentStop`'s payload includes `agent_id`. If it does → use a `Set<agent_id>`. If it does NOT → use a signed counter (start +1 / stop −1, floored at 0). **Either way, `Stop` (turn end) resets the session's subagent state to empty** — subagents cannot outlive their turn, so this invariant heals any missed `SubagentStop`.
2. Confirm the exact field name for the subagent id (`agent_id`) and that `hook_event_name` appears verbatim in every payload (docs say yes).

## 5. Components

### 5.1 `th108-daemon/agent-state.js` (new, pure, unit-tested)
- Owns the in-memory session map: `sessionId → { busy:bool, subagents:Set|count, checkmarkAt:ms, notifyAt:ms, attention:bool, bootAt:ms, lastSeen:ms }`.
- `ingest(hookJson, now)` — routes on `hook_event_name`, mutates the map, returns nothing.
  - `Notification` → `notifyAt=now`, `attention=true` (the "!" latch; `notifyAt` is the phase clock for hold→breathe→reminder).
  - `SessionStart` → `bootAt=now`.
  - `UserPromptSubmit` / `Stop` / `SubagentStart` / `SubagentStop` → **clear `attention=false`** (activity resumed → the "!" resolves), in addition to their own effects.
- `aggregate(filter, now)` — given `filter` (`"all"` or a `session_id`) returns `{ busy, subagentCount, checkmarkAt, notifyAt, attention, bootAt }` merged across the selected sessions (`busy`/`attention` = any selected session true; `subagentCount` = sum; the `*At` timestamps = most recent; `notifyAt` reported only while some selected session's `attention` is still true).
- `sessions()` — list of `{ id, label, busy, subagentCount, lastSeen }` for the UI picker (`label` = `basename(cwd)` + short id).
- **TTL sweep:** a session with no events for N minutes (e.g. 10) is dropped; `busy` older than N minutes (missed `Stop`) is force-cleared. Guards against leaks from a killed session.
- Pure and DOM-free → `node --test`.

### 5.2 `th108-daemon/server.js` — `POST /agent/event`
- Reads the request body (raw hook JSON), calls `agent-state.ingest(json, Date.now())`, replies `204`. Same-origin/localhost; consistent with the existing control API hardening.

### 5.3 `th108-daemon/daemon.js` — feed the engine
- Each `runTick`, call `state.agent = agentState.aggregate(agentLayer.settings.session || 'all', Date.now())` when an `agent` layer is enabled (mirrors how the audio frame is folded into `state.audio`).

### 5.4 `th108-engine.js` — `type:'agent'` renderer (shared, pure)
- `renderAgent(L, state, now)` reads `state.agent` and the layer settings; writes the layer's `rgb` + `_alpha` buffers. Transparent (alpha 0) everywhere when idle (no busy, no subagents, no recent checkmark) → reveals layers beneath.
- Registered in `renderLayer`/composite like the other types; because it's pure it also renders in the iso-view.

### 5.5 `th108-layers-ui.js` — the layer card
Settings:
- **Colors:** twinkle (orange default), spinner, checkmark (green default) — reuse the shared color-picker pattern.
- **Session filter:** dropdown — All sessions / a specific active session (populated from `GET /status` or a new field exposing `agent-state.sessions()`).
- **Twinkle region:** a **keyboard-preview selector** — reuse `th108-paint-board.js`'s selection model, which already supports **both** a **marquee box-select** AND **individual key toggling** (Shift+click adds one key, Ctrl+click removes one; Alt-box erases a region). So the region can be any arbitrary set of keys — a contiguous box, the F-row, or hand-picked scattered keys — chosen live against the keyboard preview. Default = alpha cluster. Stored as a key-index list in the layer settings.
- **Emphasis (while agent anims are active), independent toggles:**
  - **Silhouette full numpad** — carve the whole numpad region out of the layers below (the audio layer's "carve below" Silhouette treatment) so the spinner/checkmark read against black.
  - **Dim layers below** — duck the underlying composite to a configurable ~10% while activity is live (the audio layer's translucency/duck), so the animation stands out.
- **Exclamation (!) animation:** `holdMs` (solid hold before breathing); `reminderEnabled` (on/off); `reminderAfterMs` (breathe duration before a reminder blink); `reminderBlinks` (2 or 3). Breathe rate can be fixed initially. (These drive the persistent "!" lifecycle in §6.)
- **Preview toggle** — inject a synthetic activity feed (fake busy + a couple of fake subagents + periodic checkmark + a held "!" so its hold→breathe→reminder phases are tunable) so colors/region/animation can be tuned with no live agents. Mirrors the audio layer's synthetic feed. Page-side only.

## 6. Visual specifications

- **Subagent twinkles:** N keys of the selected region lit orange, each with a phase-shifted brightness shimmer (twinkle), where N = live subagent count (clamped to the region size). Coexists with the spinner.
- **Spinner:** a lead dot marching the numpad perimeter through the corners **3 → 1 → 7 → 9 → 3**, looping while busy, with a **fading tail** (trailing keys at decreasing opacity behind the lead). Implementation may interpolate along the edge keys between corners for a smooth march; corner-only is the fallback. Clears immediately on turn end.
- **Checkmark:** numpad keys **7, 5, 9, −** flash **green** for ~1s on turn end (7→5 short arm to center, 5→9→− long arm up to the top-right = a ✓), after the spinner clears. Optional quick draw-on sweep.
- **Exclamation:** numpad keys **\*, 9, 6, .** on `Notification` — the `*→9→6` vertical stem down column 3 plus the `.` dot below the gap = a "!" (attention color, e.g. amber/red). Signals "Claude needs you." **Unlike the ✓ flash, this is a PERSISTENT attention state** with a multi-phase lifecycle:
  1. **Appear** — snaps on immediately.
  2. **Hold** — solid for `holdMs` (user-set).
  3. **Breathe** — pulses/breathes continuously while waiting.
  4. **Reminder blink** — after `reminderAfterMs` of breathing, a **double or triple blink** (`reminderBlinks`) to re-grab attention, repeating on that interval. **Opt-out** via `reminderEnabled`.
  5. **Clear** — resolves when the session resumes activity: the next `UserPromptSubmit`, `Stop`, or `SubagentStart/Stop` for that session clears the attention latch (so the "!" isn't a fixed-duration flash — it stays until you act, then goes).
- **Boot sweep:** a one-shot sweep across the board (~1s) on `SessionStart` — an "AI online" cue. A simple left-to-right wave in the twinkle color; kept low-key so session churn isn't distracting.

**Numpad priority** (spinner, ✓, and ! all live on the numpad), highest first: **! (persistent attention)** > **✓ (transient flash)** > **spinner**. The spinner runs while `busy`; a live **!** supersedes it (Claude is waiting on you, not working) and holds until the attention latch clears; the **✓** is a ~1s flash on turn end. Because `Stop` both clears `attention` and fires the ✓, a `!`→`Stop` sequence transitions cleanly (! disappears, ✓ flashes, spinner already gone). Subagent twinkles and the boot sweep render on their own regions and are unaffected.

## 7. Page vs daemon

This is **daemon-driven** — hooks only reach the daemon. When the page (WebHID) drives, `state.agent` has no live feed, so the layer is transparent, or shows the **synthetic Preview** feed for tuning. Identical to the now-playing bar / media-layer pattern. **A long-running daemon must be restarted to pick up the new engine code** (modules are `require`'d at startup, no hot reload) — the known handoff gotcha for every new engine layer type.

## 7b. Optional / future event cues (NOT in this build)

Documented so a later pass can add them without re-deriving; deliberately out of scope now (YAGNI / noise):

- **Failed-tool red flash** — `PostToolUse` carries `tool_response`; a red flash on an errored tool. Needs response parsing; moderately useful.
- **Per-tool tint** — `PreToolUse` (matchable by tool name) tinting per Bash/Edit/WebSearch etc. Fires very frequently → visual noise; skip unless a "tools churning" texture is wanted.
- **Compaction pulse** — `PreCompact`/`PostCompact` a subtle "compacting memory" pulse. Niche.

All of these reuse the same transport (hook → `curl` POST → daemon routes on `hook_event_name`); adding one is a new `ingest` case + a renderer cue, no architecture change.

## 8. Edge cases

- **Daemon down / not installed:** hooks `curl` fails silently, exits without blocking (async). No lighting, no harm.
- **Missed `SubagentStop` (crashed subagent):** `Stop` resets the session's subagent set; TTL sweep is the backstop.
- **Missed `Stop`:** TTL force-clears `busy` after N minutes.
- **Parallel sessions:** aggregated by default (sum of subagents, any-busy); or filter to one.
- **Selected session ends:** filter falls back to showing nothing for that id until reselected; UI greys a stale pick.
- **Numpad contention with other layers:** none introduced — the agent layer composites at its own opacity/blend like any layer; the emphasis toggles are opt-in.

## 9. Safety

Pure lighting layer over the existing ACK-gated `0x32` stream — **no LCD/flash writes**, so none of the brick-risk upload rules apply. No new HID surface. The only new external surface is the localhost `POST /agent/event` (same trust boundary as the existing localhost control API).

## 10. Testing

- **`agent-state.test.js`** (`node --test`): ingest of each event type; the `Stop`-resets-subagents invariant; counter-vs-set handling; aggregation across sessions; session filter; TTL sweep.
- **Engine:** `renderAgent` idle → all-alpha-0; busy → spinner keys lit; checkmark window → the 4 numpad keys green; twinkle count clamps to region size.
- **Hook wiring:** a manual verification step — install the hooks, run a Claude Code turn with a subagent, confirm `daemon.log` shows `/agent/event` posts and the board animates. (Hardware glance by the user, like every lighting change.)

## 11. Files touched (summary)

| File | Change |
|---|---|
| `~/.claude/settings.json` | 7 async `curl` hooks (documented; not committed to the repo) |
| `th108-daemon/agent-state.js` | **new** — session map, ingest, aggregate, sessions, TTL |
| `th108-daemon/agent-state.test.js` | **new** — unit tests |
| `th108-daemon/server.js` | `POST /agent/event` route |
| `th108-daemon/daemon.js` | fold `state.agent` into the tick; expose sessions on `/status` |
| `th108-engine.js` | `type:'agent'` + `renderAgent` |
| `th108-engine.test.js` | renderAgent cases |
| `th108-layers-ui.js` | agent layer card (colors, session filter, twinkle-region cropper, emphasis toggles, preview) |
| `docs/.../plans/2026-07-01-agent-activity-layer.md` | implementation plan (next step) |

## 12. Open items for the implementer

- Verify `SubagentStop` carries `agent_id` (§4).
- Decide the exact default twinkle-key set (alpha cluster indices).
- Tune spinner march speed, tail length, twinkle shimmer rate, checkmark duration on hardware.
- Confirm the daemon exposes the session list to the page (extend `/status` vs a new `GET /agent/sessions`).
