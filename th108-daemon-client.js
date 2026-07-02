/* th108-daemon-client.js — the controller page's client for the background daemon's control API
   (same-origin localhost:8123: /status /claim /release /yield /resume /heartbeat /config /autostart /quit).
   Owns the page side of the device LEASE handshake — a per-page `clientId`, the `present` flag, the
   Web-Worker heartbeat (main-thread timers throttle to 1/min in hidden tabs, which used to starve the
   daemon's watchdog into re-grabbing a device the page still owned), lease-loss detection off the
   /status poll, and the Background-daemon panel wiring.
   Extracted unchanged from th108-controller.html. Browser-only IIFE (window.TH108DaemonClient);
   with no daemon present every call is a no-op and the page behaves as a plain WebHID controller.

   Usage: const DC = TH108DaemonClient.create({log, getConfig});
     DC.ping() → refresh `present` · DC.claim()/DC.release() → device lease (newest-wins; resolves
     {granted}, falls back to the legacy /yield for a daemon predating /claim) — yieldDevice()/resume()
     remain as aliases for existing callers · DC.clientId → this page's lease id ·
     DC.onLeaseLost(cb) → cb fires once this page held the lease and then lost it (another controller
     won it) · DC.reclaim() → alias for claim(), i.e. "take control back" ·
     DC.heartbeatStart()/DC.heartbeatStop() → proof-of-life while the page holds the device ·
     DC.pushConfig() → mirror layer edits to the daemon's config.json · DC.mountPanel() → wire
     the #daemonPanel controls · DC.present / DC.beating → state getters.
     window.DC is also set to the created client (once) so other same-page scripts — e.g. th108-hid.js's
     claim-before-open gate, or a Task-5 banner — can reach it without an explicit wire-up. */
