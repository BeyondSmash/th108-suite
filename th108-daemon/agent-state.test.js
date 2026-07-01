const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentState } = require('./agent-state.js');

const ev = (name, extra = {}) => Object.assign({ hook_event_name: name, session_id: 's1', cwd: '/home/u/proj' }, extra);

test('UserPromptSubmit sets busy; Stop clears busy + fires checkmark', () => {
  const A = createAgentState();
  A.ingest(ev('UserPromptSubmit'), 1000);
  assert.equal(A.aggregate('all', 1000).busy, true);
  A.ingest(ev('Stop'), 2000);
  const a = A.aggregate('all', 2000);
  assert.equal(a.busy, false);
  assert.equal(a.checkmarkAt, 2000);
});

test('SubagentStart/Stop tracks live count; Stop resets it to 0', () => {
  const A = createAgentState();
  A.ingest(ev('SubagentStart', { agent_id: 'a1' }), 1000);
  A.ingest(ev('SubagentStart', { agent_id: 'a2' }), 1100);
  assert.equal(A.aggregate('all', 1100).subagentCount, 2);
  A.ingest(ev('SubagentStop', { agent_id: 'a1' }), 1200);
  assert.equal(A.aggregate('all', 1200).subagentCount, 1);
  A.ingest(ev('Stop'), 1300);
  assert.equal(A.aggregate('all', 1300).subagentCount, 0);   // reset-on-Stop heals a missed SubagentStop
});

test('SubagentStart without agent_id still counts (anon fallback)', () => {
  const A = createAgentState();
  A.ingest(ev('SubagentStart'), 1000);
  A.ingest(ev('SubagentStart'), 1100);
  assert.equal(A.aggregate('all', 1100).subagentCount, 2);
  A.ingest(ev('SubagentStop'), 1200);   // no id → removes one anon
  assert.equal(A.aggregate('all', 1200).subagentCount, 1);
});

test('Notification latches attention; next activity clears it', () => {
  const A = createAgentState();
  A.ingest(ev('Notification'), 1000);
  let a = A.aggregate('all', 1000);
  assert.equal(a.attention, true);
  assert.equal(a.notifyAt, 1000);
  A.ingest(ev('UserPromptSubmit'), 2000);
  assert.equal(A.aggregate('all', 2000).attention, false);
});

test('SessionStart sets bootAt; SessionEnd drops the session', () => {
  const A = createAgentState();
  A.ingest(ev('SessionStart'), 1000);
  assert.equal(A.aggregate('all', 1000).bootAt, 1000);
  A.ingest(ev('SessionEnd'), 2000);
  assert.equal(A.sessions(2000).length, 0);
});

test('aggregate across sessions: busy=any, count=sum; filter isolates one', () => {
  const A = createAgentState();
  A.ingest({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a' }, 1000);
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: '/a', agent_id: 'x' }, 1000);
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's2', cwd: '/b', agent_id: 'y' }, 1000);
  assert.equal(A.aggregate('all', 1000).busy, true);
  assert.equal(A.aggregate('all', 1000).subagentCount, 2);
  assert.equal(A.aggregate('s2', 1000).busy, false);
  assert.equal(A.aggregate('s2', 1000).subagentCount, 1);
});

test('TTL sweep drops stale sessions and clears a leaked busy', () => {
  const A = createAgentState({ ttlMs: 10000, busyTtlMs: 5000 });
  A.ingest(ev('UserPromptSubmit'), 1000);          // busy, lastSeen=1000
  assert.equal(A.aggregate('all', 7000).busy, false);   // busy older than busyTtlMs → cleared
  assert.equal(A.sessions(12000).length, 0);            // lastSeen older than ttlMs → dropped
});

test('sessions() returns a label from cwd basename + short id', () => {
  const A = createAgentState();
  A.ingest({ hook_event_name: 'SessionStart', session_id: 'abcdef123456', cwd: '/home/u/Epomaker Project' }, 1000);
  const s = A.sessions(1000)[0];
  assert.match(s.label, /Epomaker Project/);
  assert.equal(s.id, 'abcdef123456');
});
