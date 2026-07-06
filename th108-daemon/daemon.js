// TH108 V2 PRO background lighting daemon.
// Runs the user's saved controller config (th108-daemon/config.json) always-on in the background,
// rendered host-side by the shared th108-engine.js and streamed over ACK-gated raw HID. A global
// keyboard hook (uiohook-napi) drives the reactive layer in ANY app — no browser tab needed.
// Serves the controller page + a control API on http://localhost:8123; hands the device back to
// the WebHID page when it yields, and re-grabs it on resume / heartbeat timeout.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const E = require('../th108-engine.js');
const PC = require('../profile-cycle.js');
const OBP = require('../th108-onboard.js');   // packAllled() — build the cmd-0x23 onboard-effect payload (for the "mask onboard flash to black" toggle)
const T = require('./hid-transport.js');
const U = require('./usb-reset.js');
const { KEYMAP, INDICES, UIOHOOK_TO_CODE } = require('./th108-map.js');
const { createAgentState } = require('./agent-state.js');
const agentState = createAgentState();

const CONFIG_PATH = path.join(__dirname, 'config.json');
const FPS = 30;
const ts = () => new Date().toTimeString().slice(0, 8);   // timestamped logs — to correlate board mute events with system events
const log = (...a) => console.log(ts(), ...a);

// Tee everything (incl. the server's logs) into th108-daemon/daemon.log — the autostart daemon runs in a
// hidden window, so without a file these logs vanish, and we're hunting recurring spontaneous board-mute
// events whose timestamps need correlating with system/USB activity. ~1 MB cap, one .old generation.
const LOG_PATH = path.join(__dirname, 'daemon.log');
const _clog = console.log.bind(console);
console.log = (...a) => {
  _clog(...a);
  try {
    try { if (fs.statSync(LOG_PATH).size > 1_000_000) { fs.rmSync(LOG_PATH + '.old', { force: true }); fs.renameSync(LOG_PATH, LOG_PATH + '.old'); } } catch {}
    fs.appendFileSync(LOG_PATH, a.join(' ') + '\n');
  } catch {}
};
console.log(ts() + ' ───── daemon start ─────');

// The autostart daemon runs in a hidden window — stderr goes NOWHERE, so an uncaught throw used
// to kill the process with zero trace (2026-06-11: died mid-stream the instant the user flipped
// the keyboard's power switch; last log line was a healthy "board RECOVERED"). Log everything
// fatal, and for the known class (HID handle errors when the device vanishes) keep running —
// closeDevice + the 5s reopen loop is exactly the designed recovery.
process.on('uncaughtException', (err) => {
  console.log(ts() + ' ✗ UNCAUGHT: ' + (err && err.stack || err));
  try { closeDevice(); } catch {}
  nextOpenAt = Date.now() + 5000;
});
process.on('unhandledRejection', (err) => {
  console.log(ts() + ' ✗ UNHANDLED REJECTION: ' + (err && err.stack || err));
  try { closeDevice(); } catch {}
  nextOpenAt = Date.now() + 5000;
});

// ----- config -----
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}

let state = null, device = null, send = null, paused = false, timer = null;
const { createLease } = require('./device-lease.js');
const lease = createLease({ settleMs: 800 });   // 800ms = the historically-tuned handoff settle debounce (was HANDOFF_SETTLE_MS), survives restart+refresh storms
// paused is now DERIVED from the lease so every existing `if (paused)` gate keeps working.
function syncPaused() {
  const held = lease.owner() !== 'daemon';
  if (held !== paused) { paused = held; syncAudioCapture(); }   // capture follows ownership, exactly as yield/resume did
}
let lcdBusy = false;     // a now-playing flash upload is running — the 0x32 stream must stay quiet
let npBlinkAt = 0;       // timestamp of a throttled-skip → blink the spacebar red twice
let npFlashAt = 0;       // timestamp of a track change → flash the number row (keys 1-0) for 150ms
let profileFlashAt = 0, profileFlashColor = '#ffffff', profileFlashLed = -1;   // profile-switch number flash
let brightnessBlinkAt = 0;   // brightnessCycle host-action: whole-board white flash the moment brightness hits 100%
const PROFILE_FLASH_MS = 990, PROFILE_BLINK_MS = 330, PROFILE_BLINK_ON = 180;   // ~1s number flash, blinking ~3× (180ms on / 150ms off)
let barCount = 0, barStepAt = 0;   // ANIMATED lit-key count for the progress-bar (lerps toward target one key per BAR_STEP_MS — a seek visibly counts up/down)
const BAR_STEP_MS = 50, BAR_FADE_MS = 600;   // 50ms per key (the sequential walk) / 600ms idle crossfade-out
const SPACE_K = INDICES.indexOf(KEYMAP['Space']);   // spacebar's slot in the flat frame (for the blink overlay)
// keys 1..0 (the number row) → their slots in the flat frame, for the song-progress light-bar
const DIGIT_KS = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0']
  .map(c => INDICES.indexOf(KEYMAP[c])).filter(k => k >= 0);
// the numpad digits (1-9 then 0) — the bar can run on these INSTEAD of the number row (settings.npBarKeys), filling bottom→top
const NUMPAD_KS = ['Numpad1','Numpad2','Numpad3','Numpad4','Numpad5','Numpad6','Numpad7','Numpad8','Numpad9','Numpad0']
  .map(c => INDICES.indexOf(KEYMAP[c])).filter(k => k >= 0);
const hexRGB = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [17, 255, 0]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// paint the first `lit` keys of `keys` as a progress bar, crossfaded over the frame by `op`. grad:
//   'solid' = flat color | 'toWhite' = fades to white at the leading edge | 'fromWhite' = white at the start, fades to color
function paintBar(flat, keys, lit, op, base, f, grad, fit) {
  const [br, bg, bb] = base;
  // gradient normalization: fit=false (default) spans the whole row (over keys.length) so each key keeps its
  // color as the bar fills and white lands on the LAST key; fit=true stretches over the LIT portion so the
  // leading edge is always the gradient end (white at the current position).
  const span = (fit ? lit : keys.length) - 1;
  for (let i = 0; i < lit && i < keys.length; i++) {
    let b = 0; if (grad && grad !== 'solid' && span > 0) { const p = i / span; b = grad === 'fromWhite' ? 1 - p : p; }
    const r = (br + (255 - br) * b) * f, g = (bg + (255 - bg) * b) * f, bl = (bb + (255 - bb) * b) * f, o = keys[i] * 4;
    flat[o + 1] = (flat[o + 1] * (1 - op) + r) | 0; flat[o + 2] = (flat[o + 2] * (1 - op) + g) | 0; flat[o + 3] = (flat[o + 3] * (1 - op) + bl) | 0;
  }
}
let unpausedAt = 0;      // when the daemon last took ownership — flash uploads need STABLE ownership
let framesSent = 0, framesDeduped = 0;   // HID 0x32 stream stats for /metrics (sent vs deduped — shows how much the dedupe is saving)

// ----- daemon settings (separate from config.json, which is the page's layer array verbatim) -----
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
function loadSettings() {
  const DEF = { usbReset: true, nowPlaying: false, npTitle: '#ffffff', npArtist: '#ffd98c', lightsOn: true, brightness: 100, npRevertSec: 0, npAllow: {}, npArtFit: false,
                npBar: false, npBarColor: '#11ff00', npBarBright: 60, npFlash: true, npFlashColor: '#ffd000', npBarIdleSec: 3, npBarGrad: 'solid', npBarGradFit: false, npBarKeys: 'row', npBarAgentTop: false, npOnboardMask: false, dimOnDisplayOff: false };   // npBarAgentTop = let the agent layer's numpad glyphs render ABOVE the progress bar (z-swap on the shared keys)   // dimOnDisplayOff = blank the board while the monitor is off on the idle timeout   // npOnboardMask = set the keyboard's onboard effect to BLACK so the per-update flash is a dark blink, not rainbow   // npBarIdleSec = fade the bar out after this long with nothing playing   // npRevertSec 0 = never revert; npAllow = per-source override (absent → Spotify-only default); npBar = the 1-0 song-progress light-bar (lighting-only, no flash writes), npFlash = yellow track-change blip
  try { return Object.assign({}, DEF, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEF); }   // usbReset default ON — the escalation fails gracefully (one log line) if the task isn't registered
}
let settings = loadSettings();
function saveSettings() { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings)); } catch {} }

// Reload config.json → rebuild engine state. Absent/invalid config → idle (state = null).
function rebuildState() {
  const cfg = loadConfig();
  state = cfg ? E.createState(cfg) : null;
  if (state) state.bri = Math.max(0, Math.min(100, settings.brightness != null ? settings.brightness : 100)) / 100;   // global brightness parity with the page (shared engine reads state.bri)
}
rebuildState();

