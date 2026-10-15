'use strict';

/*
 * How Shroudly comes up: in the tray only, with its window, or with its
 * window minimised. Apart from main.js so the rules can be tested without
 * Electron.
 */

const { execFile } = require('child_process');

/* Is the tray icon visible at all? Not on a stock GNOME (Fedora, Debian):
 * it shows tray icons only with an extension. There, a window sent to the
 * tray or closed for being idle would leave Shroudly running with nothing on
 * screen to bring it back, so the window is minimised instead and never closed
 * for being idle. Asked once, of the session bus: is a StatusNotifier host
 * (what Electron draws tray icons with) listening? An X11 session that is not
 * GNOME still has the classic tray as a fallback. Resolves true or false;
 * `ask` stands in for the D-Bus question in tests. */
function trayVisible({ platform = process.platform, env = process.env, ask } = {}) {
  if (platform !== 'linux') return Promise.resolve(true);
  // Tests run both ways on one machine (tests/e2e).
  if (/^(present|absent)$/.test(env.SHROUDLY_TRAY || '')) return Promise.resolve(env.SHROUDLY_TRAY === 'present');
  const desktop = String(env.XDG_CURRENT_DESKTOP || '');
  const x11Tray = env.XDG_SESSION_TYPE === 'x11' && !/GNOME/i.test(desktop);
  const query = ask || ((cb) => execFile('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher'],
  { timeout: 3000 }, cb));
  return new Promise((resolve) => {
    try {
      query((err, out) => {
        const sni = !err && /boolean true/.test(String(out));
        resolve(sni || x11Tray || (!!err && !/GNOME/i.test(desktop)));
      });
    } catch { resolve(!/GNOME/i.test(desktop)); }
  });
}

/* What an update leaves for the copy it starts: whether the window was open
 * on screen, and which version did the installing. */
function afterUpdateRecord(window, version, now = Date.now()) {
  return { window: !!window, from: String(version), at: now };
}

/* Is this launch the one an update started? Only when the version has
 * changed since the record was written, and soon after it: a record left by
 * an update that never got as far as starting Shroudly again must not decide
 * how a later launch, started by hand, looks. One without a version (written
 * before 2.5.5) cannot tell, so the window is shown. main.js clears the
 * record either way. */
const AFTER_UPDATE_MS = 30 * 60 * 1000;
function isUpdateRelaunch(record, version, now = Date.now()) {
  if (!record || typeof record !== 'object' || record.from === undefined) return false;
  const at = Number(record.at) || 0;
  return String(record.from) !== String(version) && now - at < AFTER_UPDATE_MS && now - at > -60000;
}

/* 'tray' (no window at all), 'minimised' or 'shown'. Started at login with
 * "minimize to tray" on, or back from an update installed while the window
 * was closed: the tray only, where a tray can be seen. Without one, nothing
 * on screen could bring a window back that is not there, so it comes up
 * minimised in the taskbar instead. */
function startWindow({ autoStart, minimizeToTray, afterUpdate, trayShown }) {
  const quiet = (autoStart && minimizeToTray) || !!(afterUpdate && afterUpdate.window === false);
  if (!quiet) return 'shown';
  return trayShown ? 'tray' : 'minimised';
}

module.exports = { trayVisible, afterUpdateRecord, isUpdateRelaunch, startWindow, AFTER_UPDATE_MS };
