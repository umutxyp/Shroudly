'use strict';

/*
 * Flatpak programs and Shroudly's program proxy (Linux).
 *
 * A Flatpak program runs in a sandbox and is not given the session's
 * environment, so HTTPS_PROXY set for the desktop never reaches it: Roblox
 * through Sober, a Flatpak Discord or Steam all go straight out, around
 * Shroudly, whatever the desktop is set to. (A user reported exactly this and
 * worked around it by hand: `flatpak run --env=http_proxy=... org.vinegarhq.Sober`,
 * which works but only from a terminal, not from the program's own icon.)
 *
 * Flatpak does have one supported place for it: an override, which it reads
 * for every start of that program, icon or terminal alike. Shroudly writes one
 * per program, for the programs it knows and the user actually has installed —
 * never a global one, so if anything is ever left behind it is limited to
 * those, not to every Flatpak program on the machine.
 *
 * An override is kept on disk: unlike macOS's launchctl or Windows' volatile
 * environment it outlives a logout and a restart. A value left pointing at a
 * proxy that is gone would leave those programs with no internet, so:
 *   - every value is marked as ours (MARK), and only marked values are removed;
 *   - it is taken out when the mode goes off and when Shroudly quits, and
 *     app-env's recovery takes out what a Shroudly that died left behind;
 *   - removal is checked. Where `--unset-env` is not understood (flatpak
 *     before 1.12), the value is emptied instead, which programs read as no
 *     proxy — so the worst case still leaves them working.
 */

const { execFile, execFileSync } = require('child_process');

/* What we set, and the mark that says a value is ours. Both cases: some
 * programs read the lower-case names, some the upper-case ones. */
const PROXY_VARS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'];
const MARK = 'SHROUDLY_APP_PROXY';

/* The Flatpak programs Shroudly covers: the ones people route through it.
 * Only those actually installed are touched. */
const KNOWN_APPS = [
  'org.vinegarhq.Sober',          // Roblox
  'org.vinegarhq.Vinegar',        // Roblox Studio
  'com.discordapp.Discord',
  'dev.vencord.Vesktop',
  'io.github.spacingbat3.webcord',
  'com.valvesoftware.Steam',
];

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (err, out) => resolve({ ok: !err, out: String(out || '') })));
}

/* `flatpak list --app --columns=application`: one application id per line. */
function parseInstalled(out) {
  return String(out || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9_.-]+$/.test(l) && l.includes('.'));
}

/* `flatpak override --show <app>`: an ini. Only [Environment] interests us. */
function parseShowEnv(out) {
  const env = new Map();
  let inEnv = false;
  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEnv = /^\[Environment\]$/i.test(line); continue; }
    if (!inEnv || !line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) env.set(line.slice(0, i).trim(), line.slice(i + 1));
  }
  return env;
}

/* The arguments that set our values for one program, mark first so that a
 * cleanup after any later failure still knows they are ours. */
function setArgs(app, url) {
  const a = ['override', '--user', app, `--env=${MARK}=${url}`];
  for (const v of PROXY_VARS) a.push(`--env=${v}=${url}`);
  return a;
}
function unsetArgs(app) {
  const a = ['override', '--user', app];
  for (const v of PROXY_VARS) a.push(`--unset-env=${v}`);
  a.push(`--unset-env=${MARK}`);
  return a;
}
/* The fallback where --unset-env is not understood: empty, which programs
 * read as no proxy. */
function emptyArgs(app) {
  const a = ['override', '--user', app];
  for (const v of PROXY_VARS) a.push(`--env=${v}=`);
  a.push(`--env=${MARK}=`);
  return a;
}

/* Values of ours in what `--show` returned: the mark is set and the proxy
 * names carry it. */
function oursIn(env) {
  const mark = env.get(MARK);
  return !!(mark && PROXY_VARS.some((v) => env.get(v) === mark));
}
/* Nothing of ours is left (removed, or emptied by the fallback). */
function cleanedIn(env) {
  if (env.get(MARK)) return false;
  return PROXY_VARS.every((v) => !env.get(v));
}

class FlatpakEnv {
  constructor(opts = {}) {
    this.exec = opts.run || run;
    this.apps = opts.apps || KNOWN_APPS;
    this.log = opts.log || (() => {});
    this.applied = false;
    this.touched = [];
  }

  /* Is flatpak here at all? */
  async available() {
    const r = await this.exec('flatpak', ['--version']);
    return r.ok && /\d/.test(r.out);
  }

