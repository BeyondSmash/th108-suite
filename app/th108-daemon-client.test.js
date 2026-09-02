// th108-daemon-client.test.js — the lease-liveness guard in beat(): a page that lost its WebHID handle must hand the
// lease back instead of heart-beating forever (the "board dark, only NumLock lit" stuck-lease bug, 2026-09-01).
// Run: node --test th108-daemon-client.test.js   (no hardware, no browser — fetch/Worker/navigator are stubbed)
const { test, mock } = require('node:test');
const assert = require('node:assert');
mock.timers.enable({ apis: ['setInterval'] });   // once for the file — enable() throws if called twice

function load({ holdsDevice }) {
  const calls = [];   // every URL the client hits, in order
  global.window = globalThis;
  global.location = { protocol: 'http:' };
  global.performance = global.performance || { now: () => 0 };
  global.Worker = undefined;                       // no Worker → the client falls back to setInterval (mockable)
  global.navigator = { sendBeacon: (url) => { calls.push(url); return true; } };
  global.fetch = (url) => {
    calls.push(url);
    const json = url === '/status' ? { leaseOwner: 'daemon', paused: false, deviceConnected: true }
               : url === '/claim' ? { granted: true, epoch: 2 }
               : { npWants: false };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
  };
  delete require.cache[require.resolve('./th108-daemon-client.js')];
  require('./th108-daemon-client.js');
  const logs = [];
  const DC = window.TH108DaemonClient.create({ log: (m) => logs.push(m), holdsDevice, onLeaseHandedBack: () => logs.push('__handedback__') });
  return { DC, calls, logs };
}

test('lost handle + no bind in flight for 3 beats → stops beating and POSTs /release', async () => {
  let held = true;
  const { DC, calls, logs } = load({ holdsDevice: () => held });
  await DC.ping(); await DC.claim();
  DC.heartbeatStart();
  assert.equal(DC.beating, true);
  mock.timers.tick(3000); mock.timers.tick(3000);             // healthy: handle held
  held = false;                                               // BT↔wired toggle / replug: handle gone, no rebind running
  mock.timers.tick(3000); mock.timers.tick(3000);
  assert.equal(DC.beating, true, 'two dead beats are not enough (a sleep/wake rebind binds within ~3s)');
  assert.ok(!calls.includes('/release'));
  mock.timers.tick(3000);                                     // third dead beat (~9s)
  assert.equal(DC.beating, false);
  assert.ok(calls.includes('/release'), 'the daemon was told to take the keyboard back');
  assert.ok(logs.some(m => /handed lighting back/.test(m)));
  assert.ok(logs.includes('__handedback__'));
});

test('a handle coming back (rebind succeeded) resets the dead-beat count', async () => {
  let held = true;                                            // holdsDevice = device || binding: a picker/rebind in flight reads as held
  const { DC, calls } = load({ holdsDevice: () => held });
  await DC.ping(); await DC.claim();
  DC.heartbeatStart();
  held = false;                                               // handle gone…
  mock.timers.tick(3000); mock.timers.tick(3000);             // two dead beats
  held = true;                                                // …rebind poll re-bound within its 6s window — count must reset
  mock.timers.tick(3000);
  held = false;
  mock.timers.tick(3000); mock.timers.tick(3000);
  assert.equal(DC.beating, true, 'only two dead beats since the last good one');
  assert.ok(!calls.includes('/release'));
  DC.heartbeatStop();   // mock timers are file-global — don't let this instance tick into the next test
});

test('no holdsDevice predicate → legacy behaviour, beats forever', async () => {
  const { DC, calls } = load({});
  await DC.ping(); await DC.claim();
  DC.heartbeatStart();
  for (let i = 0; i < 10; i++) mock.timers.tick(3000);
  assert.equal(DC.beating, true);
  assert.ok(!calls.includes('/release'));
  DC.heartbeatStop();
});
