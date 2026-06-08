// th108-daemon/server.js — serves the controller page + a tiny control API on localhost:8123.
// Control endpoints let the WebHID page auto-yield the device while it customizes, then hand back.
// A heartbeat watchdog re-grabs the device if the page disappears without resuming.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// control = { yield(), resume(), saveConfig(cfg), status() }
function createServer({ control, root, port = 8123, watchdogMs = 5000 }) {
  let lastBeat = Date.now(), yielded = false, wd = null;
  function armWatchdog() {
    clearInterval(wd);
    wd = setInterval(() => {
      if (yielded && Date.now() - lastBeat > watchdogMs) { control.resume(); yielded = false; }
    }, Math.max(50, Math.floor(watchdogMs / 4)));
  }
  const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)); });
  const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const srv = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
    try {
      if (req.method === 'GET' && u === '/status') return sendJson(res, 200, control.status());
      if (req.method === 'POST' && u === '/yield') { control.yield(); yielded = true; lastBeat = Date.now(); armWatchdog(); return sendJson(res, 200, { ok: true }); }
      if (req.method === 'POST' && u === '/resume') { control.resume(); yielded = false; clearInterval(wd); return sendJson(res, 200, { ok: true }); }
      if (req.method === 'POST' && u === '/heartbeat') { lastBeat = Date.now(); return sendJson(res, 200, { ok: true }); }
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
  server.listening = new Promise((resolve) => srv.listen(port, '127.0.0.1', () => { server.port = srv.address().port; resolve(); }));
  return server;
}

module.exports = { createServer };
