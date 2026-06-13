// one-shot splice: replace the inline layer-cards block in th108-controller.html with the LUI instance
const fs = require('fs');
const f = 'th108-controller.html';
const src = fs.readFileSync(f, 'utf8').split('\n');
const start = src.findIndex(l => l.includes('===== layer cards UI (built from the layers array'));
const end = src.findIndex(l => l.includes("document.getElementById('layersPanel').addEventListener('change', scheduleSaveLayers);"));
if (start < 0 || end < 0 || end <= start) { console.error('markers not found', start, end); process.exit(1); }
const replacement = `// ===== layer cards UI — extracted to th108-layers-ui.js (cards + bodies + Adjust block + grip reorder + persist) =====
const LUI=TH108LayersUI.create({
  state, engine: TH108Engine,
  cards: document.getElementById('layerCards'),
  panel: document.getElementById('layersPanel'),
  attachHex, snap,                                           // page UI helpers (hex box per color picker, slider detent)
  pushConfig: ()=>DC.pushConfig(),                           // mirror debounced saves to the daemon's config.json
  isRunning: ()=>running,                                    // reorder warm-renders the new stack only while the loop is live
  onPatternPick: ()=>{ if(obActive && HID.device && !running && !gifPlaying) start(); }   // picking a pattern while a firmware effect is showing = "back to layers", no extra click
});
LUI.init();   // restore saved layers → ensureSettings backfill → build cards → persist-on-edit listeners on #layersPanel
attachHex(document.getElementById('gifPanel'));   // typeable hex box on the GIF bar-color picker`;
src.splice(start, end - start + 1, replacement);
fs.writeFileSync(f, src.join('\n'));
console.log('spliced lines', start + 1, 'through', end + 1);
