# HANDOFF — 2026-06-17

## Where things stand
Long night that started as a mute incident and turned into four daemon hardening fixes + a full design→plan for the **music layer** (audio-reactive lighting). All committed, working tree clean (HEAD `3d34a55`), 39/39 daemon tests green. The big open thread: the **daemon has NOT been restarted**, so tonight's three daemon fixes aren't active yet. Deep background lives in `_HANDOFF.md` (older) + project memory.

## Ledger

### ✅ Solved (verified)
- **Hung-daemon port-squat incident** — a corpse daemon (PID 68212, from 06/15) held port 8123 with `/status` timing out, so every "Start" silently failed. Killed it → port freed → fresh daemon came back; user confirmed lighting restored. Root-caused + recorded in memory `th108-hung-daemon-port-squat`.
- **Individual-keys layer — HARDWARE-VERIFIED.** User confirmed "individual keys is perfect" this session. Closes the last gating item from the 2026-06-16 handoff.
- **Tonight's spontaneous ACK-mute auto-recovered** — board went MUTE 00:21:45 after ~4.6h streaming, daemon's PnP USB-restart fired and recovered it in 38s (user confirmed "it came back"). The existing auto-recovery working as designed; NOT a regression (known USB/firmware quirk).

### 🟡 Open / in-progress
- **RESTART THE DAEMON** — currently PID 82760 running the pre-fix engine (no hot-reload). The next 3 fixes only activate on restart; restart also **arms the flight recorder** to capture the next mute. This is the #1 next action.
- **ACK-gate fix is defensive, not a proven mute cure** (`a0b9f83`). Real `0x32` ACK = `0x55 32`; cmd-match rejects foreign-cmd false hits (e.g. `0x55 23`) but the recurring broadcasts are *same-cmd* `0x55 32` (byte-identical to a real ACK). Evidence still shows broadcasts appear at RECOVERY, not before collapse → false-ACK theory UNSUPPORTED. OPEN: find a payload discriminator from flight-recorder data. See memory `th108-lighting-protocol`.
- **Flight recorder** (`0a09ac1`) — dumps last 48 input-reports+writes at a mute. Committed + unit-tested, but never fired on real hardware yet (needs a mute after a daemon restart).
- **Tray self-heal** (`a35dcd7`) — kills a hung daemon squatting 8123 before launching. Committed, not yet exercised (takes effect on next tray relaunch).
- **Daemon stuck-reactive-key safeguard** (`2c3c1b6`) — releases stuck keys on each fresh device handle. Committed, no reproducer to verify against.
- **Music layer** — design spec `c51fcfc` (`docs/superpowers/specs/2026-06-16-music-layer-design.md`) + **Plan 1a** `3d34a55` (`docs/superpowers/plans/2026-06-17-music-layer-1a-engine-ui.md`, 10 TDD tasks) written and approved, **NOT started**. Plan 1b (.NET NAudio capture sidecar) not yet written.
- **Page ACK gate** (`th108-hid.js` ~line 69) still loose — mirror the cmd-match from the daemon later, ONE device-path change at a time.

### 🔴 Regressed / suspect
- None. Tonight's mute was the known spontaneous USB/firmware quirk (auto-recovered), not a code regression.

## Build / run
- **Static page (sole device owner):** `node _serve.js` → http://localhost:8123/ (daemon stopped)
- **Daemon (always-on):** `node th108-daemon/daemon.js` (serves page + API on :8123). **One device owner at a time.**
- **Health check:** `powershell -NoProfile -ExecutionPolicy Bypass -File th108-daemon/_state-check.ps1` → prints HEALTHY / HUNG / DOWN + the owning PID.
- **Restart daemon:** tray icon → Quit (it relaunches; now self-heals a hung port), or `setup.cmd`.
- **Tests:** `cd th108-daemon && node --test` (39) · `node --test th108-engine.test.js` (engine). Plan 1a adds `th108-audio-synth.test.js` + audio tests.
- **HTML check after editing th108-controller.html:** `node -e "const fs=require('fs');const h=fs.readFileSync('th108-controller.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(s=>s.length>500).pop();new Function(b);console.log('OK')"`

## Gotchas
- **Daemon has no hot-reload** — engine/module changes need a restart.
- **A hung daemon holds port 8123 invisibly** → symptom is "Start does nothing"; diagnose with `_state-check.ps1`; tray self-heal fixes it after next relaunch.
- **One device owner at a time** — opening the page while the daemon drives = two-writer FIFO wedge (caused a mute tonight). Handoff via `/yield`+`/resume`.
- **Board wedge recovery = flip the BT↔wired mode switch** (battery MCU; a USB-restart can't reboot it).
- **Never blanket-kill `node`** — ~30 node procs on this machine are MCP servers from a Claude session; target `daemon.js` by command line (`_state-check.ps1` identifies the right PID).
- **Commits author `Beyon <you@example.com>`, NO Claude/Co-Authored-By trailer.** American spelling.

## Next action
**Restart the daemon** (tray → Quit → relaunch) to activate the 3 daemon fixes + arm the flight recorder. Then begin **Plan 1a** at Task 1 (`docs/superpowers/plans/2026-06-17-music-layer-1a-engine-ui.md`) via subagent-driven execution — the first 3 tasks are pure-engine TDD (no hardware) and validate the plan's code.
