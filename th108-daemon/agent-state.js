// Pure, in-memory agent-activity state fed by Claude Code hooks (via daemon POST /agent/event).
// One entry per Claude Code session_id; aggregate() merges across sessions (or filters to one) for the
// engine's 'agent' layer. Deterministic — every method takes `now` (ms) so it's unit-testable.
'use strict';

function basename(p) { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }

function createAgentState(opts = {}) {
  const TTL = opts.ttlMs || 10 * 60 * 1000;        // drop a session with no events for this long
  const BUSY_TTL = opts.busyTtlMs || 10 * 60 * 1000; // clear a busy that never got its Stop
  const map = new Map();   // session_id -> entry
  let anon = 0;

  function ensure(id, cwd, now) {
    let e = map.get(id);
    if (!e) { e = { subs: new Set(), busy: false, busyAt: 0, checkmarkAt: 0, notifyAt: 0, attention: false, bootAt: 0, cwd: cwd || '', lastSeen: now }; map.set(id, e); }
    if (cwd) e.cwd = cwd;
    e.lastSeen = now;
    return e;
  }
  function sweep(now) {
    for (const [id, e] of map) {
      if (now - e.lastSeen > TTL) { map.delete(id); continue; }
      if (e.busy && now - e.busyAt > BUSY_TTL) { e.busy = false; }   // leaked busy (missed Stop)
    }
  }

  function ingest(hook, now) {
    if (!hook || !hook.session_id) return;
    const name = hook.hook_event_name;
    const id = hook.session_id;
    if (name === 'SessionEnd') { map.delete(id); return; }
    const e = ensure(id, hook.cwd, now);
    switch (name) {
      case 'UserPromptSubmit': e.busy = true; e.busyAt = now; e.attention = false; break;
      case 'Stop': e.busy = false; e.subs.clear(); e.attention = false; e.checkmarkAt = now; break;
      case 'SubagentStart': e.subs.add(hook.agent_id || ('anon:' + (++anon))); e.attention = false; break;
      case 'SubagentStop': {
        if (hook.agent_id && e.subs.has(hook.agent_id)) e.subs.delete(hook.agent_id);
        else { const first = e.subs.values().next().value; if (first !== undefined) e.subs.delete(first); }
        e.attention = false; break;
      }
      case 'Notification': e.notifyAt = now; e.attention = true; break;
      case 'SessionStart': e.bootAt = now; break;
      default: break;   // unhooked event types ignored
    }
  }

  function pick(filter) { return filter && filter !== 'all' ? (map.has(filter) ? [map.get(filter)] : []) : [...map.values()]; }

  function aggregate(filter, now) {
    sweep(now);
    const es = pick(filter);
    let busy = false, count = 0, checkmarkAt = 0, notifyAt = 0, attention = false, bootAt = 0;
    for (const e of es) {
      if (e.busy) busy = true;
      count += e.subs.size;
      if (e.checkmarkAt > checkmarkAt) checkmarkAt = e.checkmarkAt;
      if (e.bootAt > bootAt) bootAt = e.bootAt;
      if (e.attention) { attention = true; if (e.notifyAt > notifyAt) notifyAt = e.notifyAt; }
    }
    return { busy, subagentCount: count, checkmarkAt, notifyAt, attention, bootAt };
  }

  function sessions(now) {
    sweep(now);
    return [...map.entries()].map(([id, e]) => ({ id, label: (basename(e.cwd) || 'session') + ' ' + id.slice(0, 6), busy: e.busy, subagentCount: e.subs.size, lastSeen: e.lastSeen }));
  }

  return { ingest, aggregate, sessions };
}

module.exports = { createAgentState };
