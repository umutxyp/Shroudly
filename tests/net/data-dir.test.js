'use strict';

/* Where Shroudly keeps its data (electron/data-dir.js, issue #72). Covered:
 *   - the default folder when nothing is chosen
 *   - portable: a "Shroudly Data" folder next to the program wins (next to
 *     Shroudly.app on a Mac, next to the AppImage on Linux, next to the exe
 *     of a copy that was not installed on Windows), never inside an installed
 *     Windows copy (every update empties it)
 *   - a folder chosen in Settings, through the pointer in the default folder;
 *     one not reachable now: the default for this run, and said
 *   - a change copies everything but caches, locks and this computer's own
 *     state, overwrites nothing, leaves the old folder, and is what the next
 *     start uses; back to the default; leaving a portable folder */

const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../../electron/data-dir');
const H = require('./helpers');

const t = H.suite('data-dir');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-datadir-'));
const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const def = mk('appdata', 'Shroudly');
write(path.join(def, 'config.json'), '{"language":"tr"}');
write(path.join(def, 'logs', 'today.log'), 'x');
write(path.join(def, 'Local Storage', 'leveldb', '000003.log'), 'ls');
write(path.join(def, 'proxy-state.json'), '{}');
write(path.join(def, 'Cache', 'data_0'), 'cache');
write(path.join(def, 'SingletonLock'), '');

// Program folders as each system has them.
const macApps = mk('mac');
const macExec = path.join(macApps, 'Shroudly.app', 'Contents', 'MacOS', 'Shroudly');
const winInstalled = mk('win-installed');
write(path.join(winInstalled, 'Uninstall Shroudly.exe'), '');
const winLoose = mk('win-loose');
const linuxDir = mk('linux');

let r = D.resolve({ defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
t.ok(r.dir === def && r.how === 'default' && !r.problem, 'nothing chosen: the default folder');
t.ok(D.programDir({ platform: 'darwin', execPath: macExec, env: {} }) === macApps, 'a Mac: the folder Shroudly.app is in');
t.ok(D.programDir({ platform: 'linux', execPath: '/tmp/.mount_x/shroudly', env: { APPIMAGE: path.join(linuxDir, 'Shroudly.AppImage') } }) === linuxDir, 'Linux: the folder the AppImage is in');

mk('mac', 'Shroudly Data');
r = D.resolve({ defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
t.ok(r.how === 'portable' && r.dir === path.join(macApps, 'Shroudly Data'), 'portable: "Shroudly Data" next to Shroudly.app is used');

mk('win-installed', 'Shroudly Data');
r = D.resolve({ defaultDir: def, platform: 'win32', execPath: path.join(winInstalled, 'Shroudly.exe'), env: {} });
t.ok(r.how === 'default' && r.problem && r.problem.kind === 'portable-installed' && /every update empties/.test(D.problemLine(r.problem)),
  'never inside an installed Windows copy: the default, and the log says why');
mk('win-loose', 'Shroudly Data');
r = D.resolve({ defaultDir: def, platform: 'win32', execPath: path.join(winLoose, 'Shroudly.exe'), env: {} });
t.ok(r.how === 'portable', 'a Windows copy that was not installed: portable');
t.ok(D.choices({ current: r, defaultDir: def, platform: 'win32', execPath: path.join(winInstalled, 'Shroudly.exe'), env: {} }).portable === null,
  'Settings offers no portable folder for an installed Windows copy');

// Chosen in Settings.
const cur = D.resolve({ defaultDir: def, platform: 'linux', execPath: path.join(linuxDir, 'shroudly'), env: {} });
const usb = path.join(root, 'usb', 'Shroudly');
let c = D.choose(usb, { current: cur, defaultDir: def, platform: 'linux', execPath: path.join(linuxDir, 'shroudly'), env: {} });
t.ok(c.ok && c.dir === usb, 'a folder chosen: done');
t.ok(fs.readFileSync(path.join(usb, 'config.json'), 'utf8') === '{"language":"tr"}' && fs.existsSync(path.join(usb, 'logs', 'today.log'))
  && fs.existsSync(path.join(usb, 'Local Storage', 'leveldb', '000003.log')), 'the settings, the logs and the window\'s storage are copied');
t.ok(!fs.existsSync(path.join(usb, 'Cache')) && !fs.existsSync(path.join(usb, 'SingletonLock')) && !fs.existsSync(path.join(usb, 'proxy-state.json')),
  'not the caches, the locks, nor this computer\'s own state (it stays in the default folder)');
t.ok(fs.existsSync(path.join(def, 'config.json')), 'the old folder is left as it was');
r = D.resolve({ defaultDir: def, platform: 'linux', execPath: path.join(linuxDir, 'shroudly'), env: {} });
t.ok(r.how === 'custom' && r.dir === usb, 'the next start uses it');

// Nothing overwritten in a folder that has things already.
write(path.join(def, 'config.json'), '{"language":"de"}');
const back = D.choose('default', { current: r, defaultDir: def, platform: 'linux', execPath: path.join(linuxDir, 'shroudly'), env: {} });
t.ok(back.ok && fs.readFileSync(path.join(def, 'config.json'), 'utf8') === '{"language":"de"}', 'nothing already there is overwritten');
t.ok(D.resolve({ defaultDir: def, platform: 'linux', execPath: path.join(linuxDir, 'shroudly'), env: {} }).how === 'default', 'back to the default');

// A chosen folder not reachable now.
fs.writeFileSync(path.join(def, D.POINTER), JSON.stringify({ dir: path.join(root, 'file-not-folder', 'x') }));
fs.writeFileSync(path.join(root, 'file-not-folder'), 'a file stands where the folder would be');
r = D.resolve({ defaultDir: def, platform: 'linux', execPath: path.join(linuxDir, 'shroudly'), env: {} });
t.ok(r.how === 'default' && r.problem && r.problem.kind === 'unreachable' && /not reachable now/.test(D.problemLine(r.problem)),
  'a chosen folder not reachable now: the default for this run, and said');
fs.unlinkSync(path.join(def, D.POINTER));

// Refused: inside an installed Windows copy; a relative path.
const inst = D.resolve({ defaultDir: def, platform: 'win32', execPath: path.join(winInstalled, 'Shroudly.exe'), env: {} });
t.ok(D.choose(path.join(winInstalled, 'data'), { current: inst, defaultDir: def, platform: 'win32', execPath: path.join(winInstalled, 'Shroudly.exe'), env: {} }).error === 'installed',
  'a folder inside an installed Windows copy is refused');
t.ok(D.choose('relative/dir', { current: inst, defaultDir: def }).error === 'path', 'a relative path is refused');

// Leaving a portable folder: marked, and no longer used.
const port = D.resolve({ defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
c = D.choose('default', { current: port, defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
r = D.resolve({ defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
t.ok(c.ok && fs.existsSync(path.join(port.dir, D.LEFT)) && r.how === 'default', 'leaving a portable folder: it says it is not in use, and is not used');
c = D.choose('portable', { current: r, defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
r = D.resolve({ defaultDir: def, platform: 'darwin', execPath: macExec, env: {} });
t.ok(c.ok && r.how === 'portable', 'and chosen again from Settings: in use again');

fs.rmSync(root, { recursive: true, force: true });
console.log(`data-dir: ${t.count} passed`);
