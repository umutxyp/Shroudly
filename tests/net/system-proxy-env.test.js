'use strict';

/* XFCE, LXQt and other Linux desktops without a system proxy setting
 * (electron/system-proxy.js, "Linux desktops without a proxy setting"):
 * Firefox through GNOME's setting, Chromium browsers through auto_proxy
 * written for the next login. Against stand-ins for gsettings, systemctl and
 * dbus-update-activation-environment, in a throwaway home directory: nothing
 * here reads or changes this machine's settings. What it proves:
 *   - exactly what is written where (environment.d, ~/.xprofile, LXQt's
 *     session.conf), and that removing it gives back the files byte for
 *     byte, with and without content of the user's own, including a value
 *     of auto_proxy the user had before
 *   - the PAC keeps its port from run to run, and moves (saying so) when it
 *     is taken
 *   - the status for each case: ok, partial_env (and which part),
 *     no_system_proxy
 *   - nothing is written on GNOME or KDE, which have real settings
 *   - a quit and a crash recovery keep these entries; the user's stop, and a
 *     start with protection off, remove them */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sysproxy-env-'));
const HOME = path.join(TMP, 'home');
process.env.HOME = HOME; // login hooks and anything else under ~: never the real one
fs.mkdirSync(HOME, { recursive: true });

const SystemProxy = require(path.join(ROOT, 'electron', 'system-proxy.js'));
const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
const t = suite('system-proxy-env');

const XPROFILE = path.join(HOME, '.xprofile');
const ENVD_DIR = path.join(HOME, '.config', 'environment.d');
const ENVD = path.join(ENVD_DIR, '90-shroudly.conf');
const LXQT = path.join(HOME, '.config', 'lxqt', 'session.conf');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const state = (name) => path.join(TMP, name, 'proxy-state.json');
const envFile = (name) => path.join(TMP, name, 'proxy-env.json');

function fakeExec(handlers) {
  const calls = [];
  const runSync = (cmd, args) => {
    calls.push([path.basename(cmd), ...args]);
    const h = handlers[path.basename(cmd)];
    if (!h) { const e = new Error(`spawn ${cmd} ENOENT`); e.code = 'ENOENT'; throw e; }
    return String(h(args) ?? '');
  };
  return { calls, runSync, run: async (cmd, args) => runSync(cmd, args), spawnDetached: (cmd, args) => { calls.push([path.basename(cmd), ...args]); } };
}

function fakeGsettings(values) {
  return (args) => {
    const [op, schema, key, value] = args;
    const k = `${schema} ${key}`;
    if (op === 'get') { if (!values.has(k)) throw new Error('No such key'); return `${values.get(k)}\n`; }
    if (op === 'set') values.set(k, key === 'port' ? String(value) : `'${value}'`);
    return '';
  };
}
const gnome = () => new Map(Object.entries({
  'org.gnome.system.proxy mode': "'none'",
  'org.gnome.system.proxy autoconfig-url': "''",
  'org.gnome.system.proxy.socks host': "''",
  'org.gnome.system.proxy.socks port': '0',
}));

/* systemctl --user {show,set,unset}-environment over a Map, and
 * dbus-update-activation-environment, which can only set. */