  /* The known programs this machine actually has. */
  async installed() {
    const r = await this.exec('flatpak', ['list', '--app', '--columns=application']);
    if (!r.ok) return [];
    const have = new Set(parseInstalled(r.out));
    return this.apps.filter((a) => have.has(a));
  }

  async showEnv(app) {
    const r = await this.exec('flatpak', ['override', '--user', '--show', app]);
    return r.ok ? parseShowEnv(r.out) : new Map();
  }

  /* Point the installed known programs at `url`. A program that already has a
   * proxy of somebody else's is left alone. Returns the ids changed. */
  async apply(url) {
    const apps = await this.installed();
    const done = [];
    for (const app of apps) {
      const env = await this.showEnv(app);
      const mark = env.get(MARK);
      const foreign = PROXY_VARS.some((v) => { const cur = env.get(v); return cur && cur !== mark; });
      if (foreign) { this.log('info', `Games and apps: ${app} already has a proxy of its own, left as it is`); continue; }
      const r = await this.exec('flatpak', setArgs(app, url));
      if (!r.ok) { this.log('warning', `Games and apps: ${app} could not be pointed at Shroudly`); continue; }
      done.push(app);
    }
    this.touched = done;
    this.applied = done.length > 0;
    return done;
  }

  /* Take ours out again, from every known program (not only the ones this run
   * set), and check it is really gone. Returns the ids cleared. */
  async clear() {
    const apps = await this.installed();
    const done = [];
    for (const app of apps) {
      let env = await this.showEnv(app);
      if (!oursIn(env) && cleanedIn(env)) continue;      // nothing of ours there
      if (!oursIn(env)) continue;                        // somebody else's: never touched
      await this.exec('flatpak', unsetArgs(app));
      env = await this.showEnv(app);
      if (!cleanedIn(env)) {
        // An older flatpak without --unset-env: empty them instead, so the
        // program reads no proxy rather than a dead one.
        await this.exec('flatpak', emptyArgs(app));
        env = await this.showEnv(app);
      }
      if (cleanedIn(env)) done.push(app);
      else this.log('warning', `Games and apps: ${app} still has Shroudly's proxy set; run: flatpak override --user --unset-env=https_proxy ${app}`);
    }
    this.touched = [];
    this.applied = false;
    return done;
  }
}

/* Is flatpak on this machine? Asked once: the answer cannot change while
 * Shroudly runs, and the places that need it (whether the mode can be
 * offered) are not allowed to wait. */
let haveFlatpak;
FlatpakEnv.availableSync = function availableSync(platform = process.platform, exec = execFileSync) {
  if (haveFlatpak !== undefined) return haveFlatpak;
  if (platform !== 'linux') { haveFlatpak = false; return false; }
  try { haveFlatpak = /\d/.test(String(exec('flatpak', ['--version'], { timeout: 4000 }))); }
  catch { haveFlatpak = false; }
  return haveFlatpak;
};
FlatpakEnv.resetAvailable = function resetAvailable() { haveFlatpak = undefined; };

/* Quitting: take ours out of the programs this run set, and no more, so that
 * a quit stays quick. Anything else of ours is swept up by the next start
 * (clear()). Never throws. */
FlatpakEnv.prototype.clearSync = function clearSync(exec = execFileSync) {
  const apps = this.touched.slice();
  this.touched = [];
  this.applied = false;
  for (const app of apps) {
    try { exec('flatpak', unsetArgs(app), { timeout: 5000, stdio: 'ignore' }); } catch {}
    try {
      const out = String(exec('flatpak', ['override', '--user', '--show', app], { timeout: 5000 }));
      if (!cleanedIn(parseShowEnv(out))) exec('flatpak', emptyArgs(app), { timeout: 5000, stdio: 'ignore' });
    } catch {}
  }
  return apps;
};

module.exports = FlatpakEnv;
module.exports.MARK = MARK;
module.exports.PROXY_VARS = PROXY_VARS;
module.exports.KNOWN_APPS = KNOWN_APPS;
module.exports.parseInstalled = parseInstalled;
module.exports.parseShowEnv = parseShowEnv;
module.exports.setArgs = setArgs;
module.exports.unsetArgs = unsetArgs;
module.exports.emptyArgs = emptyArgs;
module.exports.oursIn = oursIn;
module.exports.cleanedIn = cleanedIn;