// ----- global keyboard hook: uiohook keycode -> LED index -----
// UIOHOOK_TO_CODE: UiohookKey property name -> KeyboardEvent.code; KEYMAP: code -> LED index.
const UIO2IDX = {};
for (const [name, code] of Object.entries(UIOHOOK_TO_CODE)) {
  const kc = UiohookKey[name], idx = KEYMAP[code];
  if (kc !== undefined && idx !== undefined) UIO2IDX[kc] = idx;
}
// uiohook-napi's UiohookKey OMITS some keys (no property at all), so they never enter UIO2IDX by name — add them
// by their raw libuiohook codes so reactive lighting AND host actions can resolve them. Without this the daemon
// can't map the keypress to an LED, so nothing fires (and it lands in the 🔍 unmapped log below).
const RAW_UIO = { 3677: 'ContextMenu', 3653: 'Pause', 57378: 'NumLock' };   // Apps/Menu (VC_CONTEXT_MENU 0x0E5D), Pause/Break (VC_PAUSE 0x0E45), NumLock (this board emits 57378, which UiohookKey.NumLock doesn't match → host-action binding couldn't see it)
for (const [kc, code] of Object.entries(RAW_UIO)) { const idx = KEYMAP[code]; if (idx !== undefined) UIO2IDX[+kc] = idx; }
// DISCOVER: log (once each) any pressed key the daemon couldn't map → tells us the real code to add if a board
// sends something unexpected (e.g. Menu on a different code than 3677). Cheap; only fires on a genuinely unmapped key.
const _seenUnmapped = new Set();
uIOhook.on('keydown', e => { if (UIO2IDX[e.keycode] === undefined && !_seenUnmapped.has(e.keycode)) { _seenUnmapped.add(e.keycode); log('🔍 unmapped key: uiohook keycode ' + e.keycode + ' — add to UIO2IDX to bind it (reactive/host actions)'); } });
uIOhook.on('keydown', e => { lastKeyAt = Date.now(); if (state) { const i = UIO2IDX[e.keycode]; if (i !== undefined) E.stampKey(state, i); } });
uIOhook.on('keyup',   e => { if (state) { const i = UIO2IDX[e.keycode]; if (i !== undefined) E.releaseKey(state, i); } });
// Global recovery hotkey: Ctrl+Alt+End in ANY app = "my lighting broke — fix it" (user request
// 2026-06-11). Typing keeps flowing through an ACK-mute wedge, so the chord always arrives.
// Action = the proven PnP software replug + a reopen window; ownership then sorts itself out
// (the page rebinds and resumes, or hands back and the daemon drives). Deliberately ignores the
// settings.usbReset toggle — that governs AUTOMATIC restarts, and this is an explicit human ask.
let hotkeyAt = 0;
uIOhook.on('keydown', e => {
  if (e.keycode !== UiohookKey.End || !e.ctrlKey || !e.altKey) return;
  if (Date.now() - hotkeyAt < 15_000) return;   // swallow key-repeat + no replug spam
  hotkeyAt = Date.now();
  log('🔧 recovery hotkey (Ctrl+Alt+End) — PnP-restarting the keyboard; typing drops ~1-2s, lighting returns by itself');
  usbFiredAt = Date.now();
  U.fire(log);
  closeDevice(); nextOpenAt = Date.now() + 3000;   // let the re-enumeration settle, then the tick reopens (when not yielded)
});
// ----- HOST ACTIONS: a user-chosen TRIGGER fires a host-side action (NOT a firmware remap — the key still types
// whatever it types; the daemon just WATCHES it). Bound in the page's "Host Actions" binder tab, which pushes the
// registry here so it runs with the page/tab CLOSED. Schema is normalized by host-actions.js:
//   trigger: key | chord (mods+key) | multitap (N presses in a window) | hold (press for N ms)
//   action:  micToggle | profileNext | profilePrev | profileSelect(index) | macro(steps) | launch(target)
const HA = require('./host-actions.js');
const HOST_ACTIONS_PATH = path.join(__dirname, 'host-actions.json');
const PROFILES_PATH = path.join(__dirname, 'profiles.json');
function loadJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
let hostActions = HA.normalize(loadJSON(HOST_ACTIONS_PATH) || []);
let profiles = loadJSON(PROFILES_PATH) || [];          // [{name, layers, order}] — pushed by the page so cycling works page-closed
const INDICATOR_PATH = path.join(__dirname, 'profile-indicator.json');
let indicator = loadJSON(INDICATOR_PATH) || { on: true, keys: 'numberRow' };   // profile-switch number flash settings
function saveIndicator() { try { fs.writeFileSync(INDICATOR_PATH, JSON.stringify(indicator)); } catch {} }
let curProfile = -1;                                   // index of the last-applied profile (best-effort; -1 = unknown)
function saveHostActions() { try { fs.writeFileSync(HOST_ACTIONS_PATH, JSON.stringify(hostActions)); } catch {} }
// Migrate the OLD per-layer Mic toggle-hotkey (settings.toggleKeyLed) into a key→micToggle binding, once.
(function migrateToggleKey() {
  try { const cfg = loadConfig();
    if (Array.isArray(cfg)) { const a = cfg.find(x => x && x.type === 'audio' && x.settings && x.settings.toggleKeyLed != null);
      if (a && !hostActions.some(b => b.action.type === 'micToggle')) { hostActions.push({ trigger: { type: 'key', led: a.settings.toggleKeyLed }, action: { type: 'micToggle' } }); saveHostActions(); } }
  } catch {}
})();
function toggleAudioLayer() {
  if (!state) return;
  const L = state.layers.find(l => l && l.type === 'audio' && l.settings); if (!L) return;
  L.enabled = !L.enabled;
  state.lastFlat = null;   // force a resend (a static frame might not otherwise)
  const cfg = loadConfig();   // mirror the flip into config.json so it survives restart + the page sees it
  if (Array.isArray(cfg)) { const cl = cfg.find(x => x && x.type === 'audio');
    if (cl) { cl.enabled = L.enabled; try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg)); } catch {} } }
  syncAudioCapture();   // disabling the audio layer stops capture; enabling restarts it
  log('🎚 host action: audio layer "' + (L.name || '') + '" ' + (L.enabled ? 'ON' : 'OFF'));
}
function applyProfile(p, label) {   // shared apply path (cycle + direct-select); applies aspects per profile type
  if (!p) return;
  const asp = PC.applyAspects(p.type);
  if (asp.layers && Array.isArray(p.layers)) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(p.layers)); } catch {}   // persist so it survives + the page sees it
    if (!paused && state) { state = E.applyConfig(state, p.layers);   // apply live unless the page holds the device
      if (state) { state.bri = Math.max(0, Math.min(100, settings.brightness != null ? settings.brightness : 100)) / 100; state.lastFlat = null; } }
  }
  if (asp.hotkeys) {   // swap Host Actions, preserving the LIVE profile-cycle bindings so the cycle key survives
    hostActions = HA.normalize(PC.mergeKeepingCycle(p.hostActions || [], hostActions)); saveHostActions(); _haReset();
  }
  syncAudioCapture();
  if (indicator.on) { profileFlashAt = Date.now(); profileFlashColor = p.color || '#ffffff'; profileFlashLed = PC.flashLed(indicator.keys, curProfile, DIGIT_KS, NUMPAD_KS); }
  log('🎚 host action: profile → "' + label + '"');
}
function cycleProfile(dir) {
  if (!Array.isArray(profiles) || !profiles.length) { log('🎚 host action: profile cycle — no profiles saved (save some on the Profiles tab)'); return; }
  curProfile = ((curProfile < 0 ? 0 : curProfile + dir) + profiles.length) % profiles.length;
  applyProfile(profiles[curProfile], (profiles[curProfile].name || ('#' + (curProfile + 1))) + ' (' + (curProfile + 1) + '/' + profiles.length + ')');
}
function selectProfile(index) {
  if (!Array.isArray(profiles) || !profiles.length) { log('🎚 host action: profile select — no profiles saved'); return; }
  if (index < 0 || index >= profiles.length) { log('🎚 host action: profile ' + (index + 1) + ' not saved (only ' + profiles.length + ' exist)'); return; }
  curProfile = index; applyProfile(profiles[index], profiles[index].name || ('#' + (index + 1)));
}
// KeyboardEvent.code → uiohook keycode, so a page-recorded macro (which speaks KeyboardEvent.code) can be played
// back through uiohook.keyTap (which speaks libuiohook keycodes). Built from the same table the input hook uses.
const CODE2UIO = {};
for (const [name, code] of Object.entries(UIOHOOK_TO_CODE)) { const kc = UiohookKey[name]; if (kc !== undefined) CODE2UIO[code] = kc; }
CODE2UIO.ContextMenu = 3677; CODE2UIO.Pause = 3653;   // the keys uiohook-napi omits (see RAW_UIO above)
function playMacro(steps) {
  if (!Array.isArray(steps) || !steps.length) return;
  let i = 0; const next = () => { if (i >= steps.length) return; const s = steps[i++];
    if (s.ms != null) { setTimeout(next, Math.max(0, s.ms)); return; }   // delay step — wait, then continue
    const key = CODE2UIO[s.code];
    if (key !== undefined) { const mods = [];
      if (s.ctrl) mods.push(UiohookKey.Ctrl); if (s.shift) mods.push(UiohookKey.Shift); if (s.alt) mods.push(UiohookKey.Alt); if (s.meta) mods.push(UiohookKey.Meta);
      try { uIOhook.keyTap(key, mods); } catch {} }
    setTimeout(next, 40); };   // ~40ms default gap between keys so apps register each one
  next();
  log('🎚 host action: macro (' + steps.length + ' steps)');
}
function launchTarget(target) {
  target = String(target || '').trim().replace(/^["']+|["']+$/g, '').trim();   // strip surrounding quotes (Copy as path)
  if (!target) return;
  // open a program / file / URL with its default handler. spawn (no shell) + windowsHide → no console flash.
  // The target is the user's OWN local binding (their machine), so this isn't a trust boundary.
  try { require('child_process').spawn('cmd.exe', ['/c', 'start', '', target], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    log('🎚 host action: launch "' + target + '"'); }
  catch (e) { log('🎚 host action: launch failed — ' + e.message); }
}
function winCmd(cmd) { try { ensureFocusHost(); fs.writeFileSync(FOCUS_REQ, cmd); } catch {} }   // window op on the FOREGROUND window via the warm host (reliable Win32 ShowWindow, no Win+Down toggle)
// A WARM, persistent PowerShell that focuses windows on demand (reads a path per line from stdin). Spawning a
// fresh PowerShell per press cost ~300ms (cold CLR + Add-Type); this pays that ONCE so repeated "Switch to" is
// near-instant. Lazily started on first use (or pre-warmed at startup if a focusApp binding exists).
let _focusPS = null;
const FOCUS_REQ = path.join(__dirname, '_focusreq.txt');
function ensureFocusHost() {
  if (_focusPS) return _focusPS;
  const psPath = path.join(__dirname, '_focushost.ps1');
  // Reliable IPC: the host POLLS a request file (stdin reading from a piped PS was the regression). The daemon
  // writes the target path to _focusreq.txt; the host reads+deletes it and focuses (Alt tap satisfies the
  // foreground lock; launches if not running).
  const ps = ['Add-Type @"', 'using System; using System.Runtime.InteropServices;',
    'public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e); }', '"@',
    '$req = Join-Path $PSScriptRoot "_focusreq.txt"',
    '$prev = [IntPtr]::Zero',   // the window we switched AWAY from, so a re-press toggles back to it
    'function FocusWin($h) { if ([int64]$h -eq 0) { return }; if ([W]::IsIconic($h)) { [W]::ShowWindow($h, 9) | Out-Null }; [W]::keybd_event(0xA4,0,0,[IntPtr]::Zero); [W]::keybd_event(0xA4,0,2,[IntPtr]::Zero); [W]::SetForegroundWindow($h) | Out-Null }',   // restore ONLY if minimized (keeps maximized state — no unmaximize); alt-tap beats the foreground lock
    'while ($true) {',
    '  if (Test-Path -LiteralPath $req) {',
    "    $p = ''; try { $p = [System.IO.File]::ReadAllText($req) } catch {}",
    '    Remove-Item -LiteralPath $req -Force -ErrorAction SilentlyContinue',
    '    $p = $p.Trim().Trim([char]34).Trim()',
    "    if ($p -ne '') { try {",
    "      if ($p -eq ':MIN') { $h = [W]::GetForegroundWindow(); if ($h -ne [IntPtr]::Zero) { [W]::ShowWindow($h, 6) | Out-Null } }",          // 6 = SW_MINIMIZE (always minimizes, no toggle)
    "      elseif ($p -eq ':MAX') { $h = [W]::GetForegroundWindow(); if ($h -ne [IntPtr]::Zero) { [W]::ShowWindow($h, 3) | Out-Null } }",       // 3 = SW_MAXIMIZE
    "      elseif ($p -eq ':RESTORE') { $h = [W]::GetForegroundWindow(); if ($h -ne [IntPtr]::Zero) { [W]::ShowWindow($h, 9) | Out-Null } }",   // 9 = SW_RESTORE (unmaximize)
    '      else {',
    '        $proc = $null',     // inline try/catch in Where-Object is PS7-only; Windows PowerShell 5.1 needs a foreach with try/catch STATEMENTS ($_.Path throws on protected processes)
    '        foreach ($pr in (Get-Process)) { if ($pr.MainWindowHandle -eq 0) { continue }; $pp = $null; try { $pp = $pr.Path } catch {}; if ($pp -eq $p) { $proc = $pr; break } }',
    '        if ($proc) { $target = $proc.MainWindowHandle; $cur = [W]::GetForegroundWindow()',
    '          if ([int64]$cur -eq [int64]$target) { if ([int64]$prev -ne 0 -and [W]::IsWindow($prev) -and [int64]$prev -ne [int64]$target) { FocusWin $prev } }',   // already on the app -> toggle back to the previous window
    '          else { $prev = $cur; FocusWin $target } }',   // remember where we came from, then switch
    '        else { Start-Process -FilePath $p } } } catch {} }',
    '  }',
    '  Start-Sleep -Milliseconds 70',
    '}'].join('\r\n');
  try { fs.writeFileSync(psPath, ps); } catch { return null; }
  try { _focusPS = _spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psPath], { windowsHide: true, stdio: 'ignore' });
    _focusPS.on('exit', () => { _focusPS = null; }); _focusPS.on('error', () => { _focusPS = null; });
  } catch { _focusPS = null; }
  return _focusPS;
}
function focusApp(target) {
  target = String(target || '').trim().replace(/^["']+|["']+$/g, '').trim(); if (!target) return;
  try { ensureFocusHost(); fs.writeFileSync(FOCUS_REQ, target); log('🎚 host action: switch to "' + target + '"'); }
  catch (e) { log('🎚 host action: switch-to failed — ' + e.message); }
}
function fireHostAction(b) {
  const a = b.action;
  if (a.type === 'micToggle') return toggleAudioLayer();
  if (a.type === 'profileNext') return cycleProfile(1);
  if (a.type === 'profilePrev') return cycleProfile(-1);
  if (a.type === 'profileSelect') return selectProfile(a.index | 0);
  if (a.type === 'macro') return playMacro(a.steps);
  if (a.type === 'launch') return launchTarget(a.target);
  if (a.type === 'focusApp') return focusApp(a.target);
  if (a.type === 'winMin') return winCmd(':MIN');
  if (a.type === 'winMax') return winCmd(':MAX');
  if (a.type === 'winRestore') return winCmd(':RESTORE');
  if (a.type === 'brightnessCycle') return cycleBrightness();
}
// brightnessCycle: step global brightness +10% (wrap 100→0), apply live, and white-flash the board at 100%.
function cycleBrightness() {
  const { value, blink } = HA.nextBrightness(settings.brightness);
  settings.brightness = value;
  if (state) { state.bri = value / 100; state.lastFlat = null; }   // live + bust the send dedupe so it applies now
  if (blink) brightnessBlinkAt = Date.now();
  saveSettings();
}
// per-binding state for the stateful triggers (multitap taps, hold timers) + a fire debounce for key/chord.
const _haState = new Map();   // binding ref → { taps:[], holdTimer }
const _haLastFire = new Map();
function _haReset() { for (const st of _haState.values()) if (st.holdTimer) clearTimeout(st.holdTimer); _haState.clear(); _haLastFire.clear(); }
// While the page is in key-capture (binding a key), it suppresses host-action firing so the key being pressed
// doesn't ALSO run whatever it's already bound to (which would yank a window around mid-bind). TTL-guarded so a
// page that closes mid-capture can't wedge actions off forever.
let _haSuppressUntil = 0;
function setHaSuppress(ms) { _haSuppressUntil = ms > 0 ? Date.now() + Math.min(ms, 60000) : 0; }
function _haDebounceFire(b, now) { if (now - (_haLastFire.get(b) || 0) < 400) return; _haLastFire.set(b, now); fireHostAction(b); }
uIOhook.on('keydown', e => {
  const led = UIO2IDX[e.keycode]; if (led === undefined || !hostActions.length) return;
  const now = Date.now(); if (now < _haSuppressUntil) return;   // page is mid-bind: don't fire the key's existing action
  const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
  for (const b of hostActions) {
    const t = b.trigger; if (t.led !== led) continue;
    if (t.type === 'key') { _haDebounceFire(b, now); }
    else if (t.type === 'chord') { if (HA.chordMatches(t.mods, mods)) _haDebounceFire(b, now); }
    else if (t.type === 'multitap') {
      const st = _haState.get(b) || { taps: [] };
      const last = st.taps[st.taps.length - 1];
      if (last != null && now - last < 60) continue;   // ignore OS key-repeat (real taps are >60ms apart)
      const r = HA.tapFires(st.taps, now, t.count, t.windowMs); st.taps = r.taps; _haState.set(b, st);
      if (r.fire) fireHostAction(b);
    } else if (t.type === 'hold') {
      const st = _haState.get(b) || {};
      if (!st.holdTimer) { st.holdTimer = setTimeout(() => { st.holdTimer = null; fireHostAction(b); }, t.holdMs); _haState.set(b, st); }   // key-repeat keydowns won't re-arm (guarded); keyup cancels
    }
  }
});
uIOhook.on('keyup', e => {
  const led = UIO2IDX[e.keycode]; if (led === undefined) return;
  for (const b of hostActions) { if (b.trigger.type === 'hold' && b.trigger.led === led) { const st = _haState.get(b); if (st && st.holdTimer) { clearTimeout(st.holdTimer); st.holdTimer = null; } } }
});
uIOhook.start();

// ----- device lifecycle -----
function closeDevice() {
  if (device) { try { device.close(); } catch {} }
  device = null; send = null;
}

// Clear any reactive keys still marked "down". The daemon's one stuck-key path is a uiohook keyup
// dropped under heavy load (the page's brief-blur path is fixed in b252b20). Fired on every fresh
// device handle — reconnect / mute-recovery / onboard cycle, all natural recovery points — so a
// missed keyup can't survive a reopen. Uses releaseKey (a fade-out), NOT rebuildState, so running
// animations and their timers are untouched. (No clean event covers the pure continuous-drive case;
// that trigger was already reduced by the media-sidecar leak fix f78d66b — see th108-reactive-stuck-keys.)
function releaseHeldKeys() {
  if (!state) return;
  const d = state.react.down;
  for (let i = 0; i < d.length; i++) if (d[i]) E.releaseKey(state, i);
}

// Write a single onboard-effect packet (cmd 0x23, 16-byte allled) on the control interface, then cycle
// the handle (a live 0x23 leaves the board ACKing-but-IGNORING 0x32 paint). Pauses the 0x32 stream while
// it writes — same protocol-safety stance as an LCD flash. Returns false if we don't own a healthy board.
async function sendOnboard(allled) {
  if (!device || paused || muteLogged) return false;
  const prevBusy = lcdBusy; lcdBusy = true;                       // hold the 0x32 stream off while we write 0x23
  const t0 = Date.now(); while (sendingFrame && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 20));
  try {
    const pkt = Buffer.alloc(64);
    pkt[0] = 0xAA; pkt[1] = 0x23; pkt[2] = 16; pkt[6] = 1;        // header: marker, cmd, len, last=1 (offset 0)
    for (let i = 0; i < 16; i++) pkt[8 + i] = allled[i];
    device.write([0x00, ...pkt]);                                // leading reportId 0 (Windows)
    await new Promise(r => setTimeout(r, 350));                  // let the 0x23 ACK land (mirrors the page)
  } catch { lcdBusy = prevBusy; return false; }
  closeDevice(); nextOpenAt = 0;                                 // cure: fresh handle so 0x32 paints again
  if (state) state.lastFlat = null;                             // force a repaint on the reopened handle
  lcdBusy = prevBusy;
  return true;
}

// Try to (re)open the control interface when we have none and aren't paused.
// PROBE BEFORE WRITING (defense in depth for the single-writer rule): Windows HID opens are SHARED,
// so nothing at the OS level stops daemon + page from both holding the device. Listen ~1.5s on the
// fresh handle first — unsolicited 0x55 ACK traffic means a live page is streaming (its yield expired
// but it's still there); writing too would wedge the board. Back off and re-probe on a later tick.
let probing = false, nextOpenAt = Date.now() + 5000;   // startup grace: a live page's heartbeat needs a beat (≤3s) to park us before we first touch the device
let lastOkAt = 0, streakStart = 0, muteLogged = false, muteAt = 0;   // mute-episode tracking (transition logging)
let usbFiredAt = 0, lastTickAt = 0;   // USB-restart escalation state + sleep-gap detection
let lastKeyAt = Date.now();           // last physical keypress (from the global hook) — drives the idle-aware USB-restart threshold
let offCleared = false;               // lights-off / display-off: the one black frame was sent
let displayOff = false;               // monitor is off on the idle timeout (from display-watch.ps1) → blank the board
let sendingFrame = false;             // a 0x32 frame is mid-flight — closing the device NOW leaves the board's chunk parser desynced
let fastReopen = false;               // set on a clean lease reclaim → the next reopen uses a SHORT probe + immediate repaint (kills the ~1.5s post-handoff dark: the lease already guarantees single ownership, so the full 1.5s foreign-writer probe is overkill here)
async function openIfPossible() {
  if (device || paused || probing) return;
  if (Date.now() < nextOpenAt) return;   // backoff after a mute/failed device — no 2s open/close churn against a wedged board
  const p = T.findPath();
  if (!p) return;
  probing = true;
  let d = null;
  try {
    d = T.openDevice(p);
    const fast = fastReopen; fastReopen = false;   // consume the one-shot flag once a probe actually runs
    const traffic = await T.probeTraffic(d, fast ? 400 : 1500);   // clean lease reclaim → short probe (still catches an actively-streaming foreign writer like Sudachi/Steam), else the full backstop
    if (paused) { try { d.close(); } catch {} return; }   // yielded mid-probe — hand it straight back
    if (traffic > 0) {
      try { d.close(); } catch {}
      nextOpenAt = Date.now() + 5000;   // cool down — re-probing every tick churns handles against a live streamer, and once raced into a double-open ("backing off" → "device open" 2s later → mute, 2026-06-11 log)
      log(`… another writer on the device (${traffic} reports during probe) — backing off`);
      return;
    }
    device = d;
    send = T.makeSender(device, { ackTimeoutMs: 800 });
    if (fast && state) state.lastFlat = null;   // fresh handle after a fast reclaim → force an immediate repaint so the board doesn't sit dark
    releaseHeldKeys();   // fresh handle = a recovery point: drop any key a missed keyup left stuck
    if (!muteLogged) log('✓ device open');   // stay quiet during a mute-retry loop — the MUTE/recovered transition lines tell the story
  } catch { try { if (d) d.close(); } catch {} nextOpenAt = Date.now() + 5000; }
  finally { probing = false; }
}

// ----- render loop ~30fps -----
let tickBusy = false;   // single-flight guard: setInterval keeps firing every ~33ms, but a slow/stalling send
// (up to the 800ms ACK timeout) must NOT let the next interval re-enter and start a SECOND concurrent send —
// two overlapping sendFrame calls interleave writes on the shared ACK gate → FIFO overrun → wedge (this is
// what turns a one-frame board hiccup into a full mute). Mirrors the page's layerInFlight guard.
async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try { await runTick(); } finally { tickBusy = false; }
}
async function runTick() {
  // Drive the lease's clock + derive `paused` FIRST — this must run even while paused (owner != 'daemon')
  // so the fallback ladder (probe → USB re-enumerate) and the settle-debounced reclaim keep progressing;
  // the `if (paused...) return` below only gates the daemon's OWN rendering/open path.
  syncPaused();
  const act = lease.tick(Date.now());
  if (act && act.action === 'reclaim') {
    rebuildState(); unpausedAt = Date.now();   // mirrors the old resume(): reload the page's saved config + reset the flash-upload stability window
    syncPaused();   // owner is 'daemon' again → clear derived paused NOW so openIfPossible() reopens this same tick
    fastReopen = true;   // the page released cleanly (lease says daemon owns) → short-probe + repaint at once, so the board doesn't sit dark ~1.5s after the handoff
  } else if (act && act.action === 'probe') {
    // revoked page never released — probe on a throwaway handle; quiet ⇒ grant, else escalate to re-enumerate.
    // NOTE: 'reenumerate' is decided HERE, inside probeResult()'s return — lease.tick() itself never emits
    // it (only 'reclaim'/'probe'/null), so the escalation must be handled off this call, not a later tick().
    const p = T.findPath();
    if (p) {
      let d = null;
      try {
        d = T.openDevice(p);
        const traffic = await T.probeTraffic(d, 1500);
        try { d.close(); } catch {}
        const pr = lease.probeResult(traffic === 0, Date.now());
        if (pr && pr.action === 'reenumerate') {
          U.fire(log);   // same PnP-restart task the page's /usbfix triggers (control.usbFix) — drops all handles OS-side
          setTimeout(() => { lease.forceGrant(Date.now()); syncPaused(); }, 2500);   // grant after re-enumeration settles
        }
      } catch { try { if (d) d.close(); } catch {} }
    }
  }
  if (paused || lcdBusy) return;   // lcdBusy: a flash upload owns the board — no lighting writes
  // Sleep-gap re-baseline: after a suspend, the pre-sleep muteAt is hours stale — without this the USB
  // restart would insta-fire on the first failed send at wake, even though wake mutes recover on their own.
  const nowWall = Date.now();
  if (lastTickAt && nowWall - lastTickAt > 30_000 && muteLogged) muteAt = nowWall;
  lastTickAt = nowWall;
  await openIfPossible();
  // board goes dark when the master switch is off OR (opt-in) while the monitor is off on the idle timeout:
  // clear it once, then stay quiet until it should light again.
  if (!settings.lightsOn || displayOff) {
    if (device && send && !offCleared) {
      const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0));
      if (await send(off)) offCleared = true;
    }
    return;
  }
  if (device && send && state) {
    const now = performance.now();
    if (acHandle) {   // fold the latest real-audio frame into state.audio (>250ms stale → null → engine decays to silence)
      const raw = AC.freshOr(acHandle.latest(), Date.now(), 250);
      const aL = state.layers.find(L => L.enabled && L.type === 'audio');
      // On stale (capture stalled on pause) feed a SILENT frame instead of skipping — skipping froze the bars
      // and ran the fast decay for the first 250ms; feeding {live:0} lets pause-decay settle them to 0 evenly.
      if (aL) E.applyAudioFeatures(state, raw || { level: 0, live: 0 }, aL.settings, now);
    }
    const agL = state.layers.find(L => L.enabled && L.type === 'agent');
    E.applyAgentFeed(state, agL ? agentState.aggregate(agL.settings && agL.settings.session || 'all', Date.now()) : null);
    const flat = E.composeFrame(state, now);
    // throttled-skip feedback: blink the SPACEBAR red TWICE when a media command lands inside the
    // safety window (it's queued until the buffer clears). Overlaid on the live frame — flatEq below
    // sends only on each phase change (on↔off), so static frames still idle to the 1fps keepalive.
    if (npBlinkAt) {
      const bt = Date.now() - npBlinkAt;
      if (bt >= 0 && bt < 640) {                       // 2 blinks: on [0,160) off [160,320) on [320,480) off [480,640)
        const ph = Math.floor(bt / 160);
        if (ph === 0 || ph === 2) { flat[SPACE_K * 4 + 1] = 255; flat[SPACE_K * 4 + 2] = 0; flat[SPACE_K * 4 + 3] = 0; }
      } else npBlinkAt = 0;
    }
    // song-progress light-bar on the number row (keys 1-0): light the first N of 10 keys in the bar
    // color to show how far through the song we are. SAFE — lighting only, no LCD flash writes. The
    // yellow track-change flash (150ms, all 10) rides the same toggle, gated by its own on/off.
    if (settings.npBar && npHandle && DIGIT_KS.length) {
      // OPTIONAL z-swap (settings.npBarAgentTop): let the agent glyphs (spinner / ✓ / "!") read ABOVE the
      // bar instead of under it. Off by default → the bar paints over the agent layer as before. When on,
      // snapshot the composed value of any bar key the agent layer is lighting and restore it after the bar +
      // flash paint, so the glyph punches through (matters when both share the numpad, npBarKeys='numpad').
      const agKs = settings.npBarKeys === 'numpad' ? NUMPAD_KS : DIGIT_KS;
      const agRestore = [];
      if (settings.npBarAgentTop && agL) for (const k of agKs) { const t = k * 3; if (agL.rgb[t] + agL.rgb[t + 1] + agL.rgb[t + 2] > 6) { const o = k * 4; agRestore.push([o, flat[o + 1], flat[o + 2], flat[o + 3]]); } }
      const ms = npHandle.mediaState();
      // idle crossfade: nothing playing for npBarIdleSec → fade the bar out (reveal the lighting beneath)
      let op = 1;
      if (ms.hasMedia && !ms.playing) {
        const idleSec = settings.npBarIdleSec == null ? 3 : settings.npBarIdleSec;
        const over = (ms.idleMs || 0) - idleSec * 1000;
        if (over > 0) op = Math.max(0, 1 - over / BAR_FADE_MS);
      }
      if (ms.hasMedia && op > 0) {
        const [br, bg, bb] = hexRGB(settings.npBarColor);
        const f = (Math.max(0, Math.min(100, settings.npBarBright == null ? 60 : settings.npBarBright)) / 100) * op;
        // sequential lerp: walk the lit-key count toward the target ONE key per BAR_STEP_MS, so a seek
        // (e.g. 73% → 24%) visibly counts down rather than snapping. Normal playback advances 1 step
        // every ~(song/10)s, so it just keeps pace.
        const barKs = settings.npBarKeys === 'numpad' ? NUMPAD_KS : DIGIT_KS;   // run the bar on the number row OR the numpad (not both)
        const target = Math.round(ms.progress * barKs.length);
        const nowMs = Date.now();
        if (barCount !== target && nowMs - barStepAt >= BAR_STEP_MS) { barCount += Math.sign(target - barCount); barStepAt = nowMs; }
        // crossfade the bar OVER the underlying lighting (op<1 mid-fade)
        paintBar(flat, barKs, barCount, op, [br, bg, bb], f, settings.npBarGrad, settings.npBarGradFit);
        // NO lastFlat reset: flatEq below catches a step/fade change and sends it; a STATIC bar over
        // static lighting stays equal → idles to the 1fps keepalive instead of forcing 30fps.
      } else if (!ms.hasMedia) { barCount = 0; }   // media gone → next song fills from empty
      if (npFlashAt && settings.npFlash) {
        const ft = Date.now() - npFlashAt;
        if (ft >= 0 && ft < 150) { const [fr, fg, fb] = hexRGB(settings.npFlashColor); const fks = settings.npBarKeys === 'numpad' ? NUMPAD_KS : DIGIT_KS; for (const k of fks) { const o = k * 4; flat[o + 1] = fr; flat[o + 2] = fg; flat[o + 3] = fb; } }   // flatEq sends the flash on its on/off edges
        else if (ft >= 150) npFlashAt = 0;
      } else if (npFlashAt && !settings.npFlash) npFlashAt = 0;
      for (const [o, r, g, b] of agRestore) { flat[o + 1] = r; flat[o + 2] = g; flat[o + 3] = b; }   // agent glyph back on top of bar + flash
      if (profileFlashAt && profileFlashLed >= 0) {   // ~1s profile-switch number flash, in the profile's color, blinking ~3×
        const pt = Date.now() - profileFlashAt;
        if (pt >= PROFILE_FLASH_MS) profileFlashAt = 0;
        else if (pt >= 0 && (pt % PROFILE_BLINK_MS) < PROFILE_BLINK_ON) { const [pr, pg, pb] = hexRGB(profileFlashColor); const o = profileFlashLed * 4; flat[o + 1] = pr; flat[o + 2] = pg; flat[o + 3] = pb; }
      }
    }
    if (brightnessBlinkAt) {   // brightnessCycle "hit 100%" cue: whole board white for ~150ms (flatEq sends the on/off edges)
      const bt = Date.now() - brightnessBlinkAt;
      if (bt >= 0 && bt < 150) { for (let o = 0; o < flat.length; o += 4) { flat[o + 1] = 255; flat[o + 2] = 255; flat[o + 3] = 255; } }
      else if (bt >= 150) brightnessBlinkAt = 0;
    }
    if (!E.flatEq(flat, state.lastFlat) || now - state.lastSent >= 1000) {
      sendingFrame = true;
      let ok; try { ok = await send(flat); } finally { sendingFrame = false; }
      if (ok) {
        framesSent++;
        state.lastFlat = flat; state.lastSent = now;
        if (!lastOkAt || muteLogged) {                     // streaming (re)started — one transition line, with mute duration if recovering
          streakStart = Date.now();
          if (muteLogged) { log(`✓ board RECOVERED — ACKing again (mute lasted ${Math.round((Date.now() - muteAt) / 1000)}s)`); muteLogged = false; }
        }
        lastOkAt = Date.now();
      } else {                  // stall → drop device, retry after a pause (a wedged board stays mute until replug)
        const trace = (send && send.flightRecorder) ? send.flightRecorder() : null;   // grab BEFORE closeDevice() nulls send — this is the pre-silence trace
        closeDevice(); nextOpenAt = Date.now() + 5000;
        if (paused) return;                                // the "stall" was our own yield closing the device mid-frame — not a board event, don't log MUTE
        if (!muteLogged) {                                 // one transition line per mute episode (the 5s retries stay silent)
          muteLogged = true; muteAt = Date.now();
          log('⚠ board went MUTE — no ACKs (' + (lastOkAt
            ? 'was streaming ' + Math.round((muteAt - streakStart) / 60000) + ' min, last ACK ' + Math.round((muteAt - lastOkAt) / 1000) + 's ago'
            : 'never ACKed since open') + ') — retrying every 5s; USB restart fires at ' + Math.round(U.IDLE_THRESHOLD_MS / 1000) + 's if AFK, ' + Math.round(U.THRESHOLD_MS / 1000) + 's while typing');
          if (trace) log('   ↳ flight recorder (last input reports + writes before silence):\n' + trace);
        }
        // Escalation: a PnP restart of the keyboard's USB node = software replug (proven to clear a true
        // wedge). Loud by design — it drops typing ~1-2s, so the log must say exactly when and why.
        // Idle-aware threshold: a USB restart costs a ~1-2s typing dropout, so wait the full 30s while you're
        // actively typing — but if you've been AFK (no keypress for IDLE_AFTER_MS) the dropout is free, so
        // recover the lighting much sooner (IDLE_THRESHOLD_MS). lastKeyAt comes from the global key hook.
        const afk = Date.now() - lastKeyAt > U.IDLE_AFTER_MS;
        const thresholdMs = afk ? U.IDLE_THRESHOLD_MS : U.THRESHOLD_MS;
        if (settings.usbReset && U.shouldFire({ muteAt, now: Date.now(), lastFireAt: usbFiredAt, thresholdMs })) {
          usbFiredAt = Date.now();
          log('⚡ ESCALATING: mute has lasted ' + Math.round((usbFiredAt - muteAt) / 1000) + 's (' + (afk ? 'AFK — recovering early' : 'actively typing') + ') — PnP-restarting the keyboard USB device (task "' + U.TASK_NAME + '"); typing drops ~1-2s');
          U.fire(log);
        }
      }
    } else framesDeduped++;   // frame identical to the last + inside the keepalive window → skipped (the dedupe idling static lighting to ~1fps)
  }
}
timer = setInterval(() => { tick().catch(() => {}); }, Math.round(1000 / FPS));

