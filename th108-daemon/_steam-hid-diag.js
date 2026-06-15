// th108-daemon/_steam-hid-diag.js — diagnostic for the Steam (and similar app) HID-conflict mute.
//
// ⚠ RUN ONLY WITH THE DAEMON STOPPED. Discovered 2026-06-14: merely OPENING a second handle on the
// control interface (MI_02) — even read-only — WEDGES the board. The TH108 multiplexes all 8 HID
// collections through ONE firmware command FIFO; the HID feature/descriptor queries the OS issues at
// open time desync that FIFO and mute whatever stream is live. So this tool must be the SOLE host
// opener: stop the daemon first (and quit Steam) before running it. That isolation IS the experiment.
//
// READ-ONLY: lists every TH108 HID interface (the surface an app like Steam Input enumerates on
// device-arrival), then opens the control interface (0xFF68/0x61) and timestamps every input report.
// It never writes — but per the note above, the OPEN itself is the perturbation we're studying.
//
// What we're trying to learn — does Steam touch THIS (control) interface, or a different collection?
//   • A 0x55 ACK with a cmd byte that ISN'T 0x32 appearing right as Steam launches  → Steam wrote a
//     command on the control interface (it's a second writer on our pipe).
//   • Input reports simply STOP / the open fails                                     → Steam grabbed
//     the device some other way (exclusive open, or a different collection) — escalate to ProcMon/USBPcap.
//   • Nothing changes here but the daemon still logs MUTE                             → Steam is hitting
//     a DIFFERENT collection; the wedge propagates through the shared firmware FIFO — needs OS capture.
//
// Usage (from th108-daemon/):  node _steam-hid-diag.js
//   Run A (real scenario):  leave the daemon RUNNING (it's the writer; daemon.log timestamps the mute),
//                           start this as a second READ-ONLY watcher, then launch Steam.
//   Run B (Steam alone):    stop the daemon first, run this, then launch Steam — isolates Steam from us.
//   Cross-reference the timestamps below with daemon.log.
const HID = require('node-hid');
const T = require('./hid-transport.js');
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(8) + 's';
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');

const all = HID.devices().filter(d => d.vendorId === T.VENDOR);
console.log(`\n=== TH108 (vendor 0x${T.VENDOR.toString(16)}) HID interfaces — the surface Steam Input enumerates ===`);
if (!all.length) { console.log('  (none — is the keyboard connected? if on Bluetooth, try wired)'); process.exit(1); }
for (const d of all) {
  console.log(`  iface#${d.interface}  usagePage=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)}  "${(d.product || '').trim()}"`);
  console.log(`           ${d.path}`);
}

const p = T.findPath();
if (!p) { console.log('\n✗ control interface (0xFF68/0x61) not found.'); process.exit(1); }

console.log(`\n=== watching (READ-ONLY) the control interface 0xFF68/0x61 ===`);
console.log('    Now launch Steam (or do BT→wired). Watch the lines below; Ctrl+C to stop.\n');
let dev;
try { dev = new HID.HID(p); }
catch (e) { console.log('✗ could not open the control iface: ' + e.message + '\n  (another process may hold it exclusively — that itself is a finding; note the time vs Steam launch.)'); process.exit(1); }
dev.on('error', e => console.log(ts() + '  ⚠ READ ERROR: ' + (e && e.message) + '  (handle died — note this time vs Steam launch)'));

let n = 0; const seen = new Set();
dev.on('data', buf => {
  n++;
  const cmd = buf[1];
  const isAck = buf[0] === 0x55;
  const novel = isAck && cmd !== 0x32 && !seen.has(cmd);   // a NON-0x32 ACK = a command from someone else
  if (isAck && cmd !== 0x32) seen.add(cmd);
  const tag = isAck ? `0x55 ACK cmd=0x${(cmd || 0).toString(16).padStart(2, '0')}` : 'input';
  const flag = novel ? '   ←★ NON-0x32 ACK — a foreign command was written to THIS interface' : '';
  console.log(`${ts()}  #${n}  ${tag}  [${hex(buf.slice(0, 12))} …]${flag}`);
});

setInterval(() => {}, 1 << 30);   // keep the process alive
process.on('SIGINT', () => { try { dev.close(); } catch {} console.log(`\nstopped — ${n} input report(s) seen.`); process.exit(0); });