function fakeSystemd(envMap, dbusMap) {
  return {
    systemctl: (args) => {
      if (args[0] !== '--user') throw new Error('not --user');
      if (args[1] === 'show-environment') return [...envMap].map(([k, v]) => (/[^\w:/.@%+,=-]/.test(v) ? `${k}=$'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : `${k}=${v}`)).join('\n');
      if (args[1] === 'set-environment') { const [k, ...v] = args[2].split('='); envMap.set(k, v.join('=')); return ''; }
      if (args[1] === 'unset-environment') { envMap.delete(args[2]); return ''; }
      throw new Error(`unknown ${args[1]}`);
    },
    'dbus-update-activation-environment': (args) => {
      for (const a of args.filter((x) => !x.startsWith('--'))) { const [k, ...v] = a.split('='); dbusMap.set(k, v.join('=')); if (args.includes('--systemd')) envMap.set(k, v.join('=')); }
      return '';
    },
  };
}

function logs() { const l = []; const f = (level, msg) => l.push(`${level}: ${msg}`); f.lines = l; return f; }
function memStore(init = {}) { const mem = { ...init }; return { mem, get: () => mem.pacPort, set: (p) => { mem.pacPort = p; } }; }
const xfce = (extra = {}) => ({ XDG_CURRENT_DESKTOP: 'XFCE', HOME, ...extra });
const lxqt = (extra = {}) => ({ XDG_CURRENT_DESKTOP: 'LXQt', HOME, ...extra });
const clean = () => { for (const f of [XPROFILE, ENVD, LXQT]) fs.rmSync(f, { force: true }); fs.rmSync(path.join(HOME, '.config'), { recursive: true, force: true }); };

(async () => {
  // ── XFCE with GNOME's setting available (Firefox), a fresh session ─────
  {
    clean();
    const g = gnome();
    const sysEnv = new Map([['PATH', '/usr/bin']]);
    const dbusEnv = new Map();
    const fx = fakeExec({ gsettings: fakeGsettings(g), ...fakeSystemd(sysEnv, dbusEnv) });
    SystemProxy._setExec(fx);
    const port = memStore();
    const log = logs();
    const name = 'xfce';
    const sp = new SystemProxy(log, { platform: 'linux', env: xfce(), stateFile: state(name), portStore: port });
    const st = await sp.apply(10808, 'all');
    const url = sp.pacUrl;
    t.ok(st.code === 'partial_env' && !st.ok && st.system === 'xfce' && st.firefox === true && st.chromiumAfterRelogin === true && st.chromiumNow === false,
      'XFCE, fresh session: partial_env — Firefox now, Chromium browsers after the next login');
    t.ok(log.lines.includes('info: Firefox goes through Shroudly now; Chrome and other Chromium browsers will after you log out and back in') && !log.lines.some((l) => l.startsWith('success')),
      'XFCE: logged as exactly that, not as routed');
    t.ok(g.get('org.gnome.system.proxy mode') === "'auto'" && g.get('org.gnome.system.proxy autoconfig-url') === `'${url}'`, 'XFCE: GNOME\'s setting set (Firefox reads it on any desktop)');
    t.ok(read(ENVD) === `# Written by Shroudly while its protection is on; removed when it is switched off.\nauto_proxy=${url}\n`,
      'environment.d/90-shroudly.conf: exactly the comment and auto_proxy=<PAC>');
    t.ok(read(XPROFILE) === `# >>> Shroudly (removed automatically) >>>\nexport auto_proxy='${url}'\n# <<< Shroudly <<<\n`,
      '~/.xprofile (none before): exactly the marked block');
    t.ok(!fs.existsSync(LXQT), 'XFCE: LXQt\'s session.conf left alone');
    t.ok(sysEnv.get('auto_proxy') === url && dbusEnv.get('auto_proxy') === url, 'systemd and D-Bus activation environments get it for programs started through them now');
    t.ok(port.mem.pacPort === sp.pacPort, 'the PAC\'s port is kept for the next run');
    const rec = JSON.parse(read(envFile(name)));
    t.ok(rec.url === url && rec.files.length === 2 && rec.files.find((f) => f.kind === 'xprofile').created === true && rec.activation.systemd.prev === null,
      'what was written, and what was there before, is recorded (next to the state file, not in it)');
    t.ok(fs.existsSync(state(name)) && !JSON.stringify(JSON.parse(read(state(name)))).includes('xprofile'), 'the state file the watchdog looks after holds only GNOME\'s setting');

    // A quit: GNOME's setting goes back, the entries for the next login stay.
    await sp.restore();
    t.ok(g.get('org.gnome.system.proxy mode') === "'none'" && !fs.existsSync(state(name)), 'quit: GNOME\'s setting restored, state file gone (the watchdog has nothing to do)');
    t.ok((read(XPROFILE) || '').includes(url) && (read(ENVD) || '').includes(url) && sysEnv.get('auto_proxy') === url && fs.existsSync(envFile(name)),
      'quit: the entries for the next login stay (logout quits Shroudly; they are for the next login)');

    // Next run, same port: same address; the files do not change.
    const xp = read(XPROFILE);
    const sp2 = new SystemProxy(() => {}, { platform: 'linux', env: xfce(), stateFile: state(name), portStore: port });
    await sp2.apply(10808, 'all');
    t.ok(sp2.pacUrl === url && read(XPROFILE) === xp && JSON.parse(read(envFile(name))).files.find((f) => f.kind === 'xprofile').created === true,
      'next run: the PAC keeps its port, the files stay as they are, the record still knows they were ours');

    // A crash: the watchdog's (and the login hook's) recovery restores GNOME's
    // setting and leaves the entries.
    sp2.stopPacServer();
    t.ok(SystemProxy.recoverSync({ stateFile: state(name), platform: 'linux', env: xfce() }) === true && g.get('org.gnome.system.proxy mode') === "'none'",
      'crash recovery: GNOME\'s setting restored');
    t.ok(read(XPROFILE) === xp && (read(ENVD) || '').includes(url) && sysEnv.get('auto_proxy') === url && fs.existsSync(envFile(name)), 'crash recovery: the entries for the next login are kept (a crash is not a stop)');

    // After the next login the session has it: Chromium browsers started now follow it.
    const sp3 = new SystemProxy(logs(), { platform: 'linux', env: xfce({ auto_proxy: url }), stateFile: state(name), portStore: port });
    const st3 = await sp3.apply(10808, 'all');
    t.ok(st3.ok && st3.code === 'ok' && st3.system === 'xfce' && sp3.pacUrl === url, 'XFCE after re-login (this session has auto_proxy=<our PAC>), with GNOME\'s setting: ok');
    await sp3.restore();

    // The saved port taken by something else: another one, everything moved
    // to it, and a re-login is needed again.
    const squat = net.createServer();
    await new Promise((r) => squat.listen(port.mem.pacPort, '127.0.0.1', r));
    const log4 = logs();
    const sp4 = new SystemProxy(log4, { platform: 'linux', env: xfce({ auto_proxy: url }), stateFile: state(name), portStore: port });
    const st4 = await sp4.apply(10808, 'all');
    const url4 = sp4.pacUrl;
    t.ok(url4 !== url && port.mem.pacPort === sp4.pacPort && st4.code === 'partial_env' && st4.chromiumAfterRelogin && !st4.chromiumNow,
      `PAC port taken: moved to ${sp4.pacPort}, saved, and the status says a re-login is needed again`);
    t.ok(log4.lines.some((l) => l.startsWith('warning: The address browsers use to reach Shroudly had to change')), '…and the log says so');
    t.ok(read(XPROFILE) === `# >>> Shroudly (removed automatically) >>>\nexport auto_proxy='${url4}'\n# <<< Shroudly <<<\n` && read(ENVD).includes(`auto_proxy=${url4}\n`) && sysEnv.get('auto_proxy') === url4,
      '…every entry now names the new address (one block, not two)');
    squat.close();

    // The user stops protection: everything goes, exactly.
    const log5 = logs();
    await sp4.restore();
    sp4.log = log5;
    t.ok(sp4.clearEnv() === true && !fs.existsSync(XPROFILE) && !fs.existsSync(ENVD) && !fs.existsSync(ENVD_DIR) && !fs.existsSync(envFile(name))
      && !sysEnv.has('auto_proxy') && log5.lines.includes('info: Browser settings for the next login removed'),
    'user stop: ~/.xprofile (made by us) and environment.d removed, folder too, systemd\'s variable unset, record gone');
    t.ok(sp4.clearEnv() === false, 'a second stop finds nothing to remove');
  }

  // ── ~/.xprofile of the user's own, back byte for byte ──────────────────
  for (const [label, text] of [
    ['with a final newline', '#!/bin/sh\nexport GTK_THEME=Adwaita:dark\nxset s off\n'],
    ['without one', 'export EDITOR=vim'],
    ['empty', ''],
    ['with an auto_proxy of the user\'s own', "export auto_proxy='http://wpad.corp/p.pac'\n"],
  ]) {
    clean();
    fs.writeFileSync(XPROFILE, text, { mode: 0o600 });
    SystemProxy._setExec(fakeExec({}));
    const name = `xp-${label.length}`;
    const sp = new SystemProxy(() => {}, { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'i3', HOME }, stateFile: state(name), portStore: memStore() });
    const st = await sp.apply(10808, 'all');
    const now = read(XPROFILE);
    t.ok(st.code === 'partial_env' && !st.firefox && st.chromiumAfterRelogin && st.system === 'other' && now.startsWith(text) && now.endsWith(`export auto_proxy='${sp.pacUrl}'\n# <<< Shroudly <<<\n`)
      && (text === '' || text.endsWith('\n') ? now === text + SystemProxy._xprofileBlock(sp.pacUrl) : now === `${text}\n${SystemProxy._xprofileBlock(sp.pacUrl)}`),
    `~/.xprofile ${label}: the block appended after it, nothing else touched`);
    await sp.restore();
    sp.clearEnv();
    t.ok(read(XPROFILE) === text && (fs.statSync(XPROFILE).mode & 0o777) === 0o600, `~/.xprofile ${label}: back byte for byte (and its permissions) after the stop`);
  }
  {
    // Someone added a line after our block meanwhile: only the block goes.
    clean();
    fs.writeFileSync(XPROFILE, 'export A=1\n');
    SystemProxy._setExec(fakeExec({}));
    const sp = new SystemProxy(() => {}, { platform: 'linux', env: xfce(), stateFile: state('xp-later'), portStore: memStore() });
    await sp.apply(10808, 'all');
    fs.appendFileSync(XPROFILE, 'export B=2\n');
    await sp.restore();
    sp.clearEnv();
    t.ok(read(XPROFILE) === 'export A=1\nexport B=2\n', '~/.xprofile changed since: exactly our block is taken out, the rest stays');
  }

  // ── LXQt: session.conf, [Environment] ──────────────────────────────────
  for (const [label, text] of [
    ['none before', null],
    ['with other groups, no [Environment]', '[General]\n__userfile__=true\nwindow_manager=openbox\n'],
    ['without a final newline', '[General]\nwindow_manager=openbox'],
    ['[Environment] with other variables', '[Environment]\nGTK_CSD=0\nQT_SCALE_FACTOR=1\n\n[General]\nwindow_manager=kwin_x11\n'],
    ['[Environment] last, no final newline', '[General]\nleave_confirmation=true\n\n[Environment]\nGTK_CSD=0'],
    ['an auto_proxy of the user\'s own', '[Environment]\nauto_proxy="http://wpad.corp/p.pac"\nGTK_CSD=0\n\n[General]\nwindow_manager=openbox\n'],
  ]) {
    clean();
    if (text !== null) { fs.mkdirSync(path.dirname(LXQT), { recursive: true }); fs.writeFileSync(LXQT, text); }
    const sysEnv = new Map(text && text.includes('wpad.corp') ? [['auto_proxy', 'http://wpad.corp/p.pac?a=1&b=2']] : []);
    const dbusEnv = new Map();
    SystemProxy._setExec(fakeExec(fakeSystemd(sysEnv, dbusEnv)));
    const name = `lxqt-${label.length}`;
    const sp = new SystemProxy(() => {}, { platform: 'linux', env: lxqt(), stateFile: state(name), portStore: memStore() });
    const st = await sp.apply(10808, 'all');
    const now = read(LXQT);
    const groups = [...now.matchAll(/^\[Environment\]$/gm)].length;
    const lines = now.split('\n');
    const envAt = lines.indexOf('[Environment]');
    const keyAt = lines.indexOf(`auto_proxy=${sp.pacUrl}`);
    t.ok(st.code === 'partial_env' && st.system === 'lxqt' && groups === 1 && keyAt > envAt && !lines.slice(envAt + 1, keyAt).some((l) => l.startsWith('[')) && !fs.existsSync(XPROFILE),
      `LXQt session.conf, ${label}: auto_proxy=<PAC> in [Environment] (one group), and no ~/.xprofile`);
    if (text !== null) {
      const others = text.split('\n').filter((l) => l && !l.startsWith('auto_proxy='));
      t.ok(others.every((l) => lines.includes(l)), `LXQt session.conf, ${label}: every other line kept`);
    }
    if (text && text.includes('wpad.corp')) t.ok(sysEnv.get('auto_proxy') === sp.pacUrl, 'systemd: our value replaces the user\'s own for now');
    await sp.restore();
    sp.clearEnv();
    t.ok(read(LXQT) === text && (text !== null || !fs.existsSync(path.dirname(LXQT))), `LXQt session.conf, ${label}: back byte for byte after the stop${text === null ? ' (gone, with the folder made for it)' : ''}`);
    if (text && text.includes('wpad.corp')) t.ok(sysEnv.get('auto_proxy') === 'http://wpad.corp/p.pac?a=1&b=2' && dbusEnv.get('auto_proxy') === 'http://wpad.corp/p.pac?a=1&b=2',
      'a user\'s own auto_proxy in the session (systemd, D-Bus) is put back exactly, quoting and all');
  }

  // ── what each case reports ─────────────────────────────────────────────
  {
    clean();
    SystemProxy._setExec(fakeExec({}));
    const port = memStore();
    const sp = new SystemProxy(logs(), { platform: 'linux', env: xfce(), stateFile: state('st1'), portStore: port });
    const st = await sp.apply(10808, 'all');
    t.ok(st.code === 'partial_env' && !st.firefox && st.chromiumAfterRelogin && !st.chromiumNow, 'no gsettings, fresh session: partial_env, Chromium after re-login, Firefox by hand');
    const url = sp.pacUrl;
    await sp.restore();
    const log2 = logs();
    const sp2 = new SystemProxy(log2, { platform: 'linux', env: xfce({ auto_proxy: url }), stateFile: state('st1'), portStore: port });
    const st2 = await sp2.apply(10808, 'all');
    t.ok(st2.code === 'partial_env' && st2.chromiumNow && !st2.firefox && !st2.chromiumAfterRelogin && log2.lines.includes('info: Chrome and other Chromium browsers go through Shroudly; Firefox has to be set by hand'),
      'no gsettings, session already has it: partial_env, Chromium now, Firefox by hand');
    await sp2.restore();
    sp2.clearEnv();
    // Nowhere to record (so nothing is written) and no gsettings: nothing at all.
    const log3 = logs();
    const sp3 = new SystemProxy(log3, { platform: 'linux', env: xfce(), portStore: memStore() });
    const st3 = await sp3.apply(10808, 'all');
    t.ok(st3.code === 'no_system_proxy' && !fs.existsSync(XPROFILE) && log3.lines.some((l) => l.startsWith('warning') && l.includes('SOCKS5 127.0.0.1:10808')),
      'nothing could be set: no_system_proxy, logged with the address to use by hand');
    await sp3.restore();
    // GNOME's setting only.
    const g = gnome();
    SystemProxy._setExec(fakeExec({ gsettings: fakeGsettings(g) }));
    const log4 = logs();
    const sp4 = new SystemProxy(log4, { platform: 'linux', env: xfce(), portStore: memStore() });
    const st4 = await sp4.apply(10808, 'all');
    t.ok(st4.code === 'partial_env' && st4.firefox && !st4.chromiumAfterRelogin && !st4.chromiumNow
      && log4.lines.includes('warning: Firefox goes through Shroudly; Chrome and other Chromium browsers could not be set on this desktop'),
    'only GNOME\'s setting: partial_env, Firefox only, said as a warning');
    await sp4.restore();
  }

  // ── GNOME and KDE have real settings: nothing written for the next login ──
  for (const env of [{ XDG_CURRENT_DESKTOP: 'GNOME', HOME }, { XDG_CURRENT_DESKTOP: 'KDE', HOME, XDG_CONFIG_HOME: path.join(TMP, 'kdecfg') }]) {
    clean();
    const g = gnome();
    const sysEnv = new Map();
    const fx = fakeExec({ gsettings: fakeGsettings(g), ...fakeSystemd(sysEnv, new Map()) });
    SystemProxy._setExec(fx);
    const port = memStore();
    const name = `real-${env.XDG_CURRENT_DESKTOP}`;
    const sp = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: state(name), portStore: port });
    const st = await sp.apply(10808, 'all');
    t.ok(st.ok && !fs.existsSync(XPROFILE) && !fs.existsSync(ENVD) && !fs.existsSync(LXQT) && !fs.existsSync(envFile(name)) && !sysEnv.size && port.mem.pacPort === undefined,
      `${env.XDG_CURRENT_DESKTOP}: routed through its own setting; nothing written for the next login, no fixed port`);
    await sp.restore();
  }

  // ── EngineManager: who removes them ────────────────────────────────────
  {
    clean();
    SystemProxy._setExec(fakeExec({}));
    const name = 'em';
    const mem = {};
    const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
    const opts = { stateFile: state(name), platform: 'linux', env: xfce() };
    const em = new EngineManager(store, { proxyOptions: opts });
    const st = await em.proxy.apply(10808, 'all');
    t.ok(st.code === 'partial_env' && mem.pacPort === em.proxy.pacPort, 'EngineManager: the PAC\'s port is kept in the settings store');
    em.active = true;
    // A quit (the app stops the engine without the user asking).
    await em.stop();
    t.ok(fs.existsSync(XPROFILE) && fs.existsSync(ENVD), 'EngineManager: a quit (stop without the user) keeps them');
    await em.recover({ protectionOn: true });
    t.ok(fs.existsSync(XPROFILE) && fs.existsSync(ENVD), 'EngineManager: the next start with protection on keeps them');
    await em.recover({ protectionOn: false });
    t.ok(!fs.existsSync(XPROFILE) && !fs.existsSync(ENVD) && !fs.existsSync(envFile(name)), 'EngineManager: a start with protection off removes them');
    await em.proxy.apply(10808, 'all');
    em.active = true;
    await em.stop({ user: true });
    t.ok(!fs.existsSync(XPROFILE) && !fs.existsSync(ENVD) && !fs.existsSync(envFile(name)), 'EngineManager: the user\'s Stop removes them');
  }

  SystemProxy._setExec(null);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`system-proxy-env: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
