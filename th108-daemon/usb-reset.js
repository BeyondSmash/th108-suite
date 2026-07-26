// USB-restart escalation for the board ACK-mute/wedge: a PnP restart of the keyboard's composite USB
// device node is a SOFTWARE REPLUG — proven 2026-06-09 (pnputil /restart-device cleared a wedge that a
// fresh HID handle-open could not; lighting recovered within 5s). pnputil needs elevation, so the daemon
// (unelevated, HKCU Run) triggers a pre-registered elevated on-demand scheduled task instead:
//   register once (admin):  th108-daemon\install-usb-restart-task.ps1
//   task payload:           th108-daemon\restart-usb.bat (dynamic instance-ID lookup, port-independent)
// Guardrails: only after THRESHOLD_MS of unbroken mute (brief self-recovering blips shouldn't cost a
// 1-2s typing dropout; sleep entry is safe because the daemon freezes within seconds of suspend and
// re-baselines the mute clock after a sleep gap, so a stale pre-sleep muteAt can't insta-fire on wake),
// and at most one shot per COOLDOWN_MS — a restart loop would be worse than the wedge.
const { execFile } = require('child_process');

const TASK_NAME = 'TH108 USB Restart';
const THRESHOLD_MS = 30_000;        // mute must persist this long before we touch USB *while you're typing* — a 1-2s dropout mid-sentence is worse than a few more dark seconds
const IDLE_THRESHOLD_MS = 12_000;   // …but if you've been AFK (see IDLE_AFTER_MS), a dropout costs nothing, so recover the lighting ~18s sooner
const IDLE_AFTER_MS = 20_000;       // "AFK" = no keypress for this long; under it we assume you're mid-task and hold the conservative threshold
const COOLDOWN_MS = 10 * 60_000;
// Key-hold-off: a USB re-enumeration mid-keystroke drops the held key's key-UP event, so Windows sees the
// key as still down (stuck Shift → '/' types '?', WASD stuck in-game) plus a ~1-2s input freeze. Confirmed
// 2026-07-25 in a live Palworld session (daemon.log: 20:04:12 fired "actively typing"). So once past the
// mute threshold, wait for a keypress LULL — nothing held AND a brief quiet gap — before re-enumerating.
const LULL_MS = 1_500;              // no key held + no keydown for this long = a genuine gap between keystrokes/actions (not mid-burst, no keyup in flight)
const HARD_CEILING_MS = 90_000;    // …but never defer the lighting recovery past this — a missed keyup (alt-tab, focus loss) can leave a key stuck in `held` forever, which would otherwise block recovery indefinitely

// Pure decision: fire only for a real, aged mute, outside the cooldown window, and (until the hard ceiling)
// only during a keypress lull so a re-enumeration can't strand a held key.
function shouldFire({ muteAt, now, lastFireAt, thresholdMs = THRESHOLD_MS, cooldownMs = COOLDOWN_MS,
                      keysHeld = 0, sinceKeydownMs = Infinity, lullMs = LULL_MS, hardCeilingMs = HARD_CEILING_MS }) {
  if (!muteAt) return false;
  if (now - muteAt < thresholdMs) return false;
  if (lastFireAt && now - lastFireAt < cooldownMs) return false;
  if (now - muteAt < hardCeilingMs && (keysHeld > 0 || sinceKeydownMs < lullMs)) return false;
  return true;
}

// Trigger the elevated task (schtasks /run works unelevated for a task the user owns).
function fire(log) {
  execFile('schtasks', ['/run', '/tn', TASK_NAME], { windowsHide: true }, (err, _so, se) => {
    if (err) log('✗ USB-restart task failed to start: ' + (((se || '').trim()) || err.message) + ' — register it once via install-usb-restart-task.ps1 (run as admin)');
    else log('… USB-restart task triggered — board should re-enumerate in a few seconds');
  });
}

module.exports = { shouldFire, fire, TASK_NAME, THRESHOLD_MS, IDLE_THRESHOLD_MS, IDLE_AFTER_MS, COOLDOWN_MS, LULL_MS, HARD_CEILING_MS };
