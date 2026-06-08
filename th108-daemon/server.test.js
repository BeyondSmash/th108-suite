const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createServer } = require('./server.js');

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

test('bad /config json → 400, no save', async () => {
  const ctl = fakeControl();
  const server = createServer({ control: ctl, root: path.join(__dirname, '..'), port: 0 });
  await server.listening;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/config`, { method: 'POST', body: 'not json{' });
    assert.equal(res.status, 400);
    assert.equal(ctl.saved, null);
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
