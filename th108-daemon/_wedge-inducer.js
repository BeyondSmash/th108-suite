// th108-daemon/_wedge-inducer.js — controlled, ON-DEMAND reproducer for the external-app HID-conflict mute.
//
// Mimics what Steam Input / SDL / Logitech G HUB do during controller/peripheral detection: it OPENS the
// keyboard's INPUT collections (keyboard / mouse / consumer / system) and fires HID GET_FEATURE queries,
// in rapid enumeration sweeps. Run it WHILE the daemon is driving; if it desyncs the board's single shared
// command FIFO, the daemon's 0x32 lighting stream stops getting ACKs → daemon.log logs "board went MUTE".
// That gives us the deterministic wedge we need to verify a recovery fix.
//
// SAFETY: only DEVICE OPENS + GET_FEATURE READS on the INPUT collections. It never touches the vendor
// lighting iface (0xFF68), the screen iface (0xFF67), or any lighting-protocol command (0x32/0x50/0x22/
// 0x23/0x0F). GET_FEATURE is a non-destructive HID read by spec — the only effect we expect is the FIFO
// desync (the wedge we're trying to provoke), which the daemon's recovery then handles.
//
// Usage (from th108-daemon/, daemon running):  node _wedge-inducer.js [sweeps]   (default 40 sweeps, ~8s)
const HID = require('node-hid');
const VENDOR = 0x0C45;

const all = HID.devices().filter(d => d.vendorId === VENDOR);
// the INPUT collections an enumerator probes: keyboard (0x01/0x06), mouse (0x01/0x02),
// consumer (0x0c/0x01), system (0x01/0x80). Deliberately SKIP the vendor 0xFF68/0xFF67 ifaces.
const isInput = d => (d.usagePage === 0x01 && [0x06, 0x02, 0x80].includes(d.usage)) || (d.usagePage === 0x0c && d.usage === 0x01);
const targets = all.filter(isInput);
if (!targets.length) { console.log('no input collections found — is the keyboard connected on WIRED?'); process.exit(1); }
console.log(`probing ${targets.length} input collection(s) (NOT the lighting iface):`);
targets.forEach(d => console.log(`  up=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)}  ${d.path}`));

const SWEEPS = +process.argv[2] || 40;
let sweep = 0;
function probeOnce(d) {
  let h;
  try { h = new HID.HID(d.path); } catch (e) { return; }     // the OPEN itself = HidD_* descriptor reads (part of enumeration)
  h.on('error', () => {});
  for (const id of [0, 1, 2, 3, 5]) { try { h.getFeatureReport(id, 64); } catch (e) {} }   // GET_FEATURE sweep — what controller detection does
  try { h.close(); } catch (e) {}
}
console.log(`\nstarting ${SWEEPS} enumeration sweeps (a sweep every 200ms) — watch daemon.log for MUTE...\n`);
const iv = setInterval(() => {
  sweep++;
  for (const d of targets) probeOnce(d);
  if (sweep % 5 === 0) console.log(`  sweep ${sweep}/${SWEEPS}`);
  if (sweep >= SWEEPS) { clearInterval(iv); console.log('\ndone — check daemon.log: did the board go MUTE?'); process.exit(0); }
}, 200);
