# HANDOFF — 2026-07-09

> Durable rules / protocol / detailed dev reference: **`_HANDOFF.md`** (gitignored, local) + project memory. This file = the focused, scannable state of THIS session.

## Where things stand
Agent-layer **window-focus** feature is functionally complete: the "Focus window" picker now lists every open VSCode window (not just live Claude sessions), focuses the exact one by handle, and supports **per-project outline colors**. The Dry-run safety checkbox was removed (focus is live by default). Also shipped this session: outline-flash fix, twinkle-region connector, audio-layer polish, Import confirmation. Next task is the **new-user test-environment setup** (author ship defaults in a sandbox).

## Ledger

### ✅ Solved (verified)
- **Window-focus actually focuses** — `5b37761` matched claude-view's invocation (dropped `windowsHide`); user confirmed "it worked!".
- **Outline glow never launched (spaces-in-path)** — `3dba208`: `Start-Process -ArgumentList` doesn't auto-quote the `-File` path, and the bundled path has spaces (`…\Epomaker Project\…`) so the child PS couldn't find `focus-flash.ps1`. Quoted it; verified via log (`flash START` fires) + user saw the green glow.
- **Window-enumeration picker** — `0639e46`: `/agent/windows` returns all 3 windows incl. Portfolio (HTTP 200 confirmed); focusing Portfolio **by hwnd** brought it to front with a green outline — user confirmed. Daemon confirmed already restarted.

### 🟡 Open / in-progress (code done, NOT hardware-verified — needs daemon restart + a look)
- **Per-project outline colors** — `6b1d3cf`. Daemon-side (`colorFor`, `setFocusConfig` projectColor, `/status`) needs a **daemon restart** to activate. Verify: pick Portfolio → set blue → ⤒ flashes blue; ChemTetris → still default orange. Keyed by project/workspace name (`vscWinLabel`), stored in `settings.focusProjectColors`.
- **Dry-run checkbox removed** — `8bb96c7`. Page-reload shows it gone; daemon default flip (`focusDryRun:false`) needs restart (user's config already false). Latent kill-switch kept: set `focusDryRun:true` in `th108-daemon/config.json`.
- **Per-project label** — `3bffa13`: reads "Color (override) for <project>". Not visually confirmed.
- **Twinkle-region connector** — `496c46e`: elbow line from controls → mounted keyboard preview. Not visually confirmed by user.
- **Audio layer** — `cbd43ab`: "Nothing playing" note centered under dropdown+Refresh (capital N); live-preview pill "Show" no longer scrolls up to the original. Not confirmed by user.
- **Hex-text sync on color resets** — `7117e4c`: reset buttons now dispatch `input` so the hex box updates without a refresh. Simple, unconfirmed.
- **NEXT TASK: new-user test-environment setup** — see Next action.

### 🔴 Regressed / suspect
- None open. **History note:** window-focus caused **4 VSCode-window-close incidents** earlier (`a76e2df`, `b701ade`) before switching to claude-view's proven method + **manual-only, no auto-cascade**. KEEP window-focus manual-only. The auto-triggers (`focusAutoSwitch`/`focusOutlineOnSwitch`) deliberately route to the log-only path in `daemon.js` and must NOT be wired live.

## Build / run
- **Daemon** serves the controller at `http://localhost:8123` and runs background lighting. Start/restart via the tray (setup.cmd / start-tray.vbs); a running tray watches `_startreq.txt`. **Restart the daemon** to load `daemon.js`/`server.js` changes.
- **PowerShell scripts are read per-spawn** — `focus-vscode.ps1`, `focus-flash.ps1`, `list-vscode-windows.ps1` take effect immediately, NO daemon restart needed.
- Quick daemon-alive check: `curl -s http://localhost:8123/agent/windows` → 200 + window list = restarted with the new route.
- Syntax gate after editing: `node --check th108-layers-ui.js && node --check th108-daemon/daemon.js`; for HTML inline scripts, wrap each `<script>` body in `new Function(...)`.

## Gotchas
- **Commits:** author `Beyon <you@example.com>`, **NO** Claude / Co-Authored-By trailer. `git -c user.name="Beyon" -c user.email="you@example.com" commit --author="Beyon <you@example.com>" -m "…"`.
- **Never commit** Epomaker copyrighted bundles (`app.*.js`, `chunk-*.js`, `*.js.txt`) or the OpenRGB zip.
- **PowerShell** is the win32 host; don't route it through Bash. `Start-Process -ArgumentList` won't quote paths with spaces — pre-quote them (bit us in `3dba208`).
- **Daemon session list is IN-MEMORY** — wiped on restart; idle chats disappear from *session-based* views until they send a hook (this is why "Portfolio" vanished from the old session picker). The window picker is now **window-based** so it's immune.
- **One controller at a time** — daemon vs page; use localhost, not `file://`.
- Untracked junk in tree (`_keytest.html`, `th108-daemon/_agentverify.out`) — not part of any task; leave or clean.

## Next action
**Start the new-user test-environment setup** — a sandbox seeded from the user's current config to author ship-to-users **default** settings.
- **Brainstorm/design FIRST** (`superpowers:brainstorming`) before coding — scope isolation carefully.
- **HARD CONSTRAINT:** never modify the user's personal profile/config. See memory `th108-defaults-test-env`.
- **Isolation is the risk:** a prior defaults-sandbox review found 4 criticals by auditing *every* persistence channel (localStorage / IndexedDB / HTTP `/config` / `config.json`), not just the happy path — prefer one systematic choke point over per-site gates. See memory `feedback-verify-all-channels-not-happy-path`.
- First, though: user should **restart the daemon** and confirm per-project colors + the window picker on hardware.
