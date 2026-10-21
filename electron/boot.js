'use strict';

/*
 * Which boot of this computer we are in, told without the wall clock.
 *
 * A record left by a Shroudly (the system proxy's state file, Games and apps
 * mode's) names its process by its id, and an id from before a restart names
 * some other process now; so the record also says which boot it was made in.
 * "Now minus the uptime" moves with the clock: a clock set at login by NTP
 * (a dual-boot machine whose other system keeps the hardware clock in local
 * time is hours off), or by hand, made a running Shroudly look like one from
 * another boot, and the login restore then took its system proxy away. So
 * the boot is told by what the system itself names it:
 *   Linux    /proc/sys/kernel/random/boot_id
 *   macOS    kern.bootsessionuuid
 *   Windows  the time of the last shutdown (HKLM\...\Control\Windows
 *            ShutdownTime), written once per shutdown or restart, never by
 *            a sleep
 * and only when that cannot be read, by the time it started, with the
 * tolerance it always had.
 */

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let cached;
let reader = defaultReader;

function defaultReader(platform = process.platform) {
  try {
    if (platform === 'linux') return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    if (platform === 'darwin') {
      return String(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 3000, encoding: 'utf8' })).trim() || null;
    }
    if (platform === 'win32') {
      const out = String(execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Windows', '/v', 'ShutdownTime'],
        { timeout: 3000, encoding: 'utf8', windowsHide: true }));
      const m = /ShutdownTime\s+REG_BINARY\s+([0-9A-F]+)/i.exec(out);
      return m ? `shutdown-${m[1].toUpperCase()}` : null;
    }
  } catch {}
  return null;
}

/* This boot's name, or null where the system does not say. Read once: it
 * cannot change while this process runs. */
function bootKey() {
  if (cached === undefined) cached = reader() || null;
  return cached;
}

/* When this boot started, in seconds, by the wall clock (the fallback). */
function bootTime() { return Math.round(Date.now() / 1000 - os.uptime()); }

/* Was a record with { boot, bootKey } made in this boot? By the name when
 * both have one; else by the time, within `toleranceS`. A record with
 * neither is taken to be of this boot. */
function sameBoot(rec, toleranceS = 120) {
  if (!rec) return false;
  const key = bootKey();
  if (rec.bootKey && key) return rec.bootKey === key;
  if (!rec.boot) return true;
  return Math.abs(rec.boot - bootTime()) <= toleranceS;
}

/* Tests: stand in for the system (fn() -> key or null). */
function _setReader(fn) { reader = fn || defaultReader; cached = undefined; }

module.exports = { bootKey, bootTime, sameBoot, _setReader };