// ----- autostart = per-user HKCU Run key (NO admin needed, so the daemon can toggle it itself) -----
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', RUN_NAME = 'TH108LightingDaemon';
const RUN_CMD = `wscript.exe "${path.join(__dirname, 'start-tray.vbs')}"`;   // login starts the TRAY, which starts (and supervises via menu) the daemon
function getAutostart() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => execFile('reg', ['query', RUN_KEY, '/v', RUN_NAME], (err) => resolve(!err)));
}
function setAutostart(on) {
  if (process.platform !== 'win32') return Promise.reject(new Error('autostart is Windows-only'));
  const args = on ? ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', RUN_CMD, '/f']
                  : ['delete', RUN_KEY, '/v', RUN_NAME, '/f'];
  return new Promise((resolve, reject) =>
    execFile('reg', args, (err) => (err && on) ? reject(new Error('registry write failed')) : resolve()));
    // deleting an absent value errors — that's "already off", treat as success
}

// ----- th108:// URL protocol (HKCU, no admin) — lets the controller page start/restart us via a link.
// Self-registered on startup so the path self-heals if the folder moves; idempotent (reg add /f). The
// dispatcher (th108-url.vbs) only honors fixed "start"/"restart" words, so a stray th108:// link is safe. -----
function registerUrlScheme() {
  if (process.platform !== 'win32') return;
  const ROOT = 'HKCU\\Software\\Classes\\th108';
  const cmd = `wscript.exe "${path.join(__dirname, 'th108-url.vbs')}" "%1"`;
  const steps = [
    ['add', ROOT, '/ve', '/d', 'URL:TH108 Lighting Protocol', '/f'],
    ['add', ROOT, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', ROOT + '\\shell\\open\\command', '/ve', '/d', cmd, '/f'],
  ];
  let i = 0;
  const next = () => {
    if (i >= steps.length) { console.log(ts() + ' ✓ th108:// protocol registered (page Start/Restart links work)'); return; }
    execFile('reg', steps[i++], { windowsHide: true }, (err) => { if (err) console.log(ts() + ' … th108:// scheme registration step failed (non-fatal): ' + err.message); else next(); });
  };
  next();
}

// ----- standard-GIF mirror: the page pushes its last GIF Screen upload here so now-playing can
// revert to it after a long pause. Stored as JSON {frames:[{d,b64}]} (≤33 frames ≈ ≤1.4 MB). -----
const GIF_PATH = path.join(__dirname, 'standard-lcd.json');
function saveStandardGif(obj) {
  if (!obj || !Array.isArray(obj.frames) || !obj.frames.length || obj.frames.length > 33) return false;
  for (const f of obj.frames) { if (typeof f.b !== 'string' || Buffer.from(f.b, 'base64').length !== 30720) return false; }
  fs.writeFileSync(GIF_PATH, JSON.stringify(obj));
  console.log(ts() + ' [api] standard GIF mirrored (' + obj.frames.length + ' frames) — pause-revert has a target');
  return true;
}
function loadStandardGif() {
  try {
    const o = JSON.parse(fs.readFileSync(GIF_PATH, 'utf8'));
    return o.frames.map(f => ({ bytes: new Uint8Array(Buffer.from(f.b, 'base64')), delayMs: Math.max(20, +f.d || 100) }));
  } catch { return null; }
}

// ----- media-source whitelist (SAFETY: X/Twitter video tabs spamming LCD flash writes softbricked
// the board 2026-06-12). Default = Spotify only; the user can allow others per-source in the UI. -----
const seenSources = new Set();          // every source AUMID observed this run (for the UI list)
function isSourceAllowed(aumid) {
  aumid = aumid || '';
  if (Object.prototype.hasOwnProperty.call(settings.npAllow, aumid)) return !!settings.npAllow[aumid];
  return NP.isSpotifySource(aumid);     // default: only Spotify (desktop "Spotify.exe" / store "SpotifyAB.SpotifyMusic…")
}
function noteSource(aumid) { if (aumid && !seenSources.has(aumid)) { seenSources.add(aumid); console.log(ts() + ' ♪ media source seen: ' + aumid + (isSourceAllowed(aumid) ? ' (allowed)' : ' (blocked)')); } }
function sourceList() {                  // seen ∪ configured, each with its current allow state
  const ids = new Set(seenSources); Object.keys(settings.npAllow).forEach(k => ids.add(k));
  return [...ids].map(id => ({ id, allowed: isSourceAllowed(id) }));
}

// ----- now-playing on the LCD (nowplaying.js: sidecar + state machine + flash upload) -----
const NP = require('./nowplaying.js');
let npHandle = null;
function syncNowPlaying() {
  const wantSidecar = settings.nowPlaying || settings.npBar;   // the bar needs the sidecar's media position too — run it, but with LCD writes gated off
  if (wantSidecar && !npHandle) {
    npHandle = NP.start({
      lcdEnabled: () => settings.nowPlaying,   // bar-only (nowPlaying off) → sidecar runs for the progress-bar, but NO LCD flash writes
      onTrackChange: () => { npFlashAt = Date.now(); },   // new song → yellow flash on the number row (150ms)
      isYielded: () => paused,
      isMute: () => muteLogged,
      // flash writes need STABLE ownership: the daemon must hold a healthy, recently-ACKing board
      // and must not be fresh off a takeover (handover turbulence muted boards three times today)
      isUnstable: () => !device || (Date.now() - lastOkAt > 3000) || (Date.now() - unpausedAt < 3000),
      // PARK the key lighting to BLACK right before the flash, then RESUME (force-repaint) right after.
      // The board reclaims to its onboard startup-animation when the host goes silent mid-effect; a clean
      // "all-off" command parks it dark (a lights-out blink the user accepts) instead, and the forced
      // repaint re-asserts custom lighting the instant the flash ends (not after the 1s keepalive).
      pauseRender: async () => {
        lcdBusy = true;
        try {
          if (device && send) {
            const t0 = Date.now(); while (sendingFrame && Date.now() - t0 < 500) await new Promise(r => setTimeout(r, 10));   // let any in-flight frame finish
            const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0));
            sendingFrame = true; try { await send(off); } finally { sendingFrame = false; }
            if (state) state.lastFlat = null;   // so the post-flash repaint is guaranteed to differ from this black frame
          }
        } catch {}
      },
      resumeRender: () => { lcdBusy = false; if (state) state.lastFlat = null; },   // force an immediate repaint — re-assert lighting at once
      getColors: () => ({ title: settings.npTitle, artist: settings.npArtist }),
      getFit: () => !!settings.npArtFit,       // album-art style: true = Fit (letterbox the whole cover), false = Crop (fill+crop)
      getCal: () => settings.npCal || null,   // page-pushed LCD calibration (null → the baked default profile)
      getRevertSec: () => settings.npRevertSec || 0,
      getStandardGif: loadStandardGif,        // the page's last GIF Screen upload, mirrored here
      isSourceAllowed, noteSource,            // SAFETY whitelist: only Spotify drives the LCD by default
      onThrottled: () => { npBlinkAt = Date.now(); },   // a skip landed inside the safety window → spacebar blinks "queued, wait"
      log,
    });
  } else if (!wantSidecar && npHandle) { npHandle.stop(); npHandle = null; }
}
syncNowPlaying();

