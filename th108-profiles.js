/* th108-profiles.js — named lighting profiles for the TH108 controller (Profiles tab).
   A profile is a snapshot of the whole lighting setup: the layer config (same format as the
   daemon's config.json / the Toolbox Export) plus the layer stacking order. Up to 10 profiles,
   renamable in place, each exportable as JSON; Import accepts a profile file OR a bare layer
   array (the Toolbox Export format), so configs move freely between the two.

   Storage: localStorage 'th108_profiles' = [{name, layers, order, savedAt}].
   Applying a profile writes the layer keys back, pushes to the daemon, and reloads the page
   (same flow as the Toolbox Import — the layer cards rebuild from storage on boot).

   Usage: const PROFILES = TH108Profiles.create({log, flushSave, getCurrent, applyData});
   flushSave() flushes the live layer state to localStorage before a snapshot; getCurrent()
   returns {layers, order}; applyData({layers, order}) commits + reloads. UMD so the pure
   helpers are unit-testable under node --test. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TH108Profiles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'th108_profiles', MAX_PROFILES = 10, NAME_MAX = 40;

  // ---- pure helpers (unit-tested) ----
  function sanitizeName(s, fallback) {
    const n = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    return n || fallback || 'Profile';
  }
  function canAdd(list) { return list.length < MAX_PROFILES; }
  // first free "Profile N" that doesn't collide with an existing name
  function defaultName(list) {
    const used = new Set(list.map(p => p.name));
    for (let n = 1; ; n++) { const name = 'Profile ' + n; if (!used.has(name)) return name; }
  }
  // accept a profile file {name?, layers, order?} OR a bare layer array (the Toolbox Export format)
  function normalizeImport(parsed) {
    if (Array.isArray(parsed)) return { name: null, layers: parsed, order: null };
    if (parsed && Array.isArray(parsed.layers)) {
      return { name: typeof parsed.name === 'string' ? parsed.name : null,
               layers: parsed.layers,
               order: Array.isArray(parsed.order) ? parsed.order : null };
    }
    throw new Error('not a profile file or a layer array');
  }
  function fileSlug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'; }

  function create(opts) {
    opts = opts || {};
    const noop = function () {};
    const log = opts.log || noop, flushSave = opts.flushSave || noop,
          getCurrent = opts.getCurrent || (() => ({ layers: [], order: null })),
          applyData = opts.applyData || noop;
    const $ = id => document.getElementById(id);

    function load() { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
    const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff2d55', '#a2845e'];
    const defaultColor = i => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
    function loadIndicator() { try { return Object.assign({ on: true, keys: 'numberRow' }, JSON.parse(localStorage.getItem('th108_profileIndicator') || '{}')); } catch (_) { return { on: true, keys: 'numberRow' }; } }
    function saveIndicator(ind) { try { localStorage.setItem('th108_profileIndicator', JSON.stringify(ind)); } catch (_) {} pushToDaemon(); }
    // current Host Actions, minus the profile-cycle bindings (those must never be captured into a profile)
    function captureHotkeys() {
      let acts = []; try { acts = JSON.parse(localStorage.getItem('th108_host_actions') || '[]'); } catch (_) {}
      return (typeof window !== 'undefined' && window.TH108ProfileCycle) ? window.TH108ProfileCycle.stripCycleBindings(acts) : acts;
    }
    // Mirror the profile list to the daemon so the Host Actions "Profile → Next/Prev" key can cycle them with
    // this page closed (the daemon applies a profile's layers + config.json straight to the board).
    function pushToDaemon(list) {
      try { fetch('/profiles', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profiles: (list || load()).map(p => ({ name: p.name, layers: p.layers || [], order: p.order || null, type: p.type || 'lighting', color: p.color || '', hostActions: p.hostActions || [] })),
          indicator: loadIndicator()
        }) }).catch(() => {}); } catch (_) {}
    }
    function store(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { } pushToDaemon(list); }

    function snapshot(name, type, color) {
      flushSave();   // flush the live layer state to localStorage first, same as Toolbox Export
      const t = type || 'lighting';
      const p = { name, type: t, color: color || '', savedAt: Date.now() };
      if (t !== 'hotkey') { const cur = getCurrent(); p.layers = cur.layers; p.order = cur.order; }   // lighting/global capture layers
      else { p.layers = []; p.order = null; }
      if (t === 'hotkey' || t === 'global') p.hostActions = captureHotkeys();
      return p;
    }

    function render() {
      const list = load(), host = $('profList');
      host.textContent = '';
      $('profCount').textContent = list.length + ' / ' + MAX_PROFILES;
      $('profSave').disabled = !canAdd(list);
      $('profImport').disabled = !canAdd(list);
      if (!list.length) {
        const p = document.createElement('p'); p.className = 'hint'; p.style.margin = '0';
        p.textContent = 'No profiles yet — set up your layers on the Lighting tab, then Save Current as Profile.';
        host.appendChild(p);
        return;
      }
      list.forEach((prof, i) => {
        const row = document.createElement('div'); row.className = 'profrow';
        const name = document.createElement('input');
        name.type = 'text'; name.value = prof.name; name.maxLength = NAME_MAX; name.spellcheck = false;
        name.title = 'rename — saved when you click away';
        name.addEventListener('change', () => {
          const l = load(); l[i].name = sanitizeName(name.value, l[i].name); store(l);
          name.value = l[i].name;
          log('profile renamed → "' + l[i].name + '"', 'dim');
        });
        row.appendChild(name);
        const typeSel = document.createElement('select');
        typeSel.title = 'what this profile switches when applied or cycled';
        [['lighting', 'Lighting'], ['hotkey', 'Hotkey'], ['global', 'Global']].forEach(o => {
          const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1];
          if ((prof.type || 'lighting') === o[0]) op.selected = true; typeSel.appendChild(op);
        });
        typeSel.addEventListener('change', () => { const l = load(); l[i].type = typeSel.value; store(l); render(); });
        row.appendChild(typeSel);
        const color = document.createElement('input');
        color.type = 'color'; color.value = prof.color || '#888888'; color.title = 'on-keyboard flash color for this profile';
        color.addEventListener('input', () => { const l = load(); l[i].color = color.value; store(l); });
        row.appendChild(color);
        const btn = (label, title, fn, cls) => {
          const b = document.createElement('button'); b.textContent = label; b.title = title;
          if (cls) b.className = cls;
          b.addEventListener('click', fn); row.appendChild(b); return b;
        };
        btn('Apply', 'apply this profile live (no reload)', () => {
          if (!confirm('Apply "' + prof.name + '"?\n\nThis replaces your current setup live (save it as a profile first to keep it).')) return;
          applyData(prof, i);
        }, 'go');
        btn('Update', 'overwrite this profile from the current setup (per its type)', () => {
          const l = load(); l[i] = snapshot(l[i].name, l[i].type, l[i].color); store(l);
          log('✓ profile "' + l[i].name + '" updated', 'ok');
          render();
        });
        btn('Export', 'download this profile as JSON', () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([JSON.stringify({ name: prof.name, layers: prof.layers, order: prof.order })], { type: 'application/json' }));
          a.download = 'th108-profile-' + fileSlug(prof.name) + '.json'; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          log('✓ exported profile "' + prof.name + '"', 'ok');
        });
        btn('✕', 'delete this profile', () => {
          if (!confirm('Delete profile "' + prof.name + '"?')) return;
          const l = load(); l.splice(i, 1); store(l);
          log('profile "' + prof.name + '" deleted', 'dim');
          render();
        });
        host.appendChild(row);
      });
    }

    $('profSave').addEventListener('click', () => {
      const list = load();
      if (!canAdd(list)) { log('profile limit reached (' + MAX_PROFILES + ') — delete one first', 'err'); return; }
      const prof = snapshot(defaultName(list), 'lighting', defaultColor(list.length));
      list.push(prof); store(list);
      log('✓ saved current setup as "' + prof.name + '" (' + prof.layers.length + ' layers) — click its name to rename', 'ok');
      render();
    });
    $('profImport').addEventListener('click', () => $('profFile').click());
    $('profFile').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const imp = normalizeImport(JSON.parse(await f.text()));
        const list = load();
        if (!canAdd(list)) { log('profile limit reached (' + MAX_PROFILES + ') — delete one first', 'err'); return; }
        const name = sanitizeName(imp.name, defaultName(list));
        list.push({ name, type: 'lighting', color: defaultColor(list.length), layers: imp.layers, order: imp.order, savedAt: Date.now() }); store(list);
        log('✓ imported profile "' + name + '" (' + imp.layers.length + ' layers)', 'ok');
        render();
      } catch (err) { log('profile import failed: ' + (err && err.message || err), 'err'); }
    });

    (function buildIndicatorRow() {
      const host = $('profList'); if (!host || !host.parentNode || $('profIndRow')) return;
      const ind = loadIndicator();
      const row = document.createElement('div'); row.id = 'profIndRow'; row.className = 'hint';
      row.style.cssText = 'display:flex;align-items:center;gap:14px;margin:0 0 10px;flex-wrap:wrap';
      row.innerHTML =
        '<label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="profIndOn"' + (ind.on ? ' checked' : '') + '> Flash the profile number on switch</label>' +
        '<label style="display:flex;align-items:center;gap:6px;margin:0">Keys <select id="profIndKeys"><option value="numberRow"' + (ind.keys !== 'numpad' ? ' selected' : '') + '>Number row</option><option value="numpad"' + (ind.keys === 'numpad' ? ' selected' : '') + '>Numpad</option></select></label>' +
        '<span style="opacity:.65">Bind the cycle key on the <b>Host Actions</b> tab (Profile → Next / Previous / Jump).</span>';
      host.parentNode.insertBefore(row, host);
      $('profIndOn').addEventListener('change', () => { const v = loadIndicator(); v.on = $('profIndOn').checked; saveIndicator(v); });
      $('profIndKeys').addEventListener('change', () => { const v = loadIndicator(); v.keys = $('profIndKeys').value; saveIndicator(v); });
    })();

    render();
    pushToDaemon();   // initial sync so the daemon has the current profiles even with no edit this session
    return { render };
  }

  return { create, MAX_PROFILES, sanitizeName, canAdd, defaultName, normalizeImport, fileSlug };
});
