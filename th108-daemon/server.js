// th108-daemon/server.js — serves the controller page + a tiny control API on localhost:8123.
// Control endpoints let the WebHID page auto-yield the device while it customizes, then hand back.
// A heartbeat watchdog re-grabs the device if the page disappears without resuming.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const ts = () => new Date().toTimeString().slice(0, 8);   // timestamped logs — needed to correlate board mute events with system events

// control = { yield(), resume(), saveConfig(cfg), status(), getAutostart(), setAutostart(on), setUsbReset(on), quit() }
// watchdogMs default: the page beats every 3s from a Web Worker timer (throttle-proof); 12s tolerates
// 2-3 dropped beats before concluding the page is gone. The old 5s window was tighter than real page
// behavior (heartbeats only started after device-bind, and main-thread timers throttle in hidden tabs)
// — the watchdog "resumed" into a live page and the two writers wedged the board.
function createServer({ control, root, port = 8123, watchdogMs = 12000 }) {
  let lastBeat = Date.now(), yielded = false, wd = null, boundPort = port, lastYieldAt = 0;
  function armWatchdog() {
    clearInterval(wd);
    let lastTick = Date.now();
    wd = setInterval(() => {
      const now = Date.now();
      // A big gap between ticks means the OS slept — OUR timer was frozen, and so was the page's
      // heartbeat worker, so a stale lastBeat proves nothing. Re-baseline and give the page a full
      // window to start beating again; resuming blind here put daemon + waking page on the device
      // at once (two writers → flicker/half-frames → mute → onboard fallback; 2026-06-11 wake).
      if (now - lastTick > 30000) {
        if (yielded) console.log(`${ts()} [watchdog] ${Math.round((now - lastTick) / 1000)}s tick gap (system sleep) — re-baselining the heartbeat window`);
        lastBeat = now;
      }
      lastTick = now;
      if (yielded && now - lastBeat > watchdogMs) {
        console.log(`${ts()} [watchdog] no page heartbeat for >${watchdogMs}ms — resuming daemon control`);
        control.resume(); yielded = false;
      }
    }, Math.max(50, Math.floor(watchdogMs / 4)));
  }
  const readBody = (req, maxBytes = 65536) => new Promise((resolve, reject) => {   // 64 KiB default cap (memory-DoS); /lcdgif raises it for the GIF mirror
    let b = '', over = false;
    req.on('data', c => { if (over) return; b += c; if (b.length > maxBytes) { over = true; req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { if (!over) resolve(b); });
  });
  const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  // ---- request-rate metrics + flood detector: so the next /yield-class loop ANNOUNCES itself in the
  // log (⚠ FLOOD) instead of being found by luck, and /metrics shows live per-endpoint rates. ----
  const metrics = Object.create(null), floodAt = Object.create(null);
  const FLOOD_WINDOW_MS = 5000, FLOOD_THRESHOLD = 25;   // >25 hits to one endpoint in 5s = a client looping
  function recordHit(key) {
    const now = Date.now();
    const m = metrics[key] || (metrics[key] = { total: 0, recent: [] });
    m.total++; m.recent.push(now);
    const cut = now - FLOOD_WINDOW_MS; while (m.recent.length && m.recent[0] < cut) m.recent.shift();
    if (m.recent.length > FLOOD_THRESHOLD && (!floodAt[key] || now - floodAt[key] > 10000)) {
      floodAt[key] = now;
      console.log(ts() + ' ⚠ FLOOD: ' + key + ' — ' + m.recent.length + ' hits in ' + (FLOOD_WINDOW_MS / 1000) + 's (' + (m.recent.length / (FLOOD_WINDOW_MS / 1000)).toFixed(1) + '/s); a client is looping — check its rate-limit');
    }
  }
  function metricsSnapshot() {
    const now = Date.now(), eps = {};
    for (const k in metrics) { const r = metrics[k].recent.filter(t => now - t < FLOOD_WINDOW_MS); eps[k] = { total: metrics[k].total, ratePerSec: +(r.length / (FLOOD_WINDOW_MS / 1000)).toFixed(2) }; }
    return eps;
  }

  const srv = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
    if (req.method === 'POST' || u === '/status') recordHit(req.method + ' ' + u);   // count the API surface (not static asset GETs)
    // Loopback-only + CSRF/DNS-rebinding guard: this is an always-on local service with state-changing
    // endpoints. The server binds 127.0.0.1 only; a DNS-rebound request carries the attacker's Host (not
    // localhost), and a cross-site POST carries a foreign Origin — reject both. /config additionally
    // requires application/json (forces a CORS preflight that fails cross-origin).
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return sendJson(res, 403, { error: 'forbidden host' });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}` && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) return sendJson(res, 403, { error: 'cross-origin denied' });
      if (u === '/config' && !String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'content-type must be application/json' });
    }
    try {
      if (req.method === 'GET' && u === '/status') return sendJson(res, 200, control.status());
      if (req.method === 'GET' && u === '/metrics') return sendJson(res, 200, { endpoints: metricsSnapshot(), windowSec: FLOOD_WINDOW_MS / 1000, driver: control.metrics ? control.metrics() : null });
      if (req.method === 'GET' && u === '/audio/apps') return sendJson(res, 200, { apps: control.listAudioApps ? await control.listAudioApps() : [] });   // currently-playing audio processes for the "Specific app" picker
      if (req.method === 'GET' && u === '/audio/inputs') return sendJson(res, 200, { inputs: control.listAudioInputs ? await control.listAudioInputs() : [] });   // recording devices for the Mic device picker
      if (req.method === 'GET' && u === '/host-actions') return sendJson(res, 200, { actions: control.getHostActions ? control.getHostActions() : [] });   // current host-action key bindings
      if (req.method === 'POST' && u === '/host-actions') {   // page pushes the host-action registry (key LED → action)
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.setHostActions) control.setHostActions(body.actions || []);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u === '/ha-suppress') {   // page is mid key-bind: pause action firing (ms>0 to arm, 0 to clear) so the pressed key doesn't run its current binding
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.suppressHostActions) control.suppressHostActions(body.ms || 0);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && u === '/open-apps') return sendJson(res, 200, { apps: control.listOpenApps ? await control.listOpenApps() : [] });   // currently-open windowed apps for the "pick a running app" dropdown
      if (req.method === 'GET' && u === '/pick-file') return sendJson(res, 200, { path: control.pickFile ? await control.pickFile() : null });   // native OpenFileDialog for the Launch host action (browser can't read real paths)
      if (req.method === 'POST' && u === '/app-icon') {   // extract an .exe's icon (PNG data-URL) for a Launch binding
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        return sendJson(res, 200, { icon: control.appIcon ? await control.appIcon(body.path) : null });
      }
      if (req.method === 'POST' && u === '/profiles') {   // page pushes saved profiles so the daemon can cycle them page-closed
        const b = await readBody(req, 1_048_576); let body;   // profiles carry full layer configs → raise the body cap
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.setProfiles) control.setProfiles(body.profiles || []);
        if (control.setIndicator && body.indicator) control.setIndicator(body.indicator);
        if (control.setPrimary) control.setPrimary(body.primary || null);   // the base/primary profile name (composes overlays)
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u === '/app-profiles') {   // page pushes the app→profile auto-switch map
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.setAppProfiles) control.setAppProfiles(body);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u === '/apply-profile') {   // page-side manual Apply → daemon applies live + flashes
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.applyProfileByIndex) control.applyProfileByIndex(body.index | 0);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && u === '/audio/frame') return sendJson(res, 200, { frame: control.audioFrame ? control.audioFrame() : null });   // latest system/app audio frame for the page preview/drive
      if (req.method === 'GET' && u === '/nowplaying/pos') return sendJson(res, 200, { pos: control.npPos ? control.npPos() : null });   // media position so the page can draw the song-progress bar while it drives
      if (req.method === 'POST' && u === '/yield') {
        // BACKSTOP for the yield-storm (2026-06-13): if we're already yielded and another /yield
        // lands within 1s, it's a flapping page looping — ACK without re-running control.yield()
        // (which closes the device + waits on lcdBusy each time). Stops the storm even from a stale tab.
        const now = Date.now();
        if (yielded && now - lastYieldAt < 1000) return sendJson(res, 200, { ok: true, coalesced: true });
        lastYieldAt = now;
        console.log(ts() + ' [api] /yield — page is taking the device'); await control.yield(); yielded = true; lastBeat = now; armWatchdog(); return sendJson(res, 200, { ok: true });   // await: the response must not unleash the page onto a board mid-flash-write
      }
      if (req.method === 'POST' && u === '/resume') { console.log(ts() + ' [api] /resume — page released the device'); control.resume(); yielded = false; clearInterval(wd); return sendJson(res, 200, { ok: true }); }
      if (req.method === 'GET' && u === '/autostart') return sendJson(res, 200, { enabled: await control.getAutostart() });
      if (req.method === 'POST' && u === '/autostart') {
        const b = await readBody(req); let on;
        try { on = !!JSON.parse(b || '{}').on; } catch { return sendJson(res, 400, { error: 'bad json' }); }
        await control.setAutostart(on);
        console.log(ts() + ' [api] /autostart ' + (on ? 'on' : 'off'));
        return sendJson(res, 200, { ok: true, enabled: on });
      }
      if (req.method === 'POST' && u === '/usbreset') {   // toggle the auto USB-restart wedge fix (state reads back via /status.usbReset)
        const b = await readBody(req); let on;
        try { on = !!JSON.parse(b || '{}').on; } catch { return sendJson(res, 400, { error: 'bad json' }); }
        control.setUsbReset(on);
        console.log(ts() + ' [api] /usbreset ' + (on ? 'on' : 'off'));
        return sendJson(res, 200, { ok: true, enabled: on });
      }
      if (req.method === 'POST' && u === '/displayoff') {   // toggle "blank the board while the monitor is off (idle timeout)"
        const b = await readBody(req); let on;
        try { on = !!JSON.parse(b || '{}').on; } catch { return sendJson(res, 400, { error: 'bad json' }); }
        control.setDimOnDisplayOff(on);
        console.log(ts() + ' [api] /displayoff ' + (on ? 'on' : 'off'));
        return sendJson(res, 200, { ok: true, enabled: on });
      }
      if (req.method === 'POST' && u === '/lighting') {   // master lighting switch + global brightness (header controls)
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        control.setLighting(body);
        console.log(ts() + ' [api] /lighting ' + JSON.stringify(body));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u === '/nowplaying') {   // toggle and/or text colors (state reads back via /status)
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (body.titleColor || body.artistColor) { control.setNpColors(body.titleColor, body.artistColor); console.log(ts() + ' [api] /nowplaying colors ' + (body.titleColor || '-') + '/' + (body.artistColor || '-')); }
        if (body.cal) { control.setNpCal(body.cal); console.log(ts() + ' [api] /nowplaying cal updated'); }
        if ('revertSec' in body) { control.setNpRevertSec(body.revertSec); console.log(ts() + ' [api] /nowplaying revertSec=' + body.revertSec); }
        if ('artFit' in body && control.setNpArtFit) { control.setNpArtFit(!!body.artFit); console.log(ts() + ' [api] /nowplaying artFit=' + !!body.artFit); }
        if (body.source && typeof body.source.id === 'string') { control.setNpSource(body.source.id, !!body.source.allow); console.log(ts() + ' [api] /nowplaying source ' + body.source.id + '=' + !!body.source.allow); }
        if (body.bar && control.setNpBar) { control.setNpBar(body.bar); console.log(ts() + ' [api] /nowplaying bar ' + JSON.stringify(body.bar)); }
        if ('on' in body) { const r = control.setNowPlaying(!!body.on); console.log(ts() + ' [api] /nowplaying ' + (body.on ? 'on' : 'off') + (r && r.revert ? ' revert=' + JSON.stringify(r.revert) : '')); return sendJson(res, 200, { ok: true, revert: r && r.revert }); }
        if (body.refresh && control.npRefresh) { const r = await control.npRefresh(); console.log(ts() + ' [api] /nowplaying refresh → ' + JSON.stringify(r)); return sendJson(res, 200, r); }
        if ('mask' in body && control.setOnboardMask) { const r = await control.setOnboardMask(!!body.mask); console.log(ts() + ' [api] /nowplaying mask=' + !!body.mask + ' → ' + JSON.stringify(r)); return sendJson(res, 200, r); }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u === '/usbfix') {   // the page's last-resort wedge recovery (cooldown enforced by control.usbFix)
        const r = control.usbFix();
        console.log(ts() + ' [api] /usbfix → ' + JSON.stringify(r));
        return sendJson(res, 200, r);
      }
      if (req.method === 'POST' && u === '/quit') {
        console.log(ts() + ' [api] /quit — shutting down');
        sendJson(res, 200, { ok: true });
        setTimeout(() => control.quit(), 150);   // respond first, then exit
        return;
      }
      if (req.method === 'POST' && u === '/restart' && typeof control.restart === 'function') {
        console.log(ts() + ' [api] /restart — exiting non-zero so the supervisor revives us');
        sendJson(res, 200, { ok: true });
        setTimeout(() => control.restart(), 150);   // respond first, then exit(42) → start-hidden.vbs respawns
        return;
      }
      if (req.method === 'POST' && u === '/heartbeat') {
        const b = await readBody(req); let ev = {}; try { ev = JSON.parse(b || '{}'); } catch {}
        lastBeat = Date.now();
        if (!yielded && !(ev && ev.clientId)) {   // LEGACY pages only: a clientId beat owns via the lease, so no legacy re-grab (a modern owner would else claim against its own ownership → ladder → USB restart)
          console.log(ts() + ' [api] heartbeat while not yielded — a legacy page holds the device; yielding to it');
          await control.yield(); yielded = true; armWatchdog();
        }
        const out = control.heartbeat ? control.heartbeat(ev) : {};   // control.heartbeat(ev) reads ev.clientId (Task 3)
        // npWants rides the beat: the page learns within one heartbeat (≤3s) that a song is
        // waiting, pauses its stream, and grants the upload window via /npgo
        return sendJson(res, 200, { ok: true, npWants: control.npWants ? control.npWants() : false, ...(out || {}) });
      }
      if (req.method === 'POST' && u === '/lcdgif') {   // the page mirrors its GIF Screen upload (pause-revert target)
        const b = await readBody(req, 3_000_000); let body;
        try { body = JSON.parse(b); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        return sendJson(res, 200, { ok: control.saveLcdGif(body) });
      }
      if (req.method === 'POST' && u === '/npgo') {   // the page paused its stream — write the pending song now
        const r = await control.npGo();
        console.log(ts() + ' [api] /npgo → ' + JSON.stringify(r));
        return sendJson(res, 200, r);
      }
      if (req.method === 'POST' && u === '/claim') {          // a controller asks for the device (newest-wins)
        const b = await readBody(req); let ev;
        try { ev = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        const out = control.claim ? await control.claim(ev) : { granted: true, epoch: 0 };
        return sendJson(res, 200, out);   // BLOCKS in control.claim until the caller may open (or the fallback resolves)
      }
      if (req.method === 'POST' && u === '/release') {        // the revoked owner confirms it closed its handle
        const b = await readBody(req); let ev;
        try { ev = JSON.parse(b || '{}'); } catch { ev = {}; }   // sendBeacon may send text/plain; tolerate
        if (control.release) control.release(ev);
        return sendJson(res, 204, {});
      }
      if (req.method === 'POST' && u === '/agent/event') {   // Claude Code hook posts raw hook JSON here
        const b = await readBody(req); let ev;
        try { ev = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        const cp = req.headers['x-claude-pid']; if (cp && !ev.claude_pid) ev.claude_pid = cp;   // hook forwards $PPID via header → agent-state stores it for window-focus
        if (control.agentEvent) control.agentEvent(ev);
        return sendJson(res, 204, {});   // hooks are fire-and-forget; keep it cheap
      }
      if (req.method === 'POST' && u === '/agent/focus') {   // claude-view (optional) posts the focused session: { session_id } — or null/'' to clear
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.agentFocus) control.agentFocus(body.session_id != null ? body.session_id : body.sessionId);
        return sendJson(res, 204, {});   // advisory + fire-and-forget
      }
      if (req.method === 'POST' && u === '/agent/focus-config') {   // outline color + auto-switch / outline-on-switch toggles
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (control.setFocusConfig) control.setFocusConfig(body);
        return sendJson(res, 204, {});
      }
      if (req.method === 'GET' && u === '/agent/windows') return sendJson(res, 200, { windows: control.listVscodeWindows ? await control.listVscodeWindows() : [] });   // every open VSCode window for the picker
      if (req.method === 'POST' && u === '/agent/focus-window') {   // manual: bring a window to front + flash — by exact hwnd (picker) or by session (followed/selected)
        const b = await readBody(req); let body;
        try { body = JSON.parse(b || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (body.hwnd && control.focusWindowByHwnd) control.focusWindowByHwnd(body.hwnd, body.title || '');
        else if (control.focusWindowManual) control.focusWindowManual(body.session_id || body.project || '');
        return sendJson(res, 204, {});
      }
      if (req.method === 'GET' && u === '/agent/sessions') return sendJson(res, 200, { sessions: control.agentSessions ? control.agentSessions() : [] });
      if (req.method === 'POST' && u === '/config') {
        const b = await readBody(req); let cfg;
        try { cfg = JSON.parse(b); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        control.saveConfig(cfg); return sendJson(res, 200, { ok: true });
      }
      // static files
      if (req.method === 'GET') {
        const rel = u === '/' ? '/th108-controller.html' : u;
        const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
        const file = path.join(root, safe);
        if (file.startsWith(path.resolve(root)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          // no-store: the page assets (controller HTML + th108-engine.js / th108-layers-ui.js / client) change
          // often during development; without this the browser caches them and a normal refresh keeps STALE code
          // (e.g. an old audio engine still running while the daemon is fresh) — the classic "my fix isn't live".
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) { sendJson(res, 500, { error: String(e && e.message || e) }); }
  });

  srv.on('error', (e) => {
    // console.LOG (not error) so daemon.js tees it into daemon.log — otherwise this failure is invisible in the
    // hidden window and the log falsely reads "daemon running" (the ▶ line prints before this async bind result).
    if (e.code === 'EADDRINUSE') { console.log(`✗ port ${port} already in use — the daemon can't bind and is exiting (a stale _serve.js, a foreign app on ${port}, or a hung daemon the tray's Restart clears).`); process.exit(1); }
  });

  const server = { port, close: () => { clearInterval(wd); try { srv.closeAllConnections && srv.closeAllConnections(); } catch {} srv.close(); } };   // closeAllConnections drops the page's keep-alive poll so the listener frees the port immediately (a lingering connection could otherwise hold it)
  server.listening = new Promise((resolve) => srv.listen(port, '127.0.0.1', () => { boundPort = server.port = srv.address().port; resolve(); }));
  return server;
}

module.exports = { createServer };
