/* th108-onboard.js — onboard (firmware) effects panel for the TH108 controller (module #5 of the controller decomposition).
   Builds and sends the single cmd-0x23 16-byte allledPack (a PERSISTENT flash write — set-once, never per-frame),
   then quietly cycles the HID handle: a live 0x23 can leave the board ACKing-but-IGNORING 0x32 paint, and only a
   close+reopen clears it (see th108-lighting-protocol memory). Extracted unchanged from th108-controller.html's
   inline script. UMD so the pure packer (packAllled) is unit-testable under node --test.

   Usage: const OB = TH108Onboard.create({hid, log, attachHex, hexToRgb, panel,
            isRunning, stopLayers, startLayers, gifPlaying, stopGif, setObActive});
   The module owns the #ob* DOM subtree; the transport instance, layer/GIF loop control, and the page's
   obActive flag arrive via opts. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108Onboard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 16-byte allledPack for cmd 0x23 — [0]=effect, [1..3]=primary RGB, [4]=255, [5..7]=secondary RGB,
  // [8]=colorful flag (0=solid), [9]=brightness 1..6, [10]=speed 1..6, [11..15]=0. Hardware-confirmed layout.
  function packAllled(p) {
    const clamp=v=>Math.max(1,Math.min(6,Math.round(v||1)));
    const a=new Uint8Array(16);
    a[0]=p.effect;
    a[1]=p.primary[0]; a[2]=p.primary[1]; a[3]=p.primary[2];
    a[4]=255;
    a[5]=p.secondary[0]; a[6]=p.secondary[1]; a[7]=p.secondary[2];
    a[8]=p.colorful?1:0;
    a[9]=clamp(p.brightness);
    a[10]=clamp(p.speed);
    // bytes 11..15 stay 0
    return a;
  }

  function create(opts) {
    opts = opts || {};
    const noop = function () {};
    const hid = opts.hid, log = opts.log || noop, hexToRgb = opts.hexToRgb,
          attachHex = opts.attachHex || noop, panel = opts.panel,
          isRunning = opts.isRunning || (() => false),
          stopLayers = opts.stopLayers || (async () => {}), startLayers = opts.startLayers || noop,
          gifPlaying = opts.gifPlaying || (() => false), stopGif = opts.stopGif || (async () => {}),
          setObActive = opts.setObActive || noop;

    attachHex(panel);   // typeable hex box on the primary/secondary pickers
    (function(){
      const bri=document.getElementById('obBri'), briV=document.getElementById('obBriV');
      const spd=document.getElementById('obSpeed'), spdV=document.getElementById('obSpeedV');
      bri.addEventListener('input',()=>briV.textContent=bri.value);
      spd.addEventListener('input',()=>spdV.textContent=spd.value);
    })();
    function obSetStatus(s,c=''){ const e=document.getElementById('obStatus'); e.textContent=s; e.className='hint '+c; e.style.margin='0'; }
    async function applyOnboard(){
      if(!hid.device){ log('connect first','err'); obSetStatus('connect first','err'); return; }
      if(isRunning()) await stopLayers();       // firmware effect replaces the live host stream
      if(gifPlaying()) await stopGif();
      const clamp=v=>Math.max(1,Math.min(6,Math.round(v||1)));
      const eff=+document.getElementById('obEffect').value;
      const colorful=document.getElementById('obColorful').checked;
      const bright=clamp(+document.getElementById('obBri').value);
      const speed=clamp(+document.getElementById('obSpeed').value);
      const allled=packAllled({ effect:eff,
        primary:hexToRgb(document.getElementById('obPrimary').value),
        secondary:hexToRgb(document.getElementById('obSecondary').value),
        colorful, brightness:bright, speed });
      try{
        await hid.device.sendReport(hid.reportId, hid.buildPkt(0x23, 16, 0, allled, 0, true));
        const lbl=document.getElementById('obEffect').selectedOptions[0].textContent;
        log('onboard effect applied: '+lbl+(colorful?' (colorful)':' (solid)')+' · bri '+bright+' · spd '+speed,'ok');
        obSetStatus('effect set — runs on the keyboard','ok');
        setObActive();   // a pattern click can now auto-resume layers over this
        // Re-arm: a live 0x23 write can leave the board ACKing-but-IGNORING 0x32 paint, and only a handle
        // close+reopen clears it (stream restarts don't). Re-bind quietly so "back to layers" paints first try.
        await new Promise(r=>setTimeout(r,350));   // let the 0x23 ACK land before cycling the handle
        if(await hid.rebind()) log('control interface re-bound (post-effect re-arm)','dim');
        else log('post-effect re-bind failed — if layers don\'t paint, refresh the page','err');
      }catch(e){ log('onboard apply failed: '+e.message,'err'); obSetStatus('apply failed','err'); }
    }
    document.getElementById('obApply').addEventListener('click',applyOnboard);
    document.getElementById('obBack').addEventListener('click',()=>{ if(!hid.device){ log('connect first','err'); return; } if(!isRunning()) startLayers(); else log('layers already running — they override the firmware effect','dim'); });   // resume host layers over the firmware effect

    return { apply: applyOnboard };
  }

  return { create, packAllled };
});
