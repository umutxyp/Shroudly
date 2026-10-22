'use strict';

/*
 * Windows: links that open programs which read only HTTPS_PROXY
 * (roblox-player:, roblox-studio:, ...) go through Shroudly while Games and
 * apps mode is on.
 *
 * Why (issue #30): such a program gets HTTPS_PROXY from whoever starts it
 * (app-env.js). A link clicked in a browser is started by the browser, with
 * the environment the browser got when it started, which is usually before
 * Shroudly set anything; Windows never gives a running program a new one.
 * The website's Play and Edit buttons are such links, so the player and
 * Studio opened from them went around Shroudly every time, however often
 * they were reopened. The player could be restarted through Shroudly;
 * Studio, which may hold unsaved work, never is, and asked to reopen it, the
 * user could only open it the same way again.
 *
 * What: the user's own entry for each such link (HKCU\Software\Classes,
 * which Windows reads before the machine's) runs Shroudly instead:
 *     "...\Shroudly.exe" --open-link=<class> -- "%1"
 * which (link-open.js) reads, at that moment, the setting Games and apps
 * mode keeps in the session's environment and starts the link's own program
 * with it. Never with less than the link had: with Shroudly stopped, quit,
 * killed or gone after a restart, the session has no setting, and the link
 * opens its program exactly as it would without Shroudly.
 *
 * Which links: every URL protocol with one of WORDS in its name, in the
 * user's classes or the machine's, whatever program handles it (Roblox's
 * own, or a bootstrapper that took it over: Bloxstrap, Fishstrap, the next
 * fork), and the class the user chose for it in Windows' settings
 * (UserChoice) when there is one. Data, not code: a program of the same kind
 * is one more word.
 *
 * What was there is kept beside ours, in the same key: the original command
 * (ShroudlyOriginal, with its type), where it came from (ShroudlyFrom: user,
 * user-expand, or machine when the user had no entry and ours was made from
 * scratch) and our own command (ShroudlyCommand). Each class taken over is
 * listed under HKCU\Software\Shroudly\LinkHandlers, which the restore reads:
 * on Stop, on quit, by the watchdog after a crash, at the next start, and by
 * the uninstaller (installer.nsh). Put back only while ours is still there:
 * a program that wrote its entry again meanwhile (Roblox does when it
 * updates) keeps what it wrote. The machine's entries are never written.
 *
 * Programs write their entries again (an update, a bootstrapper at each
 * start), so main.js applies again after a Roblox program starts and every
 * few minutes; one that is still ours costs a few reads.
 *
 * The registry is read with "reg export" and written with "reg import":
 * files in UTF-16, so a path such as C:\Users\Ümit\... is kept exactly
 * ("reg query" prints in the console's code page).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const USER = 'HKEY_CURRENT_USER\\Software\\Classes';
const MACHINE = 'HKEY_LOCAL_MACHINE\\Software\\Classes';
const CHOICE = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations';
const OWN = 'HKEY_CURRENT_USER\\Software\\Shroudly';
const INDEX = `${OWN}\\LinkHandlers`;
const CMD = '\\shell\\open\\command';
const V = { original: 'ShroudlyOriginal', from: 'ShroudlyFrom', command: 'ShroudlyCommand' };
const ARG = '--open-link';
// Links of the programs Games and apps mode is for, by a word in their name.
const WORDS = ['roblox'];
// A class name that can go into a command line and a registry path as it is.
const SAFE = /^[A-Za-z][\w.+-]{0,99}$/;

/* ── .reg files ──────────────────────────────────────────────────────────── */

const TYPES = { 1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY', 4: 'REG_DWORD', 7: 'REG_MULTI_SZ', b: 'REG_QWORD' };

/* A quoted string at the start of s ("...", with \\ and \"): [text, rest]. */
function quoted(s) {
  if (s[0] !== '"') return null;
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
    if (c === '"') return [out, s.slice(i + 1)];
    out += c;
  }
  return null;
}

function utf16(bytes) {
  return Buffer.from(bytes).toString('utf16le').replace(/\0+$/, '');
}

/* What "reg export" wrote: Map of KEY (upper-cased) -> { path, values: Map
 * of name (lower-cased; '' is the default value) -> { name, type, data } }.
 * Strings are text; other types keep their bytes. */
