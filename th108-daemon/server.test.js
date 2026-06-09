const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./server.js');

// raw request so we can set Host/Origin (fetch won't let us) — needed to exercise the security guards
function raw(server, method, p, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: p, method, headers: headers || {} }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.end();
  });
}

function fakeControl() {
  return {
    calls: [], _paused: false, saved: null,
    yield() { this.calls.push('yield'); this._paused = true; },
    resume() { this.calls.push('resume'); this._paused = false; },
    saveConfig(c) { this.calls.push('save'); this.saved = c; },
    status() { return { running: true, paused: this._paused, deviceConnected: true, fps: 30 }; },
  };
}

async function call(server, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${server.port}${p}`, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  return { code: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? null : await res.text() };
}

test('control endpoints drive the controller + watchdog auto-resumes', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0, watchdogMs: 120 });
  await server.listening;
  try {
    assert.equal((await call(server, 'GET', '/status')).json.running, true);
    await call(server, 'POST', '/yield'); assert.equal(ctl._paused, true);
    await call(server, 'POST', '/config', [{ name: 'X' }]); assert.deepEqual(ctl.saved, [{ name: 'X' }]);
    await new Promise(r => setTimeout(r, 250));   // no heartbeats → watchdog should fire
    assert.ok(ctl.calls.includes('resume'), 'watchdog should auto-resume after silence');
  } finally { server.close(); }
});

test('heartbeats hold the watchdog off; silence after them still resumes', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0, watchdogMs: 200 });
  await server.listening;
  try {
    await call(server, 'POST', '/yield');
    for (let i = 0; i < 6; i++) {              // beat every 70ms for ~420ms — well past watchdogMs
      await new Promise(r => setTimeout(r, 70));
      await call(server, 'POST', '/heartbeat');
    }
    assert.ok(!ctl.calls.includes('resume'), 'watchdog must NOT fire while heartbeats flow');
    await new Promise(r => setTimeout(r, 400));   // then go silent → it must fire
    assert.ok(ctl.calls.includes('resume'), 'watchdog must fire after heartbeats stop');
  } finally { server.close(); }
});

test('bad /config json → 400, no save', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json{' });
    assert.equal(res.status, 400);
    assert.equal(ctl.saved, null);
  } finally { server.close(); }
});

test('security guards: foreign Host, cross-Origin POST, and non-JSON /config are rejected', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    // DNS-rebinding: a request whose Host isn't our loopback host is refused
    assert.equal((await raw(server, 'POST', '/yield', { host: 'evil.example:1234' })).code, 403);
    // CSRF: same loopback Host (auto) but a foreign Origin is refused
    assert.equal((await raw(server, 'POST', '/yield', { origin: 'http://evil.example' })).code, 403);
    // /config without application/json is refused (forces a CORS preflight cross-origin)
    assert.equal((await raw(server, 'POST', '/config', { 'content-type': 'text/plain' })).code, 415);
    // none of the above reached the control object
    assert.deepEqual(ctl.calls, []);
    // sanity: a same-origin POST (loopback Host, matching Origin) still works
    const ok = await raw(server, 'POST', '/yield', { origin: `http://127.0.0.1:${server.port}` });
    assert.equal(ok.code, 200);
    assert.ok(ctl.calls.includes('yield'));
  } finally { server.close(); }
});

test('serves th108-controller.html at /', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    const r = await call(server, 'GET', '/');
    assert.equal(r.code, 200);
    assert.ok(/<html|<!doctype/i.test(r.text), 'should return the controller HTML');
  } finally { server.close(); }
});

test('blocks path traversal', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    const r = await call(server, 'GET', '/../../../../Windows/win.ini');
    assert.equal(r.code, 404);
  } finally { server.close(); }
});
