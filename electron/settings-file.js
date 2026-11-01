'use strict';

/*
 * The settings file (config.json in the user's data folder, kept by
 * electron-store), and what the first start and older versions leave in it.
 * Apart from main.js so the rules can be tested without Electron.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'config.json';
// The file as it was at the last start that got as far as the window or the
// tray: what a damaged one is replaced with.
const COPY = 'config.backup.json';
const PROTECTION_KEY = 'protectionOn';

/* 'missing', 'ok', or 'damaged': empty, cut short, filled with NUL bytes,
 * not an object, or not readable at all. A disk that lost its last write, a
 * sync or cleanup tool, or a copy taken while it was being written leave
 * such a file behind. */
function check(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? 'missing' : 'damaged'; }
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? 'ok' : 'damaged';
  } catch { return 'damaged'; }
}

/* Opens the settings. A damaged file used to stop Shroudly at its first
 * line, before it could show anything, at every start, and a reinstall
 * keeps the user's data folder: nobody who does not know where the file is
 * could get out of that. Now it is set aside next to where it was
 * (config.broken-<time>.json, for a bug report) and the copy kept at the
 * last good start takes its place; without one, Shroudly starts with a new
 * install's settings. A file damaged while Shroudly runs reads as empty
 * instead of ending it (clearInvalidConfig).
 *
 * firstRun: nothing says Shroudly ran here before (no settings, no copy of
 * them, no window storage): a new install, not a file that went missing. */
function open(Store, { dir, now = Date.now() } = {}) {
  const file = path.join(dir, FILE);
  const copy = path.join(dir, COPY);
  const out = { firstRun: false, damaged: false, restored: false, setAside: null };
  const state = check(file);
  if (state === 'missing') {
    out.firstRun = check(copy) === 'missing' && !fs.existsSync(path.join(dir, 'Local Storage'));
  } else if (state === 'damaged') {
    out.damaged = true;
    const aside = path.join(dir, `config.broken-${now}.json`);
    try { fs.renameSync(file, aside); out.setAside = aside; } catch {}
    if (check(copy) === 'ok') {
      try { fs.copyFileSync(copy, file); out.restored = true; } catch {}
    }
  }
  let real = null;
  try { real = new Store({ clearInvalidConfig: true }); } catch (e) { out.unsaved = e; }
  out.store = sparing(real || memoryStore(), (e) => {
    if (out.unsaved) return;
    out.unsaved = e;
    if (out.onUnsaved) out.onUnsaved(e);
  });
  return out;
}

/* A write that cannot reach the disk (full, read-only, a folder the user
 * cannot write to) threw out of whatever was saving, and at a start that
 * was the start itself: no tray, no window, no protection. Now such a value
 * is kept for this run and read back from here, each later write tries the
 * disk again with everything kept, and the first failure is told once
 * (onUnsaved). Keys are taken as the code uses them: whole, without dots. */
const GONE = Symbol('deleted');
function sparing(store, onUnsaved = () => {}) {
  const kept = new Map();
  const flush = () => {
    for (const [k, v] of kept) {
      if (v === GONE) store.delete(k); else store.set(k, v);
      kept.delete(k);
    }
  };
  const write = (fn, k, v) => {
    try { flush(); fn(); kept.delete(k); } catch (e) { kept.set(k, v); onUnsaved(e); }
  };
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'get') {
        return (k, d) => {
          if (kept.has(k)) return kept.get(k) === GONE ? d : kept.get(k);
          return target.get(k, d);
        };
      }
      if (prop === 'has') return (k) => (kept.has(k) ? kept.get(k) !== GONE : target.has(k));
      if (prop === 'set') {
        return (k, v) => {
          if (k && typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) write(() => target.set(kk, vv), kk, vv); return; }
          write(() => target.set(k, v), k, v);
        };
      }
      if (prop === 'delete') return (k) => write(() => target.delete(k), k, GONE);
      if (prop === 'store') {
        const all = { ...target.store };
        for (const [k, v] of kept) { if (v === GONE) delete all[k]; else all[k] = v; }
        return all;
      }
      if (prop === 'unsavedCount') return kept.size;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/* Settings that could not be opened at all: this run's only. */
function memoryStore() {
  const m = new Map();
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); },
    has: (k) => m.has(k),
    delete: (k) => { m.delete(k); },
    get store() { return Object.fromEntries(m); },
  };
}

/* After a start that got this far: the settings as they are now, kept for
 * the next time the file is found damaged. A damaged file never replaces a
 * good copy. Written beside it and moved into place, so a copy cut short
 * is never what is kept. */
function keepCopy(dir) {
  const file = path.join(dir, FILE);
  if (check(file) !== 'ok') return false;
  const copy = path.join(dir, COPY);
  const tmp = `${copy}.tmp`;
  try {
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, copy);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/* Whether protection should be on: the user's own Start or Stop. A
 * settings file from before 2.6.44 may not say yet (see settle): then what
 * decided back then, Auto mode. */
function protectionWanted(store) {
  return store.has(PROTECTION_KEY) ? store.get(PROTECTION_KEY) !== false : store.get('autoMode', true) !== false;
}

/* At every start, before anything reads the settings:
 *
 * - Protection as it is now is written down once. Before 2.6.44 a user who
 *   had never pressed Start or Stop (most: protection starts by itself)
 *   got protection from Auto mode alone, so turning Auto mode off, or the
 *   strategy "Off", also kept protection from starting at the next sign-in,
 *   and nothing said so. From now on only Start and Stop change it.
 *
 * - A new install starts with the computer, quietly in the tray (launch.js):
 *   protection that stops at the first restart, until Shroudly is found and
 *   opened again, looks to someone who knows nothing as if Shroudly stopped
 *   working. Never on a later start, so a user who turned it off keeps it
 *   off, and never for a copy run from its source folder, whose login entry
 *   would start Electron alone.
 *
 * - Settings lost to a damaged file, with no copy to put back: whether
 *   Shroudly starts with the computer is taken from the system, as the user
 *   left it, instead of being switched off with the rest.
 *
 * Says what it did in the log: lines main.js writes, and logText.js knows. */
function settle(store, { firstRun = false, damaged = false, restored = false, packaged = false, autoStartNow = () => false, log = () => {} } = {}) {
  if (damaged) {
    log('warning', restored ? 'The settings file was damaged; the copy kept at the last start was used'
      : "The settings file was damaged; Shroudly started with a new install's settings");
  }
  if (!store.has(PROTECTION_KEY)) store.set(PROTECTION_KEY, protectionWanted(store));
  if (firstRun && packaged) {
    store.set('autoStart', true);
    log('info', 'First start: "Start at sign-in" turned on (Settings)');
  } else if (damaged && !restored && !store.has('autoStart')) {
    let on = false;
    try { on = !!autoStartNow(); } catch {}
    store.set('autoStart', on);
  }
}

module.exports = { open, keepCopy, settle, protectionWanted, check, sparing, FILE, COPY, PROTECTION_KEY };
