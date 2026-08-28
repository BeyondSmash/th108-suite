/* profile-cycle.js — pure helpers for profile cycling (UMD: node daemon + browser page).
   No DOM, no I/O — just the decision logic, unit-tested under node --test. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108ProfileCycle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CYCLE = new Set(['profileNext', 'profilePrev', 'profileSelect']);
  const isCycle = b => !!(b && b.action && CYCLE.has(b.action.type));

  // strip profile-cycle bindings so they're never captured INTO a profile (the cycle key must survive a switch)
  function stripCycleBindings(actions) { return (Array.isArray(actions) ? actions : []).filter(b => !isCycle(b)); }

  // a profile's non-cycle bindings PLUS the live cycle bindings preserved
  function mergeKeepingCycle(profileActions, liveActions) {
    return stripCycleBindings(profileActions).concat((Array.isArray(liveActions) ? liveActions : []).filter(isCycle));
  }

  // which aspects a profile type applies on switch
  function applyAspects(type) {
    return { layers: type !== 'hotkey', hotkeys: type === 'hotkey' || type === 'global' };
  }

  // Compose a profile `p` against a base (the primary GLOBAL profile): `p` supplies whichever section its TYPE
  // owns, the base supplies the OTHER — so a non-global overlay shows its own section + the base's remainder
  // (and switching away reverts cleanly). Returns { layers, hostActions }: an array = apply it, null = leave
  // that section as-is (the no-base fallback, so overlays behave like before when no primary is set).
  function composeApply(p, base) {
    const asp = applyAspects(p && p.type);
    const bL = base && Array.isArray(base.layers) ? base.layers : null;
    const bH = base && Array.isArray(base.hostActions) ? base.hostActions : null;
    return {
      layers:      asp.layers  ? (Array.isArray(p.layers) ? p.layers : null) : bL,
      hostActions: asp.hotkeys ? (Array.isArray(p.hostActions) ? p.hostActions : []) : bH,
    };
  }

  // the single LED index to flash for profile #idx (0-based), or -1 if out of range
  function flashLed(keys, idx, digitKs, numpadKs) {
    const arr = keys === 'numpad' ? numpadKs : digitKs;
    return (Array.isArray(arr) && idx >= 0 && idx < arr.length) ? arr[idx] : -1;
  }

  function flashActive(now, flashAt, durMs) { return !!flashAt && (now - flashAt) >= 0 && (now - flashAt) < durMs; }

  return { CYCLE, stripCycleBindings, mergeKeepingCycle, applyAspects, composeApply, flashLed, flashActive };
});
