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
  let lastBeat = Date.now(), yielded = false, wd = null, boundPort = port;
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
  const readBody = (req) => new Promise((resolve, reject) => {   // capped to 64 KiB to avoid memory-DoS
    let b = '', over = false;
    req.on('data', c => { if (over) return; b += c; if (b.length > 65536) { over = true; req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { if (!over) resolve(b); });
  });
  const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const srv = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
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
      if (req.method === 'POST' && u === '/yield') { console.log(ts() + ' [api] /yield — page is taking the device'); control.yield(); yielded = true; lastBeat = Date.now(); armWatchdog(); return sendJson(res, 200, { ok: true }); }
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
      if (req.method === 'POST' && u === '/heartbeat') {
        lastBeat = Date.now();
        if (!yielded) {   // a beating page believes it holds the device (e.g. WE restarted under it and it won't re-/yield) — honor that instead of opening against it (live repro 2026-06-11 12:52)
          console.log(ts() + ' [api] heartbeat while not yielded — a page holds the device; yielding to it');
          control.yield(); yielded = true; armWatchdog();
        }
        return sendJson(res, 200, { ok: true });
      }
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
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) { sendJson(res, 500, { error: String(e && e.message || e) }); }
  });

  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`✗ port ${port} in use (stale _serve.js or another daemon?). Stop it and retry.`); process.exit(1); }
  });

  const server = { port, close: () => { clearInterval(wd); srv.close(); } };
  server.listening = new Promise((resolve) => srv.listen(port, '127.0.0.1', () => { boundPort = server.port = srv.address().port; resolve(); }));
  return server;
}

module.exports = { createServer };
