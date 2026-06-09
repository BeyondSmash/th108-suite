// th108-lcd.js — LCD image / animated-GIF uploader, self-contained module ported from th108-screen.html.
// The board's only dynamic-LCD path is cmd 0x50 (flash upload at 0x650000); the firmware then plays the
// uploaded multi-frame GIF itself. No live framebuffer exists. Clock-sync is cmd 0x34. (0x51 is inert here.)
//
// Public API: window.TH108LCD = { mount(container), setDevices({screen,screenReportId,control,controlReportId}), onShow(), onHide() }
// DOM-scoped: every element lookup goes through $() against the mounted container — NEVER document.getElementById
// for the tool's own elements (avoids id collisions with the host controller). The only document.getElementById
// use is the shared host #log line in log() below.
(function (root) {
  'use strict';

  // --- device handles, set by the controller via setDevices ---
  let scrDev = null, scrId = 0, scrLen = 0;   // screen interface (large output report) — cmd 0x50
  let ctlDev = null, ctlId = 0, ctlLen = 0;   // control interface (0xFF68/0x61)        — cmd 0x34
  const TFT_CMD = 0x50, ADDR = 6619136;       // 0x650000

  // --- mount container + scoped lookup (NO global getElementById — avoids clashing with the controller) ---
  let el = null;
  const $ = (sel) => el.querySelector(sel);

  // --- ported state (module scope; isolated inside the IIFE so no rename needed) ---
  let cv = null, ctx = null, actx = null;          // preview canvases (set in mount)
  let baseData = null;                              // {data} of the frame currently previewed (un-corrected)
  let frames = [];                                 // [{rgba: Uint8ClampedArray(160*96*4), delayMs}]
  let previewTimer = null, previewIdx = 0;
  let off = null, octx = null;                     // 160x96 offscreen scratch canvas
  let srcCanvas = null, srcW = 0, srcH = 0;        // first full frame + dims (for the crop guide)
  let czoom = 1, cpanX = 0, cpanY = 0;             // adjustable crop transform (Crop mode)
  let cropHist = [], cropHi = -1;                  // crop reposition/scale history
  let currentFile = null;                          // currently-loaded image/GIF blob
  let hist = [], hi = -1;                          // color-calibration undo/redo history
  let uploading = false;
  let lastReport = null;
  let barColorT = null;                            // bar-color debounce timer

  const hex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0')).join(' ');
  const clamp255 = x => x < 0 ? 0 : x > 255 ? 255 : x | 0;
  const cl01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

  function log(m, c) {   // append to the LCD page's own log box (below the previews); fall back to the host #log / console
    const box = (el && el.querySelector('#lcdLog')) || document.getElementById('log');
    if (box) {
      const d = document.createElement('div'); if (c) d.className = c;
      d.textContent = '[' + new Date().toISOString().substr(11, 12) + '] ' + m;
      box.appendChild(d); box.scrollTop = box.scrollHeight;
    } else console.log('[lcd]', m);
  }

  // ---------------------------------------------------------------------------
  // UI markup (screen-tool body, ids prefixed `lcd`, MINUS the 0x51 slot button)
  // ---------------------------------------------------------------------------
  const LCD_HTML = `
  <style>
    .lcd-tool button,.lcd-tool input[type=file]{ font:inherit; }
    .lcd-tool button{ background:#21262d; color:#e6edf3; border:1px solid #30363d; border-radius:8px; padding:9px 14px; cursor:pointer; margin:0 8px 8px 0; }
    .lcd-tool button:hover:not(:disabled){ border-color:#58a6ff; }
    .lcd-tool button:disabled{ opacity:.4; cursor:not-allowed; }
    .lcd-tool button.go{ background:#238636; border-color:#238636; }
    .lcd-tool .row{ margin:12px 0; }
    .lcd-tool #lcdPreview,.lcd-tool #lcdPreviewActual{ image-rendering:pixelated; border:1px solid #30363d; width:320px; height:192px; background:#000; }
    .lcd-tool .lcd-log{ width:646px; max-width:100%; height:130px; overflow:auto; background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:6px 8px; font:11px/1.55 ui-monospace,monospace; color:#8b949e; white-space:pre-wrap; }
    .lcd-tool .lcd-log .err{ color:#f85149; } .lcd-tool .lcd-log .ok{ color:#3fb950; } .lcd-tool .lcd-log .in{ color:#58a6ff; } .lcd-tool .lcd-log .dim{ color:#6e7681; }
    .lcd-tool label{ color:#8b949e; }
    .lcd-tool .sub,.lcd-tool .hint{ color:#8b949e; }
    .lcd-tool progress{ width:320px; }
    .lcd-tool input[type=range]{ width:100%; }
    .lcd-tool .num{ width:62px; font:inherit; background:#0d1117; color:#58a6ff; border:1px solid #30363d; border-radius:5px; padding:2px 5px; font-family:ui-monospace,monospace; }
    .lcd-tool button.mini{ padding:3px 8px; margin:0; font-size:13px; }
    .lcd-tool button.rst{ padding:1px 5px; margin:0; font-size:12px; line-height:1; color:#8b949e; }
    .lcd-tool button.rst:hover{ color:#e6edf3; }
    .lcd-tool button.mini:disabled{ opacity:.35; }
    .lcd-tool #lcdUrl{ font:inherit; background:#0d1117; color:#e6edf3; border:1px solid #30363d; border-radius:6px; padding:5px 8px; width:340px; }
    .lcd-tool #lcdOvl{ position:fixed; inset:0; background:rgba(1,4,9,.66); display:none; align-items:center; justify-content:center; z-index:1000; }
    .lcd-tool #lcdOvl .box{ background:#161b22; border:1px solid #30363d; border-radius:14px; padding:26px 38px; min-width:400px; text-align:center; box-shadow:0 12px 48px rgba(0,0,0,.6); }
    .lcd-tool #lcdOvl .t{ font-size:16px; color:#e6edf3; margin-bottom:8px; }
    .lcd-tool #lcdOvl .p{ font-size:36px; font-weight:700; color:#58a6ff; font-family:ui-monospace,monospace; }
    .lcd-tool #lcdOvl .bar{ height:10px; background:#0d1117; border:1px solid #30363d; border-radius:6px; overflow:hidden; margin-top:14px; }
    .lcd-tool #lcdOvl .fill{ height:100%; width:0%; background:linear-gradient(90deg,#1f6feb,#58a6ff); transition:width .1s linear; }
    .lcd-tool #lcdOvl .s{ color:#8b949e; font-size:12.5px; margin-top:12px; }
  </style>
  <div class="lcd-tool">
    <p class="sub">Uploads an image or <b>animated GIF</b> to the keyboard's 160×96 screen over WebHID (cmd 0x50, RGB565),
       with per-channel color calibration applied to every frame.</p>

    <div class="row"><span id="lcdDevNote" class="hint">not connected — connect on the main page first</span></div>

    <div class="row">
      <input type="file" id="lcdFile" accept="image/*" />
      <label style="margin-left:14px"><input type="checkbox" id="lcdSwap" checked /> little-endian byte order (correct for TH108 — untick only if colors look wrong)</label>
    </div>
    <div class="row">
      <input type="text" id="lcdUrl" placeholder="paste an image / GIF URL…" />
      <button id="lcdUrlLoad">Load URL</button>
      <button id="lcdPaste">Paste image (Ctrl+V)</button>
      <button id="lcdSave" title="save the currently loaded image to the library">★ Add to Library</button>
      <button id="lcdLibBtn">📚 Library</button>
      <span class="hint">URL load needs the host to allow cross-origin fetch (CORS). Ctrl+V also pastes.</span>
    </div>
    <div class="row" id="lcdLib" style="display:none"></div>
    <div class="row">
      <b style="margin-right:8px">Fit mode:</b>
      <label><input type="radio" name="lcdFit" value="cover" checked /> <b>Crop</b> (fill the screen, cut the edges)</label>
      <label style="margin-left:16px"><input type="radio" name="lcdFit" value="fit" /> <b>Fit</b> (whole GIF, bars, no crop)</label>
    </div>
    <div class="row">
      <b style="margin-right:8px">Fit bars:</b>
      <select id="lcdBarFill" style="font:inherit;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:3px 6px">
        <option value="black">Black</option>
        <option value="color">Solid color →</option>
        <option value="blur">Blurred content</option>
        <option value="edge">Edge-color average</option>
      </select>
      <input type="color" id="lcdBarColor" value="#000000" style="margin-left:8px;width:48px;height:28px;background:none;border:1px solid #30363d;border-radius:6px" />
      <span class="hint">how to fill the bars when using Fit mode</span>
    </div>
    <div class="row" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
      <div>
        <div class="sub" id="lcdCropLbl" style="margin:0 0 4px">load a GIF to see the crop guide</div>
        <canvas id="lcdCropGuide" style="border:1px solid #30363d;background:#000;border-radius:4px;cursor:move"></canvas>
        <div id="lcdCropCtls" style="display:none;gap:10px;align-items:center;margin-top:7px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px">zoom <input type="range" id="lcdCropZoom" min="100" max="500" value="100" style="width:140px"></label>
          <button id="lcdCropUndo" title="undo">↶</button>
          <button id="lcdCropRedo" title="redo">↷</button>
          <button id="lcdCropReset">reset crop</button>
          <span class="sub" style="margin:0">drag the box above to reposition</span>
        </div>
      </div>
    </div>
    <div class="row" style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          <div><div class="sub" style="margin:0 0 4px">LCD preview — calibrated (what the screen shows)</div><canvas id="lcdPreview" width="160" height="96"></canvas></div>
          <div><div class="sub" style="margin:0 0 4px">Actual — desktop colors (the true source)</div><canvas id="lcdPreviewActual" width="160" height="96"></canvas></div>
        </div>
        <div class="sub" style="margin:0">Log</div>
        <div id="lcdLog" class="lcd-log"></div>
      </div>
      <div class="ctl" style="display:grid;grid-template-columns:auto 250px 60px 26px;gap:5px 8px;align-items:center">
        <div style="grid-column:1/5;display:flex;align-items:center;gap:8px;margin-bottom:2px">
          <b>Per-channel RGB calibration</b><span id="lcdCalStatus" class="dim" style="font-weight:normal;color:#8b949e"></span>
          <span style="flex:1"></span>
          <button id="lcdUndo" class="mini" title="undo (Ctrl+Z)">↶</button>
          <button id="lcdRedo" class="mini" title="redo (Ctrl+Y)">↷</button>
          <button id="lcdResetColor" class="mini">Reset all</button>
        </div>
        <label style="color:#ff7b72">R gain</label><input type="range" id="lcdrGain" min="20" max="220" value="100"><input type="number" class="num" id="lcdrGainN"><button class="rst" data-id="lcdrGain" title="reset">↺</button>
        <label style="color:#ff7b72">R γ</label><input type="range" id="lcdrGamma" min="40" max="260" value="100"><input type="number" class="num" id="lcdrGammaN"><button class="rst" data-id="lcdrGamma" title="reset">↺</button>
        <label style="color:#ff7b72">R black</label><input type="range" id="lcdrBlack" min="0" max="40" value="0"><input type="number" class="num" id="lcdrBlackN"><button class="rst" data-id="lcdrBlack" title="reset">↺</button>
        <label style="color:#56d364">G gain</label><input type="range" id="lcdgGain" min="20" max="220" value="100"><input type="number" class="num" id="lcdgGainN"><button class="rst" data-id="lcdgGain" title="reset">↺</button>
        <label style="color:#56d364">G γ</label><input type="range" id="lcdgGamma" min="40" max="260" value="100"><input type="number" class="num" id="lcdgGammaN"><button class="rst" data-id="lcdgGamma" title="reset">↺</button>
        <label style="color:#56d364">G black</label><input type="range" id="lcdgBlack" min="0" max="40" value="0"><input type="number" class="num" id="lcdgBlackN"><button class="rst" data-id="lcdgBlack" title="reset">↺</button>
        <label style="color:#79c0ff">B gain</label><input type="range" id="lcdbGain" min="20" max="220" value="100"><input type="number" class="num" id="lcdbGainN"><button class="rst" data-id="lcdbGain" title="reset">↺</button>
        <label style="color:#79c0ff">B γ</label><input type="range" id="lcdbGamma" min="40" max="260" value="100"><input type="number" class="num" id="lcdbGammaN"><button class="rst" data-id="lcdbGamma" title="reset">↺</button>
        <label style="color:#79c0ff">B black</label><input type="range" id="lcdbBlack" min="0" max="40" value="0"><input type="number" class="num" id="lcdbBlackN"><button class="rst" data-id="lcdbBlack" title="reset">↺</button>
        <b style="grid-column:1/5;margin:6px 0 2px">Global adjustments</b>
        <label>Temperature</label><input type="range" id="lcdwarmth" min="40" max="160" value="100"><input type="number" class="num" id="lcdwarmthN"><button class="rst" data-id="lcdwarmth" title="reset">↺</button>
        <label>Brightness</label><input type="range" id="lcdbrightness" min="40" max="180" value="100"><input type="number" class="num" id="lcdbrightnessN"><button class="rst" data-id="lcdbrightness" title="reset">↺</button>
        <label>Saturation</label><input type="range" id="lcdsaturation" min="0" max="200" value="100"><input type="number" class="num" id="lcdsaturationN"><button class="rst" data-id="lcdsaturation" title="reset">↺</button>
        <label>Contrast</label><input type="range" id="lcdcontrast" min="50" max="200" value="100"><input type="number" class="num" id="lcdcontrastN"><button class="rst" data-id="lcdcontrast" title="reset">↺</button>
      </div>
    </div>
    <p class="sub" style="margin:6px 0 0">
      <b>Calibrate by matching:</b> adjust the sliders until the <b>preview looks like how your LCD shows the image at default</b> (its washed / blue-purple tint). The upload automatically sends the <b>inverse</b> of those settings, so the LCD reverses its own distortion and ends up showing corrected colors. (Each upload writes the keyboard's flash.)</p>
    <p class="sub" style="margin:6px 0 0;color:#d29922">
      <b>Note:</b> Uploading writes the GIF to flash — the key lighting briefly blanks during the write, then resumes.</p>
    <div class="row">
      <button id="lcdUpload" class="go" disabled>Upload to screen ▶</button>
      <progress id="lcdProg" value="0" max="100"></progress>
      <label style="margin-left:14px">max frames <input id="lcdMaxFrames" type="number" value="33" min="1" max="33" title="hard-capped at 33 — the LCD flash region only holds ~33 frames (~1MB); more would overflow into config flash" style="width:56px" /></label>
      <span class="sub">leave high to keep every frame; lower only to shrink a very long GIF.</span>
    </div>
    <div class="row">
      <b style="margin-right:8px">Clock:</b>
      <button id="lcdSyncClock" disabled>Sync clock to PC time (0x34)</button>
      <span id="lcdClockNow" class="sub" style="font-variant-numeric:tabular-nums"></span>
      <span class="sub">— sets the keyboard's built-in clock; view it with FN+knob → scroll right → click.</span>
    </div>
    <div class="row"><button id="lcdCopyReport">📋 Copy last upload report</button>
      <span class="sub">if an upload stalls or fails, click this and paste it to me — it has the full timeline.</span></div>
    <div id="lcdStatus" class="sub"></div>

    <div id="lcdOvl">
      <div class="box">
        <div class="t" id="lcdOvlTitle">Uploading to keyboard…</div>
        <div class="p" id="lcdOvlPct">0%</div>
        <div class="bar"><div class="fill" id="lcdOvlFill"></div></div>
        <div class="s" id="lcdOvlSub">keep the keyboard plugged in — this syncs live with the screen</div>
      </div>
    </div>
  </div>`;

  // ---------------------------------------------------------------------------
  // image -> 160x96 helpers (ported, de-globalized)
  // ---------------------------------------------------------------------------
  function drawActual(rgba) { actx.putImageData(new ImageData(new Uint8ClampedArray(rgba), 160, 96), 0, 0); }
  function isFit() { const r = $('input[name=lcdFit]:checked'); return r && r.value === 'fit'; }
  function barFill() { const s = $('#lcdBarFill'); return s ? s.value : 'black'; }

  // average color of the image's edge pixels touching the bars
  function edgeAverage(dx, dy, dw, dh, letterbox) {
    let r = 0, g = 0, b = 0, n = 0;
    const acc = arr => { for (let i = 0; i < arr.length; i += 4) { r += arr[i]; g += arr[i + 1]; b += arr[i + 2]; n++; } };
    try {
      if (letterbox) { acc(octx.getImageData(dx, dy, dw, 1).data); acc(octx.getImageData(dx, dy + dh - 1, dw, 1).data); }
      else { acc(octx.getImageData(dx, dy, 1, dh).data); acc(octx.getImageData(dx + dw - 1, dy, 1, dh).data); }
    } catch (e) { }
    return n ? `rgb(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0})` : '#000';
  }

  // adjustable crop transform (Crop mode): zoom + pan, clamped to the source
  function cropRect(srcW, srcH) {
    const tr = 160 / 96, ir = srcW / srcH; let cw0, ch0;
    if (ir > tr) { ch0 = srcH; cw0 = srcH * tr; } else { cw0 = srcW; ch0 = srcW / tr; }   // base cover rect (5:3)
    const cw = cw0 / czoom, ch = ch0 / czoom, maxX = (srcW - cw) / 2, maxY = (srcH - ch) / 2;
    cpanX = Math.max(-maxX, Math.min(maxX, cpanX)); cpanY = Math.max(-maxY, Math.min(maxY, cpanY));  // clamp + write back
    return { cx: (srcW - cw) / 2 + cpanX, cy: (srcH - ch) / 2 + cpanY, cw, ch };
  }

  function coverDraw(srcW, srcH, drawable) {   // render drawable to 160x96 (crop or fit), return RGBA bytes
    const tw = 160, th = 96, ir = srcW / srcH, tr = tw / th;
    octx.filter = 'none'; octx.clearRect(0, 0, tw, th);
    if (isFit()) {                            // FIT: whole image, filled bars
      let dw, dh, dx, dy; const letterbox = ir > tr;
      if (letterbox) { dw = tw; dh = tw / ir; dx = 0; dy = (th - dh) / 2; } else { dh = th; dw = th * ir; dx = (tw - dw) / 2; dy = 0; }
      dx = Math.round(dx); dy = Math.round(dy); dw = Math.min(tw - dx, Math.round(dw)); dh = Math.min(th - dy, Math.round(dh));
      const fill = barFill();
      if (fill === 'blur') {                    // blurred cover-crop behind the fitted image
        octx.filter = 'blur(4px)';
        let sw, sh, sx, sy;
        if (ir > tr) { sh = srcH; sw = sh * tr; sx = (srcW - sw) / 2; sy = 0; } else { sw = srcW; sh = sw / tr; sx = 0; sy = (srcH - sh) / 2; }
        octx.drawImage(drawable, sx, sy, sw, sh, 0, 0, tw, th); octx.filter = 'none';
        octx.drawImage(drawable, 0, 0, srcW, srcH, dx, dy, dw, dh);
      } else {
        octx.drawImage(drawable, 0, 0, srcW, srcH, dx, dy, dw, dh);   // image first (so edge-avg can sample it)
        let col = '#000';
        if (fill === 'color') col = $('#lcdBarColor').value;
        else if (fill === 'edge') col = edgeAverage(dx, dy, dw, dh, letterbox);
        octx.fillStyle = col;
        if (letterbox) { octx.fillRect(0, 0, tw, dy); octx.fillRect(0, dy + dh, tw, th - (dy + dh)); }
        else { octx.fillRect(0, 0, dx, th); octx.fillRect(dx + dw, 0, tw - (dx + dw), th); }
      }
    } else {                                // COVER: crop (repositionable + scalable)
      const c = cropRect(srcW, srcH);
      octx.drawImage(drawable, c.cx, c.cy, c.cw, c.ch, 0, 0, tw, th);
    }
    return octx.getImageData(0, 0, tw, th).data;
  }

  // keep the first full frame + its dimensions so we can draw the crop guide
  function captureSource(drawable, w, h) {
    srcW = w; srcH = h; srcCanvas = document.createElement('canvas'); srcCanvas.width = w; srcCanvas.height = h;
    srcCanvas.getContext('2d').drawImage(drawable, 0, 0, w, h);
  }

  // draw the full source with the kept (160×96 / 5:3) region highlighted and the cropped-out parts dimmed
  function drawCropGuide() {
    const cg = $('#lcdCropGuide'); if (!cg || !srcCanvas) return;
    const dispW = Math.min(320, srcW), s = dispW / srcW, dispH = Math.round(srcH * s);
    cg.width = dispW; cg.height = dispH;
    const c = cg.getContext('2d'); c.drawImage(srcCanvas, 0, 0, dispW, dispH);
    const lbl = $('#lcdCropLbl');
    if (isFit()) {                                  // FIT: whole image kept (letterboxed) — no crop
      c.strokeStyle = '#3fb950'; c.lineWidth = 2; c.strokeRect(1, 1, dispW - 2, dispH - 2);
      if (lbl) lbl.textContent = `source ${srcW}×${srcH} → whole GIF kept, letterboxed to 160×96 (black bars)`;
    } else {                                       // COVER: dim cropped-out area, dash the kept (adjustable) region
      const cr = cropRect(srcW, srcH);
      const rx = cr.cx * s, ry = cr.cy * s, rw = cr.cw * s, rh = cr.ch * s;
      c.fillStyle = 'rgba(1,4,9,.6)';
      c.fillRect(0, 0, dispW, ry); c.fillRect(0, ry + rh, dispW, dispH - (ry + rh));
      c.fillRect(0, ry, rx, rh); c.fillRect(rx + rw, ry, dispW - (rx + rw), rh);
      c.strokeStyle = '#58a6ff'; c.lineWidth = 2; c.setLineDash([6, 4]);
      c.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2); c.setLineDash([]);
      if (lbl) lbl.textContent = `source ${srcW}×${srcH} → drag to reposition, zoom to scale · ${(czoom * 100 | 0)}%`;
    }
    const ctls = $('#lcdCropCtls'); if (ctls) ctls.style.display = (srcCanvas && !isFit()) ? 'flex' : 'none';
  }

  // evenly sample frames down to maxN, summing skipped frames' delays so total duration is preserved
  function sampleFrames(maxN) {
    if (frames.length <= maxN) return frames;
    const out = [], step = frames.length / maxN;
    for (let k = 0; k < maxN; k++) {
      const start = Math.floor(k * step), end = Math.floor((k + 1) * step);
      let delay = 0; for (let i = start; i < Math.max(end, start + 1); i++) delay += frames[i]?.delayMs || 100;
      out.push({ rgba: frames[start].rgba, delayMs: delay });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // preview loop
  // ---------------------------------------------------------------------------
  function stopPreview() { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } }
  function tickPreview() {
    if (!frames.length) return;
    baseData = { data: frames[previewIdx].rgba }; applyColor();
    drawActual(frames[previewIdx].rgba);            // raw desktop colors, side-by-side for comparison
    const d = Math.max(20, frames[previewIdx].delayMs || 100);
    previewIdx = (previewIdx + 1) % frames.length;
    if (frames.length > 1) previewTimer = setTimeout(tickPreview, d);
  }
  function startPreview() { stopPreview(); if (frames.length) tickPreview(); }

  // ---------------------------------------------------------------------------
  // crop reposition / scale, with undo·redo·reset
  // ---------------------------------------------------------------------------
  const cropSnap = () => ({ z: czoom, x: cpanX, y: cpanY });
  function cropPush() { cropHist = cropHist.slice(0, cropHi + 1); cropHist.push(cropSnap()); cropHi = cropHist.length - 1; cropBtns(); }
  function cropBtns() { const u = $('#lcdCropUndo'), r = $('#lcdCropRedo'); if (u) u.disabled = cropHi <= 0; if (r) r.disabled = cropHi >= cropHist.length - 1; }
  function cropApplySnap(s) { czoom = s.z; cpanX = s.x; cpanY = s.y; $('#lcdCropZoom').value = Math.round(czoom * 100); drawCropGuide(); if (currentFile) processFile(currentFile); }
  function cropResetState() { czoom = 1; cpanX = 0; cpanY = 0; cropHist = []; cropHi = -1; const z = $('#lcdCropZoom'); if (z) z.value = 100; }

  // ---------------------------------------------------------------------------
  // decode an image / animated GIF into frames[]
  // ---------------------------------------------------------------------------
  async function processFile(f) {
    stopPreview(); frames = []; previewIdx = 0;
    log('decoding ' + f.name + ' (' + (isFit() ? 'fit' : 'crop') + ')…', 'in');
    try {
      if (window.ImageDecoder) {            // decodes animated GIF/WebP/APNG frame-by-frame with durations
        const dec = new ImageDecoder({ data: await f.arrayBuffer(), type: f.type || 'image/gif' });
        await dec.tracks.ready;
        const track = dec.tracks.selectedTrack;
        for (let i = 0; i < 5000; i++) {
          let res; try { res = await dec.decode({ frameIndex: i }); } catch (err) { break; }
          const vf = res.image, w = vf.displayWidth || vf.codedWidth, h = vf.displayHeight || vf.codedHeight;
          if (i === 0) captureSource(vf, w, h);
          frames.push({ rgba: coverDraw(w, h, vf), delayMs: vf.duration ? vf.duration / 1000 : 100 });
          vf.close();
          if (track.frameCount && i >= track.frameCount - 1) break;
        }
      }
      if (!frames.length) { const bmp = await createImageBitmap(f); captureSource(bmp, bmp.width, bmp.height); frames.push({ rgba: coverDraw(bmp.width, bmp.height, bmp), delayMs: 100 }); bmp.close && bmp.close(); }
      log('decoded ' + frames.length + ' frame(s)' + (frames.length > 1 ? ' (animated)' : ''), 'ok');
      drawCropGuide();
      tickPreview();
    } catch (err) { log('decode failed: ' + err.message, 'err'); }
  }

  // load a blob (from URL / clipboard / library) — set as the current file and decode like a picked file
  function loadBlob(blob, name) {
    currentFile = blob; if (name && !currentFile.name) { try { Object.defineProperty(currentFile, 'name', { value: name, configurable: true }); } catch (e) { } }
    if (!currentFile.name) currentFile = new File([blob], name || 'image', { type: blob.type || '' });
    cropResetState(); processFile(currentFile).then(cropPush);
  }

  // ---------------------------------------------------------------------------
  // color calibration (forward = LCD distortion preview; inverse = what gets uploaded)
  // ---------------------------------------------------------------------------
  const CAL_KEY = 'th108_rgb_calibration';
  // module ids carry the `lcd` prefix; logical keys (without prefix) are used for storage/params
  const CAL_KEYS = ['rGain', 'rGamma', 'rBlack', 'gGain', 'gGamma', 'gBlack', 'bGain', 'bGamma', 'bBlack', 'warmth', 'brightness', 'saturation', 'contrast'];
  const calEl = key => $('#lcd' + key);                 // range input for a logical key
  const numEl = key => $('#lcd' + key + 'N');           // number input for a logical key
  const isGammaId = key => key.endsWith('Gamma');
  const defaultOf = key => key.endsWith('Black') ? 0 : 100;

  function params() {
    const g = key => +calEl(key).value / 100;
    return {
      rGain: g('rGain'), gGain: g('gGain'), bGain: g('bGain'),
      rGamma: g('rGamma'), gGamma: g('gGamma'), bGamma: g('bGamma'),
      rBlack: g('rBlack'), gBlack: g('gBlack'), bBlack: g('bBlack'),
      bright: g('brightness'), sat: g('saturation'), contrast: g('contrast'), warmth: g('warmth')
    };
  }
  // per-channel model: forward (LCD distortion) y = black + gain·x^(1/γ);  inverse x = ((y-black)/gain)^γ
  const fwdC = (x, gain, gamma, black) => cl01(black + gain * Math.pow(cl01(x), 1 / gamma));
  const invC = (y, gain, gamma, black) => cl01(Math.pow(cl01((y - black) / gain), gamma));
  function fwd(r, g, b, p) {
    r = fwdC(r, p.rGain, p.rGamma, p.rBlack); g = fwdC(g, p.gGain, p.gGamma, p.gBlack); b = fwdC(b, p.bGain, p.bGamma, p.bBlack);
    r *= p.bright; g *= p.bright; b *= p.bright;                                                  // brightness
    { const wf = p.warmth - 1; r *= 1 + wf; b *= 1 - wf; }                                        // temperature (warm = R up / B down)
    r = (r - 0.5) * p.contrast + 0.5; g = (g - 0.5) * p.contrast + 0.5; b = (b - 0.5) * p.contrast + 0.5;           // contrast
    const lum = 0.299 * r + 0.587 * g + 0.114 * b; r = lum + (r - lum) * p.sat; g = lum + (g - lum) * p.sat; b = lum + (b - lum) * p.sat; // saturation
    return [r, g, b];
  }
  function inv(r, g, b, p) {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b; r = lum + (r - lum) / p.sat; g = lum + (g - lum) / p.sat; b = lum + (b - lum) / p.sat; // inv saturation
    r = (r - 0.5) / p.contrast + 0.5; g = (g - 0.5) / p.contrast + 0.5; b = (b - 0.5) / p.contrast + 0.5;           // inv contrast
    { const wf = p.warmth - 1; r /= 1 + wf; b /= 1 - wf; }                                        // inv temperature
    r /= p.bright; g /= p.bright; b /= p.bright;                                                  // inv brightness
    r = invC(r, p.rGain, p.rGamma, p.rBlack); g = invC(g, p.gGain, p.gGamma, p.gBlack); b = invC(b, p.bGain, p.bGamma, p.bBlack); // inv per-channel
    return [r, g, b];
  }
  function applyColor() {
    if (!baseData) return;
    const p = params(), src = baseData.data, d = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const o = fwd(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, p);   // preview = exactly what gets uploaded
      d[i] = clamp255(o[0] * 255); d[i + 1] = clamp255(o[1] * 255); d[i + 2] = clamp255(o[2] * 255); d[i + 3] = 255;
    }
    ctx.putImageData(new ImageData(d, 160, 96), 0, 0);
  }

  // ---- persistent color calibration (saved locally, applies to all future uploads incl. GIF frames) ----
  function saveCal() {
    const p = {}; CAL_KEYS.forEach(key => p[key] = calEl(key).value);
    localStorage.setItem(CAL_KEY, JSON.stringify(p));
    $('#lcdCalStatus').textContent = '· saved';
  }
  // dialed-in TH108 V2 PRO color-correction profile, baked in as the standard default
  const DEFAULT_CAL = { rGain: 100, rGamma: 97, rBlack: 0, gGain: 100, gGamma: 100, gBlack: 4, bGain: 122, bGamma: 100, bBlack: 9, warmth: 95, brightness: 114, saturation: 100, contrast: 104 };
  function loadCal() {
    let saved = false, p = null;
    try { p = JSON.parse(localStorage.getItem(CAL_KEY) || 'null'); saved = !!p; } catch (e) { }
    if (!p) p = DEFAULT_CAL;
    for (const k of CAL_KEYS) if (p[k] != null) { const e = calEl(k); if (e) e.value = p[k]; }
    return saved;
  }
  function syncNum(key) {
    const e = calEl(key), num = numEl(key);
    num.value = isGammaId(key) ? (+e.value / 100).toFixed(2) : +e.value;
  }
  // set a param's range value + number field (no history push); optionally re-render
  function setParam(key, raw, render) {
    if (render === undefined) render = true;
    const e = calEl(key);
    e.value = Math.max(+e.min, Math.min(+e.max, raw));
    syncNum(key);
    if (render) { applyColor(); saveCal(); }
  }

  // ---- undo / redo history (snapshots of all params) ----
  const snapshot = () => { const s = {}; CAL_KEYS.forEach(key => s[key] = +calEl(key).value); return s; };
  function applySnap(s) { CAL_KEYS.forEach(key => setParam(key, s[key], false)); applyColor(); saveCal(); }
  function pushHistory() { hist = hist.slice(0, hi + 1); hist.push(snapshot()); hi = hist.length - 1; updateHistButtons(); }
  function updateHistButtons() { $('#lcdUndo').disabled = hi <= 0; $('#lcdRedo').disabled = hi >= hist.length - 1; }

  // ---------------------------------------------------------------------------
  // RGB565 encode (calibrated, inverse-corrected per frame)
  // ---------------------------------------------------------------------------
  function transformFrame(srcRgba) {
    // You tune the sliders so the PREVIEW (fwd) matches the LCD's default washed look; the UPLOAD sends the
    // INVERSE (inv), so the LCD reverses that distortion and ends up showing corrected colors.
    const p = params();
    const out = new Uint8ClampedArray(srcRgba.length);
    for (let i = 0; i < srcRgba.length; i += 4) {
      const t = inv(srcRgba[i] / 255, srcRgba[i + 1] / 255, srcRgba[i + 2] / 255, p);
      out[i] = clamp255(t[0] * 255); out[i + 1] = clamp255(t[1] * 255); out[i + 2] = clamp255(t[2] * 255); out[i + 3] = 255;
    }
    return out;
  }
  function encodeFrame(srcRgba) {
    const data = transformFrame(srcRgba), swap = $('#lcdSwap').checked, out = new Uint8Array(160 * 96 * 2);
    for (let i = 0, o = 0; i < data.length; i += 4, o += 2) {
      const v = ((data[i] & 0xF8) << 8) | ((data[i + 1] & 0xFC) << 3) | (data[i + 2] >> 3);
      if (swap) { out[o] = v & 0xFF; out[o + 1] = v >> 8; } else { out[o] = v >> 8; out[o + 1] = v & 0xFF; }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // chunked, ACK-gated upload (cmd 0x50) via the screen handle
  // ---------------------------------------------------------------------------
  function buildPktTFT(chunkIndex, totalSize, dataBuf) {
    const pkt = new Uint8Array(scrLen || 4104);
    pkt[0] = 0xAA; pkt[1] = TFT_CMD;
    pkt[2] = chunkIndex & 0xFF; pkt[3] = (chunkIndex >> 8) & 0xFF;
    const totalChunks = Math.ceil(totalSize / 4096);   // match the official's chunk count exactly (firmware is sensitive to this)
    pkt[4] = totalChunks & 0xFF; pkt[5] = (totalChunks >> 8) & 0xFF;
    pkt[6] = (ADDR / 4096) & 0xFF; pkt[7] = ((ADDR / 4096) >> 8) & 0xFF;
    pkt.set(dataBuf, 8);
    return pkt;
  }
  // ---- upload progress overlay (synced live with the device via ACK-gated chunks) ----
  function showOverlay(title, pct) { $('#lcdOvlTitle').textContent = title; $('#lcdOvlSub').textContent = 'keep the keyboard plugged in — this syncs live with the screen'; setOverlay(pct); $('#lcdOvl').style.display = 'flex'; }
  function setOverlay(pct, title, sub) {
    if (title != null) $('#lcdOvlTitle').textContent = title;
    if (sub != null) $('#lcdOvlSub').textContent = sub;
    if (pct != null) { $('#lcdOvlPct').textContent = pct + '%'; $('#lcdOvlFill').style.width = pct + '%'; }
  }
  function hideOverlay() { $('#lcdOvl').style.display = 'none'; }

  // ---- upload diagnostic / crash report ----
  function buildReport(diag, c) {
    const start = diag.find(d => d.ev === 'start') || {};
    const ins = diag.filter(d => d.ev === 'in').length, retries = diag.filter(d => d.ev === 'retry').length;
    const lastChunk = diag.filter(d => d.ev === 'send').reduce((m, d) => Math.max(m, d.chunk), -1);
    let s = '=== TH108 GIF upload report ===\n';
    s += 'when: ' + new Date().toISOString() + '\n';
    s += 'device: ' + c.device + '  reportId=' + c.reportId + '  reportLen=' + c.reportLen + '\n';
    s += 'gif: ' + start.frames + ' frames, ' + start.bytes + ' bytes, ' + start.chunks + ' chunks, mode=' + start.mode + '\n';
    s += 'RESULT: ' + c.result + '\n';
    s += 'reached chunk ' + lastChunk + '/' + start.chunks + '  ·  inputreports=' + ins + '  ·  retries=' + retries + '\n';
    s += '--- timeline (t = ms from start) ---\n';
    for (const d of diag) {
      s += String(d.t).padStart(7) + '  ' + d.ev;
      if (d.chunk != null) s += ' chunk=' + d.chunk;
      if (d.attempt != null) s += ' try=' + d.attempt;
      if (d.b) s += ' [' + d.b + ']';
      if (d.err) s += '  ERR=' + d.err;
      s += '\n';
    }
    return s;
  }

  async function upload() {
    if (uploading) { log('⚠ an upload is already running — let it finish before starting another.', 'err'); return; }
    if (!scrDev) { log('connect first', 'err'); return; }
    if (!frames.length) { log('pick an image first', 'err'); return; }
    uploading = true;
    const upBtn = $('#lcdUpload'), fileInput = $('#lcdFile');
    upBtn.disabled = true; fileInput.disabled = true;
    stopPreview();
    try { window.__lcdHost && window.__lcdHost.pauseLighting && window.__lcdHost.pauseLighting(); } catch (_) { }   // free the device — a flash upload can't run while key lighting streams 0x32
    showOverlay('Uploading to keyboard…', 0);
    const REGION_FRAMES = 33;                               // HARD cap = the official's max (33×30720 ≈ 1.01MB, 248 chunks). More overflows past the screen-flash region into config flash → corrupts the keyboard. The official samples long GIFs down to this.
    const want = Math.max(1, +$('#lcdMaxFrames').value || 20);
    const maxN = Math.min(REGION_FRAMES, want);
    if (want > REGION_FRAMES) log(`capping ${want}→${REGION_FRAMES} frames to fit the LCD flash region (overflow would corrupt the keyboard)`, 'dim');
    let up = sampleFrames(maxN);                            // evenly sample down to the frame cap (preserves whole animation)
    if (up.length < frames.length) log(`sampling ${frames.length} → ${up.length} frames to fit the screen`, 'in');
    // Each frame = 30720B = 7.5 chunks; an EVEN frame count lands on a 4096B boundary so the 256B header
    // offset drops the last 128px (bottom row) and under-erases it → stale-flash glitch. Duplicating the
    // last frame makes the count ODD, which sends every byte and erases the full region. (Protocol-safe:
    // keeps the official's totalChunks formula intact.)
    if (up.length % 2 === 0) { up = up.concat([up[up.length - 1]]); log('even frame count → duplicating last frame to avoid the bottom-row glitch', 'dim'); }
    const FB = 160 * 96 * 2;                                // 30720 bytes/frame
    const enc = up.map(fr => encodeFrame(fr.rgba));         // calibrated RGB565 per frame
    const n = new Uint8Array(enc.length * FB); enc.forEach((e, i) => n.set(e, i * FB));
    const frameCount = up.length;
    const header = new Uint8Array(256).fill(255);
    header[0] = frameCount;
    for (let i = 0; i < frameCount - 1; i++) header[i + 1] = Math.min(255, Math.round((up[i].delayMs || 100) / 2)); // delay byte = ms/2 (=5×centiseconds)
    header[frameCount] = 0;
    const totalSize = n.length;
    const S = Math.ceil(totalSize / 4096);
    log(`uploading ${frameCount} frame(s): ${totalSize} bytes (${S} chunks)`, 'in');

    // diagnostic timeline (captured for the crash report)
    const t0d = Date.now(), diag = []; const D = o => { if (diag.length < 3000) diag.push(Object.assign({ t: Date.now() - t0d }, o)); };
    D({ ev: 'start', frames: frameCount, bytes: totalSize, chunks: S, reportId: scrId, reportLen: scrLen, mode: 'direct' });
    let result = 'ok';

    // ACK gate — device replies 0x55 0x41 after each chunk is written
    let resolveAck = null;
    const onInput = e => { const b = new Uint8Array(e.data.buffer); D({ ev: 'in', b: hex(b.slice(0, 12)) }); if (b[0] === 0x55 && b[1] === 0x41 && resolveAck) resolveAck(); };
    scrDev.addEventListener('inputreport', onInput);
    // send one chunk and await its ACK (arms the listener BEFORE sending so an early ACK isn't missed)
    const sendOne = (pkt, ms) => new Promise((resolve, reject) => {
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; resolveAck = null; reject(new Error('ACK timeout')); } }, ms);
      resolveAck = () => { if (!settled) { settled = true; clearTimeout(to); resolveAck = null; resolve(); } };
      scrDev.sendReport(scrId, pkt).catch(err => { if (!settled) { settled = true; clearTimeout(to); resolveAck = null; reject(err); } });
    });

    try {
      for (let v = 0; v < S; v++) {
        let data;
        if (v === 0) { const t = new Uint8Array(4096); t.set(header, 0); t.set(n.slice(0, 3840), 256); data = t; }
        else { const a = 4096 * v - 256; data = n.slice(a, Math.min(a + 4096, n.length)); }
        const pkt = buildPktTFT(v, totalSize, data);
        if (v === 0) log('first packet: ' + hex(pkt.slice(0, 12)) + '… (flash erase ~0.3s)', 'dim');
        D({ ev: 'send', chunk: v });
        // NEVER re-send a chunk. Re-sending while the firmware is mid flash-erase/commit corrupts adjacent
        // flash (it wedged a board — recovered only via the official "Reset all settings"). The official driver
        // is purely ACK-driven and never re-sends. So: one send, wait for the 0x55 0x41 ACK with a generous
        // window, and on a real stall ABORT cleanly (no re-send). User power-cycles + retries the whole upload.
        try { await sendOne(pkt, v === 0 ? 6000 : 4000); D({ ev: 'ack', chunk: v }); }   // real ACKs land in ~0.14-0.26s; window is only to abort cleanly on a true stall (never re-sends)
        catch (err) {
          D({ ev: 'GIVEUP', chunk: v, err: err.message });
          throw new Error(`chunk ${v}: no ACK (${err.message}) — aborted WITHOUT re-sending (mid-write re-sends corrupt flash). Power-cycle the keyboard, then retry the whole upload.`);
        }
        if (v === 0) { D({ ev: 'settle' }); await new Promise(r => setTimeout(r, 250)); }  // let the flash erase fully settle before streaming
        const pct = Math.floor((v + 1) / S * 100);
        $('#lcdProg').value = pct; setOverlay(pct);
      }
      D({ ev: 'complete' });
      setOverlay(100, 'Upload complete ✓', 'your GIF is now on the keyboard screen');
      log('✓ upload complete — check the screen!', 'ok');
      await new Promise(r => setTimeout(r, 900));
    } catch (err) {
      result = 'FAILED: ' + err.message; D({ ev: 'FAIL', err: err.message });
      setOverlay(null, 'Upload failed', 'if the screen is frozen, replug → wait → reconnect → retry');
      log('✗ upload failed: ' + err.message + ' — click "📋 Copy last upload report" and paste it to me. If the screen is frozen, replug → wait → reconnect → retry.', 'err');
      await new Promise(r => setTimeout(r, 1400));
    }
    finally {
      lastReport = buildReport(diag, { result, device: scrDev && scrDev.productName, reportId: scrId, reportLen: scrLen });
      hideOverlay();
      scrDev.removeEventListener('inputreport', onInput);
      uploading = false;
      $('#lcdUpload').disabled = !scrDev;
      $('#lcdFile').disabled = false;
      tickPreview();   // resume the on-page preview animation
      try { window.__lcdHost && window.__lcdHost.resumeLighting && window.__lcdHost.resumeLighting(); } catch (_) { }   // restore key lighting after the upload
    }
  }

  // ---------------------------------------------------------------------------
  // clock-sync (cmd 0x34) via the control handle
  // ---------------------------------------------------------------------------
  // send a control packet on a given interface and resolve on its 0x55 <cmd> ACK (one-shot listener)
  function sendAwaitAck(dev, repId, pkt, ackCmd, ms) {
    if (ms === undefined) ms = 3000;
    return new Promise((resolve, reject) => {
      let done = false;
      const on = e => { const b = new Uint8Array(e.data.buffer); if (b[0] === 0x55 && b[1] === ackCmd && !done) { done = true; cleanup(); resolve(b); } };
      function cleanup() { clearTimeout(to); dev.removeEventListener('inputreport', on); }
      const to = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('ACK timeout')); } }, ms);
      dev.addEventListener('inputreport', on);
      dev.sendReport(repId, pkt).catch(err => { if (!done) { done = true; cleanup(); reject(err); } });
    });
  }
  // clock: set the keyboard's built-in clock to PC time (cmd 0x34, captured from official "Time Correction")
  function buildTimePkt(d, len) {
    const pkt = new Uint8Array(len || 64);
    pkt[0] = 0xAA; pkt[1] = 0x34; pkt[2] = 0x38; pkt[6] = 0x01;                       // prefix, cmd=set-time, payloadLen=56, isLast=1
    pkt[8] = 0x5A; pkt[9] = 0x01; pkt[10] = 0x5A;                                     // fixed preamble
    pkt[11] = (d.getFullYear() - 2000) & 0xFF; pkt[12] = d.getMonth() + 1; pkt[13] = d.getDate();
    pkt[14] = d.getHours(); pkt[15] = d.getMinutes(); pkt[16] = d.getSeconds();       // plain-binary y/m/d h:m:s (always 24h)
    pkt[17] = d.getDay();                                                             // day-of-week 0=Sun..6=Sat
    return pkt;
  }
  async function syncClock() {
    if (uploading) { log('⚠ wait for the upload to finish before syncing the clock.', 'err'); return; }
    if (!ctlDev) { log('✗ clock: no control interface available — connect on the main page first.', 'err'); return; }
    const d = new Date(), ts = d.toLocaleString(), pkt = buildTimePkt(d, ctlLen);
    log('clock → ' + hex(pkt.slice(0, 17)) + '… (' + ts + ')', 'dim');
    try { await sendAwaitAck(ctlDev, ctlId, pkt, 0x34); log('✓ clock synced to ' + ts + ' — view it with FN+knob → scroll right → click.', 'ok'); }
    catch (e) { log('✗ clock sync: ' + e.message, 'err'); }
  }

  // ---------------------------------------------------------------------------
  // bar-color swatch visibility
  // ---------------------------------------------------------------------------
  function updateBarColorVis() { $('#lcdBarColor').style.display = (barFill() === 'color') ? '' : 'none'; }

  // ---------------------------------------------------------------------------
  // wire all handlers (container-scoped)
  // ---------------------------------------------------------------------------
  let clockTimer = null;

  function wire() {
    cv = $('#lcdPreview'); ctx = cv.getContext('2d');
    actx = $('#lcdPreviewActual').getContext('2d');
    off = document.createElement('canvas'); off.width = 160; off.height = 96;
    octx = off.getContext('2d', { willReadFrequently: true });

    // ---- file picker ----
    $('#lcdFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) { currentFile = f; cropResetState(); processFile(f).then(cropPush); } });

    // ---- URL / clipboard / library loaders (all route through processFile) ----
    $('#lcdUrlLoad').addEventListener('click', () => loadFromUrl($('#lcdUrl').value.trim()));
    $('#lcdUrl').addEventListener('keydown', e => { if (e.key === 'Enter') loadFromUrl(e.target.value.trim()); });
    $('#lcdPaste').addEventListener('click', async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) { const ty = it.types.find(t => t.startsWith('image/')); if (ty) return loadBlob(await it.getType(ty), 'pasted-image'); }
        log('no image on the clipboard', 'dim');
      } catch (e) { log('clipboard read failed: ' + e.message + ' — copy the image again, or just press Ctrl+V on the page', 'err'); }
    });
    pasteHandler = e => {
      if (!shown) return;                 // ignore paste unless the LCD overlay is open (don't hijack the host page)
      const items = e.clipboardData && e.clipboardData.items; if (!items) return;
      for (const it of items) { if (it.type && it.type.startsWith('image/')) { const b = it.getAsFile(); if (b) { e.preventDefault(); loadBlob(b, 'pasted-image'); return; } } }
    };
    window.addEventListener('paste', pasteHandler);
    $('#lcdLibBtn').addEventListener('click', () => { const lib = $('#lcdLib'); lib.style.display = lib.style.display === 'none' ? 'block' : 'none'; refreshLib(); });
    $('#lcdSave').addEventListener('click', async () => {   // save the loaded image to the shared media library (parity with the GIF→keyboard panel)
      if (!currentFile) { log('load an image first', 'dim'); return; }
      if (!(window.TH108Media && TH108Media.available)) { log('library unavailable — serve via http://localhost (not file://)', 'err'); return; }
      try { await TH108Media.add(currentFile, (currentFile && currentFile.name) || 'lcd-image'); log('added to library', 'ok'); refreshLib(); }
      catch (e) { log('add to library failed: ' + e.message, 'err'); }
    });

    // ---- crop reposition / scale, undo·redo·reset ----
    $('#lcdCropUndo').addEventListener('click', () => { if (cropHi > 0) { cropHi--; cropApplySnap(cropHist[cropHi]); cropBtns(); } });
    $('#lcdCropRedo').addEventListener('click', () => { if (cropHi < cropHist.length - 1) { cropHi++; cropApplySnap(cropHist[cropHi]); cropBtns(); } });
    $('#lcdCropReset').addEventListener('click', () => { czoom = 1; cpanX = 0; cpanY = 0; $('#lcdCropZoom').value = 100; drawCropGuide(); if (currentFile) processFile(currentFile); cropPush(); });
    // zoom slider: live guide on input, commit (re-process + history) on release
    $('#lcdCropZoom').addEventListener('input', () => { czoom = (+$('#lcdCropZoom').value) / 100; drawCropGuide(); });
    $('#lcdCropZoom').addEventListener('change', () => { czoom = (+$('#lcdCropZoom').value) / 100; drawCropGuide(); if (currentFile) processFile(currentFile); cropPush(); });
    // drag the crop guide to reposition (Crop mode only)
    (function () {
      const cg = $('#lcdCropGuide'); let drag = null;
      cg.addEventListener('mousedown', e => { if (isFit() || !srcCanvas) return; const s = cg.width / srcW; drag = { mx: e.clientX, my: e.clientY, px: cpanX, py: cpanY, s }; e.preventDefault(); });
      cropMove = e => { if (!drag) return; cpanX = drag.px + (e.clientX - drag.mx) / drag.s; cpanY = drag.py + (e.clientY - drag.my) / drag.s; drawCropGuide(); };
      cropUp = () => { if (!drag) return; drag = null; if (currentFile) processFile(currentFile); cropPush(); };
      window.addEventListener('mousemove', cropMove);
      window.addEventListener('mouseup', cropUp);
    })();
    // toggling Crop/Fit re-processes the loaded GIF with the new mode
    el.querySelectorAll('input[name=lcdFit]').forEach(r => r.addEventListener('change', () => { if (currentFile) processFile(currentFile); }));
    // bar fill visibility + reprocess
    updateBarColorVis();
    $('#lcdBarFill').addEventListener('change', () => { updateBarColorVis(); if (currentFile) processFile(currentFile); });
    // debounce the color picker so dragging it doesn't re-decode every frame
    $('#lcdBarColor').addEventListener('input', () => { clearTimeout(barColorT); barColorT = setTimeout(() => { if (currentFile) processFile(currentFile); }, 150); });

    // ---- color calibration wiring ----
    const hadCal = loadCal();
    CAL_KEYS.forEach(key => {
      const e = calEl(key), num = numEl(key);
      if (isGammaId(key)) { num.min = (+e.min / 100).toFixed(2); num.max = (+e.max / 100).toFixed(2); num.step = '0.01'; }
      else { num.min = e.min; num.max = e.max; num.step = '1'; }
      e.addEventListener('input', () => { syncNum(key); applyColor(); saveCal(); });
      e.addEventListener('change', pushHistory);   // commit a history step on release
      num.addEventListener('input', () => {
        // allow partial typing (e.g. "1" on the way to "100") — move the slider but DON'T rewrite the field
        if (num.value === '' || num.value === '-' || num.value.endsWith('.')) return;
        const raw = isGammaId(key) ? Math.round(parseFloat(num.value) * 100) : Math.round(parseFloat(num.value));
        if (isNaN(raw)) return;
        e.value = Math.max(+e.min, Math.min(+e.max, raw));
        applyColor(); saveCal();
      });
      num.addEventListener('change', () => { syncNum(key); applyColor(); saveCal(); pushHistory(); });  // normalize on blur/Enter
      syncNum(key);
    });
    // per-param reset (↺) — data-id carries the prefixed id; strip the `lcd` prefix to the logical key
    el.querySelectorAll('button.rst').forEach(btn => btn.addEventListener('click', () => {
      const key = btn.dataset.id.replace(/^lcd/, '');
      setParam(key, defaultOf(key)); pushHistory();
    }));
    $('#lcdResetColor').addEventListener('click', () => {
      CAL_KEYS.forEach(key => setParam(key, defaultOf(key), false)); applyColor(); saveCal(); pushHistory();
    });
    $('#lcdUndo').addEventListener('click', () => { if (hi > 0) { hi--; applySnap(hist[hi]); updateHistButtons(); } });
    $('#lcdRedo').addEventListener('click', () => { if (hi < hist.length - 1) { hi++; applySnap(hist[hi]); updateHistButtons(); } });
    keyHandler = e => {
      if (!shown) return;                 // only handle Ctrl+Z/Y while the LCD overlay is open
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('#lcdUndo').click(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); $('#lcdRedo').click(); }
    };
    window.addEventListener('keydown', keyHandler);
    pushHistory();   // initial state
    $('#lcdCalStatus').textContent = hadCal ? '· loaded saved calibration' : '· baked-in default calibration';

    // ---- upload / clock / report ----
    $('#lcdUpload').addEventListener('click', upload);
    $('#lcdSyncClock').addEventListener('click', syncClock);
    $('#lcdCopyReport').addEventListener('click', () => {
      if (!lastReport) { log('no upload report yet — run an upload first', 'dim'); return; }
      navigator.clipboard.writeText(lastReport)
        .then(() => log('📋 upload report copied to clipboard', 'ok'))
        .catch(() => { log('clipboard blocked — report dumped below:', 'dim'); lastReport.split('\n').forEach(l => log(l, 'dim')); });
    });

    clockTimer = setInterval(() => { const e = $('#lcdClockNow'); if (e) e.textContent = 'PC time: ' + new Date().toLocaleTimeString(); }, 250);
  }

  // window-level listeners we attach in wire() (tracked so they could be detached if ever needed)
  let pasteHandler = null, cropMove = null, cropUp = null, keyHandler = null;

  // library picker (th108-media-lib.js) — mount on demand
  function refreshLib() {
    const lib = $('#lcdLib'); if (!lib || lib.style.display === 'none') return;
    if (window.TH108Media && TH108Media.available) {
      TH108Media.mountPicker(lib, it => {
        if (it.kind === 'seq' && it.blobs && it.blobs.length) loadBlob(it.blobs[0], it.name);
        else if (it.blob) loadBlob(it.blob, it.name);
      });
    } else {
      lib.textContent = 'library unavailable — open via http://localhost:8123 (not file://)';
    }
  }

  // load by URL (CORS-permitting)
  async function loadFromUrl(url) {
    if (!url) return;
    log('fetching ' + url + '…', 'dim');
    try {
      const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob(); if (!/^image\//.test(blob.type)) throw new Error('not an image (' + (blob.type || 'unknown type') + ')');
      loadBlob(blob, (url.split('/').pop() || 'url-image').split('?')[0]);
    } catch (e) { log('URL load failed: ' + e.message + ' — the host may block cross-origin fetch (CORS)', 'err'); }
  }

  // ---------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------
  function mount(container) {
    el = container;
    container.innerHTML = LCD_HTML;   // the screen-tool markup, MINUS the 0x51 slot button
    wire();                           // attach handlers via $()
    setDevices({});                   // start disabled until the controller hands over the handles
  }

  function setDevices(d) {
    d = d || {};
    scrDev = d.screen || null; scrId = d.screenReportId || 0; scrLen = d.screenLen || (scrDev ? 4104 : 0);
    ctlDev = d.control || null; ctlId = d.controlReportId || 0; ctlLen = d.controlLen || (ctlDev ? 64 : 0);
    const up = $('#lcdUpload'), sc = $('#lcdSyncClock'), st = $('#lcdDevNote');
    if (up) up.disabled = !scrDev;
    if (sc) sc.disabled = !ctlDev;
    if (st) st.textContent = scrDev ? (ctlDev ? 'screen + control bound' : 'screen bound (clock needs the control interface)')
      : 'not connected — connect on the main page first';
  }

  let shown = false;                      // true while the overlay is open — gates the window-level paste/keydown handlers
  function onShow() { shown = true; startPreview(); }   // start preview only if frames are loaded (startPreview guards on frames.length)
  function onHide() { shown = false; stopPreview(); }

  root.TH108LCD = { mount, setDevices, onShow, onHide };
})(window);
