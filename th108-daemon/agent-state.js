// Pure, in-memory agent-activity state fed by Claude Code hooks (via daemon POST /agent/event).
// One entry per Claude Code session_id; aggregate() merges across sessions (or filters to one) for the
// engine's 'agent' layer. Deterministic — every method takes `now` (ms) so it's unit-testable.
'use strict';

function basename(p) { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }

function createAgentState(opts = {}) {
  // Sessions are removed on SessionEnd (fires when the Claude Code session closes), so the TTL is only a
  // SAFETY NET for a session that died without firing SessionEnd (crash/kill). Keep it long (8h) so an OPEN
  // but IDLE session — one sitting in a VSCode window not currently working — stays listed as "idle" instead
  // of vanishing after a few quiet minutes. Idle sessions are inert in aggregate() (busy=false, no subs), so
  // a long TTL never affects the lighting; it only keeps the dropdown showing what's actually open.
  const TTL = opts.ttlMs || 8 * 60 * 60 * 1000;
  const BUSY_TTL = opts.busyTtlMs || 3 * 60 * 1000;  // clears a stuck spinner ~3 min after the last event even if Stop was missed
  // Focus-following: an external signal (claude-view POSTs /agent/focus on each bring-to-front) names the
  // session the user just focused. It's a DISCRETE event, not a continuous stream — so focus normally clears
  // by being SUPERSEDED (a new focus) or when the followed session ENDS (aggregate falls back to 'all' once
  // it's gone). The TTL is only a long backstop so a focus you set and then walked away from eventually
  // reverts to 'all' — matched to the session sweep TTL so a swept session and its focus expire together.
  const FOCUS_TTL = opts.focusTtlMs || TTL;
  const map = new Map();   // session_id -> entry
  let anon = 0;
  let focusId = null, focusAt = 0;

  function ensure(id, cwd, now) {
    let e = map.get(id);
    if (!e) { e = { subs: new Set(), busy: false, busyAt: 0, checkmarkAt: 0, notifyAt: 0, attention: false, bootAt: 0, firstSeen: now, cwd: cwd || '', lastSeen: now }; map.set(id, e); }
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

  // Set / clear the externally-signalled focused session (claude-view). id null/'' clears it.
  function setFocus(id, now) { focusId = (id != null && id !== '') ? String(id) : null; focusAt = now; }
  // The focused id if the signal is still FRESH, else null (stale/never-set → caller falls back).
  function resolveFocus(now) { return (focusId && now - focusAt < FOCUS_TTL) ? focusId : null; }
  // For /status: what we're following + whether the signal is live and the session is actually known.
  function focus(now) { const f = resolveFocus(now); return { id: focusId, fresh: !!f, following: (f && map.has(f)) ? f : null }; }

  function aggregate(filter, now) {
    sweep(now);
    if (filter === 'focus') { const id = resolveFocus(now); filter = (id && map.has(id)) ? id : 'all'; }   // follow-focus → the live focused session; stale/unknown → behave like 'all' (never breaks without claude-view)
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

  // human clock for the session label — "started at 2:47 PM" reads far better than a hex id chunk.
  // Claude Code hooks don't expose the chat title, so start-time is the best available distinguisher when
  // two sessions share a project folder. Deterministic given firstSeen; page can still fall back to the id.
  function fmtClock(ms) { try { const d = new Date(ms); let h = d.getHours(); const m = d.getMinutes(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return h + ':' + (m < 10 ? '0' + m : m) + ' ' + ap; } catch (_) { return ''; } }
  function sessions(now) {
    sweep(now);
    return [...map.entries()].map(([id, e]) => {
      const proj = basename(e.cwd) || 'session', clock = e.firstSeen ? fmtClock(e.firstSeen) : '';
      const active = e.busy || e.subs.size > 0 || e.attention;   // working (mid-turn / subagents) or waiting on the user = "active"; otherwise idle-but-open
      return { id, project: proj, startedAt: e.firstSeen || 0, label: clock ? proj + ' · ' + clock : proj + ' ' + id.slice(0, 6), active, busy: e.busy, subagentCount: e.subs.size, lastSeen: e.lastSeen };
    });
  }

  return { ingest, aggregate, sessions, setFocus, focus };
}

module.exports = { createAgentState };
