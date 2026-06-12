/* th108-daemon-client.js — the controller page's client for the background daemon's control API
   (same-origin localhost:8123: /status /yield /resume /heartbeat /config /autostart /quit).
   Owns the page side of the auto-yield handshake — the `present` flag, the Web-Worker heartbeat
   (main-thread timers throttle to 1/min in hidden tabs, which used to starve the daemon's watchdog
   into re-grabbing a device the page still owned), and the Background-daemon panel wiring.
   Extracted unchanged from th108-controller.html. Browser-only IIFE (window.TH108DaemonClient);
   with no daemon present every call is a no-op and the page behaves as a plain WebHID controller.

   Usage: const DC = TH108DaemonClient.create({log, getConfig});
     DC.ping() → refresh `present` · DC.yieldDevice()/DC.resume() → device handoff ·
     DC.heartbeatStart()/DC.heartbeatStop() → proof-of-life while the page holds the device ·
     DC.pushConfig() → mirror layer edits to the daemon's config.json · DC.mountPanel() → wire
     the #daemonPanel controls · DC.present / DC.beating → state getters. */
window.TH108DaemonClient = (function () {
  'use strict';
  function create(opts) {
    opts = opts || {};
    const log = opts.log || function () {};
    const getConfig = opts.getConfig || function () { return '[]'; };
    const D = { present: false, hb: null, yielded: false };

    const hbW = (() => { try { return new Worker(URL.createObjectURL(new Blob(['let t=null;onmessage=e=>{clearInterval(t);t=null;if(e.data&&e.data.ms)t=setInterval(()=>postMessage(1),e.data.ms);};'], { type: 'text/javascript' }))); } catch (_) { return null; } })();
    const beat = () => { if (navigator.sendBeacon) navigator.sendBeacon('/heartbeat'); else fetch('/heartbeat', { method: 'POST' }); };
    if (hbW) hbW.onmessage = beat;

    async function ping() {
      if (!/^https?:$/.test(location.protocol)) { D.present = false; return; }   // file:// page → no daemon server to talk to; skip (avoids a console CORS error)
      try { const r = await fetch('/status', { cache: 'no-store' }); D.present = r.ok; } catch (_) { D.present = false; }
    }
    async function yieldDevice() { if (D.present) { try { await fetch('/yield', { method: 'POST' }); D.yielded = true; } catch (_) {} } }
    function heartbeatStart() {
      if (!D.present || D.hb) return;
      beat();                                                       // first beat NOW — the yield→bind gap (device picker open) must be covered too
      if (hbW) { D.hb = true; hbW.postMessage({ ms: 3000 }); } else D.hb = setInterval(beat, 3000);
    }
    function heartbeatStop() { if (hbW) hbW.postMessage({}); if (D.hb && D.hb !== true) clearInterval(D.hb); D.hb = null; }
    function pushConfig() { if (D.present) { try { fetch('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: getConfig() }); } catch (_) {} } }
    // last-resort wedge recovery: ask the daemon to PnP-restart the keyboard's USB node (the page
    // itself can't run schtasks). The daemon enforces a cooldown and the usbReset setting.
    async function usbFix() {
      if (!D.present) return { fired: false, reason: 'no daemon' };
      try { const r = await fetch('/usbfix', { method: 'POST' }); return await r.json(); }
      catch (_) { return { fired: false, reason: 'daemon unreachable' }; }
    }
    // resume is a no-op unless THIS page yielded: /resume is unattributed on the wire, so a page
    // that never took the device (a second tab, an automated test browser) telling the daemon
    // "the page released the device" made it reclaim WHILE the real owner tab was still streaming —
    // two writers → board mute → USB-restart escalation → onboard-rainbow fallback (2026-06-11 logs).
    function resume() {
      if (!D.yielded) return;
      D.yielded = false;
      if (D.present) { if (navigator.sendBeacon) navigator.sendBeacon('/resume'); else fetch('/resume', { method: 'POST', keepalive: true }); }
    }

    // Background-daemon panel: status readout, auto-start toggle (HKCU Run key via the daemon),
    // auto-USB-restart wedge-fix toggle (daemon settings.json via /usbreset), quit.
    function mountPanel() {
      const st = document.getElementById('dmnStatus'), auto = document.getElementById('dmnAuto'), quit = document.getElementById('dmnQuit');
      const usb = document.getElementById('dmnUsbFix');
      const np = document.getElementById('lcdNowPlaying');   // lives on the LCD tab, rides the same /status poll
      if (!st || !auto || !quit) return;
      let alive = false;
      async function refresh() {
        try {
          const r = await fetch('/status', { cache: 'no-store' }); if (!r.ok) throw 0;
          const s = await r.json(); alive = true;
          st.textContent = 'daemon: running · ' + (s.paused ? 'yielded to this page' : (s.deviceConnected ? 'driving the keyboard — layer edits here apply LIVE, no Connect needed' : 'waiting for the keyboard'));
          auto.disabled = false; quit.disabled = false;
          // state rides /status; don't fight a click in progress. A daemon built before this setting
          // doesn't report the field — show the toggle disabled (it would 404) instead of a false "off".
          if (usb) {
            const knows = 'usbReset' in s;
            usb.disabled = !knows;
            usb.title = knows ? '' : 'the running daemon predates this setting — restart it (Quit, then setup.cmd or next login) to enable';
            if (knows && document.activeElement !== usb) usb.checked = !!s.usbReset;
          }
          if (np) {
            const knowsNp = 'nowPlaying' in s;
            np.disabled = !knowsNp;
            if (!knowsNp) np.parentElement.title = 'the running daemon predates this setting — restart it (Quit, then the tray) to enable';
            if (knowsNp && document.activeElement !== np) np.checked = !!s.nowPlaying;
            const stEl = document.getElementById('npState'), trEl = document.getElementById('npTrack');
            if (stEl) stEl.textContent = !knowsNp ? 'daemon needs a restart' : (s.nowPlaying ? 'on' : 'off');
            if (trEl) trEl.textContent = !s.nowPlaying ? '' :
              (s.npTrack ? 'Showing: ' + s.npTrack.title + ' — ' + s.npTrack.artist + (s.npTrack.status === 'paused' ? '  ⏸' : '')
                         : (s.npQueued && s.paused ? 'queued — waiting for this page to release the keyboard' : 'waiting for music…'));
            for (const [id, key] of [['npTitleColor', 'npTitle'], ['npArtistColor', 'npArtist']]) {
              const el = document.getElementById(id);
              if (el) { el.disabled = !(key in s); if (key in s && document.activeElement !== el) el.value = s[key]; }
            }
          }
        } catch (_) { alive = false; st.textContent = 'daemon: not running — start it with setup.cmd (lighting then survives closing this tab)'; auto.disabled = true; quit.disabled = true; if (usb) usb.disabled = true; if (np) np.disabled = true; }
      }
      async function refreshAuto() { if (!alive) return; try { const r = await fetch('/autostart', { cache: 'no-store' }); auto.checked = !!(await r.json()).enabled; } catch (_) {} }
      auto.addEventListener('change', async () => {
        try {
          await fetch('/autostart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: auto.checked }) });
          log('daemon auto-start on login ' + (auto.checked ? 'enabled' : 'disabled'), 'ok');
        } catch (_) { log('auto-start toggle failed', 'err'); refreshAuto(); }
      });
      if (usb) usb.addEventListener('change', async () => {
        try {
          await fetch('/usbreset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: usb.checked }) });
          log('auto USB-restart wedge fix ' + (usb.checked ? 'enabled' : 'disabled'), 'ok');
        } catch (_) { log('USB-restart toggle failed', 'err'); refresh(); }
      });
      if (np) np.addEventListener('change', async () => {
        try {
          await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: np.checked }) });
          log('♪ now-playing on the LCD ' + (np.checked ? 'enabled — the daemon shows the current song (overwrites the LCD GIF while on)' : 'disabled — the LCD keeps its last image'), 'ok');
        } catch (_) { log('now-playing toggle failed', 'err'); refresh(); }
      });
      for (const [id, key] of [['npTitleColor', 'titleColor'], ['npArtistColor', 'artistColor']]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', async () => {   // 'change' = picker closed — one flash re-paint per pick, not per drag
          try {
            await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: el.value }) });
            log('♪ now-playing ' + (key === 'titleColor' ? 'title' : 'artist') + ' color → ' + el.value + ' (the current song re-paints)', 'ok');
          } catch (_) { log('color change failed', 'err'); }
        });
      }
      quit.addEventListener('click', async () => {
        if (!confirm('Quit the background daemon?\n\nAlways-on lighting and reactive-anywhere stop until setup.cmd or your next login starts it again. This page keeps working as-is.')) return;
        try { await fetch('/quit', { method: 'POST' }); log('daemon quit', 'dim'); } catch (_) {}
        setTimeout(refresh, 600);
      });
      if (/^https?:$/.test(location.protocol)) { refresh().then(refreshAuto); setInterval(() => refresh(), 5000); }   // display-only poll; tab-throttling is fine
      else { st.textContent = 'daemon: unavailable on file:// — open via http://localhost:8123'; auto.disabled = true; quit.disabled = true; }
    }

    return {
      ping, yieldDevice, heartbeatStart, heartbeatStop, pushConfig, resume, mountPanel, usbFix,
      get present() { return D.present; },
      get beating() { return !!D.hb; }
    };
  }
  return { create };
})();