// ----- real audio capture (audio-capture.js: WASAPI loopback sidecar → state.audio) -----
const AC = require('./audio-capture.js');
let acHandle = null, acKey = null;
// What capture does the active config want? null = none; else {key, app?}. The daemon handles 'system'
// (WASAPI loopback) and 'app' (process-loopback); 'tab'/'mic' are page-only. NOTE: NOT gated on `paused` —
// audio capture is independent of the HID device, so we keep capturing while the page drives so the page can
// poll /audio/frame for its preview + to drive the keys with real system/app audio (else it'd be blank/synth).
function audioCfg() {
  if (!state) return null;
  const aL = state.layers.find(L => L.enabled && L.type === 'audio');
  if (!aL) return null;
  const s = aL.settings || {};
  if (s.source === 'app' && s.appId) return { key: 'app:' + s.appId, app: s.appId };
  if (s.source === 'mic') return { key: 'mic:' + (s.micDeviceId || ''), mic: true, micDevice: s.micDeviceId || '' };   // a picked recording device (else default) — daemon-driven so it works with the page closed
  if (s.source === 'tab') return null;                          // tab audio is page-only (getDisplayMedia)
  return { key: 'system' };
}
function syncAudioCapture() {
  const cfg = audioCfg();
  if (cfg && acKey !== cfg.key) {                                   // (re)start when the target changes (system↔app, or a new app)
    if (acHandle) { acHandle.stop(); acHandle = null; }
    acHandle = AC.start({ log, app: cfg.app, mic: cfg.mic, micDevice: cfg.micDevice });
    acKey = cfg.key;
    log('♪ audio capture started (' + (cfg.app ? 'app: ' + cfg.app : cfg.mic ? ('mic' + (cfg.micDevice ? ' [picked device]' : ' / line-in (default)')) : 'system loopback') + ')');
  } else if (!cfg && acHandle) {
    acHandle.stop(); acHandle = null; acKey = null; log('♪ audio capture stopped');
  }
}
syncAudioCapture();

