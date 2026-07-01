# Claude Code Hooks Setup for Agent-Activity Lighting

These hooks drive the TH108 keyboard's agent-activity lighting layer by posting Claude Code lifecycle events to the local daemon. The daemon receives events on `POST http://127.0.0.1:8123/agent/event` and routes based on the `hook_event_name` field.

## What These Hooks Do

When you submit a prompt in Claude Code, the hooks fire automatically and drive these visuals on the numpad/letter cluster:
- **UserPromptSubmit**: marks the session busy — the numpad spinner starts marching
- **SubagentStart**: adds a twinkle on the letter cluster (one per live subagent)
- **SubagentStop**: removes a twinkle as each subagent finishes
- **Stop** (turn end — the agent finished responding): clears busy, flashes the green checkmark on the numpad
- **Notification**: latches the persistent "!" attention state until the next activity
- **SessionStart**: runs a boot sweep across the board; **SessionEnd** drops the session back to idle

The daemon merges these signals into a single `state.agent` and the engine's `renderAgent` layer draws them—no manual setup needed once installed.

## Installation

Merge the following `"hooks"` block into your **user-global** `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "async": true, "timeout": 5, "command": "curl -s -m 2 -X POST http://127.0.0.1:8123/agent/event -H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1" }] }]
  }
}
```

## How It Works

Each hook runs the same curl one-liner, which:
1. POSTs the raw hook JSON to the daemon's `/agent/event` endpoint
2. Executes **asynchronously** (`async: true`) — if the daemon is down or slow, Claude Code never blocks
3. Times out after 2 seconds (`-m 2`) and discards output (`>/dev/null 2>&1`)
4. Passes a 5-second overall timeout as a safety margin

**`async: true` is load-bearing**: even if the daemon crashes, Claude Code keeps running. The daemon simply reconnects on the next event.

## Shell & Fallback

Git Bash is the default hook shell on this machine, so the `curl` syntax above works as-is.

If you use PowerShell by default and need to override, the daemon spec (§4) includes a PowerShell variant that wraps the JSON encoding—consult that section if needed.

## Verify It Works

1. Start the th108-daemon (if not already running)
2. In Claude Code, submit a prompt
3. Check `th108-daemon/daemon.log` for `POST /agent/event` entries:
   ```
   [daemon] POST /agent/event: hook_event_name='UserPromptSubmit' ...
   ```
4. Watch the keyboard: you should see lights respond (flash on prompt, spinner during subagent, checkmark on completion)

If the daemon is down when you submit, the hook silently fails (async timeout)—no impact on Claude Code. Lights resume when the daemon restarts.