function parseReg(text) {
  const keys = new Map();
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Long hex values go on over several lines, each ending in a backslash.
    if (/^(?:@|".*")=hex(?:\([0-9a-f]+\))?:/i.test(line)) {
      while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].trim();
    }
    const head = /^\[(-?)(.+)\]$/.exec(line.trim());
    if (head) {
      cur = head[1] ? null : { path: head[2], values: new Map() };
      if (cur) keys.set(cur.path.toUpperCase(), cur);
      continue;
    }
    if (!cur || !line) continue;
    let name;
    let rest;
    if (line.startsWith('@=')) { name = ''; rest = line.slice(2); } else {
      const q = quoted(line);
      if (!q || q[1][0] !== '=') continue;
      [name, rest] = [q[0], q[1].slice(1)];
    }
    let v = null;
    if (rest[0] === '"') { const q = quoted(rest); if (q) v = { type: 'REG_SZ', data: q[0] }; } else {
      const dw = /^dword:([0-9a-f]{8})$/i.exec(rest);
      const hx = /^hex(?:\(([0-9a-f]+)\))?:([0-9a-f,\s]*)$/i.exec(rest);
      if (dw) v = { type: 'REG_DWORD', data: parseInt(dw[1], 16) };
      else if (hx) {
        const code = (hx[1] || '3').toLowerCase().replace(/^0+(?=.)/, '');
        const bytes = hx[2].split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseInt(x, 16));
        const type = TYPES[code] || `REG_${code}`;
        v = type === 'REG_SZ' || type === 'REG_EXPAND_SZ' ? { type, data: utf16(bytes) } : { type, data: Buffer.from(bytes) };
      }
    }
    if (v) cur.values.set(name.toLowerCase(), { name, ...v });
  }
  return keys;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const hexText = (s) => [...Buffer.from(`${s}\0`, 'utf16le')].map((b) => b.toString(16).padStart(2, '0')).join(',');

/* A .reg file for "reg import". blocks: [{ key, remove: true }] deletes a
 * key and everything in it; [{ key, values: [{ name, type, data } |
 * { name, remove: true }] }] sets and deletes values (name '' is the
 * default). Only text values are ever written. */
function regText(blocks) {
  const out = ['Windows Registry Editor Version 5.00', ''];
  for (const b of blocks) {
    if (b.remove) { out.push(`[-${b.key}]`, ''); continue; }
    out.push(`[${b.key}]`);
    for (const v of b.values || []) {
      const name = v.name === '' ? '@' : `"${esc(v.name)}"`;
      if (v.remove) out.push(`${name}=-`);
      else if (v.type === 'REG_EXPAND_SZ') out.push(`${name}=hex(2):${hexText(v.data)}`);
      else if (/[\r\n\0]/.test(v.data)) out.push(`${name}=hex(1):${hexText(v.data)}`);
      else out.push(`${name}="${esc(v.data)}"`);
    }
    out.push('');
  }
  return `${out.join('\r\n')}\r\n`;
}

/* Key names "reg query <root> /k /f <word>" found right under root. */
function parseSearch(out, root) {
  const pre = `${root}\\`.toUpperCase();
  return String(out || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.toUpperCase().startsWith(pre))
    .map((l) => l.slice(pre.length))
    .filter((n) => n && !n.includes('\\'));
}

/* ── the real registry (Windows) ─────────────────────────────────────────── */

const regExe = () => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
const tmpReg = () => path.join(os.tmpdir(), `shroudly-reg-${process.pid}-${crypto.randomBytes(6).toString('hex')}.reg`);
const RUN = { windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] };
const decode = (buf) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString('utf16le') : buf.toString('utf8'));
const bom = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const run = (args) => new Promise((resolve, reject) => execFile(regExe(), args, { windowsHide: true, timeout: 15000 },
  (err, out) => (err ? reject(Object.assign(err, { stdout: out })) : resolve(String(out)))));
const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch {} };

const realIo = {
  searchSync(root, word) {
    try { return parseSearch(execFileSync(regExe(), ['query', root, '/k', '/f', word], RUN), root); } catch (e) { return parseSearch(e.stdout, root); }
  },
  async search(root, word) {
    try { return parseSearch(await run(['query', root, '/k', '/f', word]), root); } catch (e) { return parseSearch(e.stdout, root); }
  },
  /* The key and everything under it, or null when it is not there. */
  readSync(key) {
    const f = tmpReg();
    try { execFileSync(regExe(), ['export', key, f, '/y'], RUN); return parseReg(decode(fs.readFileSync(f))); } catch { return null; } finally { rm(f); }
  },
  async read(key) {
    const f = tmpReg();
    try { await run(['export', key, f, '/y']); return parseReg(decode(await fs.promises.readFile(f))); } catch { return null; } finally { rm(f); }
  },
  writeSync(blocks) {
    const f = tmpReg();
    try { fs.writeFileSync(f, bom(regText(blocks))); execFileSync(regExe(), ['import', f], RUN); } finally { rm(f); }
  },
  async write(blocks) {
    const f = tmpReg();
    try { await fs.promises.writeFile(f, bom(regText(blocks))); await run(['import', f]); } finally { rm(f); }
  },
};

/* ── what is done ────────────────────────────────────────────────────────── */

