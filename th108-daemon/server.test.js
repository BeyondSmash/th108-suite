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
    calls: [], _paused: false, saved: null, _autostart: false, _usbReset: true,
    yield() { this.calls.push('yield'); this._paused = true; },
    resume() { this.calls.push('resume'); this._paused = false; },
    saveConfig(c) { this.calls.push('save'); this.saved = c; },
    status() { return { running: true, paused: this._paused, deviceConnected: true, fps: 30, usbReset: this._usbReset }; },
    setUsbReset(on) { this.calls.push('setUsbReset:' + on); this._usbReset = !!on; },
    getAutostart() { this.calls.push('getAutostart'); return Promise.resolve(this._autostart); },
    setAutostart(on) { this.calls.push('setAutostart:' + on); this._autostart = !!on; return Promise.resolve(); },
    quit() { this.calls.push('quit'); },
    usbFix() { this.calls.push('usbFix'); return { fired: this._usbReset }; },
    setNowPlaying(on) { this.calls.push('setNowPlaying:' + on); this._np = !!on; },
    setNpColors(t, a) { this.calls.push('setNpColors:' + t + '/' + a); },
    setLighting(o) { this.calls.push('setLighting:' + JSON.stringify(o)); },
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

test('autostart endpoints read and write through control; /quit responds then quits', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    assert.equal((await call(server, 'GET', '/autostart')).json.enabled, false);
    assert.equal((await call(server, 'POST', '/autostart', { on: true })).json.enabled, true);
    assert.ok(ctl.calls.includes('setAutostart:true'));
    assert.equal((await call(server, 'GET', '/autostart')).json.enabled, true);
    await call(server, 'POST', '/autostart', { on: false });
    assert.equal(ctl._autostart, false);
    const q = await call(server, 'POST', '/quit');
    assert.equal(q.json.ok, true, '/quit must respond before exiting');
    assert.ok(!ctl.calls.includes('quit'), 'quit is deferred past the response');
    await new Promise(r => setTimeout(r, 250));
    assert.ok(ctl.calls.includes('quit'), 'quit fires shortly after responding');
  } finally { server.close(); }
});

test('/usbreset writes through control; state reads back via /status', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    assert.equal((await call(server, 'GET', '/status')).json.usbReset, true);   // default on
    assert.equal((await call(server, 'POST', '/usbreset', { on: false })).json.enabled, false);
    assert.ok(ctl.calls.includes('setUsbReset:false'));
    assert.equal((await call(server, 'GET', '/status')).json.usbReset, false);
    assert.equal((await call(server, 'POST', '/usbreset', { on: true })).json.enabled, true);
  } finally { server.close(); }
});

test('/nowplaying writes toggle and colors through control', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    assert.equal((await call(server, 'POST', '/nowplaying', { on: true })).json.ok, true);
    assert.ok(ctl.calls.includes('setNowPlaying:true'));
    await call(server, 'POST', '/nowplaying', { on: false });
    assert.equal(ctl._np, false);
    await call(server, 'POST', '/nowplaying', { titleColor: '#ff0000', artistColor: '#00ff00' });
    assert.ok(ctl.calls.includes('setNpColors:#ff0000/#00ff00'));
    assert.ok(!ctl.calls.includes('setNowPlaying:undefined'), 'colors-only POST must not touch the toggle');
  } finally { server.close(); }
});

test('/lighting relays the master switch + brightness through control', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    assert.equal((await call(server, 'POST', '/lighting', { on: false })).json.ok, true);
    assert.ok(ctl.calls.includes('setLighting:{"on":false}'));
    await call(server, 'POST', '/lighting', { brightness: 50 });
    assert.ok(ctl.calls.includes('setLighting:{"brightness":50}'));
  } finally { server.close(); }
});

test('/usbfix relays through control and returns its verdict (page-side wedge recovery)', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    assert.equal((await call(server, 'POST', '/usbfix')).json.fired, true);
    assert.ok(ctl.calls.includes('usbFix'));
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
