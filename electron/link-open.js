'use strict';

/*
 * "Shroudly --open-link=<class> -- <link>" (main.js, before anything else):
 * what Windows runs for a link Games and apps mode took over
 * (link-handlers.js), a roblox-studio: link clicked in a browser for one.
 * Starts the program the link was made for, with the setting the mode keeps
 * in the session's environment right now, and ends. Nothing else of
 * Shroudly starts, and it never stands in the link's way:
 *   - mode off, Shroudly stopped, quit or killed, the computer restarted:
 *     the session holds no setting of ours (or its port no longer answers),
 *     and the program starts with the browser's environment as it is (a
 *     value of ours left in it from earlier is taken out: it would point at
 *     nothing);
 *   - a proxy somebody else set (HTTPS_PROXY that is not ours) is kept;
 *   - the program's own command is used as Windows would: the one the user
 *     had, or the machine's current one (an update there is followed), with
 *     the link in place of %1; a program that updated itself into a new
 *     version folder is found there.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const LH = require('./link-handlers');

// As app-env.js writes them (not required from there: this runs at every
// link, and should start nothing it does not need).
const MARK = 'SHROUDLY_APP_PROXY';
const OURS = /^http:\/\/127\.0\.0\.1:(\d+)$/;
const NO_PROXY_VALUE = 'localhost,127.0.0.1,::1,.local,.localhost,.lan,.internal,.home.arpa,.home,.fritz.box,' +
  '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10';

/* { cls, link } from the command line, or null. The link is what Windows
 * put for %1: one argument, a URL, never anything that could become more. */
