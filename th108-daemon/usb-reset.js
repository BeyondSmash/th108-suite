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
const fs = require('fs');
const path = require('path');

const TASK_NAME = 'TH108 USB Restart';
const LOG_PATH = path.join(__dirname, 'restart-usb.log');   // restart-usb.bat appends "restart exit=N" here
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

// After schtasks kicks off the task, pnputil runs over the next few seconds and restart-usb.bat appends
// a "restart exit=N" line. schtasks /run reports only that the task STARTED, never pnputil's result — so we
// poll the log for the new line and surface the TRUTH. 3010 = Windows queued a reboot-pending reconfig; 50 =
// a later restart was refused because that reconfig is still pending. In both cases the software replug is
// DEAD until a reboot, and only a physical wired↔BT toggle (a real USB re-enumeration below the PnP layer)
// recovers the board. Without this the daemon logs a false "should re-enumerate" and the user gets no signal.
// Pure: map an appended restart-usb.log chunk → a log line (or null if no "restart exit=N" line yet).
function classify(chunk) {
  const m = /restart exit=(\d+)/.exec(chunk || '');
  if (!m) return null;
  const code = +m[1];
  if (code === 0) return '… USB-restart done — board should re-enumerate in a few seconds';
  if (code === 3010 || code === 50 || /pending|reboot/i.test(chunk))
    return '✗ Windows REFUSED the USB-restart (exit ' + code + ' — device pending a reboot from an earlier restart). The software replug is dead until you REBOOT; recover the board now with a physical wired↔BT toggle. (Auto-restarts will keep being refused until then.)';
  return '✗ USB-restart returned exit ' + code + ' — board may not have re-enumerated; if lighting stays dark, toggle wired↔BT';
}

function reportOutcome(log, sizeBefore, tries) {
  let st; try { st = fs.statSync(LOG_PATH); } catch (_) { st = null; }
  if (!st || st.size <= sizeBefore) {                       // no new line yet
    if (tries > 0) return void setTimeout(() => reportOutcome(log, sizeBefore, tries - 1), 1500);
    return;                                                  // gave up quietly — task may just be slow; the mute clock still guards recovery
  }
  let chunk = ''; try { chunk = fs.readFileSync(LOG_PATH).slice(sizeBefore).toString('utf8'); } catch (_) { return; }
  const msg = classify(chunk);
  if (msg) return void log(msg);
  if (tries > 0) setTimeout(() => reportOutcome(log, sizeBefore, tries - 1), 1500);
}

// Trigger the elevated task (schtasks /run works unelevated for a task the user owns).
function fire(log) {
  let sizeBefore = 0; try { sizeBefore = fs.statSync(LOG_PATH).size; } catch (_) {}   // baseline: only read lines appended after THIS fire
  execFile('schtasks', ['/run', '/tn', TASK_NAME], { windowsHide: true }, (err, _so, se) => {
    if (err) return log('✗ USB-restart task failed to start: ' + (((se || '').trim()) || err.message) + ' — register it once via install-usb-restart-task.ps1 (run as admin)');
    log('… USB-restart task triggered — checking result…');
    reportOutcome(log, sizeBefore, 5);   // poll ~7.5s (5×1.5s) for the pnputil exit code
  });
}

module.exports = { shouldFire, fire, classify, TASK_NAME, THRESHOLD_MS, IDLE_THRESHOLD_MS, IDLE_AFTER_MS, COOLDOWN_MS, LULL_MS, HARD_CEILING_MS };

// self-check: node usb-reset.js
if (require.main === module) {
  const A = require('assert');
  A.strictEqual(classify('foo bar'), null);                                   // no exit line → wait longer
  A.ok(/re-enumerate/.test(classify('Device restarted successfully.\nrestart exit=0')));
  A.ok(/REBOOT/.test(classify('restart exit=3010')));                         // reboot-pending
  A.ok(/REBOOT/.test(classify('Failed to restart device: pending\nrestart exit=50')));   // refused
  A.ok(/wired↔BT/.test(classify('restart exit=259')));                        // other non-zero → generic toggle advice
  console.log('usb-reset self-check OK');
}
