'use strict';

/*
 * Discord app mode's line in Discord's settings (discord-app.js), when
 * Shroudly ends without taking it out: ended in Task Manager (or a whole
 * process tree), crashed, a cafe's reset tool, a power cut, another VPN
 * installed meanwhile. The line points Discord's updater at a relay that
 * lived inside Shroudly, so the next Discord waited on "Checking for
 * updates" until Shroudly was opened again or uninstalled.
 *
 * So while the line is there, a state file says which settings files carry
 * it and which Shroudly wrote it (main.js). The watchdog, which outlives
 * Shroudly, starts the restore when Shroudly vanishes with it there
 * (watchdog.js, kind 'discord'), and so does the restore at the next login
 * (restore-proxy.js). Only our own loopback value is taken out (discord-app
 * patchSync), and nothing while the Shroudly that wrote it still runs; at a
 * login after which Shroudly starts by itself with Discord app mode on, the
 * line stays for it (main.js keeps it at a logoff for that).
 */

const fs = require('fs');
const path = require('path');

function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

/* The line is in these settings files now. owner: SystemProxy._owner(). */
function note(stateFile, files, owner) {
  const list = [...new Set((files || []).filter(Boolean))];
  if (!list.length) { clear(stateFile); return false; }
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, files: list, owner }));
    fs.renameSync(tmp, stateFile);
    return true;
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} return false; }
}

function clear(stateFile) { try { fs.rmSync(stateFile, { force: true }); } catch {} }

/* Take the line out where the state file says it is.
 *   ownerAlive(owner)  the Shroudly that wrote it still runs: left alone
 *   keep               it stays for a Shroudly about to start (a login)
 *   patch(file, null)  discord-app's patchSync (tests: a stand-in)
 * Returns 'none', 'running', 'kept', or how many files it was taken from. */
function recoverSync({ stateFile, ownerAlive = () => false, keep = false, patch = null } = {}) {
  const state = readState(stateFile);
  if (!state) { if (fs.existsSync(stateFile)) clear(stateFile); return 'none'; }
  try { if (state.owner && ownerAlive(state.owner)) return 'running'; } catch {}
  if (keep) return 'kept';
  const unpatch = patch || require('./discord-app').patchSync;
  let n = 0;
  for (const file of Array.isArray(state.files) ? state.files : []) {
    try { if (unpatch(String(file), null) === 'changed') n++; } catch {}
  }
  clear(stateFile);
  return n;
}

module.exports = { note, clear, recoverSync, readState };
