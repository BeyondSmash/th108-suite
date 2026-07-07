'use strict';
// Spawns focus-detect.ps1 (the foreground-VSCode-window watcher) and feeds each JSON line back to the
// daemon so the agent layer's 'focus' mode can follow whichever Claude/VSCode window is frontmost — with
// NO external app. Only run while Follow-focus is actually active (the daemon gates start()/stop()). Mirrors
// the media-sidecar lifecycle: idempotent spawn, only the current proc's exit respawns, helper self-recycles.
const { spawn } = require('child_process');
const path = require('path');

function createFocusPoll(opts = {}) {
  const onLine = opts.onLine || (() => {});
  const log = opts.log || (() => {});
  let proc = null, stopped = true;

  function spawnHelper() {
    if (stopped) return;
    if (proc) { try { proc.kill(); } catch (_) {} proc = null; }   // never two at once
    const p = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'focus-detect.ps1')],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc = p;
    let carry = '';
    p.stdout.on('data', (d) => {
      carry += d.toString('utf8');
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch (_) { }
      }
    });
    p.on('exit', () => { if (proc !== p) return; proc = null; if (!stopped) setTimeout(spawnHelper, 3000); });   // helper self-recycled → respawn
  }
  function start() { if (!stopped) return; stopped = false; spawnHelper(); log('👁 focus poller ON — following the foreground VSCode window'); }
  function stop() { if (stopped) return; stopped = true; if (proc) { try { proc.kill(); } catch (_) { } proc = null; } log('👁 focus poller OFF'); }
  function running() { return !stopped; }
  return { start, stop, running };
}

module.exports = { createFocusPoll };
