'use strict';

/* The settings file (electron/settings-file.js), with the real electron-store
 * main.js uses (a stand-in that keeps its file the same way where it is not
 * installed) and a stand-in for Electron. What it proves:
 *   - a damaged config.json (empty, NUL bytes, cut short, not an object)
 *     no longer stops Shroudly at its first line: it is set aside and the
 *     copy kept at the last good start takes its place, else a new install's
 *     settings; a file damaged while Shroudly runs reads as empty
 *   - a damaged file never replaces a good copy
 *   - protection is what the user's Start or Stop left, never Auto mode or
 *     the strategy: older settings get it written down once, as they were
 *   - a new install starts with the computer; an earlier install, a copy run
 *     from its source folder and a user who turned it off do not change
 *   - settings lost with no copy keep the system's own login entry */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { ROOT, suite } = require('./helpers');

const t = suite('settings-file');
const SF = require(path.join(ROOT, 'electron', 'settings-file.js'));

// electron-store asks Electron where the user's data is: each test its own.
let userData = null;
const electron = { app: { getPath: () => userData, getVersion: () => '2.6.44' }, ipcMain: { on() {} } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
// What electron-store (conf) does with its file, where it is not installed:
// the Linux containers run these tests without npm ci.
class FileStore {
  constructor(opts = {}) { this.clear = !!opts.clearInvalidConfig; this.path = path.join(userData, 'config.json'); void this.store; }
  get store() {
    let text;
    try { text = fs.readFileSync(this.path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    try { return Object.assign({}, JSON.parse(text)); } catch (e) { if (this.clear) return {}; throw e; }
  }
  get size() { return Object.keys(this.store).length; }
  has(k) { return k in this.store; }
  get(k, d) { const s = this.store; return k in s ? s[k] : d; }
  set(k, v) { const s = this.store; s[k] = v; fs.writeFileSync(this.path, JSON.stringify(s)); }
}
let Store = FileStore;
try { Store = require(path.join(ROOT, 'node_modules', 'electron-store')); } catch {
  console.log('  --  electron-store is not installed here (npm ci): a stand-in that keeps its file the same way');
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sf-'));
const fresh = () => { userData = fs.mkdtempSync(path.join(base, 'ud-')); return userData; };
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const asides = (dir) => fs.readdirSync(dir).filter((f) => /^config\.broken-\d+\.json$/.test(f));

try {
  // ── what used to end Shroudly at its first line ──
  const DAMAGE = { empty: '', 'NUL bytes': '\0'.repeat(4096), 'cut short': '{"protectionOn": tr', 'not an object': '[1,2]' };
  for (const [kind, text] of Object.entries(DAMAGE)) {
    const dir = fresh();
    write(dir, SF.FILE, text);
    if (kind === 'empty') {
      let threw = false;
      try { new Store(); } catch { threw = true; }
      t.ok(threw, 'the store as it was opened before (new Store()) throws on a damaged file: what stopped Shroudly');
    }
    const o = SF.open(Store, { dir, now: 1234 });
    t.ok(o.damaged && !o.restored && !o.firstRun && o.store.get('language') === undefined && o.store.size === 0,
      `${kind}: opened with a new install's settings, not an error`);
    t.ok(asides(dir).join() === 'config.broken-1234.json' && fs.readFileSync(path.join(dir, 'config.broken-1234.json'), 'utf8') === text,
      `${kind}: the damaged file is kept beside it, as it was, for a bug report`);
    o.store.set('language', 'tr');
    t.ok(read(dir, SF.FILE).language === 'tr', `${kind}: settings are written again`);
  }

  // ── the copy of the last good start ──
  {
    const dir = fresh();
    write(dir, SF.FILE, JSON.stringify({ language: 'de', discordMode: true, protectionOn: false, autoStart: false }));
    t.ok(SF.keepCopy(dir) && read(dir, SF.COPY).language === 'de', 'a good start keeps a copy');
    write(dir, SF.FILE, '\0\0\0');
    t.ok(!SF.keepCopy(dir) && read(dir, SF.COPY).language === 'de', 'a damaged file never replaces the good copy');
    const o = SF.open(Store, { dir, now: 99 });
    t.ok(o.damaged && o.restored && o.store.get('language') === 'de' && o.store.get('discordMode') === true && o.store.get('protectionOn') === false,
      'damaged: the copy of the last good start takes its place, with every setting the user had');
    t.ok(asides(dir).length === 1 && !fs.existsSync(path.join(dir, `${SF.COPY}.tmp`)), 'the damaged one set aside; nothing half-written left');
    const logs = [];
    SF.settle(o.store, { ...o, packaged: true, autoStartNow: () => true, log: (l, m) => logs.push(`${l}: ${m}`) });
    t.ok(o.store.get('autoStart') === false && logs.join() === 'warning: The settings file was damaged; the copy kept at the last start was used',
      'restored: the user\'s own choice stands, and the log says what happened');
  }

  // ── damaged while Shroudly runs ──
  {
    const dir = fresh();
    write(dir, SF.FILE, JSON.stringify({ language: 'tr' }));
    const o = SF.open(Store, { dir });
    write(dir, SF.FILE, '');
    let got;
    try { got = o.store.get('language', 'default'); } catch { got = 'threw'; }
    t.ok(got === 'default' && SF.protectionWanted(o.store) === true, 'a file emptied while running reads as empty, not as an uncaught error that quits');
  }

  // ── protection: the user's Start or Stop, never Auto mode ──
  const settle = (data, opts = {}) => {
    const dir = fresh();
    if (data) write(dir, SF.FILE, JSON.stringify(data));
    const o = SF.open(Store, { dir });
    const logs = [];
    SF.settle(o.store, { ...o, log: (l, m) => logs.push(`${l}: ${m}`), ...opts });
    return { store: o.store, opened: o, logs, dir };
  };
  let r = settle({ autoMode: false, language: 'en' });
  t.ok(r.store.get('protectionOn') === false, 'older settings, Auto mode off, never Start or Stop: off, as they started before');
  r.store.set('autoMode', true);
  t.ok(SF.protectionWanted(r.store) === false, 'written down once: turning Auto mode back on does not start protection at the next sign-in');
  r = settle({ autoMode: true });
  t.ok(r.store.get('protectionOn') === true, 'older settings, Auto mode on: on');
  r.store.set('autoMode', false);
  t.ok(SF.protectionWanted(r.store) === true, 'Auto mode turned off afterwards (or the strategy "Off"): protection still starts at the next sign-in (the reported case)');
  r = settle({ autoMode: true, protectionOn: false });
  t.ok(r.store.get('protectionOn') === false, 'a Stop the user pressed is never overwritten');
  r = settle({ autoMode: false, protectionOn: true });
  t.ok(r.store.get('protectionOn') === true, 'nor a Start');
  // Read before a start settled it (the login's proxy restore): what the
  // start would write.
  const unsettled = (data) => ({ has: (k) => k in data, get: (k, d) => (k in data ? data[k] : d) });
  t.ok(SF.protectionWanted(unsettled({ autoMode: false })) === false && SF.protectionWanted(unsettled({})) === true,
    'settings not settled yet read as the start would settle them');

  // ── start at sign-in: new installs only ──
  r = settle(null, { packaged: true });
  t.ok(r.opened.firstRun && r.store.get('autoStart') === true && r.store.get('protectionOn') === true,
    'a new install starts with the computer, protection on (quietly in the tray: launch.js)');
  t.ok(r.logs.join() === 'info: First start: "Start at sign-in" turned on (Settings)', 'said once in the log');
  r = settle(null, { packaged: false });
  t.ok(r.opened.firstRun && r.store.get('autoStart') === undefined, 'a copy run from its source folder: no login entry (it would start Electron alone)');
  r = settle({ language: 'en', runtimeActive: false }, { packaged: true });
  t.ok(!r.opened.firstRun && r.store.get('autoStart') === undefined, 'an earlier install that never chose: left as it was (off)');
  r = settle({ autoStart: false }, { packaged: true });
  t.ok(r.store.get('autoStart') === false, 'a user who turned it off keeps it off');
  {
    // Settings gone but the window's storage there: Shroudly ran here.
    const dir = fresh();
    fs.mkdirSync(path.join(dir, 'Local Storage'));
    const o = SF.open(Store, { dir });
    t.ok(!o.firstRun, 'no settings file, but the window ran here before: not a new install');
    const dir2 = fresh();
    write(dir2, SF.COPY, '{}');
    t.ok(!SF.open(Store, { dir: dir2 }).firstRun, 'no settings file, but a copy of them: not a new install');
  }
  // Damaged, no copy: the system's login entry decides, as the user left it.
  for (const sys of [true, false]) {
    const dir = fresh();
    write(dir, SF.FILE, '');
    const o = SF.open(Store, { dir });
    const logs = [];
    SF.settle(o.store, { ...o, packaged: true, autoStartNow: () => sys, log: (l, m) => logs.push(m) });
    t.ok(o.store.get('autoStart') === sys && !o.firstRun && logs[0] === "The settings file was damaged; Shroudly started with a new install's settings",
      `lost with no copy, the system ${sys ? 'starts' : 'does not start'} Shroudly at sign-in: kept so`);
  }

  // ── main.js opens it this way, and nowhere a store that throws ──
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(!/new Store\(\s*\)/.test(main) && /SettingsFile\.open\(Store/.test(main) && /SettingsFile\.settle\(store/.test(main) && /SettingsFile\.keepCopy\(/.test(main),
    'main.js opens, settles and keeps the settings through settings-file.js');
  t.ok(main.indexOf('SettingsFile.open(Store') < main.indexOf("process.on('uncaughtException'"), 'opened before anything that could catch the error existed: so it must not throw');
} finally { fs.rmSync(base, { recursive: true, force: true }); }

console.log(`settings-file: ${t.count} passed`);
process.exit(0);
