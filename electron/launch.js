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
 * record either way. failed: the macOS install script opened the same
 * version again after its swap failed (updater.js), which is still the
 * update's launch: a window closed before it must not open by itself. */
const AFTER_UPDATE_MS = 30 * 60 * 1000;
function isUpdateRelaunch(record, version, now = Date.now(), { failed = false } = {}) {
  if (!record || typeof record !== 'object' || record.from === undefined) return false;
  const at = Number(record.at) || 0;
  return (failed || String(record.from) !== String(version)) && now - at < AFTER_UPDATE_MS && now - at > -60000;
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

/* What Shroudly starts itself again with (Settings > Reset all settings):
 * this start's arguments without the ones that said how this start came
 * about. app.relaunch() kept them all, so a copy started at login came back
 * as a login start, into the tray with no window: the app seemed to vanish
 * from under the button just pressed. */
const ONE_START_ARGS = new Set(['--autostart', '--updated', '--update-failed']);
function relaunchArgs(argv) { return (argv || []).slice(1).filter((a) => !ONE_START_ARGS.has(a)); }

/* The window's height and least height on a screen whose work area (above
 * the taskbar) is workHeight: 760 and 560, but never taller than the screen.
 * A small or low-resolution screen with large text (1080p at 200%, 1366x768
 * at 150%, 720p at 125%) has under 560 to give, and the window could not be
 * made short enough to fit: its bottom, with the tabs, was off the screen.
 * The page scrolls in what is left. */
const WINDOW_HEIGHT = 760;
const WINDOW_MIN_HEIGHT = 560;
const WINDOW_FLOOR = 360;
function windowHeights(workHeight) {
  const room = Number(workHeight) > 0 ? Math.floor(Number(workHeight)) : WINDOW_HEIGHT;
  const minHeight = Math.max(Math.min(WINDOW_FLOOR, room), Math.min(WINDOW_MIN_HEIGHT, room));
  return { height: Math.max(minHeight, Math.min(WINDOW_HEIGHT, room)), minHeight };
}

/* The tray icon while protection is off (Windows, Linux): the app icon in
 * gray and a little faded, from its raw 4-byte pixels (BGRA or RGBA: the
 * gray is the same either way to the eye), so the tray says at a glance
 * whether Shroudly protects; before, the icon was the same either way. */
function grayPixels(buf) {
  const px = Buffer.from(buf);
  for (let i = 0; i + 3 < px.length; i += 4) {
    const y = Math.round((px[i] + px[i + 1] + px[i + 2]) / 3);
    px[i] = y; px[i + 1] = y; px[i + 2] = y;
    px[i + 3] = Math.round(px[i + 3] * 0.6);
  }
  return px;
}

/* Windows: Shroudly's login entry is there but turned off in Task
 * Manager's Startup apps or in Settings > Apps > Startup, so Windows will
 * not start it at the next login. settings: Electron's
 * getLoginItemSettings() for that entry. Its own launch item says so
 * (enabled: false); without one, the entry runs but not this program. */
function startupTurnedOff(settings, name = 'Shroudly') {
  if (!settings || !settings.openAtLogin) return false;
  const item = (settings.launchItems || []).find((i) => i && i.name === name);
  if (item && typeof item.enabled === 'boolean') return !item.enabled;
  return settings.executableWillLaunchAtLogin === false;
}

module.exports = { trayVisible, afterUpdateRecord, isUpdateRelaunch, startWindow, relaunchArgs, windowHeights, grayPixels, startupTurnedOff, AFTER_UPDATE_MS };
