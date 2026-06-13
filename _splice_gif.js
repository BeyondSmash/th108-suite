// one-shot splice: swap the inline onboard-effects block in th108-controller.html for the TH108Onboard instance
const fs = require('fs');
const f = 'th108-controller.html';
let src = fs.readFileSync(f, 'utf8').split('\n');
const idx = pat => { const i = src.findIndex(l => l.includes(pat)); if (i < 0) throw new Error('marker not found: ' + pat); return i; };

const oStart = idx('===== Onboard (firmware) effects:');
const oEnd = idx('layers already running — they override the firmware effect');
src.splice(oStart, oEnd - oStart + 1, `// ===== Onboard (firmware) effects — extracted to th108-onboard.js (single 0x23 16-byte allledPack, persists on the keyboard) =====
const OB=TH108Onboard.create({
  hid: HID, log, attachHex, hexToRgb,
  panel: document.getElementById('onboardPanel'),
  isRunning: ()=>running,
  stopLayers: ()=>stop(),                                     // awaited — the firmware effect replaces the live host stream
  startLayers: ()=>start(),
  gifPlaying: ()=>GIF.playing,
  stopGif: ()=>GIF.stop(),
  setObActive: ()=>{ obActive=true; }                         // a pattern click can now auto-resume layers over this
});`);

let txt = src.join('\n');
const from = '<script src="th108-gif-panel.js"></script>';
if (!txt.includes(from)) throw new Error('script tag anchor missing');
txt = txt.replace(from, from + '\n<script src="th108-onboard.js"></script>');
fs.writeFileSync(f, txt);
console.log('spliced onboard block lines', oStart + 1, '-', oEnd + 1, '+ script tag');