const val = (tree, key, name) => {
  const k = tree && tree.get(key.toUpperCase());
  return (k && k.values.get(name.toLowerCase())) || null;
};
const text = (v) => (v && (v.type === 'REG_SZ' || v.type === 'REG_EXPAND_SZ') ? v : null);
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes(` ${ARG}=`);

/* The command Windows is to run for class `cls`. `prefix` is Shroudly's
 * program, quoted (and, from a source checkout, its folder). */
function commandFor(prefix, cls) { return `${prefix} ${ARG}=${cls} -- "%1"`; }

/* Shroudly's program as a command starts with it. */
function prefixFor(exe, appDir) {
  const q = (p) => `"${String(p).replace(/\\+$/, '')}"`;
  return appDir ? `${q(exe)} ${q(appDir)}` : q(exe);
}

function indexNames(index) {
  const k = index && index.get(INDEX.toUpperCase());
  return k ? [...k.values.values()].map((v) => v.name).filter((n) => SAFE.test(n)) : [];
}

/* Our entry for one class: { blocks, from, changed }, or null when it is
 * not to be touched. */
function wrapClass(cls, user, machine, want) {
  const ukey = `${USER}\\${cls}`;
  const ckey = ukey + CMD;
  const cur = val(user, ckey, '');
  if (cur) {
    if (!text(cur)) return null;
    if (isOurs(cur.data)) {
      const from = text(val(user, ckey, V.from));
      // A command of ours that does not say what it stands for: left alone.
      if (!from) return null;
      const ours = text(val(user, ckey, V.command));
      if (cur.data === want && ours && ours.data === want) return { blocks: [], from: from.data, changed: false };
      // Shroudly is somewhere else now (installed again elsewhere).
      return { blocks: [{ key: ckey, values: [{ name: '', type: 'REG_SZ', data: want }, { name: V.command, type: 'REG_SZ', data: want }] }], from: from.data, changed: true };
    }
    const from = cur.type === 'REG_EXPAND_SZ' ? 'user-expand' : 'user';
    return {
      blocks: [{ key: ckey, values: [
        { name: '', type: 'REG_SZ', data: want },
        { name: V.original, type: cur.type, data: cur.data },
        { name: V.from, type: 'REG_SZ', data: from },
        { name: V.command, type: 'REG_SZ', data: want },
      ] }],
      from, changed: true,
    };
  }
  // The user has an entry of their own without a command: left as it is.
  if (user) return null;
  const mkey = `${MACHINE}\\${cls}`;
  const mc = text(val(machine, mkey + CMD, ''));
  if (!mc || isOurs(mc.data)) return null;
  const top = [];
  const label = text(val(machine, mkey, ''));
  if (label) top.push({ name: '', type: label.type, data: label.data });
  const proto = val(machine, mkey, 'URL Protocol');
  if (proto) top.push({ name: 'URL Protocol', type: 'REG_SZ', data: text(proto) ? proto.data : '' });
  return {
    blocks: [
      { key: ukey, values: top },
      { key: ckey, values: [
        { name: '', type: 'REG_SZ', data: want },
        { name: V.original, type: mc.type, data: mc.data },
        { name: V.from, type: 'REG_SZ', data: 'machine' },
        { name: V.command, type: 'REG_SZ', data: want },
      ] },
    ],
    from: 'machine', changed: true,
  };
}

/* What puts one class back: blocks for the .reg file. */
function* restoreClass(cls) {
  const ukey = `${USER}\\${cls}`;
  const ckey = ukey + CMD;
  const user = yield ['read', ukey];
  if (!user) return [];
  const cur = text(val(user, ckey, ''));
  const ours = text(val(user, ckey, V.command));
  const from = text(val(user, ckey, V.from));
  const orig = text(val(user, ckey, V.original));
  const drop = [V.original, V.from, V.command].filter((n) => val(user, ckey, n)).map((name) => ({ name, remove: true }));
  const still = !!cur && (ours ? cur.data === ours.data : isOurs(cur.data));
  if (still && from && from.data === 'machine') return [{ key: ukey, remove: true }];
  if (still && orig && !isOurs(orig.data)) return [{ key: ckey, values: [{ name: '', type: orig.type, data: orig.data }, ...drop] }];
  // Ours, but what it stands for is gone: left, so the link still opens
  // something (link-open.js falls back to the machine's entry).
  if (still) return [];
  // Written again by its program meanwhile: what it wrote stays.
  return drop.length ? [{ key: ckey, values: drop }] : [];
}

/* The list goes, and Shroudly's own key with it when nothing else is in it
 * (the Store apps' list lives there too). */
function* dropIndex() {
  const own = yield ['read', OWN];
  const top = own && own.get(OWN.toUpperCase());
  const other = own ? [...own.keys()].some((k) => k !== OWN.toUpperCase() && k !== INDEX.toUpperCase() && !k.startsWith(`${INDEX.toUpperCase()}\\`)) : true;
  return { key: top && !top.values.size && !other ? OWN : INDEX, remove: true };
}

