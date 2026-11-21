'use strict';

/*
 * A computer that does not let Shroudly create files (a report from Türkiye,
 * 2.6.87: every new file refused with ENOENT, in the temporary folder and in
 * Shroudly's own, so Advanced mode, Tor, the settings, the ad list and the
 * Discord app mode all failed one after another, in lines that said nothing
 * of why). Two causes are told apart:
 *
 *   - the system's temporary folder is gone (a cleaning program deleted
 *     it): made again, at start and whenever a write there fails;
 *   - new files are refused (security software, or Windows' Controlled
 *     folder access): looked at with a probe file in Shroudly's folder and
 *     in the temporary one, said once in plain words, and Advanced mode is
 *     not tried again by itself this session (main.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WRITE_ERRORS = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBADF']);

/* The temporary folder, made again if it is gone. true when it is there. */
function ensureTmp(dir = os.tmpdir()) {
  try { fs.mkdirSync(dir, { recursive: true }); return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/* Can a new file be made in dir? (made if missing, written, removed) */
function canCreate(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.shroudly-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

class WriteGuard {
  /* dirs: the folders Shroudly writes in (its data folder; the temporary
   * folder is always added). log(level, msg). */
  constructor({ dirs = [], log = () => {}, tmp = () => os.tmpdir() } = {}) {
    this.dirs = dirs;
    this.log = log;
    this.tmp = tmp;
    this.refused = null;   // the folders new files are refused in, once found
    this.told = false;
  }

  /* An error from writing a file: if it is one a refused or missing folder
   * gives, the temporary folder is made again and the folders looked at.
   * Returns true when new files are refused (said once). */
  note(err) {
    const code = err && err.code;
    if (!WRITE_ERRORS.has(code)) return !!this.refused;
    if (this.refused) return true;
    ensureTmp(this.tmp());
    const bad = [...this.dirs, this.tmp()].filter((d) => d && !canCreate(d));
    if (!bad.length) return false;
    this.refused = bad;
    if (!this.told) {
      this.told = true;
      this.log('warning', `This computer does not let Shroudly create files (in ${bad.join(', ')}): security software, or Windows' Controlled folder access (Windows Security → Ransomware protection), blocks it. Allow Shroudly there; until then Advanced mode, the last way out (Tor), saving settings and the Discord app mode cannot work`);
    }
    return true;
  }
}

module.exports = { WriteGuard, ensureTmp, canCreate, WRITE_ERRORS };
