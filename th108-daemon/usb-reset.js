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
const THRESHOLD_MS = 30_000;        // mute must persist this long before we touch USB — vs a 3-5s manual replug, every extra second is just broken lighting
const COOLDOWN_MS = 10 * 60_000;

// Pure decision: fire only for a real, aged mute, outside the cooldown window.
function shouldFire({ muteAt, now, lastFireAt, thresholdMs = THRESHOLD_MS, cooldownMs = COOLDOWN_MS }) {
  if (!muteAt) return false;
  if (now - muteAt < thresholdMs) return false;
  if (lastFireAt && now - lastFireAt < cooldownMs) return false;
  return true;
}

// Trigger the elevated task (schtasks /run works unelevated for a task the user owns).
function fire(log) {
  execFile('schtasks', ['/run', '/tn', TASK_NAME], { windowsHide: true }, (err, _so, se) => {
    if (err) log('✗ USB-restart task failed to start: ' + (((se || '').trim()) || err.message) + ' — register it once via install-usb-restart-task.ps1 (run as admin)');
    else log('… USB-restart task triggered — board should re-enumerate in a few seconds');
  });
}

module.exports = { shouldFire, fire, TASK_NAME, THRESHOLD_MS, COOLDOWN_MS };
