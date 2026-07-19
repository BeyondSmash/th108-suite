const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentState, isSystemCwd } = require('./agent-state.js');

test('isSystemCwd flags Windows system dirs, not real projects', () => {
  assert.ok(isSystemCwd('C:\\Windows\\System32'));
  assert.ok(isSystemCwd('C:/Windows/System32'));
  assert.ok(isSystemCwd('System32'));
  assert.ok(isSystemCwd('C:\\Windows\\SysWOW64'));
  assert.ok(!isSystemCwd('path\\to\\th108-suite'));
  assert.ok(!isSystemCwd('/home/u/proj'));
  assert.ok(!isSystemCwd(''));   // unknown cwd → keep
});

test('system-cwd (SDK/background) sessions never count as busy or list', () => {
  const A = createAgentState();
  A.ingest({ hook_event_name: 'UserPromptSubmit', session_id: 'sdk1', cwd: 'C:\\Windows\\System32' }, 1000);
  A.ingest({ hook_event_name: 'PreToolUse', session_id: 'sdk2', cwd: 'C:\\Windows\\System32' }, 1000);
  A.ingest({ hook_event_name: 'UserPromptSubmit', session_id: 'real', cwd: '/home/u/proj' }, 1000);
  assert.equal(A.aggregate('all', 1000).busy, true);              // the real session drives busy
  assert.equal(A.sessions(1000).length, 1);                       // only the real one lists
  assert.equal(A.sessions(1000)[0].id, 'real');
});

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

test("follow-focus aggregates ONLY the focused session while the signal is fresh", () => {
  const A = createAgentState({ focusTtlMs: 10000 });
  A.ingest({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/p1' }, 1000);   // s1 busy
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's2', cwd: '/p2', agent_id: 'a1' }, 1000);   // s2 has a subagent
  A.setFocus('s1', 1000);
  const f = A.aggregate('focus', 1000);
  assert.equal(f.busy, true);            // s1 is busy
  assert.equal(f.subagentCount, 0);      // s2's subagent is NOT counted — we're following s1 only
});

test("follow-focus falls back to 'all' when the signal goes stale", () => {
  const A = createAgentState({ focusTtlMs: 10000 });
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: '/p1', agent_id: 'a1' }, 1000);
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's2', cwd: '/p2', agent_id: 'b1' }, 1000);
  A.setFocus('s1', 1000);
  assert.equal(A.aggregate('focus', 5000).subagentCount, 1);        // fresh → s1 only
  assert.equal(A.aggregate('focus', 12000).subagentCount, 2);       // >TTL stale → all sessions
});

test("follow-focus falls back to 'all' when the focused session is unknown/ended", () => {
  const A = createAgentState({ focusTtlMs: 10000 });
  A.ingest({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: '/p1', agent_id: 'a1' }, 1000);
  A.setFocus('ghost', 1000);                                        // never-seen session id
  assert.equal(A.aggregate('focus', 1000).subagentCount, 1);       // unknown focus → all
});

test("focus() reports id, freshness, and whether the session is known", () => {
  const A = createAgentState({ focusTtlMs: 10000 });
  A.ingest({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/p1' }, 1000);
  A.setFocus('s1', 1000);
  assert.deepEqual(A.focus(1000), { id: 's1', fresh: true, following: 's1' });
  assert.deepEqual(A.focus(12000), { id: 's1', fresh: false, following: null });   // stale
  A.setFocus(null, 13000);
  assert.deepEqual(A.focus(13000), { id: null, fresh: false, following: null });   // cleared
});

const { pickSessionForTitle } = require('./agent-state.js');

test("pickSessionForTitle maps a VSCode title to its session by project folder", () => {
  const sessions = [
    { id: 's1', project: 'ChemTetris', busy: false, subagentCount: 0, lastSeen: 100 },
    { id: 's2', project: 'Epomaker Project', busy: false, subagentCount: 0, lastSeen: 100 },
  ];
  assert.equal(pickSessionForTitle('game.js - ChemTetris - Visual Studio Code', sessions), 's1');
  assert.equal(pickSessionForTitle('daemon.js - Epomaker Project - Visual Studio Code', sessions), 's2');
  assert.equal(pickSessionForTitle('Molecular Maelstrom - Brave', sessions), null);   // not a project window
});

test("pickSessionForTitle picks the busiest when several live sessions share a project", () => {
  const sessions = [
    { id: 'idle', project: 'ChemTetris', busy: false, subagentCount: 0, lastSeen: 500 },
    { id: 'busy', project: 'ChemTetris', busy: true, subagentCount: 0, lastSeen: 100 },
  ];
  assert.equal(pickSessionForTitle('x - ChemTetris - Visual Studio Code', sessions), 'busy');
});

test("pickSessionForTitle prefers the most-specific (longest) project name", () => {
  const sessions = [
    { id: 'short', project: 'Chem', busy: false, subagentCount: 0, lastSeen: 100 },
    { id: 'long', project: 'ChemTetris', busy: false, subagentCount: 0, lastSeen: 100 },
  ];
  assert.equal(pickSessionForTitle('x - ChemTetris - Visual Studio Code', sessions), 'long');
});

test("pickSessionForTitle ignores empty titles and too-short project names", () => {
  assert.equal(pickSessionForTitle('', [{ id: 'a', project: 'ChemTetris', lastSeen: 1 }]), null);
  assert.equal(pickSessionForTitle('RE - x', [{ id: 'a', project: 'RE', lastSeen: 1 }]), null);   // project len<=2 guarded out (would false-match everywhere)
});

test("PostToolUse refreshes busy so a long turn keeps the spinner (past BUSY_TTL)", () => {
  const A = createAgentState({ busyTtlMs: 5000 });
  A.ingest(ev('UserPromptSubmit'), 1000);
  assert.equal(A.aggregate('all', 5000).busy, true);    // 4s in, still busy
  A.ingest(ev('PostToolUse'), 5000);                    // tool activity refreshes busyAt=5000
  assert.equal(A.aggregate('all', 9000).busy, true);    // 8s after the prompt but only 4s after the last tool → STILL busy (would have aged out at 6000 without the refresh)
  assert.equal(A.aggregate('all', 11000).busy, false);  // >5s after the last activity → clears
});
