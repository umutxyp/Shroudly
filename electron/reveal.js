'use strict';

/*
 * A file shown in the file manager (Save logs), without the file manager or
 * whatever opens instead becoming part of Shroudly.
 *
 * Windows and macOS: Electron's shell.showItemInFolder (Explorer, Finder).
 *
 * Linux: Electron asks the desktop's file manager over D-Bus and, when none
 * answers, runs xdg-open as a child of Shroudly that inherits its standard
 * output and error. xdg-open then hands the folder to whatever is set for it
 * (a browser, where no file manager is installed), which keeps those pipes
 * open and stays one of Shroudly's processes after Shroudly has quit: a
 * program waiting for Shroudly's output to end never sees it end (the e2e
 * test waited forever on a runner with no file manager). So here:
 *   - the file manager over D-Bus (org.freedesktop.FileManager1.ShowItems,
 *     which Nautilus, Dolphin, Nemo and Caja answer), with the file selected:
 *     D-Bus starts the file manager itself, never as our child;
 *   - else xdg-open on the folder, started by a shell that leaves at once,
 *     with nothing of ours open in it: it belongs to the session, not to
 *     Shroudly.
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const DBUS_TIMEOUT_MS = 5000;

function dbusShow(file, run) {
  return new Promise((resolve) => {
    run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems', `array:string:${pathToFileURL(file).href}`, 'string:'],
    { timeout: DBUS_TIMEOUT_MS, windowsHide: true }, (err) => resolve(!err));
  });
}

/* xdg-open <dir> from a shell that exits at once: not our child, nothing of
 * ours inherited. */
function openDetached(dir, start) {
  try {
    const c = start('/bin/sh', ['-c', 'xdg-open "$1" >/dev/null 2>&1 </dev/null &', 'sh', dir], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch { return false; }
}

/* Resolves 'dbus', 'xdg-open', 'shell' (Electron's own), or null. deps stand
 * in for the system (tests). */
async function reveal(file, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'linux') {
    try { (deps.shell || require('electron').shell).showItemInFolder(file); return 'shell'; } catch { return null; }
  }
  if (await dbusShow(file, deps.execFile || execFile)) return 'dbus';
  return openDetached(path.dirname(file), deps.spawn || spawn) ? 'xdg-open' : null;
}

module.exports = { reveal, dbusShow, openDetached };
