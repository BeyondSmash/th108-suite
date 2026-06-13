// _parse_sniff.js — decode _hid-sniff.js captures (clean-room wire analysis).
// Usage: node _parse_sniff.js <capture.txt> [...]
// Splits the single-line dump on literal "\n", groups OUT packets by command byte,
// reassembles full cmd-0x22 keymap writes, and diffs them against the factory map
// (DEFAULT_HID from th108-binder.js) to expose new entry encodings. Any command we
// don't already know (not 0x32/0x12/0x22/0x23/0x34) is printed in full.
const fs = require('fs');
const { DEFAULT_HID } = require('./th108-binder.js');

const KNOWN_CMDS = new Set([0x32, 0x12, 0x22]);
const hex = b => b.toString(16).padStart(2, '0');

for (const file of process.argv.slice(2)) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\\n').map(s => s.trim()).filter(Boolean);
  const outs = [];
  for (const ln of lines) {
    const m = ln.match(/OUT\s+id=(\d+)\s+([0-9a-f ]+)$/i);
    if (m) outs.push(m[2].trim().split(/\s+/).map(h => parseInt(h, 16)));
  }
  console.log('\n=== ' + file + ' — ' + lines.length + ' lines, ' + outs.length + ' OUT packets ===');

  // command census
  const census = {};
  for (const p of outs) { const c = p[1]; census[c] = (census[c] || 0) + 1; }
  console.log('OUT cmd census: ' + Object.entries(census).map(([c, n]) => '0x' + hex(+c) + '×' + n).join('  '));

  // reassemble cmd-0x22 keymap writes (a new full write starts at offset 0)
  const keymaps = [];
  let cur = null;
  for (const p of outs) {
    if (p[0] !== 0xAA || p[1] !== 0x22) continue;
    const len = p[2], off = p[3] | (p[4] << 8);
    if (off === 0) { cur = new Uint8Array(512); keymaps.push(cur); }
    if (!cur) continue;
    for (let i = 0; i < len && off + i < 512; i++) cur[off + i] = p[8 + i];
  }
  console.log(keymaps.length + ' full keymap write(s)');
  keymaps.forEach((km, ki) => {
    const diffs = [];
    for (let v = 0; v < 128; v++) {
      const e = [km[v * 4], km[v * 4 + 1], km[v * 4 + 2], km[v * 4 + 3]];
      const blank = e.every(x => x === 0);
      const isFactory = e[0] === 0x02 && e[1] === 0 && e[3] === 0 && DEFAULT_HID[v] === e[2];
      if (!blank && !isFactory) diffs.push('  value ' + v + ' (default HID ' + DEFAULT_HID[v] + '): ' + e.map(hex).join(' '));
    }
    console.log(' keymap #' + (ki + 1) + ' — ' + (diffs.length ? 'NON-FACTORY entries:' : 'all factory') );
    diffs.forEach(d => console.log(d));
  });

  // unknown commands in full (dedup)
  const seen = new Set();
  for (const p of outs) {
    if (p[0] !== 0xAA || KNOWN_CMDS.has(p[1])) continue;
    const trimmed = p.slice(0, 8 + p[2]).map(hex).join(' ');
    const key = trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(' CMD 0x' + hex(p[1]) + ': ' + trimmed);
  }
}
