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
  {
    // The tray and the menu bar: Shroudly's logo, as at the window's top
    // left, its eye open while on and shut in grey while off, in every size
    // (Windows' .ico, @2x and @3x elsewhere), shipped, and the window's and
    // notifications' icon the logo itself, never a blurred small copy.
    const fs = require('fs');
    const pub = (f) => path.join(ROOT, 'public', f);
    const ico = (f) => { const b = fs.readFileSync(pub(f)); return b.readUInt16LE(2) === 1 ? b.readUInt16LE(4) : 0; };
    t.ok(ico('tray-on.ico') >= 6 && ico('tray-off.ico') >= 6
      && ['tray-on.png', 'tray-on@2x.png', 'tray-on@3x.png', 'tray-off.png', 'tray-off@2x.png', 'tray-off@3x.png'].every((f) => fs.existsSync(pub(f))),
      'tray icons in every size, on and off');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const shipped = JSON.stringify(pkg.build.extraResources);
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    t.ok(/tray-on\*/.test(shipped) && /tray-off\*/.test(shipped) && /"public\/icon\.png"/.test(shipped)
      && /iconAssetPath\('icon\.png'\)/.test(main) && !/icon-small/.test(main),
      'shipped, and the window and notifications use the logo at full size');
  }
  // W4: Settings > Reset all settings restarts Shroudly; a copy started at
  // login must come back with its window, not into the tray.
  t.ok(JSON.stringify(Launch.relaunchArgs(['C:\\Shroudly\\Shroudly.exe', '--autostart'])) === '[]'
    && JSON.stringify(Launch.relaunchArgs(['/usr/bin/electron', '.', '--autostart', '--updated', '--update-failed', '--no-sandbox'])) === '[".","--no-sandbox"]',
  'a restart by Reset: without --autostart (or an update\'s arguments), so the window comes back where the button was pressed');
  t.ok(Launch.startWindow({ autoStart: false, minimizeToTray: true, trayShown: true }) === 'shown', '…and that start shows the window');

  // W9: never taller than the screen above the taskbar.
  const h = Launch.windowHeights;
  t.ok(JSON.stringify(h(1040)) === '{"height":760,"minHeight":560}' && JSON.stringify(h(0)) === '{"height":760,"minHeight":560}',
    'a usual screen (or one that cannot be read): 760 high, 560 at least, as before');
  t.ok(JSON.stringify(h(492)) === '{"height":492,"minHeight":492}' && JSON.stringify(h(464)) === '{"height":464,"minHeight":464}',
    '1080p at 200% (492 above the taskbar), 1366x768 at 150% (464): the window fits, tabs and all, and the page scrolls');
  t.ok(h(200).minHeight === 200 && h(680).height === 680 && h(680).minHeight === 560, 'never more than the screen has, never less than it needs to');

  // W10: the tray tells protection off from on (Windows, Linux).
  const px = Launch.grayPixels(Buffer.from([0, 128, 255, 255, 10, 20, 30, 0]));
  t.ok(px[0] === 128 && px[1] === 128 && px[2] === 128 && px[3] === 153 && px[4] === 20 && px[7] === 0,
    'protection off: the icon in gray, a little faded (see-through stays see-through)');
  const main = require('fs').readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(/tray\.setImage\(makeTrayIcon\((active|look)\)\);/.test(main) && !/if \(process\.platform === 'darwin'\) tray\.setImage/.test(main)
    && /tray-\$\{active \? 'on' : 'off'\}/.test(main),
    '…switched with protection on every system (the eye open or shut), not only macOS');
  t.ok(/if \(!store\.get\('closeToldInTray', false\)\)/.test(main), 'closing the window says "still running in the tray" the first time only, not at every close');

  // W3: start at login turned off in Task Manager or Settings stays off.
  const off = Launch.startupTurnedOff;
  const item = (enabled) => ({ openAtLogin: true, executableWillLaunchAtLogin: enabled, launchItems: [{ name: 'Shroudly', path: 'C:\\S\\Shroudly.exe', args: ['--autostart'], scope: 'user', enabled }] });
  t.ok(off(item(false)) === true && off(item(true)) === false, 'turned off in Task Manager (StartupApproved): seen as off; on: on');
  t.ok(off({ openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] }) === false && off(null) === false,
    'no entry at all: not "turned off in Windows" (Shroudly\'s own switch is off)');
  t.ok(off({ openAtLogin: true, executableWillLaunchAtLogin: false }) === true, 'an Electron that lists no launch items: its own answer');
  const mainSrc = require('fs').readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(/store\.get\('autoStart', false\) === true && windowsStartupOff\(\)/.test(mainSrc) && /discordLineOutlivesSession\(\) \{ return store\.get\('autoStart', false\) === true && !windowsStartupOff\(\); \}/.test(mainSrc),
    '…then Shroudly\'s switch is off too (not turned back on at the next launch), and Discord\'s line is not kept for a login at which Shroudly will not start');

  console.log(`launch: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