// ----- display-off watcher: blank the board while the monitor is off on the idle timeout (opt-in) -----
const { spawn: _spawn } = require('child_process');
let dwProc = null;
function syncDisplayWatch() {
  const want = !!settings.dimOnDisplayOff;
  if (want && !dwProc) {
    const start = () => {
      dwProc = _spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'display-watch.ps1')],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let carry = '';
      dwProc.stdout.on('data', d => { carry += d.toString('utf8'); let i;
        while ((i = carry.indexOf('\n')) >= 0) { const s = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
          if (s === 'off' && !displayOff) { displayOff = true; log('🌒 monitor off (idle) — blanking the board'); }
          else if ((s === 'on' || s === 'dim') && displayOff) { displayOff = false; offCleared = false; if (state) state.lastFlat = null; nextOpenAt = 0; log('🌞 monitor on — restoring lighting'); }
        } });
      dwProc.on('exit', () => { dwProc = null; if (settings.dimOnDisplayOff) setTimeout(() => { if (settings.dimOnDisplayOff) start(); }, 3000); });
    };
    start();
  } else if (!want && dwProc) {
    const p = dwProc; dwProc = null; try { p.kill(); } catch {}
    if (displayOff) { displayOff = false; offCleared = false; if (state) state.lastFlat = null; }   // turning the feature off un-blanks
  }
}
syncDisplayWatch();

