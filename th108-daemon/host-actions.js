'use strict';
// Pure helpers for the Host-Action registry: schema normalization + the stateless trigger predicates. Kept in
// its own module (no daemon deps) so the matching logic is unit-testable — daemon.js owns the stateful bits
// (multi-tap timestamps, hold timers, uiohook key-send, child_process spawn).
//
// Normalized binding shape:  { trigger, action }
//   trigger.type: 'key'      { led }                         — a single press
//                 'chord'    { led, mods:{ctrl,alt,shift,meta} } — modifiers + key, exact-match
//                 'multitap' { led, count, windowMs }        — N presses within a window (double/triple-tap)
//                 'hold'     { led, holdMs }                 — press and hold for holdMs
//   action.type:  'micToggle' | 'profileNext' | 'profilePrev'
//                 'profileSelect' { index }                 — jump straight to profile N
//                 'macro'         { steps:[{key, mods}] }    — play a keystroke sequence (uiohook codes)
//                 'launch'        { target }                 — open a program / file / URL
//                 'brightnessCycle' {}                       — step global brightness +10%, wrap 100→0, white-blink at 100

const ACTIONS = new Set(['micToggle', 'profileNext', 'profilePrev', 'profileSelect', 'macro', 'launch', 'focusApp', 'winMin', 'winMax', 'winRestore', 'brightnessCycle', 'brightnessToggle']);
const TRIGGERS = new Set(['key', 'chord', 'multitap', 'hold']);

// Global-brightness cycle step: +`step`%, wrapping past 100 back to 0. Returns the new value and whether it
// landed exactly on 100 (→ the daemon flashes the board white once as a "you're at max" cue). Pure/testable.
function nextBrightness(cur, step) {
  step = step || 10;
  const c = Math.max(0, Math.min(100, Number(cur) || 0));
  let n = (Math.floor(c / step) + 1) * step;   // next grid point up (odd starting values round UP to the next step)
  if (n > 100) n = 0;                           // wrap past max
  return { value: n, blink: n === 100 };
}

// brightnessToggle: >0 → off (0); 0 → the configured "on" value. Pure/testable.
function toggleBrightness(cur, onVal) { return (Number(cur) || 0) > 0 ? 0 : clampInt(onVal, 100, 0, 100); }

// App-specific lighting: which saved-profile NAME the focused `exe` should show — its own mapping (matched by
// process name, case-insensitive), else the `def` default; null/'' → no switch (leave the board as-is). Pure/testable.
function wantedAppProfile(maps, exe, def) {
  if (!Array.isArray(maps)) return null;
  const m = maps.find(x => x && x.exe && String(x.exe).toLowerCase() === String(exe || '').toLowerCase());
  const want = m ? m.profile : def;
  return (want == null || want === '') ? null : String(want);
}
function clampInt(v, def, lo, hi) { v = Math.round(+v); if (!isFinite(v)) return def; return Math.max(lo, Math.min(hi, v)); }
function pickMods(m) { m = m || {}; return { ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift, meta: !!m.meta }; }

// Migrate + validate a stored registry into the normalized [{trigger, action}] list. Accepts the OLD format
// ([{led, action:'micToggle'}]) and the new one; silently drops entries that don't validate.
function normalize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    let trigger, action;
    if (b.trigger && b.action && typeof b.action === 'object') { trigger = b.trigger; action = b.action; }
    else if (b.led != null && typeof b.action === 'string') { trigger = { type: 'key', led: b.led }; action = { type: b.action }; }   // old single-key format
    else continue;
    if (!trigger || trigger.led == null || !TRIGGERS.has(trigger.type) || !action || !ACTIONS.has(action.type)) continue;
    const t = { type: trigger.type, led: +trigger.led };
    if (t.type === 'chord') t.mods = pickMods(trigger.mods);
    if (t.type === 'multitap') { t.count = clampInt(trigger.count, 2, 1, 10); t.windowMs = clampInt(trigger.windowMs, 400, 100, 10000); }
    if (t.type === 'hold') t.holdMs = clampInt(trigger.holdMs, 500, 150, 3000);
    const a = { type: action.type };
    if (a.type === 'profileSelect') a.index = clampInt(action.index, 0, 0, 99);
    if (a.type === 'macro') a.steps = Array.isArray(action.steps) ? action.steps.map(s => {   // key steps = KeyboardEvent.code (+ mods); delay steps = {ms}
      if (s && typeof s.code === 'string') return { code: s.code, ctrl: !!s.ctrl, alt: !!s.alt, shift: !!s.shift, meta: !!s.meta };
      if (s && s.ms != null) return { ms: clampInt(s.ms, 100, 0, 10000) };
      return null;
    }).filter(Boolean) : [];
    if (a.type === 'launch' || a.type === 'focusApp') a.target = String(action.target || '').trim().replace(/^["']+|["']+$/g, '').trim();   // strip surrounding quotes (Windows "Copy as path")
    if (a.type === 'brightnessCycle') a.flashMax = action.flashMax !== false;   // flash the WHOLE board white at 100% (default on); false → keep the number-key readout at 100%
    if (a.type === 'brightnessToggle') a.value = clampInt(action.value, 100, 0, 100);   // the "on" brightness %; the action toggles between this and 0 (off)
    out.push({ trigger: t, action: a });
  }
  return out;
}

// Chord EXACT-match: the down modifiers must equal exactly what the binding wants, so Ctrl+M doesn't also fire a
// Ctrl+Shift+M binding (and a bare key with no mods won't fire while a modifier is held).
function chordMatches(want, ev) {
  want = want || {}; ev = ev || {};
  return !!want.ctrl === !!ev.ctrl && !!want.alt === !!ev.alt && !!want.shift === !!ev.shift && !!want.meta === !!ev.meta;
}

// Multi-tap: prune taps older than the window, append this tap, and fire when `count` is reached. Returns
// { fire, taps } — taps is the pruned list to carry forward (reset to [] on a fire).
function tapFires(taps, now, count, windowMs) {
  const kept = (taps || []).filter(t => now - t < windowMs);
  kept.push(now);
  if (kept.length >= count) return { fire: true, taps: [] };
  return { fire: false, taps: kept };
}

module.exports = { normalize, chordMatches, tapFires, nextBrightness, toggleBrightness, wantedAppProfile, ACTIONS, TRIGGERS };