/* Every class taken over, put back. Resolves the classes. */
function* planRestore() {
  const index = yield ['read', INDEX];
  const classes = indexNames(index);
  const blocks = [];
  for (const cls of classes) blocks.push(...(yield* restoreClass(cls)));
  if (index) blocks.push(yield* dropIndex());
  if (blocks.length) yield ['write', blocks];
  return classes;
}

/* Take over every link of WORDS (again: one still ours is only read).
 * Resolves { links, classes, changed }. */
function* planApply(prefix, words = WORDS) {
  const found = new Map();
  for (const root of [USER, MACHINE]) {
    for (const w of words) for (const n of ((yield ['search', root, w]) || [])) if (SAFE.test(n) && !found.has(n.toLowerCase())) found.set(n.toLowerCase(), n);
  }
  const index = yield ['read', INDEX];
  const listed = indexNames(index);
  const blocks = [];
  const links = [];
  const targets = new Map();
  const indexValues = [];
  for (const scheme of [...found.values()].sort()) {
    const user = yield ['read', `${USER}\\${scheme}`];
    const machine = yield ['read', `${MACHINE}\\${scheme}`];
    if (!val(user, `${USER}\\${scheme}`, 'URL Protocol') && !val(machine, `${MACHINE}\\${scheme}`, 'URL Protocol')) continue;
    let cls = scheme;
    let u = user;
    let m = machine;
    // The program the user picked for this link in Windows' settings comes
    // first: its class is the one Windows runs.
    const ck = `${CHOICE}\\${scheme}\\UserChoice`;
    const choice = text(val(yield ['read', ck], ck, 'ProgId'));
    if (choice && choice.data.toLowerCase() !== scheme.toLowerCase()) {
      // A Store app's class is the app's own business.
      if (!SAFE.test(choice.data) || /^AppX/i.test(choice.data)) continue;
      cls = choice.data;
      u = yield ['read', `${USER}\\${cls}`];
      m = yield ['read', `${MACHINE}\\${cls}`];
    }
    if (targets.has(cls.toLowerCase())) { links.push(scheme); continue; }
    const r = wrapClass(cls, u, m, commandFor(prefix, cls));
    if (!r) continue;
    targets.set(cls.toLowerCase(), cls);
    links.push(scheme);
    blocks.push(...r.blocks);
    if (r.changed || !listed.some((n) => n.toLowerCase() === cls.toLowerCase())) indexValues.push({ name: cls, type: 'REG_SZ', data: r.from });
  }
  // Taken over before, and no longer to be (the user chose another program,
  // the link is gone): put back.
  for (const cls of listed) {
    if (targets.has(cls.toLowerCase())) continue;
    blocks.push(...(yield* restoreClass(cls)));
    indexValues.push({ name: cls, remove: true });
  }
  if (!targets.size && index) blocks.push(yield* dropIndex());
  else if (indexValues.length) blocks.push({ key: INDEX, values: indexValues });
  if (blocks.length) yield ['write', blocks];
  return { links, classes: [...targets.values()], changed: blocks.length > 0 };
}

function runSync(gen, io) {
  let r = gen.next();
  while (!r.done) { const [op, ...a] = r.value; r = gen.next(io[`${op}Sync`](...a)); }
  return r.value;
}
async function runAsync(gen, io) {
  let r = gen.next();
  while (!r.done) { const [op, ...a] = r.value; r = gen.next(await io[op](...a)); }
  return r.value;
}

class LinkHandlers {
  /* opts.io stands in for the registry (tests): search/read/write and their
   * ...Sync forms, as realIo; opts.words for WORDS (tests). */
  constructor(opts = {}) {
    this.io = opts.io || realIo;
    this.platform = opts.platform || process.platform;
    this.words = opts.words || WORDS;
  }

  get supported() { return this.platform === 'win32'; }

  /* Take the links over for Shroudly's program `prefix` (prefixFor). */
  async apply(prefix) {
    if (!this.supported) return { links: [], classes: [], changed: false };
    return runAsync(planApply(prefix, this.words), this.io);
  }

  /* Put every link taken over back; synchronous (also used while exiting).
   * The classes that were listed. */
  restoreSync() {
    if (!this.supported) return [];
    return runSync(planRestore(), this.io);
  }
}

module.exports = LinkHandlers;
Object.assign(module.exports, {
  USER, MACHINE, CHOICE, OWN, INDEX, CMD, V, ARG, WORDS, SAFE,
  parseReg, regText, parseSearch, val, text, isOurs, commandFor, prefixFor, planApply, planRestore, runSync, runAsync, realIo,
});