// ----- control hooks for the server -----
const control = {
  // A controller (page clientId) asks for the device. Blocks until it may open — through the full handoff:
  // revoke a live page → await its /release → or run the fallback ladder (probe → USB re-enumerate). Newest-wins.
  async claim(ev) {
    const id = ev && ev.clientId; if (!id) return { granted: false, epoch: lease.epoch() };
    const r = lease.claim(id, Date.now());
    if (r.granted) { closeDevice(); syncPaused(); return { granted: true, epoch: lease.epoch() }; }  // we held it (or idle) → drop our handle, page opens
    // a live page holds it: the revoked page sees leaseOwner change on its poll and POSTs /release; the
    // lease grants on that release, or tick() escalates (probe → re-enumerate). Wait up to 6s for a grant.
    const t0 = Date.now();
    while (lease.owner() !== id && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 40));
    syncPaused();
    return { granted: lease.owner() === id, epoch: lease.epoch() };
  },
  // A page confirms it closed its WebHID handle (or is handing back on unload). Grants a pending claimer,
  // or schedules the debounced daemon reclaim (tick() fires it).
  release(ev) { lease.release(ev && ev.clientId, Date.now()); syncPaused(); },
  // Records the calling page's liveness in the lease (missed heartbeats → tick() reclaims for the daemon).
  // MUST stay synchronous — the server's /heartbeat route calls it without awaiting.
  heartbeat(ev) { if (ev && ev.clientId) lease.heartbeat(ev.clientId, Date.now()); return { npWants: this.npWants() }; },
  // LEGACY: pages predating the lease call /yield//resume with no clientId. Map them to a fixed legacy owner
  // so an un-upgraded page still takes/releases the device through the same single-owner lease.
  //
  // Release the device for the WebHID page. MUST NOT complete while a flash upload is mid-flight:
  // the page opens the device the moment /yield responds, and streaming 0x32 into a board that is
  // mid-flash-write wedged it hard and cost typing (2026-06-12 incident, "chunk N: no ACK" right
  // after a /yield line). Block the response until the upload finishes (≤ erase window) or 25s.
  async yield() {
    lease.claim('legacy-page', Date.now()); syncPaused();
    // stops NEW frames; the in-flight one must COMPLETE before we close —
    // closing mid-frame leaves the board's chunk parser waiting for bytes that never come, and
    // the page's first writes then land desynced → no ACKs → onboard fallback (the recurring
    // "refresh + Connect → rainbow" pattern, finally pinned 2026-06-12 17:51)
    const tf = Date.now();
    while (sendingFrame && Date.now() - tf < 1500) await new Promise(r => setTimeout(r, 25));
    closeDevice();
    muteLogged = false;   // a mute episode ends at handoff — a stale flag here vetoed every page-permit upload (live repro 2026-06-12 13:41, endless /npgo "mute")
    const t0 = Date.now();
    while (lcdBusy && Date.now() - t0 < 25000) await new Promise(r => setTimeout(r, 100));
    if (lcdBusy) console.log(ts() + ' ⚠ yield proceeded with a flash upload still busy after 25s — investigate');
  },
  // Reload config (the page may have saved edits) and resume rendering. Reclaim timing is now owned by the
  // lease's SETTLE debounce + tick() (see syncPaused/runTick) instead of the old resumeTimer.
  resume() { lease.release('legacy-page', Date.now()); syncPaused(); },
  // Persist the page's config; refresh live state immediately unless yielded to the page.
  saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    if (!paused) { state = E.applyConfig(state, cfg);   // in-place on a settings edit → no animation reset; rebuilds only on a structural change
      if (state) state.bri = Math.max(0, Math.min(100, settings.brightness != null ? settings.brightness : 100)) / 100; }
    syncAudioCapture(); },   // an edit that enables/disables the audio layer starts/stops capture live
  // List currently-playing audio apps for the page's "Specific app" picker (one-shot app-capture.exe --list).
  listAudioApps() { return new Promise(r => AC.listApps((_e, arr) => r(arr))); },
  // List recording (capture) devices for the Mic device picker (one-shot audio-sidecar.ps1 -ListInputs).
  listAudioInputs() { return new Promise(r => AC.listInputs((_e, arr) => r(arr))); },
  // Host Actions registry (the page's "Host Actions" binder tab) — key LED index → host-side action.
  getHostActions() { return hostActions; },
  setHostActions(arr) { hostActions = HA.normalize(arr); saveHostActions(); _haReset(); },   // re-normalize + drop stale per-binding trigger state
  suppressHostActions(ms) { setHaSuppress(+ms || 0); },   // page mid-bind: pause action firing so the pressed key doesn't run its current binding

  // Saved profiles, pushed by the page so profileNext/profilePrev can switch lighting with the page CLOSED.
  setProfiles(arr) { profiles = Array.isArray(arr) ? arr : []; try { fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles)); } catch {} curProfile = -1; },
  setIndicator(ind) { if (ind && typeof ind === 'object') { indicator = { on: ind.on !== false, keys: ind.keys === 'numpad' ? 'numpad' : 'numberRow' }; saveIndicator(); } },   // profile-switch flash settings
  applyProfileByIndex(i) { selectProfile(i | 0); },   // page-side manual Apply → live apply + flash
  // Native file picker for the "Launch" host action — the browser can't see real filesystem paths, but the daemon
  // can't show a GUI itself (its window has no desktop — OpenFileDialog hangs). So it asks the TRAY (which has a
  // real message loop + GUI) to show the dialog: write _pickreq.txt, the tray writes the chosen path to
  // _pickresult.txt. Requires the tray to be running (the normal autostart). Times out if it isn't.
  pickFile() {
    return new Promise(resolve => {
      let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
      const reqPath = path.join(__dirname, '_pickreq.txt'), resPath = path.join(__dirname, '_pickresult.txt');
      try { if (fs.existsSync(resPath)) fs.unlinkSync(resPath); } catch {}
      try { fs.writeFileSync(reqPath, String(Date.now())); } catch (e) { log('🗂 pickFile: could not write request — ' + e.message); return finish(null); }
      log('🗂 pickFile: asked the tray to open the file dialog…');
      const t0 = Date.now();
      const poll = () => {
        if (fs.existsSync(resPath)) {
          let p = ''; try { p = fs.readFileSync(resPath, 'utf8').replace(/^﻿/, '').trim(); } catch {}
          try { fs.unlinkSync(resPath); } catch {}
          log('🗂 pickFile: ' + (p ? 'path chosen' : 'cancelled / none'));
          return finish(p || null);
        }
        if (Date.now() - t0 > 90000) { try { fs.unlinkSync(reqPath); } catch {} log('🗂 pickFile: 90s timeout — no response from the tray (is the tray running? Exit Tray + relaunch to load this build).'); return finish(null); }
        setTimeout(poll, 200);
      };
      poll();
    });
  },
  // Extract an .exe's icon as a PNG data-URL so the page can show it on a Launch binding (the browser can't read
  // an exe icon; this needs no desktop, unlike the file dialog). Runs from a temp .ps1 (-File) to avoid arg-mangling.
  appIcon(p) {
    return new Promise(resolve => {
      p = (p || '').trim().replace(/^["']+|["']+$/g, '').trim();   // strip surrounding quotes (Copy as path)
      if (!p || !/\.exe$/i.test(p)) return resolve(null);
      const psPath = path.join(__dirname, '_appicon.ps1');
      const ps = ['param([string]$p)', 'Add-Type -AssemblyName System.Drawing',
        'try { $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($p); $bmp = $ic.ToBitmap(); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray())) } catch {}'
      ].join('\r\n');
      try { fs.writeFileSync(psPath, ps); } catch { return resolve(null); }
      try { const proc = _spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-p', p], { windowsHide: true });
        let out = ''; if (proc.stdout) proc.stdout.on('data', d => out += d);
        proc.on('close', () => resolve(out.trim() ? ('data:image/png;base64,' + out.trim()) : null));
        proc.on('error', () => resolve(null));
        setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 8000);
      } catch { resolve(null); }
    });
  },
  // Currently-open apps (processes that own a visible window) for the "pick a running app" dropdown — so the user
  // doesn't have to type a path. Deduped by exe path; the browser can't enumerate this, only the daemon can.
  listOpenApps() {
    return new Promise(resolve => {
      const ps = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | ForEach-Object { $pp=$null; try { $pp=$_.Path } catch {}; if ($pp) { [pscustomobject]@{ path=$pp; name=$_.ProcessName; title=$_.MainWindowTitle } } } | ConvertTo-Json -Compress";
      try {
        const proc = _spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
        let out = ''; if (proc.stdout) proc.stdout.on('data', d => out += d);
        proc.on('close', () => {
          let arr = []; try { const j = JSON.parse(out.trim() || '[]'); arr = Array.isArray(j) ? j : [j]; } catch { arr = []; }
          const DENY = new Set(['applicationframehost', 'textinputhost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'lockapp', 'widgets', 'systemsettings', 'systemsettingsbroker']);   // UWP window-hosts / system artifacts, not real switch targets
          const seen = new Set(), apps = [];
          for (const a of arr) { if (!a || !a.path) continue; if (DENY.has((a.name || '').toLowerCase())) continue; const k = a.path.toLowerCase(); if (seen.has(k)) continue; seen.add(k); apps.push({ path: a.path, name: a.name || '', title: a.title || '' }); }
          apps.sort((x, y) => (x.title || x.name).localeCompare(y.title || y.name));
          resolve(apps);
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { try { proc.kill(); } catch {} resolve([]); }, 8000);
      } catch { resolve([]); }
    });
  },
  // Latest captured audio frame (system/app) so the open page can preview it + drive the keys in real time.
  audioFrame() { return acHandle ? AC.freshOr(acHandle.latest(), Date.now(), 300) : null; },
  // Current media position so the open page can draw the song-progress bar itself while it drives the device.
  npPos() { return npHandle ? npHandle.mediaState() : null; },
  status() { return { running: true, paused, leaseOwner: lease.owner(), leaseEpoch: lease.epoch(), deviceConnected: !!device, fps: FPS, setupPath: path.resolve(__dirname, '..', 'setup.cmd'), usbReset: settings.usbReset, dimOnDisplayOff: settings.dimOnDisplayOff, nowPlaying: settings.nowPlaying,
                      npTrack: npHandle ? npHandle.current() : null, npQueued: npHandle ? npHandle.queued() : false,
                      npHealth: npHandle ? npHandle.health() : null,
                      npLog: npHandle ? npHandle.recent() : [],
                      npTitle: settings.npTitle, npArtist: settings.npArtist, npArtFit: settings.npArtFit,
                      lightsOn: settings.lightsOn, brightness: settings.brightness,
                      npRevertSec: settings.npRevertSec, npHasGif: fs.existsSync(GIF_PATH),
                      npSources: sourceList(),
                      npBar: settings.npBar, npBarColor: settings.npBarColor, npBarBright: settings.npBarBright,
                      npFlash: settings.npFlash, npFlashColor: settings.npFlashColor, npBarIdleSec: settings.npBarIdleSec,
                      npBarGrad: settings.npBarGrad, npBarGradFit: settings.npBarGradFit, npBarKeys: settings.npBarKeys, npBarAgentTop: settings.npBarAgentTop,
                      npOnboardMask: settings.npOnboardMask,
                      agentSessions: agentState.sessions(Date.now()) }; },
  setNowPlaying(on) {
    const was = settings.nowPlaying;
    settings.nowPlaying = !!on; saveSettings();
    let revert = null;
    if (was && !on && npHandle) revert = npHandle.revertNow();   // turning OFF → restore the standard GIF (fast gate-check; the upload fires async). revert.reason explains a no-op
    syncNowPlaying();
    return { revert };
  },
  // page-permit upload path: the heartbeat advertises a pending song; the page pauses its own
  // 0x32 stream and POSTs /npgo, so songs land WITHOUT a device handoff (lighting holds, not off)
  npWants() { return !!(npHandle && paused && !muteLogged && npHandle.ready()); },
  npGo() { return npHandle ? npHandle.uploadNow() : Promise.resolve({ ok: false, reason: 'now-playing off' }); },
  // master lighting switch + global brightness (header controls; the page mirrors them here so the
  // look survives page↔daemon handoffs)
  setLighting(o) {
    if (o && 'on' in o) {
      settings.lightsOn = !!o.on; offCleared = false;
      if (settings.lightsOn) {
        if (state) state.lastFlat = null;            // force a repaint
        nextOpenAt = 0;                              // reopen ONLY if the handle is actually gone — do NOT closeDevice a healthy one. Reopening a long-lived handle on a quick off→on muted the board (2026-06-27, was streaming 981 min). Mirrors the monitor-wake path (which resumes from the same silence with no reopen and never mutes).
      }
    }
    if (o && o.brightness != null) {
      settings.brightness = Math.max(0, Math.min(100, Math.round(o.brightness)));
      if (state) { state.bri = settings.brightness / 100; state.lastFlat = null; }   // live, and bust the dedupe so it applies now
    }
    saveSettings();
  },
  setNpColors(title, artist) {   // valid hex only; a change re-paints the current song (one flash write)
    if (/^#[0-9a-f]{6}$/i.test(title || '')) settings.npTitle = title;
    if (/^#[0-9a-f]{6}$/i.test(artist || '')) settings.npArtist = artist;
    saveSettings();
    if (npHandle) npHandle.refresh();
  },
  setNpRevertSec(sec) { settings.npRevertSec = Math.max(0, Math.min(3600, Math.round(+sec || 0))); saveSettings(); },
  setNpArtFit(on) {   // album-art style Crop⇄Fit — re-paints the current song (one flash write)
    const before = !!settings.npArtFit; settings.npArtFit = !!on; saveSettings();
    if (npHandle && before !== settings.npArtFit) npHandle.refresh();
  },
  // song-progress light-bar (keys 1-0) + yellow track-change flash — SAFE (lighting only, no flash writes)
  setNpBar(o) {
    if (o && 'on' in o) settings.npBar = !!o.on;
    if (o && o.color != null && /^#[0-9a-f]{6}$/i.test(o.color)) settings.npBarColor = o.color;
    if (o && o.bright != null) settings.npBarBright = Math.max(0, Math.min(100, Math.round(+o.bright || 0)));
    if (o && 'flash' in o) settings.npFlash = !!o.flash;
    if (o && o.flashColor != null && /^#[0-9a-f]{6}$/i.test(o.flashColor)) settings.npFlashColor = o.flashColor;
    if (o && o.idleSec != null) settings.npBarIdleSec = Math.max(0, Math.min(60, Math.round(+o.idleSec || 0)));
    if (o && o.grad != null && ['solid', 'toWhite', 'fromWhite'].includes(o.grad)) settings.npBarGrad = o.grad;
    if (o && 'gradFit' in o) settings.npBarGradFit = !!o.gradFit;
    if (o && o.keys != null && ['row', 'numpad'].includes(o.keys)) settings.npBarKeys = o.keys;
    if (o && 'agentTop' in o) settings.npBarAgentTop = !!o.agentTop;   // z-swap: agent glyphs above the bar
    saveSettings();
    syncNowPlaying();   // toggling the bar may need to start/stop the media sidecar
    if (state) state.lastFlat = null;   // repaint now
  },
  npRefresh() { return npHandle ? npHandle.forceUpload() : Promise.resolve({ ok: false, reason: 'now-playing off' }); },   // DEBUG "Refresh LCD" — force-repaint the live song now
  // "Mask onboard flash to black": write the keyboard's onboard EFFECT (persistent cmd 0x23) to a solid
  // black so when the board reclaims to onboard during an LCD flash it shows a dark blink, not rainbow.
  // Mirrors th108-onboard.js's proven page sequence (write 0x23 → settle → cycle the handle, since a live
  // 0x23 leaves the board ACKing-but-IGNORING 0x32 paint). Best-effort; needs the daemon to own the board.
  async setOnboardMask(on) {
    settings.npOnboardMask = !!on; saveSettings();
    const allled = on
      ? OBP.packAllled({ effect: 1, primary: [0, 0, 0], secondary: [0, 0, 0], colorful: false, brightness: 1, speed: 1 })       // Static Bright + black = off
      : OBP.packAllled({ effect: 11, primary: [255, 0, 0], secondary: [0, 0, 255], colorful: true, brightness: 4, speed: 3 });  // restore a visible flowing-rainbow default
    const ok = await sendOnboard(allled);
    log(ok ? ('♪ onboard mask ' + (on ? 'ON — onboard set to BLACK (LCD flash now a dark blink)' : 'OFF — onboard restored to a colorful default'))
           : '♪ onboard mask could not apply — the daemon must be driving a healthy board (not yielded/muted)');
    return { ok, reason: ok ? undefined : 'daemon not driving the board' };
  },
  setNpSource(id, allow) { if (typeof id === 'string' && id) { settings.npAllow[id] = !!allow; saveSettings(); } },
  saveLcdGif(obj) { try { return saveStandardGif(obj); } catch { return false; } },
  setNpCal(cal) {   // the page's LCD color-correction sliders, mirrored so the art matches GIF uploads
    if (!cal || typeof cal !== 'object') return;
    const clean = {};
    for (const k of Object.keys(cal)) { const v = +cal[k]; if (Number.isFinite(v) && v >= 0 && v <= 300) clean[k] = v; }
    if (!Object.keys(clean).length) return;
    const before = JSON.stringify(settings.npCal || null);
    settings.npCal = clean;
    saveSettings();
    if (npHandle && JSON.stringify(clean) !== before) npHandle.refresh();   // re-paint only on a real change
  },
  // page-initiated escalation: the PAGE drives the device and detected a persistent wedge its own
  // handle-rebinds couldn't clear — fire the same PnP restart the daemon uses, with a cooldown so
  // a stuck page can't replug-loop the keyboard.
  usbFix() {
    if (!settings.usbReset) return { fired: false, reason: 'disabled' };
    if (Date.now() - usbFiredAt < 60_000) return { fired: false, reason: 'cooldown' };
    usbFiredAt = Date.now();
    log('⚡ page requested a USB restart (board wedged while the page was driving) — PnP-restarting the keyboard; typing drops ~1-2s');
    U.fire(log);
    return { fired: true };
  },
  agentEvent: (ev) => agentState.ingest(ev, Date.now()),
  agentSessions: () => agentState.sessions(Date.now()),
  getAutostart, setAutostart,
  // HID/now-playing diagnostics for /metrics — pairs with the server's per-endpoint rates
  metrics() {
    const sec = Math.max(1, Math.round(process.uptime()));
    return {
      uptimeSec: sec, paused, deviceConnected: !!device, fps: FPS,
      framesSent, framesDeduped, framesSentPerSec: +(framesSent / sec).toFixed(2),
      dedupeRatio: framesSent + framesDeduped ? +(framesDeduped / (framesSent + framesDeduped)).toFixed(2) : 0,
      np: npHandle ? npHandle.health() : null,
    };
  },
  setUsbReset(on) { settings.usbReset = !!on; saveSettings(); },
  setDimOnDisplayOff(on) { settings.dimOnDisplayOff = !!on; saveSettings(); syncDisplayWatch(); },
  quit() { shutdown(0); },
  restart() { shutdown(42); },   // exit non-zero so start-hidden.vbs's supervisor revives us (clean exit 0 would STOP supervision — that's why /quit needs a manual Start)
};
module.exports = { control };

// ----- server (static page + control API) -----
const { createServer } = require('./server.js');
const server = createServer({ control, root: path.join(__dirname, '..'), port: 8123 });
// Announce "running" ONLY after the port actually binds — the old unconditional line below printed even when
// listen() failed with EADDRINUSE (the error is async), so daemon.log lied "running" on every doomed spawn.
server.listening.then(() => console.log(`▶ TH108 daemon running — serving controller + control API on http://localhost:${server.port} (config: ${loadConfig() ? 'loaded' : 'none yet'})`));

// ----- clean shutdown: black-out the board, release hook -----
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  // EXTERNAL force-kill watchdog: an INDEPENDENT process that taskkills this PID after 3s. The in-process backstop
  // (setTimeout below) can't save us when device.close()/uIOhook.stop() block — those are synchronous native calls
  // that freeze the JS thread, so the timer never fires and the process zombies (server closed, but never exits →
  // the supervisor can't revive a child that didn't die; happened on a wedged board 2026-06-23). An outside killer
  // is immune to the frozen thread. If we exit cleanly first, the taskkill just hits a dead PID (harmless).
  try { require('child_process').spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Sleep -Seconds 3; Stop-Process -Id ' + process.pid + ' -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore', windowsHide: true }).unref(); } catch {}   // PowerShell hidden (like the sidecars) → NO cmd-window flash; survives our exit, force-kills us if we hang
  try { clearInterval(timer); } catch {}
  // FREE PORT 8123 FIRST. A wedged/muted board can make the HID cleanup below block (node-hid write/close
  // are synchronous native calls), and if that hangs while the port is still held, the supervisor's revived
  // instance hits EADDRINUSE and the daemon never comes back — the "Restart did nothing" port-squat
  // (diagnosed 2026-06-20: a /restart hung after 'now-playing disabled', pid kept :8123). Releasing the
  // listener up front means even a hung cleanup can't squat the port.
  try { server.close(); } catch {}
  // KILL CHILD PROCESSES NEXT, before any HID/hook cleanup. The device.close()/uIOhook.stop() calls below are
  // synchronous native calls that can BLOCK on a wedged board; if they hang while the capture sidecars are
  // still alive, those sidecars orphan and auto-respawn → zombie daemons pile up across restarts, each holding
  // its own (possibly wrong-source) capture (the 2026-06-21 multi-daemon / kick.com-bleed mess). Reaping the
  // children first guarantees no orphans even if the cleanup below hangs.
  try { if (npHandle) npHandle.stop(); } catch {}   // kill the now-playing sidecar
  try { if (acHandle) acHandle.stop(); } catch {}   // kill the audio-capture sidecar (app-capture.exe / audio-sidecar.ps1)
  try { if (_focusPS) _focusPS.kill(); } catch {}   // stop the warm focus-host PowerShell
  try { if (dwProc) dwProc.kill(); } catch {}        // kill the display-off watcher
  try { if (device && send && !muteLogged) { const off = []; INDICES.forEach(i => off.push(i, 0, 0, 0)); send(off); } } catch {}   // best-effort blackout (fire-and-forget; skip on a muted board)
  setTimeout(() => process.exit(code), 1500).unref();   // backstop
  // These can block on a wedged board — do them LAST. The OS releases the HID handle + global hook on exit
  // anyway, so a hang here can't orphan anything (port + children already cleaned).
  try { if (device) device.close(); } catch {}
  try { uIOhook.stop(); } catch {}
  process.exit(code);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

registerUrlScheme();   // make th108://start | th108://restart links work from the controller page
// (the honest "▶ running" line now fires from server.listening.then above — only on a successful bind)
setTimeout(() => { try { if (Array.isArray(hostActions) && hostActions.some(b => b && b.action && ['focusApp', 'winMin', 'winMax', 'winRestore'].includes(b.action.type))) ensureFocusHost(); } catch {} }, 1500);   // pre-warm the focus host so the FIRST window/switch action is fast too