function parseArgs(argv) {
  const list = (argv || []).map(String);
  const at = list.findIndex((a) => a.startsWith(`${LH.ARG}=`));
  if (at < 0) return null;
  const cls = list[at].slice(LH.ARG.length + 1);
  const dd = list.indexOf('--', at);
  const link = list[dd >= 0 ? dd + 1 : at + 1];
  if (!LH.SAFE.test(cls) || typeof link !== 'string' || link.length > 32000) return null;
  if (/["\0\r\n]/.test(link) || !/^[a-z][a-z0-9+.-]*:/i.test(link)) return null;
  return { cls, link };
}

/* The command the link stands for: { type, data } or null. */
function template(cls, read) {
  const ckey = `${LH.USER}\\${cls}${LH.CMD}`;
  const user = read(ckey);
  const from = LH.text(LH.val(user, ckey, LH.V.from));
  const usable = (v) => (v && !LH.isOurs(v.data) ? v : null);
  const machine = () => {
    const mk = `${LH.MACHINE}\\${cls}${LH.CMD}`;
    return usable(LH.text(LH.val(read(mk), mk, '')));
  };
  const orig = usable(LH.text(LH.val(user, ckey, LH.V.original)));
  if (from && from.data === 'machine') return machine() || orig;
  // Its program wrote its entry again since: that one.
  return usable(LH.text(LH.val(user, ckey, ''))) || orig || machine();
}

/* %NAME% from env (names in any case), as Windows expands REG_EXPAND_SZ. */
function expandEnv(s, env) {
  return String(s).replace(/%([^%\s"]+)%/g, (m, k) => {
    const hit = Object.keys(env).find((n) => n.toUpperCase() === k.toUpperCase());
    return hit !== undefined ? env[hit] : m;
  });
}

/* The link in place of %1 (and %0, %L, %l, %*); %2..%9 are empty for a link. */
function fill(cmd, link) {
  return String(cmd).replace(/%([0-9*lL])/g, (m, c) => (/[01lL*]/.test(c) ? link : ''));
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/* The program and the rest of a command line, the way CreateProcess reads
 * an unquoted path with spaces in it (the first one that is a file). */
function split(cmd, exists = isFile) {
  const s = String(cmd).trim();
  if (s.startsWith('"')) {
    const e = s.indexOf('"', 1);
    return e < 0 ? { file: s.slice(1), rest: '' } : { file: s.slice(1, e), rest: s.slice(e + 1).trim() };
  }
  const parts = s.split(' ');
  for (let n = 1; n <= parts.length; n++) {
    const f = parts.slice(0, n).join(' ');
    if (exists(f) || (!/\.\w{1,4}$/.test(f) && exists(`${f}.exe`))) return { file: f, rest: parts.slice(n).join(' ').trim() };
  }
  return { file: parts[0], rest: parts.slice(1).join(' ').trim() };
}

/* A program in a version folder that is gone (it updated itself since the
 * entry was written): the same program in the newest version folder. */
function current(file, fsx = fs) {
  try { if (fsx.statSync(file).isFile()) return file; } catch {}
  const m = /^(.*\\Versions)\\[^\\]+\\([^\\]+\.exe)$/i.exec(file);
  if (!m) return file;
  let best = null;
  let dirs = [];
  try { dirs = fsx.readdirSync(m[1]); } catch { return file; }
  for (const d of dirs) {
    const f = path.win32.join(m[1], d, m[2]);
    try { const st = fsx.statSync(f); if (st.isFile() && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs }; } catch {}
  }
  return best ? best.f : file;
}

/* The environment the program gets: the parent's, with the session's
 * setting of ours (vol: name -> value, upper-cased names) when `live`. */
function launchEnv(parent, vol, live) {
  const env = { ...parent };
  const key = (n) => Object.keys(env).find((k) => k.toUpperCase() === n);
  const get = (n) => { const k = key(n); return k === undefined ? undefined : env[k]; };
  const del = (n) => { for (const k of Object.keys(env)) if (k.toUpperCase() === n) delete env[k]; };
  const set = (n, v) => { del(n); env[n] = v; };
  const cur = get('HTTPS_PROXY');
  const curMark = get(MARK);
  // Somebody else's proxy is never replaced (app-env.js does the same).
  if (cur && !(curMark && cur === curMark && OURS.test(cur))) return env;
  const mark = vol.get(MARK);
  if (live && mark && OURS.test(mark) && vol.get('HTTPS_PROXY') === mark) {
    set('HTTPS_PROXY', mark);
    set(MARK, mark);
    const np = vol.get('NO_PROXY');
    const cnp = get('NO_PROXY');
    if (np && (!cnp || cnp === NO_PROXY_VALUE)) set('NO_PROXY', np);
  } else if (cur) {
    // Ours from an earlier run, pointing at nothing now.
    del('HTTPS_PROXY');
    del(MARK);
    if (get('NO_PROXY') === NO_PROXY_VALUE) del('NO_PROXY');
  }
  return env;
}

/* The session's environment (HKCU\Volatile Environment), upper-cased
 * names. Its values of ours are ASCII, so reg query's code page is no harm. */
function readVolatile() {
  const out = new Map();
  try {
    const text = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', 'HKCU\\Volatile Environment'], { windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
      if (m && m[2].trim()) out.set(m[1].toUpperCase(), m[2].trim());
    }
  } catch {}
  return out;
}

/* Does Shroudly answer on this port? */
function listening(port, ms = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/* Start `file` with the rest of its command line as it is. Its process id,
 * or false. */
function start(file, rest, env) {
  return new Promise((resolve) => {
    let c;
    try {
      c = spawn(file, rest ? [rest] : [], { windowsVerbatimArguments: true, argv0: `"${file}"`, detached: true, stdio: 'ignore', env });
    } catch { resolve(false); return; }
    c.once('error', () => resolve(false));
    c.once('spawn', () => { c.unref(); resolve(c.pid || true); });
  });
}

/* Exit code: 0 started, 2 not a link of ours, 3 nothing to start, 4 it
 * could not be started. deps stand in for the system (tests). */
async function main(argv = process.argv, deps = {}) {
  const a = parseArgs(argv);
  if (!a) return 2;
  const read = deps.read || ((k) => LH.realIo.readSync(k));
  const tpl = template(a.cls, read);
  if (!tpl) return 3;
  const vol = deps.volatile ? deps.volatile() : readVolatile();
  const mark = OURS.exec(vol.get(MARK) || '');
  const live = !!mark && await (deps.listening || listening)(Number(mark[1]));
  const env = launchEnv(deps.env || process.env, vol, live);
  const line = fill(tpl.type === 'REG_EXPAND_SZ' ? expandEnv(tpl.data, env) : tpl.data, a.link);
  const { file, rest } = split(line, deps.exists);
  const exe = current(file, deps.fs);
  const pid = await (deps.start || start)(exe, rest, env);
  return pid ? 0 : 4;
}

module.exports = { main, parseArgs, template, expandEnv, fill, split, current, launchEnv, readVolatile, listening, start, MARK, NO_PROXY_VALUE };
