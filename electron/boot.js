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
 *            a sleep. A power cut or a crash writes nothing, so the record
 *            also keeps how long the computer had been up when it was made
 *            (os.uptime(), which no clock change moves): less now means
 *            another boot since.
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

/* How long this computer has been up, in seconds. */
let uptimeNow = () => os.uptime();
function uptime() { return Math.round(uptimeNow()); }

/* What a record keeps to tell its boot by. */
function record() { return { boot: bootTime(), bootKey: bootKey(), uptime: uptime() }; }

// A name that a power cut does not change (Windows' last shutdown).
const weak = (key) => String(key).startsWith('shutdown-');

/* By the boot's name: true or false, or null when either side has none.
 * Windows' name stays the same over a power cut or a crash: there the
 * record's uptime beyond this boot's says it is from an earlier boot. */
function sameBootKey(rec) {
  const key = bootKey();
  if (!rec || !rec.bootKey || !key) return null;
  if (rec.bootKey !== key) return false;
  if (weak(key) && Number.isFinite(rec.uptime) && uptime() + 60 < rec.uptime) return false;
  return true;
}

/* Was a record with { boot, bootKey, uptime } made in this boot? By the
 * name when both have one; else by the time, within `toleranceS`. A record
 * with neither is taken to be of this boot. */
function sameBoot(rec, toleranceS = 120) {
  if (!rec) return false;
  const byKey = sameBootKey(rec);
  if (byKey !== null) return byKey;
  if (!rec.boot) return true;
  return Math.abs(rec.boot - bootTime()) <= toleranceS;
}

/* Tests: stand in for the system (fn() -> key or null; up() -> seconds). */
function _setReader(fn, up = null) { reader = fn || defaultReader; cached = undefined; uptimeNow = up || (() => os.uptime()); }

module.exports = { bootKey, bootTime, uptime, record, sameBoot, sameBootKey, _setReader };
