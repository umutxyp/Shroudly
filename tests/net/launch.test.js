'use strict';

/* How Shroudly comes up (electron/launch.js). It must never come up with no
 * window and no tray icon (stock GNOME on Fedora or Debian shows none), and
 * only the copy an update started may come up the way the update left it. */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const Launch = require(path.join(ROOT, 'electron', 'launch.js'));
const t = suite('launch');

(async () => {
  // ── is there a tray icon to come back from? ──
  const gnome = { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' };
  const answer = (err, out) => (cb) => setTimeout(() => cb(err, out), 20);
  const visible = (env, ask) => Launch.trayVisible({ platform: 'linux', env, ask });
  const p = visible(gnome, answer(null, '   boolean false'));
  t.ok(p instanceof Promise && (await p) === false, 'stock GNOME, no StatusNotifier host: no tray (answered as a promise the launch waits for)');
  t.ok(await visible(gnome, answer(null, '   boolean true')) === true, 'GNOME with the AppIndicator extension: tray');
  t.ok(await visible({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' }, answer(new Error('no dbus-send'))) === true, 'not GNOME, the question cannot be asked: assumed there');
  t.ok(await visible({ XDG_CURRENT_DESKTOP: 'XFCE', XDG_SESSION_TYPE: 'x11' }, answer(null, 'boolean false')) === true, 'X11 outside GNOME: the classic tray');
  t.ok(await visible({ ...gnome, SHROUDLY_TRAY: 'absent' }, answer(null, 'boolean true')) === false, 'the e2e tests can choose');
  t.ok(await Launch.trayVisible({ platform: 'win32' }) === true && await Launch.trayVisible({ platform: 'darwin' }) === true, 'Windows and macOS always have one');

  // ── with the window, minimised, or in the tray only ──
  const W = Launch.startWindow;
  t.ok(W({ autoStart: true, minimizeToTray: true, afterUpdate: null, trayShown: true }) === 'tray', 'started at login with a tray: tray only');
  t.ok(W({ autoStart: true, minimizeToTray: true, afterUpdate: null, trayShown: false }) === 'minimised', 'started at login without a tray: minimised, never invisible');
  t.ok(W({ autoStart: false, minimizeToTray: true, afterUpdate: { window: false }, trayShown: false }) === 'minimised', 'back from an update without a tray: minimised, never invisible');
  t.ok(W({ autoStart: false, minimizeToTray: true, afterUpdate: { window: false }, trayShown: true }) === 'tray', 'back from an update with the window closed: tray only');
  t.ok(W({ autoStart: false, minimizeToTray: true, afterUpdate: null, trayShown: true }) === 'shown'
    && W({ autoStart: true, minimizeToTray: false, afterUpdate: null, trayShown: true }) === 'shown'
    && W({ autoStart: false, minimizeToTray: true, afterUpdate: { window: true }, trayShown: true }) === 'shown', 'started by hand, or with "minimize to tray" off: the window');

  // ── the update's note, for the copy it started only ──
  const now = Date.now();
  const rec = Launch.afterUpdateRecord(false, '2.5.5', now);
  t.ok(rec.window === false && rec.from === '2.5.5' && rec.at === now, 'an update notes the window and the version it replaces');
  t.ok(Launch.isUpdateRelaunch(rec, '2.5.6', now + 20000), 'the copy the update started: the note counts');
  t.ok(!Launch.isUpdateRelaunch(rec, '2.5.5', now + 20000), 'the update never got to run: the same version, started by hand, ignores it');
  t.ok(Launch.isUpdateRelaunch(rec, '2.5.5', now + 20000, { failed: true })
    && W({ autoStart: false, minimizeToTray: true, afterUpdate: rec, trayShown: true }) === 'tray',
  'macOS: opened again by the install script after its swap failed (the same version): back the way it was, no window that was closed before');
  t.ok(!Launch.isUpdateRelaunch(rec, '2.5.5', now + Launch.AFTER_UPDATE_MS + 1000, { failed: true }), '…but not from a note of long ago');
  t.ok(!Launch.isUpdateRelaunch(rec, '2.5.6', now + Launch.AFTER_UPDATE_MS + 1000), 'a note from long ago is not about this launch');
  t.ok(!Launch.isUpdateRelaunch({ window: false }, '2.5.5', now) && !Launch.isUpdateRelaunch(null, '2.5.5', now) && !Launch.isUpdateRelaunch('x', '2.5.5', now),
    'a note that cannot say which update it was about: the window is shown');

  {
    // macOS, run from its disk image or Downloads (ML-5): nothing registered
    // for login (the login item, the restore agent) until it is moved, and
    // the window offers the move.
    const fs = require('fs');
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const notice = fs.readFileSync(path.join(ROOT, 'components', 'BlockedNotice.js'), 'utf8');
    t.ok(/app\.isInApplicationsFolder\(\)/.test(main) && /if \(enable && outsideApplications\(\)\) return true;/.test(main)
      && /restoreCommand: outsideApplications\(\) \? null : restoreCommand/.test(main) && /app\.moveToApplicationsFolder\(/.test(main),
      'macOS outside Applications: no login item or restore agent pointing at a temporary path, and the move is there');
    t.ok(/moveToApplications\?\.\(\)/.test(notice) && /t\('moveToAppsBtn'\)/.test(notice), 'the window offers it with one button');
  }
  console.log(`launch: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