window.TH108DaemonClient = (function () {
  'use strict';
  function create(opts) {
    opts = opts || {};
    const log = opts.log || function () {};
    const getConfig = opts.getConfig || function () { return '[]'; };
    const D = { present: false, hb: null, yielded: false, deviceConnected: false, paused: false, _owned: false };
    // Stable per-page-load id so the daemon can tell "this page" apart from another tab or a fresh
    // reload — the lease is granted/tracked per clientId, newest claim wins.
    const clientId = 'pg-' + Math.random().toString(36).slice(2) + '-' + (performance.now() | 0);

    const hbW = (() => { try { return new Worker(URL.createObjectURL(new Blob(['let t=null;onmessage=e=>{clearInterval(t);t=null;if(e.data&&e.data.ms)t=setInterval(()=>postMessage(1),e.data.ms);};'], { type: 'text/javascript' }))); } catch (_) { return null; } })();
    // beats use fetch (not sendBeacon) so the RESPONSE is readable: it carries npWants — the
    // daemon's "a song is waiting for the LCD" flag, answered by the page granting an upload
    // window (pause stream → /npgo → resume) without any device handoff. clientId rides along so
    // the daemon can tie this heartbeat to a lease (the heartbeat IS the lease liveness signal).
    const beat = () => {
      fetch('/heartbeat', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) })
        .then(r => r.json())
        .then(j => { if (j && j.npWants && opts.onNpWants) opts.onNpWants(); })
        .catch(() => {});
    };
    if (hbW) hbW.onmessage = beat;

    let _leaseCb = null;   // fires once this page held the lease and then lost it — see noteLease()
    // Track leaseOwner off any /status read (the ping() one-off and the 2.5s mountPanel poll both call
    // this) and fire the registered onLeaseLost callback the instant ownership moves away from us —
    // this is what lets the page close its WebHID handle before the new owner opens (no two-writer mute).
    function noteLease(s) {
      if (s && s.leaseOwner !== undefined) {
        const wasMine = D._owned;
        D._owned = (s.leaseOwner === clientId);
        if (wasMine && !D._owned && _leaseCb) _leaseCb();
      }
    }
    async function ping() {
      if (!/^https?:$/.test(location.protocol)) { D.present = false; return; }   // file:// page → no daemon server to talk to; skip (avoids a console CORS error)
      try { const r = await fetch('/status', { cache: 'no-store' }); D.present = r.ok;
        if (r.ok) { try { const s = await r.json(); D.deviceConnected = !!s.deviceConnected; D.paused = !!s.paused; noteLease(s); } catch (_) {} }
        else { D.deviceConnected = false; }
      } catch (_) { D.present = false; D.deviceConnected = false; }
    }
    // BUFFERED HANDOFF (2026-06-13): a wedged/flapping board makes the HID layer fire reconnect
    // events in a tight loop, each calling claim — bursts of 5+/sec stormed the daemon (2149 /yield in
    // one session) → two-writer churn → board MUTE → onboard rainbow. Coalesce concurrent calls onto
    // ONE in-flight request so the handoff can't storm no matter how hard the caller loops.
    // Claim the device from the daemon/other tab (newest-wins). Resolves { granted } — the caller opens
    // WebHID only when granted. Replaces the old fire-and-forget /yield (kept as a fallback for a
    // daemon predating /claim, so an old daemon still hands off even though it can't do a real lease).
    let _claimInflight = null;
    async function claim() {
      if (!D.present) { D._owned = true; return { granted: true }; }   // no daemon to contend the lease with — plain WebHID controller, same as always
      if (_claimInflight) return _claimInflight;
      _claimInflight = (async () => {
        try {
          const r = await fetch('/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) });
          if (r.ok) { const j = await r.json(); D.yielded = !!j.granted; D._owned = !!j.granted; return { granted: !!j.granted }; }
        } catch (_) {}
        // daemon too old for /claim (404/network) → fall back to the legacy yield so an old daemon still hands off
        try { await fetch('/yield', { method: 'POST' }); D.yielded = true; D._owned = true; return { granted: true }; } catch (_) { D._owned = false; return { granted: false }; }
      })().finally(() => { _claimInflight = null; });
      return _claimInflight;
    }
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
    // release is a no-op unless THIS page held the lease: an unattributed release would let a page
    // that never took the device (a second tab, an automated test browser) tell the daemon "the page
    // released the device" and make it reclaim WHILE the real owner tab was still streaming —
    // two writers → board mute → USB-restart escalation → onboard-rainbow fallback (2026-06-11 logs).
    // clientId now identifies the releasing page explicitly (belt-and-suspenders with the D.yielded gate).
    function release() {
      if (!D.yielded) return;
      D.yielded = false;
      if (!D.present) return;
      const body = JSON.stringify({ clientId });
      if (navigator.sendBeacon) navigator.sendBeacon('/release', new Blob([body], { type: 'application/json' }));
      else fetch('/release', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body });
    }

    // Background-daemon panel: status readout, auto-start toggle (HKCU Run key via the daemon),
    // auto-USB-restart wedge-fix toggle (daemon settings.json via /usbreset), quit.
    function mountPanel() {
      const st = document.getElementById('dmnStatus'), auto = document.getElementById('dmnAuto'), quit = document.getElementById('dmnQuit');
      const restart = document.getElementById('dmnRestart');
      const usb = document.getElementById('dmnUsbFix');
      const disp = document.getElementById('dmnDispOff');
      const np = document.getElementById('lcdNowPlaying');   // lives on the LCD tab, rides the same /status poll
      if (!st || !auto || !quit) return;
      let alive = false;

      // friendly label for a source AUMID (Spotify.exe / SpotifyAB.SpotifyMusic… / Chrome / MSEdge / Brave…)
      function srcLabel(id) {
        if (/spotify/i.test(id)) return 'Spotify';
        if (/chrome/i.test(id)) return 'Chrome';
        if (/brave/i.test(id)) return 'Brave';
        if (/edge|msedge/i.test(id)) return 'Edge';
        if (/firefox/i.test(id)) return 'Firefox';
        if (/vlc/i.test(id)) return 'VLC';
        const m = String(id).split(/[!\\._]/).filter(Boolean); return m[0] || id || 'unknown';
      }
      // render the recognized-sources whitelist. SAFETY: only checked sources may drive the LCD.
      function renderSources(host, sources) {
        const sig = JSON.stringify(sources);
        if (host.dataset.sig === sig) return;   // no churn while unchanged (don't clobber a click)
        host.dataset.sig = sig;
        host.textContent = '';
        const h = document.createElement('p'); h.className = 'hint'; h.style.margin = '0 0 4px';
        h.textContent = sources.length ? 'Allowed media sources (only Spotify by default — uncheck to block X/browser tabs):' : 'No media sources seen yet — play something.';
        host.appendChild(h);
        sources.forEach(src => {
          const l = document.createElement('label'); l.className = 'sl'; l.style.cssText = 'margin:0;cursor:pointer;display:flex;align-items:center;gap:6px';
          const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!src.allowed;
          c.addEventListener('change', async () => {
            try { await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { id: src.id, allow: c.checked } }) });
              log('♪ media source ' + (c.checked ? 'allowed' : 'blocked') + ': ' + srcLabel(src.id), 'ok'); } catch (_) { log('source toggle failed', 'err'); }
          });
          const t = document.createElement('span'); t.textContent = srcLabel(src.id); t.title = src.id;
          l.appendChild(c); l.appendChild(t); host.appendChild(l);
        });
      }
      async function refresh() {
        try {
          const r = await fetch('/status', { cache: 'no-store' }); if (!r.ok) throw 0;
          const s = await r.json(); alive = true; noteLease(s);
          // bio-card grab-bar: show the real setup.cmd path (from the daemon) + the copy button
          const spTxt = document.getElementById('setupPathTxt'), spWrap = document.getElementById('setupPathWrap'), trTxt = document.getElementById('trayPathTxt');
          if (spTxt && spWrap && s.setupPath) { if (spTxt.textContent !== s.setupPath) spTxt.textContent = s.setupPath; spWrap.style.display = 'inline-flex'; }
          if (trTxt && s.setupPath) { const t = s.setupPath.replace(/setup\.cmd$/i, 'th108-daemon\\start-tray.vbs'); if (trTxt.textContent !== t) trTxt.textContent = t; }   // start-tray.vbs sits in th108-daemon/ next to setup.cmd
          st.textContent = 'daemon: running · ' + (s.paused ? 'yielded to this page' : (s.deviceConnected ? 'driving the keyboard — layer edits here apply LIVE, no Connect needed' : 'waiting for the keyboard'));
          auto.disabled = false; quit.disabled = false; if (restart) restart.disabled = false;
          // state rides /status; don't fight a click in progress. A daemon built before this setting
          // doesn't report the field — show the toggle disabled (it would 404) instead of a false "off".
          if (usb) {
            const knows = 'usbReset' in s;
            usb.disabled = !knows;
            usb.title = knows ? '' : 'the running daemon predates this setting — restart it (Quit, then setup.cmd or next login) to enable';
            if (knows && document.activeElement !== usb) usb.checked = !!s.usbReset;
          }
          if (disp) {
            const knows = 'dimOnDisplayOff' in s;
            disp.disabled = !knows;
            disp.title = knows ? '' : 'the running daemon predates this setting — restart it to enable';
            if (knows && document.activeElement !== disp) disp.checked = !!s.dimOnDisplayOff;
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
            const fitEl = document.getElementById('npArtFit');
            if (fitEl) { const knows = 'npArtFit' in s; fitEl.disabled = !knows; if (knows && document.activeElement !== fitEl) fitEl.value = s.npArtFit ? 'fit' : 'crop'; }
            // pause-revert: slider 1-15s + a "Never" checkbox. revertSec 0 = Never.
            const rv = document.getElementById('npRevert'), rvl = document.getElementById('npRevertLbl'),
                  rvNever = document.getElementById('npRevertNever'), rvReset = document.getElementById('npRevertReset'),
                  rvTick = document.getElementById('npRevertTick');
            if (rv && rvNever) {
              const knows = 'npRevertSec' in s;
              if (knows && document.activeElement !== rv && document.activeElement !== rvNever) {
                const sec = s.npRevertSec | 0;
                rvNever.checked = (sec === 0);
                if (sec >= 1) rv.value = Math.min(15, sec);   // keep slider showing the active value; 0 leaves it at its last position
              }
              const off = rvNever.checked;
              rv.disabled = !knows || off;
              if (rvReset) rvReset.disabled = !knows || off;
              rvNever.disabled = !knows;
              if (rvl) rvl.textContent = off ? 'never' : (+rv.value + 's') + (s.npHasGif === false ? ' · upload a GIF once' : '');
            }
            // recognized media sources (whitelist) — Spotify allowed by default, others off
            const srcHost = document.getElementById('npSources');
            if (srcHost && Array.isArray(s.npSources)) renderSources(srcHost, s.npSources);
            // song-progress light-bar (keys 1-0) — SAFE: lighting only, no LCD flash writes
            const bar = document.getElementById('npBar');
            if (bar) {
              const knowsBar = 'npBar' in s;
              bar.disabled = !knowsBar;
              if (!knowsBar) bar.parentElement.title = 'the running daemon predates this feature — restart it (Quit, then the tray) to enable';
              if (knowsBar && document.activeElement !== bar) bar.checked = !!s.npBar;
              const on = !!s.npBar;
              const bc = document.getElementById('npBarColor'), bb = document.getElementById('npBarBright'),
                    bbl = document.getElementById('npBarBrightLbl'), fl = document.getElementById('npFlash'),
                    fc = document.getElementById('npFlashColor');
              if (bc) { bc.disabled = !on; if ('npBarColor' in s && document.activeElement !== bc) bc.value = s.npBarColor; }
              if (bb) { bb.disabled = !on; if ('npBarBright' in s && document.activeElement !== bb) bb.value = s.npBarBright; }
              if (bbl && bb) bbl.textContent = (+bb.value) + '%';
              if (fl) { fl.disabled = !on; if ('npFlash' in s && document.activeElement !== fl) fl.checked = !!s.npFlash; }
              if (fc) { fc.disabled = !on || !(fl && fl.checked); if ('npFlashColor' in s && document.activeElement !== fc) fc.value = s.npFlashColor; }
              const idle = document.getElementById('npBarIdle'), idleLbl = document.getElementById('npBarIdleLbl');
              if (idle) { idle.disabled = !on; if ('npBarIdleSec' in s && document.activeElement !== idle) idle.value = s.npBarIdleSec; if (idleLbl) idleLbl.textContent = (+idle.value) + 's'; }
              const grad = document.getElementById('npBarGrad'), gfit = document.getElementById('npBarGradFit'), nkeys = document.getElementById('npBarKeys');
              if (grad) { grad.disabled = !on; if ('npBarGrad' in s && document.activeElement !== grad) grad.value = s.npBarGrad; }
              if (gfit) { gfit.disabled = !on; if ('npBarGradFit' in s && document.activeElement !== gfit) gfit.checked = !!s.npBarGradFit; }
              if (nkeys) { nkeys.disabled = !on; if ('npBarKeys' in s && document.activeElement !== nkeys) nkeys.value = s.npBarKeys; }
            }
            // Refresh-LCD debug button — only meaningful when LCD now-playing is on
            const rfb = document.getElementById('npRefreshLcd');
            if (rfb) rfb.disabled = !('nowPlaying' in s) || !s.nowPlaying;
            // onboard-mask toggle
            const maskEl = document.getElementById('npOnboardMask');
            if (maskEl) { const k = 'npOnboardMask' in s; maskEl.disabled = !k; if (k && document.activeElement !== maskEl) maskEl.checked = !!s.npOnboardMask; }
            // live-status feed — media transitions + LCD-sync outcomes (newest first)
            const feedWrap = document.getElementById('npFeedWrap'), feed = document.getElementById('npFeed');
            if (feed && feedWrap) {
              const lg = Array.isArray(s.npLog) ? s.npLog : [];
              if (lg.length && (s.nowPlaying || s.npBar)) {
                feedWrap.style.display = '';
                const now = Date.now();
                const ago = ms => { const sec = Math.max(0, Math.round(ms / 1000)); return sec < 3 ? 'just now' : sec < 60 ? sec + 's ago' : Math.round(sec / 60) + 'm ago'; };
                const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
                feed.innerHTML = lg.slice().reverse().map(e => '<div><span style="opacity:.55">' + ago(now - e.t) + '</span> · ' + esc(e.msg) + '</div>').join('');
              } else { feedWrap.style.display = 'none'; }
            }
          }
        } catch (_) { alive = false; st.textContent = 'daemon: not running — start it with setup.cmd (lighting then survives closing this tab)'; auto.disabled = true; quit.disabled = true; if (restart) restart.disabled = true; if (usb) usb.disabled = true; if (np) np.disabled = true; }
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
      if (disp) disp.addEventListener('change', async () => {
        try {
          await fetch('/displayoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: disp.checked }) });
          log('lights-off-when-monitor-off ' + (disp.checked ? 'enabled' : 'disabled'), 'ok');
        } catch (_) { log('monitor-off toggle failed', 'err'); refresh(); }
      });
      if (np) np.addEventListener('change', async () => {
        // BRICK WARNING: every media change writes the LCD FLASH (cmd 0x50). On this board a flash
        // write occasionally wedges the firmware — a softbrick that kills typing until a factory
        // reset (happened repeatedly 2026-06-12/13). So enabling is an explicit, warned opt-in.
        if (np.checked && !confirm('⚠ Enable now-playing on the LCD?\n\nThis writes the keyboard\'s LCD flash on each TRACK CHANGE (not on play/pause), waits 20s between writes, and caps at 30/hour — to minimize risk. But a flash write can still occasionally WEDGE the firmware (a softbrick that stops typing until you factory-reset on Epomaker\'s site).\n\nIt has bricked the keyboard before. Only enable if you can afford a possible factory reset. Continue?')) {
          np.checked = false; return;
        }
        try {
          const r = await (await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: np.checked }) })).json();
          if (np.checked) log('♪ now-playing on the LCD enabled — ⚠ writes the LCD flash on each song change (small brick risk)', 'err');
          else {   // turning off should revert to your GIF — say whether it could, and why not
            const rv = r && r.revert;
            if (rv && rv.skipped) log('♪ now-playing off — that GIF is already on the LCD, no reload needed', 'ok');
            else if (rv && rv.ok) log('♪ now-playing off — reverting the LCD to your GIF (the 33-frame reload takes a bit)', 'ok');
            else log('♪ now-playing off — couldn\'t revert to your GIF: ' + ((rv && rv.reason) || 'unknown') + '. It\'ll revert once the daemon owns the keyboard.', 'err');
          }
        } catch (_) { log('now-playing toggle failed', 'err'); refresh(); }
      });
      const rv = document.getElementById('npRevert'), rvl = document.getElementById('npRevertLbl'),
            rvNever = document.getElementById('npRevertNever'), rvReset = document.getElementById('npRevertReset'),
            rvTick = document.getElementById('npRevertTick');
      const postRevert = async (sec) => {
        try {
          await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revertSec: sec }) });
          log('♪ pause-revert: ' + (sec ? 'after ' + sec + 's paused, the LCD returns to your GIF' : 'never (the song stays on the LCD)'), 'ok');
        } catch (_) { log('pause-revert change failed', 'err'); }
      };
      const liveRevertLbl = () => { if (rvl) rvl.textContent = (rvNever && rvNever.checked) ? 'never' : (+rv.value + 's'); };   // tick stays at the static 3s default marker
      if (rv) {
        rv.addEventListener('input', liveRevertLbl);
        rv.addEventListener('change', () => { if (!rvNever.checked) postRevert(+rv.value); });
      }
      if (rvNever) rvNever.addEventListener('change', () => {
        rv.disabled = rvNever.checked; if (rvReset) rvReset.disabled = rvNever.checked;
        liveRevertLbl(); postRevert(rvNever.checked ? 0 : +rv.value);
      });
      if (rvReset) rvReset.addEventListener('click', () => { rv.value = 3; liveRevertLbl(); if (!rvNever.checked) postRevert(3); });
      for (const [id, key] of [['npTitleColor', 'titleColor'], ['npArtistColor', 'artistColor']]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', async () => {   // 'change' = picker closed — one flash re-paint per pick, not per drag
          try {
            await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: el.value }) });
            log('♪ now-playing ' + (key === 'titleColor' ? 'title' : 'artist') + ' color → ' + el.value + ' (the current song re-paints)', 'ok');
          } catch (_) { log('color change failed', 'err'); }
        });
      }
      const npFitEl = document.getElementById('npArtFit');
      if (npFitEl) npFitEl.addEventListener('change', async () => {
        try {
          await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artFit: npFitEl.value === 'fit' }) });
          log('♪ album art → ' + (npFitEl.value === 'fit' ? 'Fit (whole cover, letterboxed)' : 'Crop (fill + crop)') + ' (the current song re-paints)', 'ok');
        } catch (_) { log('album-art style change failed', 'err'); }
      });
      // song-progress light-bar (keys 1-0) — SAFE, lighting only; all of it rides /nowplaying {bar:{…}}
      const postBar = async (patch, msg) => {
        try { await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bar: patch }) }); if (msg) log(msg, 'ok'); }
        catch (_) { log('progress-bar change failed', 'err'); }
      };
      const npBarEl = document.getElementById('npBar'), npBarColorEl = document.getElementById('npBarColor'),
            npBarBrightEl = document.getElementById('npBarBright'), npBarBrightLblEl = document.getElementById('npBarBrightLbl'),
            npFlashEl = document.getElementById('npFlash'), npFlashColorEl = document.getElementById('npFlashColor');
      if (npBarEl) npBarEl.addEventListener('change', () => postBar({ on: npBarEl.checked }, '♪ song-progress bar (keys 1-0) ' + (npBarEl.checked ? 'on — lighting only, safe; needs the daemon running' : 'off')));
      if (npBarColorEl) {
        let _colAt = 0;
        npBarColorEl.addEventListener('input', () => {   // LIVE on the keyboard while dragging the picker (throttled ~10/s, no log per tick)
          const now = Date.now(); if (now - _colAt >= 100) { _colAt = now; postBar({ color: npBarColorEl.value }); }
        });
        npBarColorEl.addEventListener('change', () => postBar({ color: npBarColorEl.value }, '♪ progress-bar color → ' + npBarColorEl.value));   // final value + one log line on close
      }
      if (npBarBrightEl) {
        let _briAt = 0;
        npBarBrightEl.addEventListener('input', () => {
          if (npBarBrightLblEl) npBarBrightLblEl.textContent = (+npBarBrightEl.value) + '%';
          const now = Date.now();
          if (now - _briAt >= 100) { _briAt = now; postBar({ bright: +npBarBrightEl.value }); }   // LIVE on the keyboard (the bar is daemon-rendered), throttled ~10/s; no log per tick
        });
        npBarBrightEl.addEventListener('change', () => postBar({ bright: +npBarBrightEl.value }, '♪ progress-bar brightness → ' + npBarBrightEl.value + '%'));   // final value + one log line on release
      }
      if (npFlashEl) npFlashEl.addEventListener('change', () => postBar({ flash: npFlashEl.checked }, '♪ track-change flash ' + (npFlashEl.checked ? 'on' : 'off')));
      if (npFlashColorEl) npFlashColorEl.addEventListener('change', () => postBar({ flashColor: npFlashColorEl.value }, '♪ track-change flash color → ' + npFlashColorEl.value));
      const npGradEl = document.getElementById('npBarGrad'), npGradFitEl = document.getElementById('npBarGradFit'), npKeysEl = document.getElementById('npBarKeys');
      if (npGradEl) npGradEl.addEventListener('change', () => postBar({ grad: npGradEl.value }, '♪ progress-bar style → ' + npGradEl.options[npGradEl.selectedIndex].text));
      if (npGradFitEl) npGradFitEl.addEventListener('change', () => postBar({ gradFit: npGradFitEl.checked }, '♪ progress-bar gradient ' + (npGradFitEl.checked ? 'stretches to the filled part' : 'fixed across all keys')));
      if (npKeysEl) npKeysEl.addEventListener('change', () => postBar({ keys: npKeysEl.value }, '♪ progress-bar on the ' + npKeysEl.options[npKeysEl.selectedIndex].text));
      const npIdleEl = document.getElementById('npBarIdle'), npIdleLblEl = document.getElementById('npBarIdleLbl');
      if (npIdleEl) {
        npIdleEl.addEventListener('input', () => { if (npIdleLblEl) npIdleLblEl.textContent = (+npIdleEl.value) + 's'; });
        npIdleEl.addEventListener('change', () => postBar({ idleSec: +npIdleEl.value }, '♪ progress-bar fades out after ' + npIdleEl.value + 's idle'));
      }
      const npRefreshBtn = document.getElementById('npRefreshLcd');
      if (npRefreshBtn) npRefreshBtn.addEventListener('click', async () => {
        npRefreshBtn.disabled = true;
        try {
          const r = await (await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: true }) })).json();
          log(r && r.ok ? '↻ LCD refreshed — repainted the current song' : '↻ LCD refresh skipped: ' + ((r && r.reason) || 'unknown'), r && r.ok ? 'ok' : 'err');
        } catch (_) { log('↻ LCD refresh failed', 'err'); }
        setTimeout(() => { npRefreshBtn.disabled = false; }, 1200);
      });
      const npMaskEl = document.getElementById('npOnboardMask');
      if (npMaskEl) npMaskEl.addEventListener('change', async () => {
        npMaskEl.disabled = true;
        try {
          const r = await (await fetch('/nowplaying', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mask: npMaskEl.checked }) })).json();
          if (r && r.ok) log('♪ onboard mask ' + (npMaskEl.checked ? 'on — onboard set to black; the update-flash is a dark blink now (A/B vs off)' : 'off — onboard restored to a colorful default'), 'ok');
          else { log('♪ onboard mask didn\'t apply: ' + ((r && r.reason) || 'the daemon must be driving the board'), 'err'); npMaskEl.checked = !npMaskEl.checked; }
        } catch (_) { log('onboard mask change failed', 'err'); npMaskEl.checked = !npMaskEl.checked; }
        setTimeout(() => { npMaskEl.disabled = false; }, 1500);   // it cycles the keyboard once — brief settle
      });
      const copyPath = (btnId, txtId) => { const btn = document.getElementById(btnId), txt = document.getElementById(txtId);
        if (btn && txt) btn.addEventListener('click', async (e) => { e.stopPropagation();   // don't let the click start a card drag
          try { await navigator.clipboard.writeText(txt.textContent || ''); const o = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = o; }, 1200); }
          catch (_) { log('clipboard blocked — select the path and copy manually', 'err'); } }); };
      copyPath('setupPathCopy', 'setupPathTxt');
      copyPath('trayPathCopy', 'trayPathTxt');
      quit.addEventListener('click', async () => {
        if (!confirm('Quit the background daemon?\n\nAlways-on lighting and reactive-anywhere stop until setup.cmd or your next login starts it again. This page keeps working as-is.')) return;
        try { await fetch('/quit', { method: 'POST' }); log('daemon quit', 'dim'); } catch (_) {}
        try { window.dispatchEvent(new Event('th108-daemon-transition')); } catch (_) {}   // flip the header Online→Offline tag now
        setTimeout(refresh, 600);
      });
      if (restart) restart.addEventListener('click', async () => {
        // /restart makes the daemon exit(42); the supervised launcher (start-hidden.vbs) revives it in ~1s.
        // If the daemon wasn't started via that launcher it simply stops — the Start button then appears.
        try { await fetch('/restart', { method: 'POST' }); log('daemon restarting…', 'dim'); } catch (_) {}
        try { window.dispatchEvent(new Event('th108-daemon-transition')); } catch (_) {}   // burst-poll the header Online tag across the ~1s downtime so it visibly dips Offline then back
        restart.disabled = true;
        [1200, 2500, 4000].forEach(ms => setTimeout(refresh, ms));   // re-poll across the ~1s downtime so the status catches the revived daemon
      });
      if (/^https?:$/.test(location.protocol)) { refresh().then(refreshAuto); setInterval(() => refresh(), 2500); }   // display-only poll (2.5s so the live-status feed feels responsive); tab-throttling is fine
      else { st.textContent = 'daemon: unavailable on file:// — open via http://localhost:8123'; auto.disabled = true; quit.disabled = true; }
    }

    // yieldDevice/resume are kept as thin aliases to claim/release: existing callers (th108-hid.js,
    // th108-controller.html) still resolve unchanged; new callers should prefer claim()/release().
    const api = {
      ping, claim, yieldDevice: claim, heartbeatStart, heartbeatStop, pushConfig, release, resume: release, mountPanel, usbFix,
      clientId,
      onLeaseLost(cb) { _leaseCb = cb; },   // cb fires once when this page held the lease and then lost it — Task 5's banner + th108-hid.js's close-on-loss both hang off this
      reclaim: claim,                       // "Take control back" is just another claim()
      get present() { return D.present; },
      get deviceConnected() { return D.deviceConnected; },
      get paused() { return D.paused; },
      get beating() { return !!D.hb; }
    };
    // Reachable as window.DC for other same-page scripts (th108-hid.js's claim-before-open gate, and
    // Task 5's banner) without them needing an explicit reference passed in. `api` is a fully-built
    // const above this line, so this can never be a load-time TDZ read.
    if (typeof window !== 'undefined') window.DC = api;
    return api;
  }
  return { create };
})();
