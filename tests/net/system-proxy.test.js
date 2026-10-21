'use strict';

/* The system proxy (electron/system-proxy.js) on every OS, against stand-ins
 * for reg.exe, networksetup, gsettings, kwriteconfig and osascript: nothing
 * here reads or changes this machine's proxy settings. What it proves:
 *   - the PAC never falls back to DIRECT for a routed host, and offers plain
 *     "SOCKS" only on macOS
 *   - both route modes set the PAC, on Windows, macOS, GNOME and KDE, and a
 *     restore puts back exactly what was there (off stays off), and only
 *     what is still ours
 *   - what 2.5.4 left behind (its SOCKS settings, its misread snapshots) is
 *     still recognised and put back, by the app and by the Windows installer
 *   - desktops with no system proxy, a Standard macOS account and a refused
 *     change are reported as such, never as routed
 *   - the administrator path on macOS, run by a real /bin/sh: one password,
 *     and the root helper restores on stop, when the app dies, and when it
 *     is itself sent TERM or HUP; one dialog however often it is clicked;
 *     a late answer after Stop is nobody's; a slow helper is waited for and
 *     never asked over; exit paths and the login hook never ask, the app
 *     asks once, in one process; an engine restart keeps the setting
 *   - a state file left by a restore that was refused is never overwritten
 *     or deleted by the next Start: the user's own PAC survives
 *   - which Linux desktop it is, by Chromium's own rules
 *   - another program taking the proxy over is noticed, but not our own stop
 *     and not GNOME's setting on KDE, nor a check that read during a
 *     re-apply; an engine restart does not hide it (P4, P13)
 *   - issue #27: a PAC removed, or replaced by another tool's on this
 *     computer, is set back by itself with one line, on Windows, macOS,
 *     GNOME and KDE, keeping the record of the user's own settings, every
 *     time (the 16 takeovers of the issue's log, Discord starts seconds
 *     apart); a manual proxy (one the user had before Shroudly excepted) or
 *     a PAC elsewhere (GNOME's WPAD too) chosen meanwhile is left alone; a
 *     program that answers every set-back within seconds (ping-pong) is
 *     fought twice, then named and left to the user; reg.exe failing, a
 *     value gone for a moment, or our address rewritten in capitals is no
 *     takeover; "Set Shroudly again" sets it back in place
 *   - a session end or a quit while a set-back is writing (macOS, GNOME): the
 *     restore wins, nothing of ours is left set after it
 *   - the user's own PAC or manual proxy served on this computer by a
 *     program that has gone is switched off at Stop and after a crash, its
 *     address kept, not put back pointing at nothing (macOS and its root
 *     helper, on 127.0.0.1 or ::1, GNOME, KDE); on Windows the PAC is put
 *     back as it was, never deleted
 *   - the PAC fails open ("; DIRECT") on XFCE, LXQt and other desktops only
 *     (P1), and its port comes from a fixed range (P16)
 *   - apply() and restore() run in order: a Stop during a re-apply ends
 *     restored, two applies make one PAC server (P2, P9)
 *   - a restore that did not take is not reported as done and keeps the
 *     state file (P7), which is written whole (P10) and names its owner, whose
 *     live session the login hook leaves alone (P12)
 *   - macOS: the user's own file:// PAC comes back (P5); a dismissed password
 *     dialog is remembered and not repeated at every login or start (P6); the
 *     login hook's dialog is in the user's language (P17)
 *   - EngineManager: a Stop wins over re-applies and restarts (P2), "Set
 *     Shroudly again" after a takeover on a Standard account sets it again
 *     (P4), the recovery dialog only with the window on screen (P6), and the
 *     dead-DNS warning only with the network up (P18)
 * XFCE, LXQt and other desktops: system-proxy-env.test.js. */

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, sleep, suite } = require('./helpers');

// Login hooks are written under the home directory: never the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sysproxy-'));
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

const SystemProxy = require(path.join(ROOT, 'electron', 'system-proxy.js'));
const FakeNS = require(path.join(__dirname, 'fixtures', 'fake-networksetup.js'));
const t = suite('system-proxy');

// ── stand-ins ──────────────────────────────────────────────────────────
function fakeExec(handlers) {
  const calls = [];
  const runSync = (cmd, args) => {
    calls.push([path.basename(cmd), ...args]);
    const h = handlers[path.basename(cmd)];
    if (!h) { const e = new Error(`spawn ${cmd} ENOENT`); e.code = 'ENOENT'; throw e; }
    return String(h(args) ?? '');
  };
  return {
    calls,
    runSync,
    run: async (cmd, args) => runSync(cmd, args),
    spawnDetached: (cmd, args) => { calls.push([path.basename(cmd), ...args]); },
  };
}
const ran = (fx, cmd) => fx.calls.filter((c) => c[0] === cmd);

/* reg.exe over a Map, printing what reg.exe prints. */
function fakeReg(values) {
  return (args) => {
    const [op, key, , name] = args;
    if (!/Internet Settings$/.test(key)) return '';
    if (op === 'query') {
      const v = values.get(name);
      if (!v) { const e = new Error('ERROR: The system was unable to find the specified registry key or value.'); e.status = 1; throw e; }
      return `\r\nHKEY_CURRENT_USER\\${key.slice(5)}\r\n    ${name}    ${v.type}    ${v.data}\r\n\r\n`;
    }
    if (op === 'add') { values.set(name, { type: args[5], data: args[7] }); return ''; }
    if (op === 'delete') { if (!values.delete(name)) { const e = new Error('not found'); e.status = 1; throw e; } return ''; }
    return '';
  };
}

/* gsettings over a Map of "schema key" -> printed value. */
function fakeGsettings(values, { failSet = null } = {}) {
  return (args) => {
    const [op, schema, key, value] = args;
    const k = `${schema} ${key}`;
    if (op === 'get') { if (!values.has(k)) throw new Error('No such key'); return `${values.get(k)}\n`; }
    if (op === 'set') {
      if (failSet && failSet(key, value)) throw new Error('GLib-GIO-CRITICAL: refused');
      values.set(k, key === 'port' ? String(value) : `'${value}'`);
    }
    return '';
  };
}

function gnomeDefaults(over = {}) {
  return new Map(Object.entries({
    'org.gnome.system.proxy mode': "'manual'",
    'org.gnome.system.proxy autoconfig-url': "''",
    'org.gnome.system.proxy.socks host': "''",
    'org.gnome.system.proxy.socks port': '0',
    'org.gnome.system.proxy.http host': "'10.0.0.5'",
    'org.gnome.system.proxy.http port': '3128',
    ...over,
  }));
}

/* kwriteconfig6/5 writing into the file it is given. */
function fakeKwrite(log) {
  return (args) => {
    if (args[0] === '--help') return 'Usage: kwriteconfig6 [options] value';
    const o = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--delete') o.delete = true;
      else if (args[i].startsWith('--')) o[args[i].slice(2)] = args[++i];
      else o.value = args[i];
    }
    log.push(o);
    let text = '';
    try { text = fs.readFileSync(o.file, 'utf8'); } catch {}
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(o.file, SystemProxy._kdeEdit(text, { [o.key]: o.delete ? null : o.value }));
    return '';
  };
}

function pacEval(body) {
  const ip = (s) => s.split('.').reduce((a, b) => a * 256 + Number(b), 0);
  const ctx = {
    isPlainHostName: (h) => !h.includes('.'),
    shExpMatch: (s, p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(s),
    isInNet: (h, pat, mask) => {
      const m = ip(mask);
      return Number(BigInt(ip(h)) & BigInt(m)) === Number(BigInt(ip(pat)) & BigInt(m));
    },
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  const find = (host) => ctx.FindProxyForURL(`https://${host}/`, host);
  find.http = (host) => ctx.FindProxyForURL(`http://${host}/`, host);
  return find;
}

function logs() { const l = []; const f = (level, msg) => l.push(`${level}: ${msg}`); f.lines = l; return f; }
const stateFile = (name) => path.join(TMP, name, 'proxy-state.json');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

(async () => {
  // ── the PAC ─────────────────────────────────────────────────────────
  for (const [platform, env] of [['win32', {}], ['linux', { XDG_CURRENT_DESKTOP: 'GNOME' }], ['linux', { XDG_CURRENT_DESKTOP: 'KDE' }], ['darwin', {}]]) {
    const sp = new SystemProxy(() => {}, { platform, env });
    const where = `${platform}${env.XDG_CURRENT_DESKTOP ? `, ${env.XDG_CURRENT_DESKTOP}` : ''}`;
    sp.mode = 'all';
    const find = pacEval(sp.pacBody(10808));
    // Every non-env desktop (Windows, GNOME, KDE) and macOS carries the SOCKS
    // (SOCKS4) entry after SOCKS5, so Java, WinINET and .NET clients that do
    // not understand "SOCKS5" are still routed instead of failing. No DIRECT.
    // Windows: WinHTTP answers "no proxy" to any answer holding a SOCKS entry,
    // so for https:// the engine is offered as an HTTP (CONNECT) proxy only;
    // plain http:// keeps the SOCKS entries.
    const socksOnly = 'SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808';
    const want = platform === 'win32' ? 'PROXY 127.0.0.1:10808' : socksOnly;
    t.ok(find('discord.com') === want, `PAC (${where}): a routed host gets "${want}", no DIRECT to slip around Shroudly`);
    t.ok(find.http('discord.com') === socksOnly, `PAC (${where}): plain http:// gets "${socksOnly}"`);
    t.ok(['nas', 'printer.local', 'router.lan', '192.168.1.1', '10.2.3.4', '172.20.0.1', '169.254.1.1', '100.100.1.1', '127.0.0.1', '[::1]']
      .every((h) => find(h) === 'DIRECT'), `PAC (${where}): this machine and the local network stay direct`);
    t.ok(find('172.32.0.1') === want && find('8.8.8.8') === want, `PAC (${where}): public addresses are routed`);
    sp.mode = 'listed'; sp.list = ['discord.com'];
    const listed = pacEval(sp.pacBody(10808));
    t.ok(listed('cdn.discord.com') === want && listed('example.com') === 'DIRECT', `PAC (${where}, listed): listed sites routed with no DIRECT fallback, the rest direct`);
    // Every platform's PAC must carry the plain "SOCKS" (SOCKS4) entry as well
    // as "SOCKS5": clients that do not understand "SOCKS5" (Java, WinINET,
    // .NET, CFNetwork) otherwise fail, and one Java app threw "unknown
    // protocol: socket" on every boot. Guard against regressing to SOCKS5-only.
    t.ok(/\bSOCKS 127\.0\.0\.1:10808\b/.test(sp.pacProxy(10808)) && sp.pacProxy(10808).startsWith('SOCKS5 '),
      `PAC (${where}): offers SOCKS (SOCKS4) after SOCKS5, so non-SOCKS5 clients are routed`);
  }
  // P1: XFCE, LXQt and other desktops, where Chromium keeps the PAC it read
  // and its address from its environment: it fails open, so a stop, a quit
  // or a crash never leaves Chromium browsers and apps without internet.
  for (const env of [{ XDG_CURRENT_DESKTOP: 'XFCE' }, { XDG_CURRENT_DESKTOP: 'LXQt' }, { XDG_CURRENT_DESKTOP: 'sway' }, {}]) {
    const sp = new SystemProxy(() => {}, { platform: 'linux', env });
    sp.mode = 'all';
    const find = pacEval(sp.pacBody(10808));
    sp.mode = 'listed'; sp.list = ['discord.com'];
    const listed = pacEval(sp.pacBody(10808));
    const w = 'SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; DIRECT';
    t.ok(find('discord.com') === w && find('192.168.1.1') === 'DIRECT' && listed('cdn.discord.com') === w && listed('example.com') === 'DIRECT',
      `PAC (P1, linux, ${env.XDG_CURRENT_DESKTOP || 'no desktop name'}): a routed host gets "${w}" (fails open)`);
  }

  // ── Windows ─────────────────────────────────────────────────────────
  {
    const reg = new Map([
      ['ProxyEnable', { type: 'REG_DWORD', data: '0x1' }],
      ['ProxyServer', { type: 'REG_SZ', data: 'corp-proxy:8080' }],
      ['AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' }],
    ]);
    const before = JSON.stringify([...reg]);
    const fx = fakeExec({ 'reg.exe': fakeReg(reg) });
    SystemProxy._setExec(fx);
    const file = stateFile('win');
    for (const mode of ['all', 'listed']) {
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file });
      const st = await sp.apply(10808, mode, ['discord.com']);
      t.ok(st.ok && st.code === 'ok' && reg.get('AutoConfigURL').data === sp.pacUrl, `Windows (${mode}): the PAC is set`);
      t.ok(reg.get('ProxyServer').data === 'corp-proxy:8080' && reg.get('ProxyEnable').data === '0x1' && !reg.has('ProxyOverride'),
        `Windows (${mode}): no SOCKS ProxyServer written, the user's manual proxy left as it is`);
      const state = readState(file);
      t.ok(state && state.snapshot.form === 'pac' && state.snapshot.ProxyServer.data === 'corp-proxy:8080', `Windows (${mode}): state file armed with all four values (an older Shroudly can restore it)`);
      t.ok(log.lines.some((l) => l.startsWith('success: System routed')), `Windows (${mode}): logged as routed`);
      await sp.restore();
      t.ok(JSON.stringify([...reg]) === before && !fs.existsSync(file), `Windows (${mode}): restore puts back exactly what was there, state file gone`);
    }
    // Another program set its own PAC meanwhile: a stop leaves it alone.
    {
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      await sp.apply(10808, 'all');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:7890/pac' });
      await sp.restore();
      t.ok(reg.get('AutoConfigURL').data === 'http://127.0.0.1:7890/pac', 'Windows: a PAC another program set since is not undone on stop');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
    }
    // Crash: the watchdog's recovery.
    {
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      await sp.apply(10808, 'all');
      sp.stopPacServer(); // the app is gone; the state file stays
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }) === true && JSON.stringify([...reg]) === before && !fs.existsSync(file),
        'Windows: after a crash, recovery restores exactly and clears the state file');
    }
    // A state file left by 2.5.4 ('all': SOCKS ProxyServer + PAC + override).
    {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, platform: 'win32', port: 10808, snapshot: {
        ProxyEnable: { type: 'REG_DWORD', data: '0x1' }, ProxyServer: { type: 'REG_SZ', data: 'corp-proxy:8080' },
        AutoConfigURL: { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' }, ProxyOverride: null, appliedMode: 'all' } }));
      reg.set('ProxyEnable', { type: 'REG_DWORD', data: '1' });
      reg.set('ProxyServer', { type: 'REG_SZ', data: 'socks=127.0.0.1:10808' });
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:50000/proxy.pac' });
      reg.set('ProxyOverride', { type: 'REG_SZ', data: '<local>;127.*;10.*;172.16.*;192.168.*;localhost' });
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }) === true && JSON.stringify([...reg]) === before,
        'Windows: a 2.5.4 state file (SOCKS form) is still recognised and restored exactly');
    }
    // No state file at all (2.0.0, or an installer that closed the app).
    {
      reg.set('ProxyServer', { type: 'REG_SZ', data: 'socks=127.0.0.1:10808' });
      reg.set('ProxyEnable', { type: 'REG_DWORD', data: '1' });
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:50000/proxy.pac' });
      t.ok(SystemProxy.resetLegacySync(() => {}, { platform: 'win32' }) && reg.get('ProxyEnable').data === '0' && !reg.has('ProxyServer') && !reg.has('AutoConfigURL'),
        'Windows reset: the old SOCKS form is switched off and removed');
      reg.set('ProxyEnable', { type: 'REG_DWORD', data: '0x1' });
      reg.set('ProxyServer', { type: 'REG_SZ', data: 'corp-proxy:8080' });
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:50000/proxy.pac' });
      t.ok(SystemProxy.resetLegacySync(() => {}, { platform: 'win32' }) && reg.get('ProxyEnable').data === '0x1' && reg.get('ProxyServer').data === 'corp-proxy:8080' && !reg.has('AutoConfigURL'),
        'Windows reset: the PAC form is removed, the user\'s manual proxy stays on');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:7890/pac' });
      t.ok(!SystemProxy.resetLegacySync(() => {}, { platform: 'win32' }) && reg.get('AutoConfigURL').data === 'http://127.0.0.1:7890/pac', 'Windows reset: another local tool\'s PAC is not ours');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
    }
    // Ownership: another program puts a PAC of its own, served somewhere
    // else (a company's, the user's own), while applied: reported, once, and
    // left as it is.
    {
      const seen = [];
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i.lost, i.takeover]), ownershipIntervalMs: 40, takeoverConfirmMs: 0 });
      await sp.apply(10808, 'all');
      t.ok(!!sp._ownTimer, 'Windows: the ownership check runs while applied');
      t.ok(new SystemProxy(() => {}, { platform: 'win32' }).ownershipIntervalMs === 20000 && new SystemProxy(() => {}, { platform: 'darwin' }).ownershipIntervalMs === 60000,
        'Windows: read back every 20 s (one reg.exe query), elsewhere every minute');
      const queries = () => ran(fx, 'reg.exe').filter((c) => c[1] === 'query').length;
      const q0 = queries();
      const ps0 = ran(fx, 'powershell.exe').length;
      await sleep(150);
      t.ok(seen.length === 0 && queries() > q0, 'ownership: our PAC in place, nothing reported (one reg query per check)');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.example/proxy.pac' });
      await sleep(150);
      t.ok(seen.length === 1 && seen[0][0] === false && seen[0][1][0] === 'AutoConfigURL' && seen[0][2].kind === 'pac'
        && reg.get('AutoConfigURL').data === 'http://wpad.example/proxy.pac', 'ownership: a PAC served elsewhere (the user\'s own) is reported, once, and left as it is');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: sp.pacUrl });
      await sleep(150);
      t.ok(seen.length === 2 && seen[1][0] === true, 'ownership: and its coming back');
      t.ok(ps0 > 0 && ran(fx, 'powershell.exe').length === ps0, 'ownership: no PowerShell on the timer (WinINET is told only on apply, restore and setting it back)');
      await sp.restore();
      t.ok(!sp._ownTimer, 'ownership: the check stops with the restore');
    }
    // Issue #27: another program removes our PAC, or puts its own local one
    // there, while protection is on: Shroudly sets it back by itself, says so
    // in one line, and the window keeps showing it as set. The record of the
    // user's own settings, the PAC server and its address stay as they were.
    {
      for (const [why, take] of [
        ['removed', () => reg.delete('AutoConfigURL')],
        ['replaced by another tool\'s PAC on this computer', () => reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:7890/pac' })],
        ['replaced by a PAC of Shroudly\'s at another address', () => reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:10999/proxy.pac' })],
      ]) {
        const seen = [];
        const log = logs();
        const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0 });
        await sp.apply(10808, 'all');
        const url = sp.pacUrl;
        const ps0 = ran(fx, 'powershell.exe').length;
        const state0 = readText(file);
        take();
        const lost = await sp.checkOwnership();
        t.ok(lost.length === 0 && reg.get('AutoConfigURL').data === url && seen.length === 0 && sp._owned,
          `issue #27 (${why}): set back by itself, nothing for the window to show`);
        t.ok(log.lines.filter((l) => l.includes('system proxy')).join('|') === 'info: Autopilot: another program changed the system proxy (AutoConfigURL); set it back to Shroudly',
          `issue #27 (${why}): one line says so`);
        t.ok(readText(file) === state0 && readState(file).snapshot.AutoConfigURL.data === 'http://wpad.corp/proxy.pac' && sp.pacUrl === url
          && reg.get('ProxyServer').data === 'corp-proxy:8080' && reg.get('ProxyEnable').data === '0x1' && ran(fx, 'powershell.exe').length === ps0 + 1,
        `issue #27 (${why}): the user's own settings are still what Stop puts back, the manual proxy under ours untouched, WinINET told once`);
        await sp.restore();
        t.ok(JSON.stringify([...reg]) === before && !fs.existsSync(file), `issue #27 (${why}): …and Stop puts exactly those back`);
      }
    }
    // A manual proxy server switched on since Shroudly applied is a choice
    // (the user's, or a VPN they started): reported and left alone, never
    // fought. Once it is gone again, our PAC is set back.
    {
      const seen = [];
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0 });
      await sp.apply(10808, 'all');
      const url = sp.pacUrl;
      reg.delete('AutoConfigURL');
      reg.set('ProxyServer', { type: 'REG_SZ', data: '127.0.0.1:8118' });
      await sp.checkOwnership();
      await sp.checkOwnership();
      t.ok(!reg.has('AutoConfigURL') && reg.get('ProxyServer').data === '127.0.0.1:8118' && seen.length === 1 && seen[0][0] === false
        && seen[0][1].takeover.kind === 'manual' && seen[0][1].takeover.server === '127.0.0.1:8118' && !seen[0][1].gaveUp
        && log.lines.includes('warning: Another program changed the system proxy (AutoConfigURL): that traffic no longer goes through Shroudly'),
      'a manual proxy server switched on meanwhile: reported once, left as it is (not fought)');
      reg.set('ProxyServer', { type: 'REG_SZ', data: 'corp-proxy:8080' });
      await sp.checkOwnership();
      t.ok(reg.get('AutoConfigURL').data === url && seen.length === 2 && seen[1][0] === true && seen[1][1].retaken
        && log.lines.includes('info: Autopilot: another program changed the system proxy (AutoConfigURL); set it back to Shroudly'),
      '…and once it is gone (the user\'s own manual proxy, kept under ours, is no new choice), ours is set back and the window told');
      await sp.restore();
      t.ok(JSON.stringify([...reg]) === before, 'manual proxy case: Stop puts back exactly what was there');
    }
    // Anti-flap: a program that puts its own setting back whenever ours is
    // set (it reacts to every proxy change) is not fought for ever. Two times
    // set back; taken a third time right after Shroudly's set-back, Shroudly
    // stops, names the program it can, tells the window, and touches nothing
    // more.
    {
      const seen = [];
      const log = logs();
      const real = fakeReg(reg);
      let fighting = true;
      const fxFight = fakeExec({ 'reg.exe': (args) => {
        const out = real(args);
        // The other program answers every write of ours at once.
        if (fighting && args[0] === 'add' && args[3] === 'AutoConfigURL' && /:\d+\/proxy\.pac$/.test(args[7] || '')) reg.delete('AutoConfigURL');
        return out;
      } });
      SystemProxy._setExec(fxFight);
      const asked = [];
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0,
        whoTookIt: async (tk) => { asked.push(tk && tk.kind); return ['V2Ray / Clash'];} });
      fighting = false;
      await sp.apply(10808, 'all');
      fighting = true;
      const writes = () => fxFight.calls.filter((c) => c[0] === 'reg.exe' && c[1] === 'add' && c[4] === 'AutoConfigURL').length;
      const w0 = writes();
      reg.delete('AutoConfigURL');
      for (let i = 0; i < 6; i++) await sp.checkOwnership();
      t.ok(writes() - w0 === 2, `anti-flap: set back twice, then no more (${writes() - w0} writes over 6 checks)`);
      const last = seen[seen.length - 1];
      t.ok(seen.length === 2 && seen.every((e) => e[0] === false) && !seen[0][1].gaveUp && last[1].gaveUp && last[1].by.join() === 'V2Ray / Clash' && asked.join() === 'cleared',
        'anti-flap: taken again at once is shown as taken over; the third takeover within the window: the window is told it is a fight, with the program named');
      t.ok(log.lines.filter((l) => l.startsWith('warning: Another program keeps changing')).length === 1
        && log.lines.includes('warning: Another program keeps changing the system proxy (AutoConfigURL), probably V2Ray / Clash; Shroudly stopped setting it back. Close it or turn off its proxy setting, then set Shroudly again.')
        && log.lines.filter((l) => l.startsWith('info: Autopilot: another program changed')).length === 0,
      'anti-flap: one line names it; "set back" is never claimed while it was taken again at once');
      // The user presses "Set Shroudly again" while it still fights: set,
      // taken again at once, and said so (not "set").
      const again = await sp.retakeNow();
      t.ok(again && again.code === 'replaced' && !reg.has('AutoConfigURL') && !sp._gaveUp, '"Set Shroudly again" while the other program still fights: reported as taken again, not as set');
      // …and once it has stopped: set back, the fight forgotten, and the
      // user's own settings from before Shroudly still what Stop puts back.
      fighting = false;
      const back = await sp.retakeNow();
      t.ok(back && back.ok && reg.get('AutoConfigURL').data === sp.pacUrl && sp._fight === 0 && !sp._gaveUp && sp._owned
        && readState(file).snapshot.AutoConfigURL.data === 'http://wpad.corp/proxy.pac', 'anti-flap: "Set Shroudly again" sets it and starts afresh, the record of the user\'s own settings kept');
      await sp.restore();
      SystemProxy._setExec(fx);
      t.ok(JSON.stringify([...reg]) === before, 'anti-flap: Stop puts back exactly what was there');
    }
    // Anti-flap over time, on a clock of the test's own: only a program that
    // answers Shroudly's set-back is a fight. Issue #27's log: the system
    // proxy taken over 16 times in five hours, each time by something
    // starting with Discord, three of them within two and a half minutes.
    // Each one is set back; it used to be the third within ten minutes that
    // made Shroudly give up.
    const clockAt = (hms) => { const [h, m, sec] = hms.split(':').map(Number); return Date.UTC(2026, 9, 1, h, m, sec); };
    {
      const log = logs();
      let clock = clockAt('18:23:45');
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [], now: () => clock, whoTookIt: async () => [] });
      await sp.apply(10808, 'all');
      const taken = ['17:07:32', '17:19:21', '18:24:45', '18:55:51', '18:56:57', '18:58:17', '20:05:27', '20:19:35', '20:30:54', '20:39:29',
        '21:25:32', '21:31:03', '21:39:53', '21:53:05', '21:56:13', '22:11:17'];
      let back = 0;
      for (const at of taken) {
        clock = clockAt(at);
        reg.delete('AutoConfigURL');
        await sp.checkOwnership();
        if (reg.has('AutoConfigURL') && reg.get('AutoConfigURL').data === sp.pacUrl) back++;
      }
      t.ok(back === 16 && !sp._gaveUp && log.lines.filter((l) => l.includes('set it back to Shroudly')).length === 16 && !log.lines.some((l) => l.includes('keeps changing')),
        `anti-flap (issue #27's log): all ${taken.length} takeovers set back, the three within minutes too (${back})`);
      // The same burst as close as it could have been: a takeover a second
      // after each Discord start of the log (some 14 s apart), seen 3 s
      // after the start. A takeover after a program start is never an answer.
      let burst = 0;
      for (const start of ['18:56:46', '18:57:17', '18:57:31', '18:57:54', '18:58:26']) {
        clock = clockAt(start);
        sp.checkSoon([]);
        clock += 1000;
        reg.delete('AutoConfigURL');
        clock += 2000;
        await sp.checkOwnership();
        if (reg.has('AutoConfigURL')) burst++;
      }
      t.ok(burst === 5 && !sp._gaveUp, `anti-flap (issue #27): five Discord starts seconds apart, each followed by a takeover: all ${burst} set back`);
      await sp.restore();
    }
    // A program that takes it again within seconds of every set-back is
    // found out within three rounds, as before: set back twice, then left.
    {
      const log = logs();
      let clock = clockAt('12:00:00');
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [], now: () => clock, whoTookIt: async () => [] });
      await sp.apply(10808, 'all');
      const writes = () => ran(fx, 'reg.exe').filter((c) => c[1] === 'add' && c[4] === 'AutoConfigURL').length;
      const w0 = writes();
      reg.delete('AutoConfigURL');
      await sp.checkOwnership();
      let rounds = 1;
      while (!sp._gaveUp && rounds < 10) {
        clock += 2000; reg.delete('AutoConfigURL');      // it answers 2 s after the set-back
        clock += 1000; await sp.checkOwnership();        // seen at the look 3 s after it
        rounds++;
      }
      t.ok(sp._gaveUp && rounds === 3 && writes() - w0 === 2 && !reg.has('AutoConfigURL')
        && log.lines.includes('warning: Another program keeps changing the system proxy (AutoConfigURL); Shroudly stopped setting it back. Close the other proxy or VPN program, then set Shroudly again.'),
      `anti-flap: a program answering every set-back within seconds: found out in ${rounds} rounds, ${writes() - w0} set-backs (unnamed when no program can be told)`);
      // It puts ours back itself: back to normal, and the fight is over. A
      // single takeover a minute later is set back, not taken for more of it.
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: sp.pacUrl });
      clock += 5000; await sp.checkOwnership();
      t.ok(!sp._gaveUp && sp._owned && sp._fight === 0 && log.lines.includes('info: The system proxy points at Shroudly again'), 'anti-flap: ours again by itself: back to normal, the fight forgotten');
      clock += 60000; reg.delete('AutoConfigURL'); await sp.checkOwnership();
      t.ok(reg.get('AutoConfigURL').data === sp.pacUrl && !sp._gaveUp && sp._fight === 1, 'anti-flap: …so the next takeover on its own is set back');
      // Twice answered, then ours for longer than the window: forgotten too.
      clock += 2000; reg.delete('AutoConfigURL'); clock += 1000; await sp.checkOwnership();
      t.ok(sp._fight === 2 && reg.has('AutoConfigURL'), 'anti-flap: answered once more: two in a row, set back');
      clock += 40000; await sp.checkOwnership();
      t.ok(sp._fight === 0, 'anti-flap: ours for longer than the window after the set-back: the count starts again');
      clock += 5000; reg.delete('AutoConfigURL'); await sp.checkOwnership();
      t.ok(reg.get('AutoConfigURL').data === sp.pacUrl && !sp._gaveUp && sp._fight === 1, 'anti-flap: …and the next takeover is set back');
      // Taken again later than the window after the set-back: a takeover of
      // its own, however many came before.
      for (let i = 0; i < 5; i++) { clock += 45000; reg.delete('AutoConfigURL'); await sp.checkOwnership(); }
      t.ok(reg.get('AutoConfigURL').data === sp.pacUrl && !sp._gaveUp && sp._fight === 1, 'anti-flap: takeovers each more than 30 s after the set-back are all set back');
      // A program start (checkSoon) begins the count afresh.
      clock += 2000; reg.delete('AutoConfigURL'); clock += 1000; await sp.checkOwnership();
      sp.checkSoon([]);
      t.ok(sp._fight === 0 && sp._retakenAt === 0, 'anti-flap: a program start forgets the count (what follows is that start\'s doing)');
      await sp.restore();
    }
    // On real timers: after a set-back the setting is read again soon by
    // itself (retakeLooksMs), so a program that answers it is seen in time.
    {
      const real = fakeReg(reg);
      const fxAnswer = fakeExec({ 'reg.exe': (args) => {
        const out = real(args);
        if (args[0] === 'add' && args[3] === 'AutoConfigURL' && /:\d+\/proxy\.pac$/.test(args[7] || '')) setTimeout(() => reg.delete('AutoConfigURL'), 15);
        return out;
      } });
      SystemProxy._setExec(fxAnswer);
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, fightWindowMs: 400, retakeLooksMs: [60, 200], whoTookIt: async () => [] });
      await sp.apply(10808, 'all');
      await sleep(30); // the apply's own write was answered too
      await sp.checkOwnership();
      const gaveUp = await (async () => { for (let i = 0; i < 40 && !sp._gaveUp; i++) await sleep(25); return sp._gaveUp; })();
      t.ok(gaveUp && fxAnswer.calls.filter((c) => c[1] === 'add' && c[4] === 'AutoConfigURL').length === 3,
        'anti-flap: the look soon after each set-back sees the answer: given up by itself, with no timer tick');
      await sp.restore();
      SystemProxy._setExec(fx);
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
      t.ok(JSON.stringify([...reg]) === before, 'anti-flap: …and Stop puts exactly back what was there');
    }
    // Not a takeover: reg.exe that could not run or was refused (a virus
    // scanner, too many processes) says nothing about the value, and a
    // settings window that wrote our address back in capitals or with a
    // trailing slash still points at us. Neither may set anything.
    {
      const seen = [];
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0 });
      await sp.apply(10808, 'all');
      const url = sp.pacUrl;
      for (const [why, err] of [['not started', Object.assign(new Error('spawn reg.exe EAGAIN'), { code: 'EAGAIN' })],
        ['refused to start', Object.assign(new Error('spawn reg.exe EPERM'), { code: 'EPERM' })],
        ['timed out', Object.assign(new Error('timed out'), { killed: true, code: null })],
        ['ended with another error', Object.assign(new Error('Command failed'), { code: 5 })]]) {
        SystemProxy._setExec({ ...fx, run: async () => { throw err; } });
        const r = await sp.checkOwnership();
        t.ok(r === null && seen.length === 0 && reg.get('AutoConfigURL').data === url, `reg.exe ${why}: unknown, not a takeover`);
      }
      SystemProxy._setExec(fx);
      const writes0 = ran(fx, 'reg.exe').filter((c) => c[1] === 'add').length;
      for (const v of [url.toUpperCase(), `${url}/`, ` ${url} `]) {
        reg.set('AutoConfigURL', { type: 'REG_SZ', data: v });
        t.ok((await sp.checkOwnership()).length === 0 && seen.length === 0, `"${v.trim()}" is still our address`);
      }
      t.ok(ran(fx, 'reg.exe').filter((c) => c[1] === 'add').length === writes0, '…and nothing was written for any of them');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: url.toUpperCase() });
      await sp.restore();
      t.ok(JSON.stringify([...reg]) === before, 'our address in capitals is still taken out at Stop');
    }
    // A value gone only for a moment (a program rewriting its settings in
    // two steps, Shroudly's own re-apply) is read again before anything is
    // set back: not a takeover.
    {
      const seen = [];
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 60 });
      await sp.apply(10808, 'all');
      const url = sp.pacUrl;
      const writes0 = ran(fx, 'reg.exe').filter((c) => c[1] === 'add').length;
      reg.delete('AutoConfigURL');
      setTimeout(() => reg.set('AutoConfigURL', { type: 'REG_SZ', data: url }), 20);
      t.ok((await sp.checkOwnership()).length === 0 && seen.length === 0 && !log.lines.some((l) => l.includes('system proxy (')) && ran(fx, 'reg.exe').filter((c) => c[1] === 'add').length === writes0,
        'a value gone for a moment: read again first, no takeover and nothing written');
      // A Stop while a takeover is being read again: nothing is set back after it.
      reg.delete('AutoConfigURL');
      const checking = sp.checkOwnership();
      await sleep(10);
      await sp.restore();
      t.ok((await checking) === null && !reg.has('AutoConfigURL') && seen.length === 0 && !fs.existsSync(file), 'a Stop during the second look: nothing set back after it');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
    }
    // The record to put things back by goes with every setting of ours: one
    // taken away meanwhile (by a restore elsewhere) is written again when the
    // setting is set back.
    {
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, restoreCommand: { exe: 'Shroudly.exe', args: ['--restore-proxy'] } });
      await sp.apply(10808, 'all');
      fs.rmSync(file);
      reg.delete('AutoConfigURL');
      await sp.checkOwnership();
      t.ok(reg.get('AutoConfigURL').data === sp.pacUrl && readState(file) && readState(file).snapshot.AutoConfigURL.data === 'http://wpad.corp/proxy.pac',
        'set back: a state file taken away meanwhile is written again');
      await sp.restore();
      t.ok(JSON.stringify([...reg]) === before && !fs.existsSync(file), '…and Stop still puts everything back');
    }
    // The user's own PAC from before Shroudly is another tool's, served on
    // this computer. The tool quits and removes the setting (ours with it),
    // which Shroudly sets back. At Stop it is put back as it was, whether
    // anything serves it now or not: Windows keeps only the address, which
    // switching it off would lose for good (a tool restarting, a logoff
    // where it ended first), and WinINET and Chromium go on without a PAC
    // they cannot fetch. The same after a crash (the watchdog's recovery).
    {
      const tool = 'http://127.0.0.1:16823/proxy_on.pac';
      let served = false;
      SystemProxy._setExec({ ...fx, listening: (port) => (port === 16823 ? served : true) });
      const gone = 'no longer running';
      for (const [why, value] of [['its program gone', false], ['still served', true], ['unknown', null]]) {
        reg.set('AutoConfigURL', { type: 'REG_SZ', data: tool });
        served = true;
        const log = logs();
        const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [] });
        await sp.apply(10808, 'all');
        served = value;
        reg.delete('AutoConfigURL');
        await sp.checkOwnership();
        const setBack = reg.get('AutoConfigURL').data === sp.pacUrl;
        await sp.restore();
        t.ok(setBack && reg.get('AutoConfigURL').data === tool && !log.lines.some((l) => l.includes(gone)) && !fs.existsSync(file),
          `Windows: Stop after the user's own local PAC was set back (${why}): put back as it was, never deleted`);
      }
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: tool });
      served = true;
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      await sp.apply(10808, 'all');
      sp.stopPacServer();
      served = false;
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }, () => {}) === true && reg.get('AutoConfigURL').data === tool && !fs.existsSync(file),
        'Windows: …and after a crash, the watchdog\'s recovery puts it back too');
      SystemProxy._setExec(fx);
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
      t.ok(JSON.stringify([...reg]) === before, 'Windows: (the registry as it was for the next tests)');
    }
    // On the timer, and ahead of it (checkSoon: a Discord just started, a
    // program the autopilot restarted).
    {
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 40, takeoverConfirmMs: 10 });
      await sp.apply(10808, 'all');
      reg.delete('AutoConfigURL');
      await sleep(250);
      t.ok(reg.get('AutoConfigURL').data === sp.pacUrl && log.lines.filter((l) => l.includes('set it back to Shroudly')).length === 1, 'set back by the timer, without anyone asking');
      await sp.restore();
      const sp2 = new SystemProxy(log, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 10 });
      await sp2.apply(10808, 'all');
      reg.delete('AutoConfigURL');
      sp2.checkSoon([20]);
      await sleep(200);
      t.ok(reg.get('AutoConfigURL').data === sp2.pacUrl, 'checkSoon: set back seconds after, not a whole interval later');
      sp2.checkSoon([20]);
      await sp2.restore();
      await sleep(80);
      t.ok(JSON.stringify([...reg]) === before && sp2._soon.length === 0, 'checkSoon: a look still waiting when protection stops does nothing');
    }
    // autoRetake false: only reported, as before.
    {
      const seen = [];
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push(o), ownershipIntervalMs: 60000, takeoverConfirmMs: 0, autoRetake: false });
      await sp.apply(10808, 'all');
      reg.delete('AutoConfigURL');
      await sp.checkOwnership();
      t.ok(!reg.has('AutoConfigURL') && seen.join() === 'false', 'autoRetake off: a takeover is only reported');
      await sp.restore();
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
    }
    // P4: taken over, then an engine restart applies again while the setting
    // is kept: still reported as taken over, not as set.
    {
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0 });
      await sp.apply(10808, 'all');
      // A PAC served elsewhere: left to it (a removed one is set back).
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.example/proxy.pac' });
      await sp.checkOwnership();
      const again = await sp.apply(10909, 'all');
      t.ok(again.code === 'replaced' && !again.ok && again.lost[0] === 'AutoConfigURL' && again.replacedFrom && again.replacedFrom.code === 'ok',
        'P4: apply() while taken over says "replaced" (the takeover is not hidden by an engine restart)');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: sp.pacUrl });
      await sp.checkOwnership();
      t.ok((await sp.apply(10909, 'all')).code === 'ok', 'P4: …and "ok" again once the setting is ours again');
      await sp.restore();
    }
    // P13: a takeover check that read in the middle of a re-apply (restore,
    // then apply) is not a takeover.
    {
      const seen = [];
      let readGate = null;
      let answerGate = null;
      const fx2 = fakeExec({ 'reg.exe': fakeReg(reg) });
      fx2.run = async (cmd, args) => { if (readGate) await readGate; const out = fx2.runSync(cmd, args); if (answerGate) await answerGate; return out; };
      SystemProxy._setExec(fx2);
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i.lost]), ownershipIntervalMs: 60000 });
      await sp.apply(10808, 'all');
      let letRead; let letAnswer;
      readGate = new Promise((r) => { letRead = r; });
      const checking = sp.checkOwnership();
      await sp.restore();                      // the user's own value back for a moment
      answerGate = new Promise((r) => { letAnswer = r; });
      letRead(); readGate = null;              // the check reads it now
      await sleep(10);
      await sp.apply(10808, 'all');            // and ours again
      letAnswer(); answerGate = null;
      await checking;
      t.ok(seen.length === 0 && sp.applied && reg.get('AutoConfigURL').data === sp.pacUrl,
        'P13: a check that read during a re-apply reports no takeover');
      await sp.restore();
      SystemProxy._setExec(fx);
    }
    // P7: the restore's own commands fail (reg.exe refused): not reported as
    // restored, and the state file, the only record of the user's own PAC, stays.
    {
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'win32', stateFile: file });
      await sp.apply(10808, 'all');
      const real = fakeReg(reg);
      SystemProxy._setExec(fakeExec({ 'reg.exe': (args) => { if (args[0] !== 'query') { const e = new Error('ERROR: Access is denied.'); e.status = 1; throw e; } return real(args); } }));
      const ok = await sp.restore();
      t.ok(ok === false && fs.existsSync(file) && /^http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/.test(reg.get('AutoConfigURL').data)
        && readState(file).snapshot.AutoConfigURL.data === 'http://wpad.corp/proxy.pac'
        && log.lines.includes('warning: System proxy settings could not be restored yet; they will be at the next start') && !log.lines.includes('success: System proxy settings restored'),
      'P7: a restore reg.exe refused is reported as not done, and the state file with the user\'s own PAC stays');
      SystemProxy._setExec(fx);
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }) === true && JSON.stringify([...reg]) === before && !fs.existsSync(file),
        'P7: …and the next recovery puts it back exactly');
    }
    // P2 and P9: apply() and restore() run one at a time, in order: a restore
    // asked for during an apply comes after it, and two applies at once make
    // one PAC server.
    {
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      const urls = [];
      const servers = [];
      const orig = sp.startPacServer.bind(sp);
      sp.startPacServer = async (...a) => { const u = await orig(...a); urls.push(u); servers.push(sp.pacServer); return u; };
      const [a, b] = await Promise.all([sp.apply(10808, 'all'), sp.apply(10808, 'all')]);
      t.ok(urls.length === 1 && a.ok && b.ok && a.pacUrl === b.pacUrl, 'P9: two applies at once: one PAC server, one address');
      const reapply = sp.restore().then(() => sp.apply(10808, 'listed', ['discord.com']));
      const stop = (async () => { await sleep(0); return sp.restore(); })();
      await Promise.all([reapply, stop]);
      // This process's own servers, not whatever listens on their ports: the
      // fixed range is shared with any other run on this computer.
      await sleep(20);
      const open = servers.map((srv) => !!(srv && srv.listening));
      t.ok(!sp.applied && JSON.stringify([...reg]) === before && !fs.existsSync(file) && !open.some(Boolean),
        'P2: a Stop during a re-apply is done after it: nothing left set, no PAC server left listening');
    }
    // P10: the state file is written whole or not at all. A write that fails
    // half-way (a full disk) leaves the previous one exactly as it was.
    {
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      await sp.apply(10808, 'all');
      const prev = readText(file);
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = function (f, data, ...rest) {
        if (String(data).includes('"snapshot"')) {
          realWrite.call(fs, f, String(data).slice(0, 25), ...rest);
          const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e;
        }
        return realWrite.call(fs, f, data, ...rest);
      };
      try { sp.updatePort(10909); } finally { fs.writeFileSync = realWrite; }
      t.ok(readText(file) === prev && readState(file).port === 10808 && !fs.readdirSync(path.dirname(file)).some((f) => f.includes('.shroudly-')),
        'P10: a state file write that fails half-way leaves the previous one whole, and no temporary file');
      sp.stopPacServer();
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }) === true && JSON.stringify([...reg]) === before,
        'P10: …so a recovery after a power cut still puts everything back');
      // A state file that cannot be read at all: our PAC is at least switched off.
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:10840/proxy.pac' });
      fs.writeFileSync(file, '{"v":2,"platform":"win32","port":10808,"pacUrl":"http://127.0.0');
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }) === false && !reg.has('AutoConfigURL') && !fs.existsSync(file),
        'P10: a state file cut short is not just deleted: our PAC still set is switched off');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' });
    }
    // P12: the login hook's restore (--restore-proxy) leaves alone the state
    // file of a Shroudly that is running: started at the same login, it is
    // that session's live setting, not a leftover.
    {
      const other = spawn('sleep', ['30']);
      // ps (macOS, Linux) and tasklist (Windows) name the process behind an id.
      const psName = { [other.pid]: 'sleep' };
      SystemProxy._setExec(fakeExec({
        'reg.exe': fakeReg(reg),
        ps: (args) => `${psName[Number(args[args.length - 1])] || ''}\n`,
        'tasklist.exe': (args) => { const pid = Number(String(args[1]).replace('PID eq ', '')); return psName[pid] ? `"${psName[pid]}.exe","${pid}","Console","1","1,000 K"\r\n` : 'INFO: No tasks are running which match the specified criteria.\r\n'; },
      }));
      const boot = SystemProxy._owner().boot;
      const live = { v: 2, platform: 'win32', port: 10808, pacUrl: 'http://127.0.0.1:10840/proxy.pac',
        snapshot: { form: 'pac', appliedMode: 'all', AutoConfigURL: { type: 'REG_SZ', data: 'http://wpad.corp/proxy.pac' } } };
      const leftover = (owner) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ...live, owner }));
        reg.set('AutoConfigURL', { type: 'REG_SZ', data: live.pacUrl });
      };
      leftover({ pid: other.pid, boot, exe: 'sleep' });
      t.ok(['linux', 'darwin', 'win32'].every((pl) => SystemProxy._ownerAlive({ pid: other.pid, boot, exe: 'sleep' }, pl))
        && !SystemProxy._ownerAlive({ pid: other.pid, boot, exe: 'Shroudly' }, 'linux') && !SystemProxy._ownerAlive({ pid: other.pid, boot, exe: 'Shroudly' }, 'win32'),
      'P12: a running owner is told by its process id, this boot and its program name (ps, tasklist)');
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32', skipIfOwnerAlive: true }) === 'running' && fs.existsSync(file) && reg.get('AutoConfigURL').data === live.pacUrl,
        'P12: the state file of a running Shroudly: not restored, not deleted');
      for (const [why, owner] of [['its process is gone', { pid: 2147483646, boot, exe: 'sleep' }], ['it was before a restart', { pid: other.pid, boot: boot - 86400, exe: 'sleep' }],
        ['the process id now belongs to another program', { pid: other.pid, boot, exe: 'Shroudly' }]]) {
        leftover(owner);
        t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32', skipIfOwnerAlive: true }) === true && JSON.stringify([...reg]) === before && !fs.existsSync(file),
          `P12: a leftover whose owner is not running (${why}) is restored`);
      }
      leftover({ pid: other.pid, boot, exe: 'sleep' });
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'win32' }) === true && JSON.stringify([...reg]) === before,
        'P12: the app\'s own start (the only Shroudly then) restores regardless');
      other.kill('SIGKILL');
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      SystemProxy._setExec(fx);
      await sp.apply(10808, 'all');
      const owner = readState(file).owner;
      t.ok(owner && owner.pid === process.pid && Math.abs(owner.boot - boot) <= 1 && owner.exe === path.basename(process.execPath), 'P12: the state file names the Shroudly that wrote it');
      await sp.restore();
    }
    // P16: the PAC's port comes from a fixed range below every system's
    // random ports, clear of Shroudly's own.
    {
      const ports = SystemProxy.pacPorts();
      t.ok(ports.length === 20 && new Set(ports).size === 20 && ports.every((p) => p >= 10840 && p <= 10859),
        'P16: the PAC\'s ports are 10840-10859 (below 32768, clear of 10808-10828, 10809, 10810)');
      const free = (port) => new Promise((r) => { const s = require('net').createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
      // Taken by us, or already taken by something else on this machine (a
      // Shroudly that is running here): either way it is not free.
      const squat = require('net').createServer();
      await new Promise((r) => { squat.once('error', () => r()); squat.listen(ports[0], '127.0.0.1', r); });
      let want = 0;
      for (const p of ports.slice(1)) if (await free(p)) { want = p; break; }
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file });
      await sp.apply(10808, 'all');
      // Another run on this computer (tests in parallel, a Shroudly) may take
      // that one meanwhile: then a later one of the range, and it is taken.
      const fine = sp.pacPort === want || (ports.indexOf(sp.pacPort) > ports.indexOf(want) && !(await free(want)));
      t.ok(fine, `P16: the first free one is used (${sp.pacPort}; ${ports[0]} was taken)`);
      await sp.restore();
      try { squat.close(); } catch {}
    }
  }

  // ── the Windows installer's hook (scripts/installer.nsh), interpreted ──
  {
    // Git on Windows checks the file out with CRLF line ends.
    const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8').replace(/\r\n/g, '\n');
    const body = nsh.match(/!macro shroudlyResetProxy\n([\s\S]*?)!macroend/)[1];
    const runMacro = (reg) => {
      const v = {};
      const val = (x) => (x.startsWith('$') ? (v[x] ?? '') : x.replace(/^"(.*)"$/, '$1'));
      const stack = [];
      const active = () => stack.every(Boolean);
      for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith(';')) continue;
        const tok = line.match(/"[^"]*"|\S+/g);
        const cond = () => val(tok[1]).toLowerCase() === val(tok[3]).toLowerCase();
        if (tok[0] === '${If}') { stack.push(active() ? cond() : false); continue; }
        if (tok[0] === '${OrIf}') { stack[stack.length - 1] = stack[stack.length - 1] || cond(); continue; }
        if (tok[0] === '${AndIf}') { stack[stack.length - 1] = stack[stack.length - 1] && cond(); continue; }
        if (tok[0] === '${EndIf}') { stack.pop(); continue; }
        if (!active()) continue;
        const inet = (k) => val(k) === '${SHROUDLY_INET}';
        if (tok[0] === 'ReadRegStr') v[tok[1]] = inet(tok[3]) ? ((reg.get(val(tok[4])) || {}).data || '') : '';
        else if (tok[0] === 'StrCpy') {
          const s = val(tok[2]);
          const max = tok[3] === undefined || tok[3] === '""' ? Infinity : Number(val(tok[3]));
          const off = tok[4] === undefined ? 0 : Number(tok[4]);
          const from = off < 0 ? Math.max(0, s.length + off) : off;
          v[tok[1]] = s.slice(from, from + max);
        } else if (tok[0] === 'WriteRegDWORD' && inet(tok[2])) reg.set(val(tok[3]), { type: 'REG_DWORD', data: tok[4] });
        else if (tok[0] === 'DeleteRegValue' && inet(tok[2])) reg.delete(val(tok[3]));
      }
    };
    const legacy = new Map([['ProxyEnable', { data: '1' }], ['ProxyServer', { data: 'socks=127.0.0.1:10808' }],
      ['AutoConfigURL', { data: 'http://127.0.0.1:50000/proxy.pac' }], ['ProxyOverride', { data: '<local>;127.*;10.*;172.16.*;192.168.*;localhost' }]]);
    runMacro(legacy);
    t.ok(legacy.get('ProxyEnable').data === '0' && legacy.size === 1, 'installer: the 2.5.4 SOCKS form is switched off and removed');
    const pac = new Map([['ProxyEnable', { data: '1' }], ['ProxyServer', { data: 'corp-proxy:8080' }], ['AutoConfigURL', { data: 'http://127.0.0.1:50000/proxy.pac' }]]);
    runMacro(pac);
    t.ok(pac.get('ProxyEnable').data === '1' && pac.get('ProxyServer').data === 'corp-proxy:8080' && !pac.has('AutoConfigURL'),
      'installer: the PAC form is removed and the user\'s own manual proxy stays on');
    const other = new Map([['ProxyEnable', { data: '1' }], ['AutoConfigURL', { data: 'http://127.0.0.1:7890/pac' }]]);
    runMacro(other);
    t.ok(other.get('AutoConfigURL').data === 'http://127.0.0.1:7890/pac' && other.get('ProxyEnable').data === '1', 'installer: another local tool\'s PAC is left alone');
  }

  // ── macOS ───────────────────────────────────────────────────────────
  // Captured from networksetup on macOS (no SOCKS server, no PAC, and set).
  {
    const none = SystemProxy._macParseSocks('Enabled: No\nServer: Port: 0\nPort: 0\nAuthenticated Proxy Enabled: 0\n');
    t.ok(none.server === '' && none.port === '' && !none.enabled, 'macOS: "Server: Port: 0" is no server, not a server called "Port: 0"');
    const set = SystemProxy._macParseSocks('Enabled: Yes\nServer: 127.0.0.1\nPort: 1080\nAuthenticated Proxy Enabled: 0\n');
    t.ok(set.server === '127.0.0.1' && set.port === '1080' && set.enabled, 'macOS: a set SOCKS proxy is read');
    const nopac = SystemProxy._macParseAuto('URL: (null)\nEnabled: No\n');
    t.ok(nopac.url === '' && !nopac.enabled, 'macOS: "URL: (null)" is no PAC');
    const pac = SystemProxy._macParseAuto('URL: http://127.0.0.1:50226/proxy.pac\nEnabled: Yes\n');
    t.ok(pac.url === 'http://127.0.0.1:50226/proxy.pac' && pac.enabled, 'macOS: a PAC is read');
    // What 2.5.4 stored from those: junk that its restore put back, on.
    const junk = SystemProxy._macRestoreArgs({ name: 'Wi-Fi', prev: { enabled: false, server: 'Port: 0', port: '0' }, prevAuto: { enabled: false, url: '(null)' } });
    t.ok(JSON.stringify(junk) === JSON.stringify([['-setsocksfirewallproxystate', 'Wi-Fi', 'off'], ['-setautoproxystate', 'Wi-Fi', 'off']]),
      'macOS: a 2.5.4 snapshot of "nothing set" restores to off, without writing "Port: 0" or "(null)"');
    const offUrl = SystemProxy._macRestoreArgs({ name: 'Wi-Fi', prevAuto: { enabled: false, url: 'http://wpad.lan/p.pac' } });
    t.ok(offUrl[0][2] === 'off' && offUrl[offUrl.length - 1][2] === 'off', 'macOS: a PAC that was off is switched off first and stays off');
    const onUrl = SystemProxy._macRestoreArgs({ name: 'Wi-Fi', prevAuto: { enabled: true, url: 'http://wpad.lan/p.pac' } });
    t.ok(JSON.stringify(onUrl) === JSON.stringify([['-setautoproxyurl', 'Wi-Fi', 'http://wpad.lan/p.pac'], ['-setautoproxystate', 'Wi-Fi', 'on']]), 'macOS: a PAC that was on comes back on');
  }

  const nsFile = path.join(TMP, 'ns.json');
  const nsInit = () => FakeNS.save(nsFile, {
    denied: false,
    log: [],
    services: {
      'Wi-Fi': { socks: { enabled: false, server: '', port: '' }, auto: { enabled: false, url: '' } },
      'USB 10/100/1000 LAN': { socks: { enabled: false, server: '', port: '' }, auto: { enabled: true, url: 'http://wpad.lan/p.pac' } },
      "Bob's \"VPN\" $(x)": { socks: { enabled: true, server: '10.0.0.9', port: '1080' }, auto: { enabled: false, url: 'http://old.lan/x.pac' } },
    },
  });
  const nsState = () => FakeNS.load(nsFile);
  /* networksetup cannot empty a PAC URL, only switch it off: a service that
   * had none keeps our address, switched off. Everything else is exact. */
  const sameAs = (before, after) => Object.entries(before).every(([name, b]) => {
    const a = after[name];
    const url = b.auto.url ? a.auto.url === b.auto.url : (a.auto.url === '' || /^http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/.test(a.auto.url));
    return url && a.auto.enabled === b.auto.enabled && JSON.stringify(a.socks) === JSON.stringify(b.socks);
  });
  const sh = process.platform !== 'win32';
  const fakeCli = path.join(TMP, 'fake-networksetup');
  if (sh) fs.writeFileSync(fakeCli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fixtures', 'fake-networksetup.js'))} "$@"\n`, { mode: 0o755 });
  // calls: dialogs shown; refuse: the answer is a refusal; prompts: what each
  // dialog said; gate: the dialog stays open until this settles; slowOff:
  // the root helper's restore takes this long per "off" (ms).
  const osa = { calls: 0, refuse: null, prompts: [], gate: null, slowOff: 0 };
  const CANCEL = 'execution error: User canceled. (-128)';
  /* osascript: undo the AppleScript strings, swap networksetup for the fake,
   * and run it with a real /bin/sh, as the elevated script would be run. */
  const fakeOsascript = (args) => {
    osa.calls++;
    const m = String(args[1]).match(/^do shell script "((?:[^"\\]|\\[\s\S])*)"(?: with prompt "((?:[^"\\]|\\[\s\S])*)")? with administrator privileges$/);
    if (!m) throw new Error('not an administrator do shell script');
    osa.prompts.push((m[2] || '').replace(/\\(["\\])/g, '$1'));
    if (osa.refuse) { const e = new Error('Command failed'); e.stderr = osa.refuse; throw e; }
    const shell = m[1].replace(/\\(["\\])/g, '$1');
    const swapped = shell.split("'/usr/sbin/networksetup'").join(`'${fakeCli}'`);
    if (swapped.includes('/usr/sbin/networksetup')) throw new Error('the real networksetup would run');
    const r = spawnSync('/bin/sh', ['-c', swapped], { env: { ...process.env, FAKE_NS_STATE: nsFile, FAKE_NS_SLOW_OFF_MS: String(osa.slowOff) }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const macExec = () => {
    const fx = fakeExec({
      networksetup: (args) => {
        const s = nsState();
        const out = FakeNS.handle(s, args);
        if (args[0].startsWith('-set')) FakeNS.save(nsFile, s); // never over a write the helper makes meanwhile
        return out;
      },
      osascript: fakeOsascript,
    });
    const runSync = fx.runSync;
    // The dialog is asynchronous: a test can keep it open (osa.gate).
    fx.run = async (cmd, args) => { if (path.basename(cmd) === 'osascript' && osa.gate) await osa.gate; return runSync(cmd, args); };
    return fx;
  };
  const holdFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.hold'));
  const waitFor = async (cond, ms = 15000) => { const until = Date.now() + ms; while (!cond() && Date.now() < until) await sleep(100); return cond(); };
  const ourPacOn = (svc) => svc.auto.enabled && /^http:\/\/127\.0\.0\.1:\d+\/proxy\.pac$/.test(svc.auto.url);

  {
    nsInit();
    const before = nsState().services;
    const fx = macExec();
    SystemProxy._setExec(fx);
    const file = stateFile('mac');
    for (const mode of ['all', 'listed']) {
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'darwin', stateFile: file });
      const st = await sp.apply(10808, mode, ['discord.com']);
      const s = nsState().services;
      t.ok(st.ok && Object.values(s).every((x) => x.auto.enabled && x.auto.url === sp.pacUrl), `macOS (${mode}): the PAC is set on every service`);
      t.ok(!nsState().log.some((l) => l[0].startsWith('-setsocks')), `macOS (${mode}): the SOCKS proxy is not touched`);
      await sp.restore();
      t.ok(sameAs(before, nsState().services) && !fs.existsSync(file), `macOS (${mode}): restore puts every service back exactly`);
      const wifi = nsState().log.filter((l) => l[1] === 'Wi-Fi');
      t.ok(wifi[wifi.length - 1].join(' ') === '-setautoproxystate Wi-Fi off' && !wifi.some((l) => l[2] === '(null)'), `macOS (${mode}): a service with no PAC ends off, no "(null)" written`);
      const st0 = nsState(); st0.log = []; FakeNS.save(nsFile, st0);
    }
    // A service changed by someone else in the meantime keeps their change.
    {
      const sp = new SystemProxy(() => {}, { platform: 'darwin', stateFile: file });
      await sp.apply(10808, 'all');
      const s = nsState(); s.services['Wi-Fi'].auto = { enabled: true, url: 'http://vpn.example/pac' }; FakeNS.save(nsFile, s);
      await sp.restore();
      t.ok(nsState().services['Wi-Fi'].auto.url === 'http://vpn.example/pac' && nsState().services['USB 10/100/1000 LAN'].auto.url === 'http://wpad.lan/p.pac',
        'macOS: only services still on our PAC are restored');
      nsInit();
    }
    // Issue #27 on macOS (an administrator's account: no password needed): a
    // service switched off by another program is set back by itself; one
    // given a manual proxy meanwhile is left as it is. A setting made with
    // an administrator's password is never set back by itself (it would ask
    // for the password out of nowhere).
    {
      const log = logs();
      const seen = [];
      const sp = new SystemProxy(log, { platform: 'darwin', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0 });
      await sp.apply(10808, 'all');
      let s = nsState(); s.services['Wi-Fi'].auto.enabled = false; FakeNS.save(nsFile, s);
      t.ok((await sp.checkOwnership()).length === 0 && ourPacOn(nsState().services['Wi-Fi']) && seen.length === 0
        && log.lines.includes('info: Autopilot: another program changed the system proxy (Wi-Fi); set it back to Shroudly'), 'macOS: a service switched off by another program is set back');
      s = nsState(); s.services['Wi-Fi'].auto.enabled = false; s.services['Wi-Fi'].web = { enabled: true, server: '10.1.1.1', port: '3128' }; FakeNS.save(nsFile, s);
      t.ok((await sp.checkOwnership()).join() === 'Wi-Fi' && !nsState().services['Wi-Fi'].auto.enabled && seen.length === 1 && seen[0][1].takeover.kind === 'manual',
        'macOS: one given a manual proxy meanwhile is reported and left as it is');
      await sp.restore();
      t.ok(!nsState().services['Wi-Fi'].auto.enabled && nsState().services['USB 10/100/1000 LAN'].auto.url === 'http://wpad.lan/p.pac' && !fs.existsSync(file),
        'macOS: Stop leaves that service as it is and puts the others back');
      t.ok(!sp._canRetake({ mode: 'admin', form: 'pac' }) && sp._canRetake({ mode: 'system', form: 'pac' }), 'macOS: a setting made with an administrator\'s password is never set back by itself');
      nsInit();
    }
    // A manual proxy the user already had before Shroudly (a company's, a
    // debugging proxy) stays on under our PAC: it is no new choice, so a
    // takeover over it is set back all the same. Only one switched on or
    // changed since is left alone.
    {
      const log = logs();
      const seen = [];
      let s = nsState();
      s.services['Wi-Fi'].web = { enabled: true, server: '10.0.0.1', port: '3128' };
      s.services['USB 10/100/1000 LAN'].secure = { enabled: true, server: 'corp.example', port: '8443' };
      FakeNS.save(nsFile, s);
      const sp = new SystemProxy(log, { platform: 'darwin', stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [] });
      await sp.apply(10808, 'all');
      const rec = readState(file).snapshot.services;
      t.ok(rec.find((x) => x.name === 'Wi-Fi').prevManual.web === '10.0.0.1:3128' && rec.find((x) => x.name === 'USB 10/100/1000 LAN').prevManual.secure === 'corp.example:8443'
        && rec.find((x) => x.name === 'Wi-Fi').prevManual.socks === '', 'macOS: the manual proxies each service had are recorded when Shroudly applies');
      s = nsState(); s.services['Wi-Fi'].auto.enabled = false; s.services['USB 10/100/1000 LAN'].auto = { enabled: true, url: 'http://127.0.0.1:7890/pac' }; FakeNS.save(nsFile, s);
      t.ok((await sp.checkOwnership()).length === 0 && ourPacOn(nsState().services['Wi-Fi']) && ourPacOn(nsState().services['USB 10/100/1000 LAN']) && seen.length === 0
        && nsState().services['Wi-Fi'].web.enabled, 'macOS: switched off, or given another tool\'s local PAC, over a manual proxy the user already had: set back all the same');
      s = nsState(); s.services['Wi-Fi'].auto.enabled = false; s.services['Wi-Fi'].web = { enabled: true, server: '10.0.0.2', port: '3128' }; FakeNS.save(nsFile, s);
      t.ok((await sp.checkOwnership()).join() === 'Wi-Fi' && !nsState().services['Wi-Fi'].auto.enabled && seen.length === 1
        && seen[0][1].takeover.kind === 'manual' && seen[0][1].takeover.server === '10.0.0.2:3128', 'macOS: …a manual proxy changed since is a new choice: reported and left alone');
      await sp.restore();
      nsInit();
    }
    // A session end (restoreSync, which cannot wait) while a set-back is
    // still writing: the restore wins. Nothing is written after it, what the
    // set-back began is put back from the record, and our PAC is not left on
    // with no record of the user's own settings.
    {
      const before = nsState().services;
      const held = { gate: null, open: null };
      const fx2 = macExec();
      const runSync2 = fx2.runSync;
      fx2.run = async (cmd, args) => {
        if (held.gate && args[0] === '-setautoproxyurl') { const g = held.gate; held.gate = null; await g; }
        return runSync2(cmd, args);
      };
      SystemProxy._setExec(fx2);
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'darwin', stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [] });
      await sp.apply(10808, 'all');
      const s = nsState(); s.services['Wi-Fi'].auto.enabled = false; FakeNS.save(nsFile, s);
      held.gate = new Promise((r) => { held.open = r; });
      const checking = sp.checkOwnership();
      await sleep(30);                 // the set-back waits on its first networksetup
      t.ok(sp.restoreSync() === true && !fs.existsSync(file) && sameAs(before, nsState().services), 'macOS: a session end during a set-back restores everything');
      held.open();                     // …and that networksetup lands after it
      t.ok((await checking) === null && sameAs(before, nsState().services) && !Object.values(nsState().services).some(ourPacOn) && !fs.existsSync(file)
        && !log.lines.some((l) => l.includes('set it back to Shroudly')), 'macOS: …the set-back stops there, and what landed after the restore is put back: nothing of ours left, no record needed');
      SystemProxy._setExec(fx);
      nsInit();
    }
    // The user's own PAC from before Shroudly is served on this Mac by a
    // program that has gone since: Stop switches it off (its address kept)
    // instead of pointing the system at nothing, and says so; one still
    // served, or one that cannot be told about, comes back on.
    for (const served of [false, true, null]) {
      const s = nsState(); s.services['USB 10/100/1000 LAN'].auto = { enabled: true, url: 'http://127.0.0.1:7890/pac' }; FakeNS.save(nsFile, s);
      SystemProxy._setExec({ ...fx, listening: (port) => (port === 7890 ? served : true) });
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'darwin', stateFile: file });
      await sp.apply(10808, 'all');
      await sp.restore();
      const usb = nsState().services['USB 10/100/1000 LAN'].auto;
      const said = log.lines.includes('info: The proxy setting from before Shroudly (http://127.0.0.1:7890/pac) points at a program on this computer that is no longer running; it was switched off instead of put back');
      t.ok(usb.url === 'http://127.0.0.1:7890/pac' && usb.enabled === (served !== false) && said === (served === false) && !fs.existsSync(file),
        `macOS: the user's own PAC on this Mac, ${served === false ? 'its program gone: switched off at Stop, and said' : served ? 'still served: back on' : 'unknown whether served: back on, as before'}`);
      SystemProxy._setExec(fx);
      nsInit();
    }
    // 2.5.4's state file after a crash: its SOCKS form, with its misread "nothing set".
    {
      const s = nsState();
      s.services['Wi-Fi'].socks = { enabled: true, server: '127.0.0.1', port: '10808' };
      FakeNS.save(nsFile, s);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, platform: 'darwin', port: 10808, snapshot: { mode: 'system', appliedMode: 'all', services: [
        { name: 'Wi-Fi', prev: { enabled: false, server: 'Port: 0', port: '0' }, prevAuto: { enabled: false, url: '(null)' } }] } }));
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'darwin' }) === true, 'macOS: a 2.5.4 state file is recognised');
      const w = nsState().services['Wi-Fi'];
      t.ok(!w.socks.enabled && w.socks.server === '127.0.0.1' && !nsState().log.some((l) => l.includes('Port: 0') || l.includes('(null)')),
        'macOS: …and restored to off, with no junk written and nothing switched on');
      nsInit();
    }
    // Reset with no state file: our PAC or our old SOCKS proxy is switched off.
    {
      const s = nsState();
      s.services['Wi-Fi'].auto = { enabled: true, url: 'http://127.0.0.1:5555/proxy.pac' };
      FakeNS.save(nsFile, s);
      t.ok(SystemProxy.resetLegacySync(() => {}, { platform: 'darwin' }) && !nsState().services['Wi-Fi'].auto.enabled && nsState().services['USB 10/100/1000 LAN'].auto.enabled,
        'macOS reset: our PAC is switched off, the user\'s stays');
      nsInit();
      // A9: a Standard account is refused the change: not reported as done.
      const s2 = nsState(); s2.denied = true; s2.services['Wi-Fi'].auto = { enabled: true, url: 'http://127.0.0.1:5555/proxy.pac' }; FakeNS.save(nsFile, s2);
      const log = logs();
      t.ok(SystemProxy.resetLegacySync(log, { platform: 'darwin' }) === false && nsState().services['Wi-Fi'].auto.enabled
        && !log.lines.some((l) => l.startsWith('success')) && log.lines.includes('warning: A system proxy left by an earlier version could not be switched off'),
      'macOS reset (A9): refused, it says so instead of logging success');
      nsInit();
    }
    {
      // A13: a PAC address read back from the state file reaches networksetup
      // (and a root shell) only when nothing in it can end the command or
      // pass for an option; P5: whatever its kind otherwise.
      const back = (url) => SystemProxy._macRestoreArgs({ name: 'Wi-Fi', prevAuto: { enabled: true, url } });
      const offOnly = JSON.stringify([['-setautoproxystate', 'Wi-Fi', 'off']]);
      t.ok(['http://x/a\n-evil', 'http://x/\ra', 'http://x/\u0000', 'http://x/\u0007', '-setautoproxystate', ' ', '(null)', 'http://127.0.0.1:50226/proxy.pac']
        .every((u) => JSON.stringify(back(u)) === offOnly), 'macOS (A13): a PAC address with a control character or a leading "-", ours, or none, is switched off, never written');
      t.ok(['https://corp.example/p.pac', 'HTTP://wpad.lan/p.pac', 'file:///Library/Corp/proxy.pac', 'file:///Users/x/My PAC/p.pac', 'http://wpad.lan/p.pac?a=1&b=$(x)']
        .every((u) => JSON.stringify(back(u)) === JSON.stringify([['-setautoproxyurl', 'Wi-Fi', u], ['-setautoproxystate', 'Wi-Fi', 'on']])),
      'macOS (P5): the user\'s own PAC comes back as it was, file:// and all');
      const own = new SystemProxy(() => {}, { platform: 'darwin', adminPrompt: (k) => (k === 'apply' ? 'In your language' : undefined) });
      t.ok(own._prompt('apply') === 'In your language' && /^Shroudly needs an administrator's password/.test(own._prompt('restore')),
        'macOS (A13): the dialog\'s sentence comes from the app (translated) or falls back to English');
      const src = SystemProxy._appleScriptAdmin('true', true, 'Say "hi"\nnow');
      t.ok(src === 'do shell script "true" with prompt "Say \\"hi\\" now" with administrator privileges', 'macOS (A13): the sentence is an AppleScript string, quotes escaped, no line breaks');
    }
    // A Standard account: networksetup refused everywhere.
    {
      const s = nsState(); s.denied = true; FakeNS.save(nsFile, s);
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'darwin', stateFile: file });
      const st = await sp.apply(10808, 'all');
      t.ok(!st.ok && st.code === 'needs_admin' && st.system === 'macos', 'macOS Standard account: reported as needs_admin, not routed');
      t.ok(!log.lines.some((l) => l.startsWith('success')) && log.lines.some((l) => l.startsWith('warning')), '…logged as a warning, not as success');
      t.ok(!fs.existsSync(file) && sp.applied && !!sp.pacUrl, '…nothing to recover (no state file); the PAC stays up for apps');

      if (sh) {
        // The password is refused or the dialog dismissed: nothing changes.
        osa.refuse = CANCEL;
        const no = await sp.applyAsAdmin();
        t.ok(no.code === 'cancelled' && !fs.existsSync(file) && !holdFiles(path.dirname(file)).length, 'macOS admin: a dismissed dialog changes nothing and leaves no state');
        osa.refuse = null;

        const osa0 = osa.calls;
        // A3: two clicks while the dialog is open: one dialog, one helper.
        const [yes, again] = await Promise.all([sp.applyAsAdmin(), sp.applyAsAdmin()]);
        const svc = nsState().services;
        t.ok(yes === again && osa.calls === osa0 + 1, 'macOS admin (A3): a second click while the dialog is open gets the same answer, no second dialog or helper');
        t.ok(yes.ok && yes.code === 'ok' && yes.admin && Object.values(svc).every((x) => x.auto.enabled && x.auto.url === sp.pacUrl),
          'macOS admin: one password sets the PAC on every service (odd service names quoted safely)');
        t.ok(/^Shroudly needs an administrator's password/.test(osa.prompts[osa.prompts.length - 1]),
          'macOS admin (A13): the dialog says Shroudly asks and why, not "osascript wants to make changes"');
        const { helperPid: helper, holdFile: hold } = readState(file).snapshot;
        t.ok(helper > 0 && fs.existsSync(hold) && alive(helper), 'macOS admin: the restoring helper waits in the background');
        const updated = sp.updateRouting('listed', ['discord.com']);
        t.ok(updated && sp.pacText.includes('discord.com') && osa.calls === osa0 + 1, 'macOS admin: a route-mode change is served from the PAC, no second password');
        // A6: the engine came back on another port. The PAC, at the same
        // address, names it; the system setting is not touched.
        const url0 = sp.pacUrl;
        const log0 = nsState().log.length;
        const re = await sp.apply(10909, 'listed', ['discord.com']);
        t.ok(re.ok && re.admin && sp.pacUrl === url0 && sp.pacText.includes('127.0.0.1:10909') && !sp.pacText.includes('10808')
          && nsState().log.length === log0 && osa.calls === osa0 + 1 && readState(file).port === 10909 && re.socks === '127.0.0.1:10909',
        'macOS admin (A6): a new engine port goes into the same PAC; no system change, no password');
        const ok = await sp.restore();
        const after = nsState().services;
        t.ok(ok && after['Wi-Fi'].auto.enabled === false && after['USB 10/100/1000 LAN'].auto.url === 'http://wpad.lan/p.pac' && after['USB 10/100/1000 LAN'].auto.enabled
          && after["Bob's \"VPN\" $(x)"].auto.url === 'http://old.lan/x.pac' && !after["Bob's \"VPN\" $(x)"].auto.enabled && after["Bob's \"VPN\" $(x)"].socks.enabled,
        'macOS admin: stopping restores every service exactly, through the helper');
        t.ok(osa.calls === osa0 + 1 && !fs.existsSync(file) && !alive(helper), 'macOS admin: …without asking for the password again; helper gone, no state left');
      }
      nsInit();
    }
    if (sh) {
      // A3: Stop (and Start again) while the password dialog is open.
      const s = nsState(); s.denied = true; FakeNS.save(nsFile, s);
      const before = nsState().services;
      const sp = new SystemProxy(() => {}, { platform: 'darwin', stateFile: file });
      await sp.apply(10808, 'all');
      let open;
      osa.gate = new Promise((r) => { open = r; });
      const late = sp.applyAsAdmin();
      await sleep(100);
      await sp.restore();
      const st2 = await sp.apply(10808, 'all');
      const snap2 = sp.snapshot;
      open(); osa.gate = null;
      const r = await late;
      t.ok(r.code === 'not_active' && st2.code === 'needs_admin' && sp.snapshot === snap2 && sp.status.code === 'needs_admin' && !fs.existsSync(file),
        'macOS admin (A3): a password given after Stop and a new Start is nobody\'s answer: nothing thrown, the new session and its state untouched');
      t.ok(await waitFor(() => sameAs(before, nsState().services) && !Object.values(nsState().services).some(ourPacOn)),
        'macOS admin (A3): the helper that answer started finds no hold file and puts everything back at once');
      await sp.restore();
      nsInit();
    }
    if (sh) {
      // A2: a restore that needed the password and was refused, then Start
      // again on a still-Standard account: the user's own PAC, recorded in
      // the state file, must survive.
      const s = nsState(); s.denied = true; FakeNS.save(nsFile, s);
      const before = nsState().services;
      const usb = (st) => st.snapshot.services.find((x) => x.name === 'USB 10/100/1000 LAN').prevAuto;
      const sp = new SystemProxy(() => {}, { platform: 'darwin', stateFile: file, helperWaitMs: 15000 });
      await sp.apply(10808, 'all');
      await sp.applyAsAdmin();
      const helper = readState(file).snapshot.helperPid;
      process.kill(helper, 'SIGKILL'); // the helper gone, our PAC still set
      t.ok(await waitFor(() => !alive(helper), 20000), `macOS admin: the killed helper (${helper}) is gone`);
      osa.refuse = CANCEL;
      const stopLog = logs();
      sp.log = stopLog;
      t.ok(await sp.restore({ interactive: true }) === false && fs.existsSync(file) && usb(readState(file)).url === 'http://wpad.lan/p.pac',
        'macOS admin: helper gone and the password refused at Stop: the state file stays, with the user\'s own PAC');
      t.ok(readState(file).declined > 0 && stopLog.lines.includes('warning: Administrator password not given; the proxy settings were not put back')
        && !stopLog.lines.some((l) => l.includes('they will be at the next start')),
      `macOS admin (P6): a dialog dismissed at Stop is remembered (the next start does not ask by itself) and said as such (declined: ${readState(file).declined}; log: ${JSON.stringify(stopLog.lines)})`);
      const kept = fs.readFileSync(file, 'utf8');
      osa.refuse = null;
      const st = await sp.apply(10808, 'all');
      t.ok(st.code === 'needs_admin' && readText(file) === kept,
        'macOS (A2): Start again ending in needs_admin leaves that state file exactly as it was (not overwritten with our stale PAC, not deleted)');
      osa.refuse = CANCEL;
      const c = await sp.applyAsAdmin();
      osa.refuse = null;
      t.ok(c.code === 'cancelled' && readText(file) === kept, 'macOS (A2): …nor does a dismissed password dialog');
      const yes = await sp.applyAsAdmin();
      t.ok(yes.ok && usb(readState(file)).url === 'http://wpad.lan/p.pac' && usb(readState(file)).enabled,
        'macOS (A2): with the password, the new snapshot carries the user\'s own PAC over instead of our stale one');
      await sp.restore();
      t.ok(sameAs(before, nsState().services) && !fs.existsSync(file), 'macOS (A2): …and stopping puts the user\'s own PAC back');
      nsInit();
    }
    if (sh) {
      // P5: a PAC of the user's own at a file:// address comes back on, by
      // networksetup (an administrator account) and by the root helper (a
      // Standard account, with the password).
      for (const denied of [false, true]) {
        nsInit();
        const s = nsState(); s.denied = denied; s.services['USB 10/100/1000 LAN'].auto = { enabled: true, url: 'file:///Library/Corp/proxy.pac' }; FakeNS.save(nsFile, s);
        const sp = new SystemProxy(() => {}, { platform: 'darwin', stateFile: file });
        await sp.apply(10808, 'all');
        if (denied) await sp.applyAsAdmin();
        const on = ourPacOn(nsState().services['USB 10/100/1000 LAN']);
        await sp.restore();
        const usbNow = nsState().services['USB 10/100/1000 LAN'].auto;
        t.ok(on && usbNow.enabled && usbNow.url === 'file:///Library/Corp/proxy.pac' && !fs.existsSync(file),
          `macOS (P5, ${denied ? 'Standard account, root helper' : 'administrator account'}): the user's file:// PAC is back, switched on`);
      }
      nsInit();
    }
    if (sh) {
      // The root helper puts the user's own PAC served on this Mac back only
      // while something listens there (nc), and switches it off, its address
      // kept, once its program has gone; a PAC served elsewhere comes back.
      const ncOpen = path.join(TMP, 'nc-open');
      fs.mkdirSync(ncOpen, { recursive: true });
      const fakeNc = path.join(TMP, 'fake-nc');
      fs.writeFileSync(fakeNc, `#!/bin/sh\n# -z -G 2 <host> <port>: connects when ${ncOpen}/<host>_<port> exists\n[ -e ${JSON.stringify(ncOpen)}/"$4_$5" ]\n`, { mode: 0o755 });
      // [the PAC, where something listens, put back on?]
      const cases = [
        ['http://127.0.0.1:7890/pac', null, false],
        ['http://127.0.0.1:7890/pac', '127.0.0.1_7890', true],
        ['http://localhost:7890/pac', '::1_7890', true],       // served on ::1 alone
        ['http://localhost:7890/pac', null, false],
      ];
      for (const [pac, open, on] of cases) {
        nsInit();
        for (const f of fs.readdirSync(ncOpen)) fs.rmSync(path.join(ncOpen, f), { force: true });
        if (open) fs.writeFileSync(path.join(ncOpen, open), '');
        const s = nsState(); s.denied = true; s.services['USB 10/100/1000 LAN'].auto = { enabled: true, url: pac }; FakeNS.save(nsFile, s);
        const app = spawn('sleep', ['30']);
        const hold = path.join(TMP, `nc-${String(open)}-${on}.hold`);
        fs.writeFileSync(hold, '');
        const services = Object.keys(nsState().services).map((name) => ({ name, prevAuto: SystemProxy._macParseAuto(FakeNS.handle(nsState(), ['-getautoproxyurl', name])) }));
        const script = SystemProxy._macAdminScript({ services, pacUrl: 'http://127.0.0.1:4323/proxy.pac', holdFile: hold, appPid: app.pid, networksetup: fakeCli, nc: fakeNc });
        const helper = parseInt(spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, FAKE_NS_STATE: nsFile }, encoding: 'utf8' }).stdout, 10);
        t.ok(ourPacOn(nsState().services['USB 10/100/1000 LAN']), `macOS admin (${pac}, ${open || 'nothing'} listening): applied`);
        fs.rmSync(hold, { force: true });             // Stop: the helper restores
        const done = await waitFor(() => !alive(helper));
        const usb = nsState().services['USB 10/100/1000 LAN'].auto;
        const bob = nsState().services["Bob's \"VPN\" $(x)"].auto;
        t.ok(done && usb.url === pac && usb.enabled === on && !nsState().services['Wi-Fi'].auto.enabled && bob.url === 'http://old.lan/x.pac' && !bob.enabled,
          `macOS admin: the root helper ${on ? `puts the user's own PAC on this Mac back while it is served (${open})` : `switches the user's own PAC on this Mac off (address kept) once its program has gone (${pac})`}`);
        app.kill('SIGKILL');
      }
      nsInit();
    }
    if (sh) {
      // A4: a root helper slower than five seconds to restore.
      const s = nsState(); s.denied = true; FakeNS.save(nsFile, s);
      const before = nsState().services;
      osa.slowOff = 2000; // three "off" steps: about six seconds
      const sp = new SystemProxy(() => {}, { platform: 'darwin', stateFile: file });
      await sp.apply(10808, 'all');
      await sp.applyAsAdmin();
      const n = osa.calls;
      const t0 = Date.now();
      const ok = await sp.restore({ interactive: true });
      const took = Date.now() - t0;
      t.ok(ok && took > 5000 && osa.calls === n && sameAs(before, nsState().services) && !fs.existsSync(file),
        `macOS admin (A4): Stop waits for a helper slower than 5 s (${took} ms) and never asks for the password over it`);
      await sp.apply(10808, 'all');
      await sp.applyAsAdmin();
      const helper = readState(file).snapshot.helperPid;
      const n2 = osa.calls;
      const t1 = Date.now();
      const r = sp.restoreSync();
      t.ok(r === false && Date.now() - t1 < 2500 && osa.calls === n2 && fs.existsSync(file),
        'macOS admin (A4): the exit path neither asks nor waits long for it: the state file stays');
      await waitFor(() => !alive(helper), 20000);
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'darwin' }) === false && !fs.existsSync(file) && sameAs(before, nsState().services) && osa.calls === n2,
        'macOS admin (A4): the helper finishes on its own, and the restore that follows finds it done, no password asked');
      osa.slowOff = 0;
      nsInit();
    }
    if (sh) {
      // The app dies: the helper notices and restores by itself.
      const app = spawn('sleep', ['30']);
      const s = nsState(); s.denied = true; FakeNS.save(nsFile, s);
      const hold = path.join(TMP, 'crash.hold');
      fs.writeFileSync(hold, '');
      const services = Object.keys(nsState().services).map((name) => ({ name, prevAuto: SystemProxy._macParseAuto(FakeNS.handle(nsState(), ['-getautoproxyurl', name])) }));
      const script = SystemProxy._macAdminScript({ services, pacUrl: 'http://127.0.0.1:4321/proxy.pac', holdFile: hold, appPid: app.pid, networksetup: fakeCli });
      const r = spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, FAKE_NS_STATE: nsFile }, encoding: 'utf8' });
      const helper = parseInt(r.stdout, 10);
      t.ok(Object.values(nsState().services).every((x) => x.auto.url === 'http://127.0.0.1:4321/proxy.pac'), 'macOS admin script: applied by a real /bin/sh');
      app.kill('SIGKILL');
      let restored = false;
      for (let i = 0; i < 40 && !restored; i++) { await sleep(150); restored = !alive(helper) && nsState().services['USB 10/100/1000 LAN'].auto.url === 'http://wpad.lan/p.pac'; }
      t.ok(restored && !nsState().services['Wi-Fi'].auto.enabled, 'macOS admin: the app killed, the root helper restores on its own');
      fs.rmSync(hold, { force: true });
      nsInit();

      // A5: the helper itself told to end (logout, shutdown, launchd): it
      // puts everything back first, while Shroudly still runs.
      for (const sig of ['SIGTERM', 'SIGHUP']) {
        const app2 = spawn('sleep', ['30']);
        const s3 = nsState(); s3.denied = true; FakeNS.save(nsFile, s3);
        const before = nsState().services;
        const hold2 = path.join(TMP, `sig-${sig}.hold`);
        fs.writeFileSync(hold2, '');
        const svcs = Object.keys(before).map((name) => ({ name, prevAuto: SystemProxy._macParseAuto(FakeNS.handle(nsState(), ['-getautoproxyurl', name])) }));
        const sc = SystemProxy._macAdminScript({ services: svcs, pacUrl: 'http://127.0.0.1:4322/proxy.pac', holdFile: hold2, appPid: app2.pid, networksetup: fakeCli });
        const h = parseInt(spawnSync('/bin/sh', ['-c', sc], { env: { ...process.env, FAKE_NS_STATE: nsFile }, encoding: 'utf8' }).stdout, 10);
        await sleep(300);
        t.ok(alive(h) && Object.values(nsState().services).every(ourPacOn), `macOS admin (A5): helper waiting, PAC set (${sig})`);
        process.kill(h, sig);
        t.ok(await waitFor(() => !alive(h) && sameAs(before, nsState().services) && !Object.values(nsState().services).some(ourPacOn)) && alive(app2.pid) && fs.existsSync(hold2),
          `macOS admin (A5): the helper sent ${sig} puts every service back before it ends`);
        app2.kill('SIGKILL');
        fs.rmSync(hold2, { force: true });
        nsInit();
      }

      // The helper is gone (a restart of the Mac) with our PAC still set.
      const s2 = nsState(); s2.services['Wi-Fi'].auto = { enabled: true, url: 'http://127.0.0.1:4321/proxy.pac' }; FakeNS.save(nsFile, s2);
      const admState = { v: 2, platform: 'darwin', port: 10808, pacUrl: 'http://127.0.0.1:4321/proxy.pac', snapshot: { mode: 'admin', form: 'pac', helperPid: 0,
        holdFile: path.join(TMP, 'gone.hold'), services: [{ name: 'Wi-Fi', applied: true, prevAuto: { enabled: false, url: '' } }] } };
      fs.writeFileSync(file, JSON.stringify(admState));
      const n0 = osa.calls;
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'darwin' }) === 'kept' && fs.existsSync(file) && osa.calls === n0,
        'macOS admin recovery (A4): the synchronous recovery (login hook, watchdog, app start) never asks; "kept" for later');
      osa.refuse = CANCEL;
      t.ok(await SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin' }) === false && fs.existsSync(file) && osa.calls === n0 + 1,
        'macOS admin recovery: asked once, asynchronously; refused, the state file stays for the next try');
      osa.refuse = null;
      // P6: that refusal is remembered. A login or an app start never asks by
      // itself again; only the window's button does.
      t.ok(readState(file).declined > 0 && JSON.stringify(SystemProxy.pendingAdminRecovery({ stateFile: file, platform: 'darwin' })) === '{"declined":true}',
        'macOS admin recovery (P6): a dismissed dialog is remembered with the state file');
      t.ok(await SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin' }) === false && osa.calls === n0 + 1 && fs.existsSync(file),
        'macOS admin recovery (P6): after that, nothing asks by itself (no dialog at every login and start)');
      t.ok(!SystemProxy.restoreProcessAsks({ pending: { declined: true } }) && SystemProxy.restoreProcessAsks({ pending: { declined: false } })
        && !SystemProxy.restoreProcessAsks({ pending: { declined: false }, autoStartWithProtection: true }) && !SystemProxy.restoreProcessAsks({ pending: null }),
      'macOS (P6): the restore process asks only for a recovery not declined, and not when Shroudly starts at login with protection on');
      osa.refuse = CANCEL;
      t.ok(await SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin', userAsked: true }) === false && osa.calls === n0 + 2 && fs.existsSync(file),
        'macOS admin recovery (P6): the window\'s button still asks');
      osa.refuse = null;
      fs.writeFileSync(file, JSON.stringify(admState));
      // The app and another process at once: one dialog (lock file).
      let open;
      osa.gate = new Promise((r) => { open = r; });
      const first = SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin' });
      await sleep(100);
      const second = await SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin' });
      open(); osa.gate = null;
      t.ok(await first === true && second === false && osa.calls === n0 + 3 && !nsState().services['Wi-Fi'].auto.enabled && !fs.existsSync(file) && !fs.existsSync(`${file}.lock`),
        'macOS admin recovery (A4): only one process asks (lock file); with the password, restored and cleared');
      // A lock held by another live process: this one does not ask.
      const other = spawn('sleep', ['30']);
      fs.writeFileSync(file, JSON.stringify(admState));
      const s4 = nsState(); s4.services['Wi-Fi'].auto = { enabled: true, url: 'http://127.0.0.1:4321/proxy.pac' }; FakeNS.save(nsFile, s4);
      fs.writeFileSync(`${file}.lock`, String(other.pid));
      const n1 = osa.calls;
      t.ok(await SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin' }) === false && osa.calls === n1 && fs.existsSync(file),
        'macOS admin recovery (A4): a lock held by another running process means no second dialog');
      other.kill('SIGKILL');
      await waitFor(() => !alive(other.pid));
      osa.refuse = CANCEL;
      t.ok(await SystemProxy.recoverAsAdmin({ stateFile: file, platform: 'darwin' }) === false && osa.calls === n1 + 1,
        'macOS admin recovery: a lock left by a process that is gone is taken over');
      osa.refuse = null;

      // --restore-proxy (restore-proxy.js), the login hook after a restart.
      const { restoreProxy } = require(path.join(ROOT, 'electron', 'restore-proxy.js'));
      const tr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'tr.json'), 'utf8'));
      const leftover = (extra = {}) => {
        fs.writeFileSync(file, JSON.stringify({ ...admState, ...extra }));
        const st = nsState(); st.services['Wi-Fi'].auto = { enabled: true, url: 'http://127.0.0.1:4321/proxy.pac' }; FakeNS.save(nsFile, st);
      };
      const settings = (o = {}) => () => ({ autoStart: false, protectionOn: true, language: 'tr', ...o });
      leftover();
      osa.refuse = CANCEL;
      const n2 = osa.calls;
      const r1 = await restoreProxy({ stateFile: file, platform: 'darwin', settings: settings() });
      t.ok(r1 === 'asked' && osa.calls === n2 + 1 && osa.prompts[osa.prompts.length - 1] === tr.proxyAdminPromptRestore && tr.proxyAdminPromptRestore !== JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8')).proxyAdminPromptRestore,
        'macOS (P17): the restore process\'s password dialog is in the user\'s language');
      t.ok(await restoreProxy({ stateFile: file, platform: 'darwin', settings: settings() }) === 'done' && osa.calls === n2 + 1 && fs.existsSync(file),
        'macOS (P6): once dismissed, the login hook does not ask again');
      osa.refuse = null;
      leftover();
      t.ok(await restoreProxy({ stateFile: file, platform: 'darwin', settings: settings({ autoStart: true }) }) === 'done' && osa.calls === n2 + 1,
        'macOS: not when Shroudly starts at this login with protection on (its own request covers it)');
      const other2 = spawn('sleep', ['30']);
      leftover({ owner: { pid: other2.pid, boot: SystemProxy._owner().boot, exe: 'sleep' } });
      const before2 = readText(file);
      t.ok(await restoreProxy({ stateFile: file, platform: 'darwin', settings: settings() }) === 'done' && osa.calls === n2 + 1 && readText(file) === before2 && ourPacOn(nsState().services['Wi-Fi']),
        'macOS (P12): the login hook leaves a running Shroudly\'s setting alone, and asks nothing');
      other2.kill('SIGKILL');
      leftover();
      t.ok(await restoreProxy({ stateFile: file, platform: 'darwin', settings: settings() }) === 'restored' && !fs.existsSync(file) && !nsState().services['Wi-Fi'].auto.enabled,
        'macOS: with the password given, the login hook puts the settings back');
      fs.rmSync(file, { force: true });
      nsInit();
    }
    if (process.platform === 'darwin') {
      // The AppleScript string escaping, through the real osascript (no
      // administrator privileges: nothing is asked, nothing is changed).
      const shell = `printf '%s' 'a"b\\c'\\''d $HOME \`x\`'`;
      const r = spawnSync('osascript', ['-e', SystemProxy._appleScriptAdmin(shell, false)], { encoding: 'utf8' });
      t.ok(r.stdout.replace(/\n$/, '') === 'a"b\\c\'d $HOME `x`', `osascript gets the shell script exactly (${JSON.stringify(r.stdout)})`);
      // The dialog form compiles (osacompile only compiles: nothing runs,
      // nothing is asked).
      const out = path.join(TMP, 'prompt.scpt');
      const c = spawnSync('osacompile', ['-o', out, '-e', SystemProxy._appleScriptAdmin('true', true, 'Shroudly needs "this".')], { encoding: 'utf8' });
      t.ok(c.status === 0, `the administrator dialog with its sentence is valid AppleScript${c.status ? `: ${c.stderr}` : ''}`);
    }
  }

  // ── Linux ───────────────────────────────────────────────────────────
  {
    const d = SystemProxy.linuxDesktop;
    t.ok(['ubuntu:GNOME', 'X-Cinnamon', 'Unity', 'Budgie:GNOME', 'Pantheon', 'Deepin', 'UKUI', 'COSMIC'].every((x) => d({ XDG_CURRENT_DESKTOP: x }) === 'gnome'),
      'Linux: GNOME-family desktops (GSettings in Chromium)');
    t.ok(d({ XDG_CURRENT_DESKTOP: 'KDE' }) === 'kde' && d({ KDE_FULL_SESSION: 'true' }) === 'kde', 'Linux: KDE Plasma');
    t.ok(d({ XDG_CURRENT_DESKTOP: 'XFCE' }) === 'xfce' && d({ XDG_CURRENT_DESKTOP: 'LXQt' }) === 'lxqt'
      && ['i3', 'sway', '', 'Hyprland'].every((x) => d({ XDG_CURRENT_DESKTOP: x }) === 'other'), 'Linux: XFCE, LXQt and window managers are told apart, none with a system proxy');
    // A11: Chromium falls back to DESKTOP_SESSION, then GNOME_DESKTOP_SESSION_ID
    // and KDE_FULL_SESSION, and compares names exactly.
    t.ok(d({ DESKTOP_SESSION: 'gnome' }) === 'gnome' && d({ DESKTOP_SESSION: 'mate' }) === 'gnome' && d({ XDG_CURRENT_DESKTOP: 'MATE', DESKTOP_SESSION: 'mate' }) === 'gnome',
      'Linux (A11): a GNOME or MATE session without XDG_CURRENT_DESKTOP (or with a name Chromium does not know) is GNOME, by DESKTOP_SESSION');
    t.ok(d({ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' }) === 'gnome' && d({ DESKTOP_SESSION: 'default', GNOME_DESKTOP_SESSION_ID: 'x' }) === 'gnome',
      'Linux (A11): GNOME_DESKTOP_SESSION_ID alone means GNOME');
    t.ok(d({ DESKTOP_SESSION: 'kde-plasma' }) === 'kde' && d({ DESKTOP_SESSION: 'kde' }) === 'kde' && d({ KDE_FULL_SESSION: '' }) === 'kde', 'Linux (A11): KDE by DESKTOP_SESSION or KDE_FULL_SESSION');
    t.ok(d({ DESKTOP_SESSION: 'xfce' }) === 'xfce' && d({ DESKTOP_SESSION: 'xubuntu' }) === 'xfce' && d({ DESKTOP_SESSION: 'lxqt' }) === 'lxqt'
      && d({ XDG_CURRENT_DESKTOP: 'lxqt' }) === 'lxqt', 'Linux (A11): XFCE and LXQt by DESKTOP_SESSION too');
    t.ok(SystemProxy.chromiumDesktop({ XDG_CURRENT_DESKTOP: 'gnome' }) === 'other' && SystemProxy.chromiumDesktop({ XDG_CURRENT_DESKTOP: 'Foo:KDE:GNOME' }) === 'kde'
      && SystemProxy.chromiumDesktop({ XDG_CURRENT_DESKTOP: 'sway', DESKTOP_SESSION: 'gnome' }) === 'gnome',
    'Linux (A11): names compared as Chromium does (case, first known name wins, unknown ones fall through)');
  }
  {
    // GNOME, both modes: 'auto' with our PAC, manual entries left alone.
    const g = gnomeDefaults({ 'org.gnome.system.proxy.socks host': "'10.1.1.1'", 'org.gnome.system.proxy.socks port': '1080' });
    const before = JSON.stringify([...g]);
    const fx = fakeExec({ gsettings: fakeGsettings(g) });
    SystemProxy._setExec(fx);
    const file = stateFile('gnome');
    const env = { XDG_CURRENT_DESKTOP: 'GNOME', HOME: process.env.HOME };
    for (const mode of ['all', 'listed']) {
      const sp = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: file });
      const st = await sp.apply(10808, mode, ['discord.com']);
      t.ok(st.ok && st.system === 'gnome' && g.get('org.gnome.system.proxy mode') === "'auto'" && g.get('org.gnome.system.proxy autoconfig-url') === `'${sp.pacUrl}'`,
        `GNOME (${mode}): automatic configuration from our PAC`);
      t.ok(g.get('org.gnome.system.proxy.socks host') === "'10.1.1.1'" && g.get('org.gnome.system.proxy.http host') === "'10.0.0.5'",
        `GNOME (${mode}): manual entries untouched (not consulted in auto mode, so a stale HTTP proxy cannot win)`);
      await sp.restore();
      t.ok(JSON.stringify([...g]) === before && !fs.existsSync(file), `GNOME (${mode}): restored exactly`);
    }
    // P2: a Stop that comes while an apply is still writing (a re-apply, or
    // a start) is done after it, not in the middle: nothing is left set.
    {
      let gate = null;
      const fx3 = fakeExec({ gsettings: fakeGsettings(g) });
      fx3.run = async (cmd, args) => { const out = fx3.runSync(cmd, args); if (gate && args[0] === 'set') await gate; return out; };
      SystemProxy._setExec(fx3);
      const sp = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: file });
      let open;
      gate = new Promise((r) => { open = r; });
      const applying = sp.apply(10808, 'all');
      await sleep(30);                         // apply() is writing GNOME's setting
      const stopping = sp.restore();
      await sleep(30);
      open(); gate = null;
      await Promise.all([applying, stopping]);
      t.ok(!sp.applied && JSON.stringify([...g]) === before && !fs.existsSync(file) && !sp.pacServer,
        'GNOME (P2): Stop during an apply restores after it: nothing left set, no PAC server, no state file');
      SystemProxy._setExec(fx);
    }
    // P7: gsettings refusing the restore is noticed: not reported as done,
    // and the state file stays for the next try.
    {
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file });
      await sp.apply(10808, 'all');
      SystemProxy._setExec(fakeExec({ gsettings: fakeGsettings(g, { failSet: () => true }) }));
      t.ok(await sp.restore() === false && fs.existsSync(file) && g.get('org.gnome.system.proxy mode') === "'auto'" && !log.lines.includes('success: System proxy settings restored'),
        'GNOME (P7): a restore gsettings refused is not reported as done; the state file stays');
      SystemProxy._setExec(fx);
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'linux', env }) === true && JSON.stringify([...g]) === before && !fs.existsSync(file),
        'GNOME (P7): …and the next recovery restores exactly');
    }
    // gsettings refuses: reported, nothing left changed, nothing armed.
    {
      SystemProxy._setExec(fakeExec({ gsettings: fakeGsettings(g, { failSet: (k) => k === 'mode' }) }));
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file });
      const st = await sp.apply(10808, 'all');
      t.ok(!st.ok && st.code === 'apply_failed' && JSON.stringify([...g]) === before && !fs.existsSync(file), 'GNOME refused: apply_failed, settings as they were, no state file');
      t.ok(!log.lines.some((l) => l.startsWith('success')), 'GNOME refused: not logged as routed');
      await sp.restore();
      SystemProxy._setExec(fx);
    }
    // A 2.5.4 state file (manual SOCKS) after a crash.
    {
      g.set('org.gnome.system.proxy mode', "'manual'");
      g.set('org.gnome.system.proxy.socks host', "'127.0.0.1'");
      g.set('org.gnome.system.proxy.socks port', '10808');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, platform: 'linux', port: 10808, snapshot: { mode: 'gnome', appliedMode: 'all',
        gnome: { mode: "'manual'", host: "'10.1.1.1'", port: '1080', autourl: "''" } } }));
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'linux', env }) === true && JSON.stringify([...g]) === before, 'GNOME: a 2.5.4 state file is restored exactly');
    }
    // Reset with no state file.
    {
      g.set('org.gnome.system.proxy mode', "'auto'");
      g.set('org.gnome.system.proxy autoconfig-url', "'http://127.0.0.1:5555/proxy.pac'");
      t.ok(SystemProxy.resetLegacySync(() => {}, { platform: 'linux', env }) && g.get('org.gnome.system.proxy mode') === "'none'", 'GNOME reset: our PAC switched off');
      g.set('org.gnome.system.proxy mode', "'manual'"); g.set('org.gnome.system.proxy autoconfig-url', "''");
    }
    // Ownership.
    {
      const seen = [];
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file, onOwnership: (o, i) => seen.push([o, i.lost]), takeoverConfirmMs: 0 });
      await sp.apply(10808, 'all');
      t.ok((await sp.checkOwnership()).length === 0, 'GNOME ownership: ours');
      // Switched off by another program: set back by itself (issue #27).
      g.set('org.gnome.system.proxy mode', "'none'");
      t.ok((await sp.checkOwnership()).length === 0 && seen.length === 0 && g.get('org.gnome.system.proxy mode') === "'auto'"
        && g.get('org.gnome.system.proxy autoconfig-url') === `'${sp.pacUrl}'` && log.lines.includes('info: Autopilot: another program changed the system proxy (GNOME); set it back to Shroudly'),
      'GNOME ownership: switched off by another program: set back, one line');
      g.set('org.gnome.system.proxy mode', "'manual'");
      t.ok((await sp.checkOwnership())[0] === 'GNOME' && seen.length === 1 && seen[0][0] === false, 'GNOME ownership: a switch to manual is reported');
      await sp.restore();
      t.ok(g.get('org.gnome.system.proxy mode') === "'manual'", 'GNOME: the other program\'s choice survives the stop');
    }
    // A8: the takeover check during a stop sees our own settings going away.
    {
      const seen = [];
      const log = logs();
      let getGate = null;
      let setGate = null;
      const fx2 = fakeExec({ gsettings: fakeGsettings(g) });
      const runSync = fx2.runSync;
      // A check's read can be held (it reads when let go); a stop's write
      // can be held after it is made.
      fx2.run = async (cmd, args) => {
        if (getGate && args[0] === 'get') await getGate;
        const out = runSync(cmd, args);
        if (setGate && args[0] === 'set') await setGate;
        return out;
      };
      SystemProxy._setExec(fx2);
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file, onOwnership: (o, i) => seen.push([o, i.lost]), ownershipIntervalMs: 20 });
      await sp.apply(10808, 'all');
      // A check already reading when the stop begins.
      let letGet;
      getGate = new Promise((r) => { letGet = r; });
      const checking = sp.checkOwnership();
      await sleep(10);
      getGate = null;
      let letSet;
      setGate = new Promise((r) => { letSet = r; });
      const stopping = sp.restore();
      await sleep(10); // the stop has written its first value and waits
      letGet();
      const lostInFlight = await checking;
      // A check started during the stop, and the timer.
      const lostDuring = await sp.checkOwnership();
      await sleep(120);
      letSet(); setGate = null;
      await stopping;
      t.ok(Array.isArray(lostInFlight) && lostInFlight[0] === 'GNOME' && sp.applied === false,
        'GNOME (A8): (a check already in flight when the stop began did read our half-restored setting)');
      t.ok(lostDuring === null && seen.length === 0 && !log.lines.some((l) => l.includes('Another program changed')) && g.get('org.gnome.system.proxy mode') === "'manual'",
        'GNOME (A8): …yet no takeover is reported, by it, by a check started during the stop, or by the timer (stopped when the stop begins)');
      SystemProxy._setExec(fx);
    }
    // A session end or a quit (restoreSync, which cannot wait) while a
    // set-back is still writing to gsettings: the restore wins. The command
    // under way is stopped and the setting it was writing put back with the
    // rest, so even with no more JavaScript after it (the exit) nothing of
    // ours is left on; and a write that lands all the same is put back when
    // the set-back resumes. No state file and no login hook come back.
    const hook = path.join(process.env.HOME, '.config', 'autostart', 'shroudly-proxy-restore.desktop');
    // Held at its first command (our address) or its second (the mode
    // switched to auto, which would turn on whatever address the restore
    // just put back).
    for (const [exiting, at] of [[true, 'autoconfig-url'], [false, 'autoconfig-url'], [false, 'mode']]) {
      const start = JSON.stringify([...g]);
      const held = { gate: null, open: null, killed: false };
      const fx4 = fakeExec({ gsettings: fakeGsettings(g) });
      const runSync4 = fx4.runSync;
      fx4.run = async (cmd, args, timeout, onChild) => {
        if (held.gate && args[0] === 'set' && args[2] === at) {
          const gate = held.gate;
          held.gate = null;
          let killed = false;
          if (onChild) onChild({ kill: () => { held.killed = true; if (exiting) killed = true; } });
          await gate;
          if (killed) throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
          return runSync4(cmd, args);
        }
        return runSync4(cmd, args);
      };
      SystemProxy._setExec(fx4);
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [],
        restoreCommand: { exe: '/opt/Shroudly/shroudly', args: ['--restore-proxy'] } });
      await sp.apply(10808, 'all');
      g.set('org.gnome.system.proxy mode', "'none'");          // another program switches it off
      held.gate = new Promise((r) => { held.open = r; });
      const checking = sp.checkOwnership();
      await sleep(20);                                           // the set-back waits on its first gsettings
      sp.restoreSync();
      const now = JSON.stringify([...g]);
      t.ok(held.killed && now === start && !fs.existsSync(file) && !fs.existsSync(hook),
        `GNOME: a ${exiting ? 'quit' : 'session end'} during a set-back (at ${at}): its command stopped, everything put back at once, no state file or login hook left`);
      held.open();
      t.ok((await checking) === null && JSON.stringify([...g]) === start && !fs.existsSync(file) && !fs.existsSync(hook)
        && !log.lines.some((l) => l.includes('set it back to Shroudly')),
      `GNOME: …${exiting ? 'the stopped command writes nothing' : `a write that landed after the restore (${at}) is put back`}, and nothing more is written: no dead PAC of ours left, the restore not undone`);
      SystemProxy._setExec(fx);
    }
    // Stop (restore(), which waits) during a set-back: done after it.
    {
      const start = JSON.stringify([...g]);
      let gate = null;
      let open = null;
      const fx5 = fakeExec({ gsettings: fakeGsettings(g) });
      fx5.run = async (cmd, args) => { if (gate && args[0] === 'set') { const w = gate; gate = null; await w; } return fx5.runSync(cmd, args); };
      SystemProxy._setExec(fx5);
      const sp = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [] });
      await sp.apply(10808, 'all');
      g.set('org.gnome.system.proxy mode', "'none'");
      gate = new Promise((r) => { open = r; });
      const checking = sp.checkOwnership();
      await sleep(20);
      const stopping = sp.restore();
      await sleep(20);
      open();
      await Promise.all([checking, stopping]);
      t.ok(!sp.applied && JSON.stringify([...g]) === start && !fs.existsSync(file), 'GNOME: Stop during a set-back is done after it: everything put back');
      SystemProxy._setExec(fx);
    }
    // Automatic with no address is WPAD, a PAC found on the network: chosen
    // by the user or an administrator, like KDE's 3. Left alone, reported,
    // not overwritten.
    {
      const start = JSON.stringify([...g]);
      const seen = [];
      const sp = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: file, onOwnership: (o, i) => seen.push([o, i]), ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [] });
      await sp.apply(10808, 'all');
      g.set('org.gnome.system.proxy autoconfig-url', "''");
      t.ok((await sp.checkOwnership()).join() === 'GNOME' && (await sp.checkOwnership()).join() === 'GNOME' && seen.length === 1 && seen[0][1].takeover.kind === 'pac'
        && g.get('org.gnome.system.proxy mode') === "'auto'" && g.get('org.gnome.system.proxy autoconfig-url') === "''", 'GNOME: "Automatic" with no address (WPAD) is a choice: reported, left as it is');
      await sp.restore();
      t.ok(g.get('org.gnome.system.proxy mode') === "'auto'" && g.get('org.gnome.system.proxy autoconfig-url') === "''", 'GNOME: …and Stop leaves it');
      for (const [k, v] of JSON.parse(start)) g.set(k, v);
    }
    // The user's own PAC from before Shroudly is served on this computer by
    // a program that has gone since: Stop sets the mode to none (the address
    // kept) instead of pointing at nothing, and says so. Still served: back.
    for (const served of [false, true]) {
      const start = JSON.stringify([...g]);
      g.set('org.gnome.system.proxy mode', "'auto'");
      g.set('org.gnome.system.proxy autoconfig-url', "'http://127.0.0.1:7890/pac'");
      SystemProxy._setExec({ ...fx, listening: (port) => (port === 7890 ? served : true) });
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file });
      await sp.apply(10808, 'all');
      await sp.restore();
      const said = log.lines.includes('info: The proxy setting from before Shroudly (http://127.0.0.1:7890/pac) points at a program on this computer that is no longer running; it was switched off instead of put back');
      t.ok(g.get('org.gnome.system.proxy mode') === (served ? "'auto'" : "'none'") && g.get('org.gnome.system.proxy autoconfig-url') === "'http://127.0.0.1:7890/pac'" && said === !served,
        `GNOME: the user's own PAC on this computer, ${served ? 'still served: back on' : 'its program gone: mode none at Stop, address kept, and said'}`);
      SystemProxy._setExec(fx);
      for (const [k, v] of JSON.parse(start)) g.set(k, v);
    }
    // A manual proxy on this computer (a Clash or v2rayA of the user's): the
    // tool quits and switches the proxy off, which Shroudly sets back. At
    // Stop nothing listens there: the mode goes to none, its servers kept,
    // instead of a manual proxy that answers nothing (no program gets
    // around one). One still listening, or unknown: manual, as before.
    for (const [why, on, back] of [['all gone', { 7890: false, 7891: false }, false], ['one still listening', { 7890: false, 7891: true }, true], ['unknown', { 7890: null, 7891: false }, true]]) {
      const start = [...g];
      g.set('org.gnome.system.proxy mode', "'manual'");
      g.set('org.gnome.system.proxy.http host', "'127.0.0.1'"); g.set('org.gnome.system.proxy.http port', '7890');
      g.set('org.gnome.system.proxy.https host', "'127.0.0.1'"); g.set('org.gnome.system.proxy.https port', '7890');
      g.set('org.gnome.system.proxy.ftp host', "''"); g.set('org.gnome.system.proxy.ftp port', '0');
      g.set('org.gnome.system.proxy.socks host', "'localhost'"); g.set('org.gnome.system.proxy.socks port', '7891');
      SystemProxy._setExec({ ...fx, listening: (port) => (port in on ? on[port] : true) });
      const log = logs();
      const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: file, onOwnership: () => {}, ownershipIntervalMs: 60000, takeoverConfirmMs: 0, retakeLooksMs: [] });
      await sp.apply(10808, 'all');
      g.set('org.gnome.system.proxy mode', "'none'");          // the tool quits
      await sp.checkOwnership();
      const setBack = g.get('org.gnome.system.proxy mode') === "'auto'";
      await sp.restore();
      const said = log.lines.includes('info: The proxy setting from before Shroudly (127.0.0.1:7890, localhost:7891) points at a program on this computer that is no longer running; it was switched off instead of put back');
      t.ok(setBack && g.get('org.gnome.system.proxy mode') === (back ? "'manual'" : "'none'") && g.get('org.gnome.system.proxy.http host') === "'127.0.0.1'"
        && g.get('org.gnome.system.proxy.socks port') === '7891' && said === !back && !fs.existsSync(file),
      `GNOME: the user's own manual proxy on this computer (${why}): ${back ? 'manual at Stop, as before' : 'mode none at Stop, its servers kept, and said'}`);
      SystemProxy._setExec(fx);
      g.clear(); for (const [k, v] of start) g.set(k, v);
    }
  }
  for (const withTool of [true, false]) {
    // KDE Plasma, with kwriteconfig6 and without (the file is edited).
    const how = withTool ? 'kwriteconfig6' : 'file edit';
    const cfg = path.join(TMP, `kde-${withTool}`);
    const file = path.join(cfg, 'kioslaverc');
    const original = '[Cache]\nMaxCacheSize=5120\n\n[Proxy Settings]\nAuthMode=0\nNoProxyFor=localhost,127.0.0.1\nProxyType=1\nhttpProxy=http://10.0.0.5 3128\n\n[$Version]\nupdate_info=kioslave.upd:proxy\n';
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(file, original);
    const kw = [];
    const fx = fakeExec(withTool ? { kwriteconfig6: fakeKwrite(kw), 'dbus-send': () => '' } : {});
    SystemProxy._setExec(fx);
    const env = { XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: cfg, HOME: process.env.HOME };
    const sf = stateFile(`kde-${withTool}`);
    const log = logs();
    const sp = new SystemProxy(log, { platform: 'linux', env, stateFile: sf });
    const st = await sp.apply(10808, 'all');
    const cur = SystemProxy._kdeRead(fs.readFileSync(file, 'utf8'));
    t.ok(st.ok && st.system === 'kde' && cur.type === '2' && cur.script === sp.pacUrl, `KDE (${how}): ProxyType=2 with our PAC`);
    t.ok(fs.readFileSync(file, 'utf8').includes('httpProxy=http://10.0.0.5 3128') && fs.readFileSync(file, 'utf8').includes('[Cache]'), `KDE (${how}): everything else in the file kept`);
    t.ok(withTool ? kw.length === 2 : true, `KDE (${how}): ${withTool ? 'written through kwriteconfig6' : 'no kwriteconfig: the file itself'}`);
    t.ok(fx.calls.some((c) => c[0] === 'dbus-send' && c.includes('/KIO/Scheduler') && c.includes('org.kde.KIO.Scheduler.reparseSlaveConfiguration')), `KDE (${how}): KIO told to re-read it`);
    t.ok(readState(sf).snapshot.kde.type === '1' && log.lines.some((l) => l.startsWith('success')), `KDE (${how}): armed and logged as routed`);
    await sp.restore();
    const back = SystemProxy._kdeRead(fs.readFileSync(file, 'utf8'));
    t.ok(back.type === '1' && back.script === null && fs.readFileSync(file, 'utf8').includes('httpProxy=http://10.0.0.5 3128') && !fs.existsSync(sf),
      `KDE (${how}): restored exactly (the key that was not there is gone again)`);
    if (!withTool) t.ok(fs.readFileSync(file, 'utf8') === original, 'KDE (file edit): byte for byte the file it was');
    // A crash, then recovery.
    const sp2 = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: sf });
    await sp2.apply(10808, 'listed', ['discord.com']);
    sp2.stopPacServer();
    t.ok(SystemProxy.recoverSync({ stateFile: sf, platform: 'linux', env }) === true && SystemProxy._kdeRead(fs.readFileSync(file, 'utf8')).type === '1',
      `KDE (${how}): recovery after a crash restores`);
    // Ownership, read from the file (no process started).
    const sp3 = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: sf, onOwnership: () => {}, takeoverConfirmMs: 0 });
    await sp3.apply(10808, 'all');
    const n = fx.calls.length;
    t.ok((await sp3.checkOwnership()).length === 0 && fx.calls.length === n, `KDE (${how}): ownership read from the file, no process started`);
    fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '0' }));
    const kd = () => SystemProxy._kdeRead(fs.readFileSync(file, 'utf8'));
    t.ok((await sp3.checkOwnership()).length === 0 && kd().type === '2' && kd().script === sp3.pacUrl, `KDE (${how}): switched off by another program: set back (issue #27)`);
    fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '1' }));
    t.ok((await sp3.checkOwnership())[0] === 'KDE' && kd().type === '1', `KDE (${how}): a manual proxy chosen meanwhile is noticed and left as it is`);
    await sp3.restore();
    t.ok(SystemProxy._kdeRead(fs.readFileSync(file, 'utf8')).type === '1', `KDE (${how}): and not undone on stop`);
    // The user's own PAC from before Shroudly served on this computer by a
    // program that has gone since: no proxy at Stop, its address kept.
    {
      const was = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, SystemProxy._kdeEdit(was, { ProxyType: '2', 'Proxy Config Script': 'http://127.0.0.1:7890/pac' }));
      for (const served of [false, true]) {
        SystemProxy._setExec({ ...fx, listening: (port) => (port === 7890 ? served : true) });
        const log4 = logs();
        const sp4 = new SystemProxy(log4, { platform: 'linux', env, stateFile: sf });
        await sp4.apply(10808, 'all');
        await sp4.restore();
        const k = kd();
        t.ok(k.type === (served ? '2' : null) && k.script === 'http://127.0.0.1:7890/pac' && log4.lines.some((l) => l.includes('no longer running')) === !served,
          `KDE (${how}): the user's own PAC on this computer, ${served ? 'still served: back' : 'its program gone: no proxy at Stop, address kept, and said'}`);
        SystemProxy._setExec(fx);
        fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '2', 'Proxy Config Script': 'http://127.0.0.1:7890/pac' }));
      }
      fs.writeFileSync(file, was);
    }
    // A manual proxy on this computer, its program gone since: no proxy at
    // Stop, its servers kept; still listening: back as before.
    {
      const was = fs.readFileSync(file, 'utf8');
      for (const served of [false, true]) {
        fs.writeFileSync(file, SystemProxy._kdeEdit(was, { ProxyType: '1', httpProxy: 'http://127.0.0.1 7890', httpsProxy: 'http://127.0.0.1:7890', socksProxy: 'socks://[::1] 7891' }));
        SystemProxy._setExec({ ...fx, listening: (port) => (port === 7890 || port === 7891 ? served : true) });
        const log5 = logs();
        const sp5 = new SystemProxy(log5, { platform: 'linux', env, stateFile: sf });
        await sp5.apply(10808, 'all');
        await sp5.restore();
        const text = fs.readFileSync(file, 'utf8');
        t.ok(kd().type === (served ? '1' : null) && /httpProxy=http:\/\/127\.0\.0\.1 7890/.test(text) && log5.lines.some((l) => l.includes('(127.0.0.1:7890, [::1]:7891)') && l.includes('no longer running')) === !served,
          `KDE (${how}): the user's own manual proxy on this computer, ${served ? 'still served: back' : 'its program gone: no proxy at Stop, its servers kept, and said'}`);
        SystemProxy._setExec(fx);
      }
      fs.writeFileSync(file, was);
    }
    // Reset with no state file.
    fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '2', 'Proxy Config Script': 'http://127.0.0.1:5555/proxy.pac' }));
    t.ok(SystemProxy.resetLegacySync(() => {}, { platform: 'linux', env }) && SystemProxy._kdeRead(fs.readFileSync(file, 'utf8')).type === '0', `KDE (${how}) reset: our PAC switched off`);
  }
  {
    // A10: Plasma with GNOME's setting also there: only KDE's counts.
    const cfg = path.join(TMP, 'kde-gsettings');
    const file = path.join(cfg, 'kioslaverc');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(file, '[Proxy Settings]\nProxyType=0\n');
    const g = gnomeDefaults();
    SystemProxy._setExec(fakeExec({ gsettings: fakeGsettings(g), 'dbus-send': () => '' }));
    const seen = [];
    const sp = new SystemProxy(() => {}, { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'KDE', XDG_CONFIG_HOME: cfg, HOME: process.env.HOME }, stateFile: stateFile('kde-g'), onOwnership: (o, i) => seen.push(i.lost), takeoverConfirmMs: 0 });
    const st = await sp.apply(10808, 'all');
    t.ok(st.ok && st.system === 'kde' && g.get('org.gnome.system.proxy mode') === "'auto'", 'KDE with gsettings: both set');
    g.set('org.gnome.system.proxy mode', "'none'");
    t.ok((await sp.checkOwnership()).length === 0 && seen.length === 0, 'KDE (A10): GNOME\'s setting changing is not a takeover on Plasma');
    fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '1' }));
    t.ok((await sp.checkOwnership()).join() === 'KDE' && seen.length === 1, 'KDE (A10): KDE\'s own setting changing is');
    await sp.restore();
  }
  {
    // KConfig escapes survive a round trip; a value with a backslash and a leading space.
    const text = SystemProxy._kdeEdit('', { 'Proxy Config Script': ' a\\b' });
    t.ok(SystemProxy._kdeRead(text).script === ' a\\b' && text === '[Proxy Settings]\nProxy Config Script=\\sa\\\\b\n', 'KDE: values escaped as KConfig does');
    t.ok(SystemProxy._kdeRead('[Proxy Settings][$i]\nProxyType=1\n').locked, 'KDE: settings locked by the administrator are recognised');
  }
  // XFCE, LXQt and other desktops without a proxy setting: system-proxy-env.test.js.

  // ── EngineManager: the status reaches the window, the admin button works ──
  {
    SystemProxy._setExec(fakeExec({}));
    const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
    const mem = {};
    const store = { get: (k, dflt) => (k in mem ? mem[k] : dflt), set: (k, v) => { mem[k] = v; } };
    const statuses = [];
    const em = new EngineManager(store, { onProxyStatus: (s) => statuses.push(s && s.code) });
    t.ok(typeof em.proxy.onOwnership === 'function', 'EngineManager: listens for the proxy being taken over');
    em._setProxyStatus({ ok: true, code: 'ok', system: 'windows' });
    em.proxy.onOwnership(false, { lost: ['AutoConfigURL'] });
    t.ok(em.proxyStatus.code === 'replaced' && em.proxyStatus.lost[0] === 'AutoConfigURL', 'EngineManager: a takeover becomes status "replaced"');
    em.proxy.onOwnership(true, { lost: [] });
    t.ok(em.proxyStatus.code === 'ok', 'EngineManager: and back to "ok" when ours again');
    // Issue #27: a program that keeps taking it: the window says Shroudly
    // stopped setting it back, and names the program.
    em.proxy.onOwnership(false, { lost: ['AutoConfigURL'], takeover: { kind: 'cleared' }, gaveUp: true, by: ['Psiphon'] });
    t.ok(em.proxyStatus.code === 'replaced' && em.proxyStatus.fight && em.proxyStatus.fight.by.join() === 'Psiphon' && em.proxyStatus.replacedFrom.code === 'ok',
      'EngineManager (issue #27): a fight becomes "replaced" with the program named');
    em.proxy.onOwnership(true, { lost: [] });
    t.ok(em.proxyStatus.code === 'ok' && !em.proxyStatus.fight, 'EngineManager (issue #27): …and "ok" again, without it, once ours again');
    {
      const W = EngineManager.whoTookProxy;
      const listener = async (port) => (port === 7890 ? { pid: 42, name: 'clash-verge.exe' } : port === 8000 ? { pid: 43, name: 'MyProxy.exe' } : null);
      const tools = async () => ['Psiphon'];
      t.ok((await W({ kind: 'local', port: 7890 }, { listener, tools })).join() === 'V2Ray / Clash'
        && (await W({ kind: 'local', port: 8000 }, { listener, tools })).join() === 'MyProxy'
        && (await W({ kind: 'local', port: 9999 }, { listener, tools })).join() === 'Psiphon'
        && (await W({ kind: 'cleared' }, { listener: async () => { throw new Error('not asked'); }, tools })).join() === 'Psiphon'
        && (await W(null, { listener, tools: async () => { throw new Error('no list'); } })).length === 0,
      'EngineManager (issue #27): the program named is the one serving the PAC that replaced ours, else a running tool known to set the proxy, else none');
    }
    const calls = [];
    em.proxy = {
      applyAsAdmin: async () => { calls.push('admin'); return { ok: true, code: 'ok', admin: true }; },
      updateRouting: () => { calls.push('pac'); return true; },
      restore: async () => { calls.push('restore'); },
      apply: async () => { calls.push('apply'); return { ok: true, code: 'ok' }; },
    };
    t.ok((await em.applyProxyAsAdmin()).code === 'not_active', 'EngineManager: the admin button does nothing while protection is off');
    em.active = true;
    const r = await em.applyProxyAsAdmin();
    t.ok(r.ok && em.proxyStatus.admin && statuses[statuses.length - 1] === 'ok', 'EngineManager: applyProxyAsAdmin() sets and reports the status');
    await em.reapplyProxy();
    t.ok(calls.join(',') === 'admin,pac', 'EngineManager: a route change after the admin path only changes the PAC');
    // A3: the dialog answered after Stop: the status of no session.
    em.proxy.applyAsAdmin = async () => { em.active = false; return { ok: true, code: 'ok', admin: true }; };
    const before = statuses.length;
    await em.applyProxyAsAdmin();
    t.ok(statuses.length === before, 'EngineManager (A3): an answer that arrives after Stop is not shown as the status');
    em.proxy.applyAsAdmin = async () => ({ ok: false, code: 'not_active' });
    em.active = true;
    await em.applyProxyAsAdmin();
    t.ok(statuses.length === before, 'EngineManager (A3): nor one the proxy says belongs to no session');
    em.active = false;

    // P2: a Stop pressed right after a route change (or "Set Shroudly
    // again"): the re-apply never puts the proxy back after the Stop.
    {
      const order = [];
      let set = true;
      em.proxy = {
        restore: async () => { await sleep(40); set = false; order.push('restore'); return true; },
        apply: async () => { await sleep(40); set = true; order.push('apply'); return { ok: true, code: 'ok' }; },
        clearEnv: () => {},
      };
      let spawned = 0;
      const realSpawn = em._spawn;
      em._spawn = async () => { spawned++; return true; };
      em._setProxyStatus({ ok: true, code: 'ok' });
      em.active = true;
      const re = em.reapplyProxy();
      await sleep(10);
      const stop = em.stop({ user: true });
      const late = em.reapplyProxy();
      const lateRestart = await em.restart();
      const lateAdmin = await em.applyProxyAsAdmin();
      await Promise.all([re, stop, late]);
      await sleep(100);
      t.ok(!set && !order.includes('apply') && em.proxyStatus === null && !em.active && lateAdmin.code === 'not_active',
        `EngineManager (P2): a re-apply under way when Stop is pressed does not set the proxy again (${order.join(',')})`);
      t.ok(lateRestart.success && spawned === 0, 'EngineManager (P2): nor does a settings restart asked for during the Stop start an engine');
      em._spawn = realSpawn;
      em.expectingStop = false; // as the next start does
    }

    // P4: macOS Standard account, taken over by another program: "Set
    // Shroudly again" sets it again, password and all, instead of only
    // changing the PAC's answer and saying it worked.
    {
      const calls2 = [];
      em.proxy = {
        updateRouting: () => { calls2.push('pac'); return true; },
        restore: async () => { calls2.push('restore'); return true; },
        apply: async () => { calls2.push('apply'); return { ok: false, code: 'needs_admin', system: 'macos' }; },
        applyAsAdmin: async () => { calls2.push('admin'); return { ok: true, code: 'ok', admin: true, system: 'macos' }; },
      };
      em.active = true;
      const base = { ok: true, code: 'ok', admin: true, system: 'macos' };
      em._setProxyStatus({ ...base, ok: false, code: 'replaced', lost: ['Wi-Fi'], replacedFrom: base });
      const r = await em.reapplyProxy({ userAsked: true });
      t.ok(calls2.join(',') === 'restore,apply,admin' && r.status.ok && em.proxyStatus.code === 'ok' && em.proxyStatus.admin,
        `EngineManager (P4): the "Set Shroudly again" button sets the admin path again, not just the PAC (${calls2.join(',')})`);
      calls2.length = 0;
      em.proxy.applyAsAdmin = async () => { calls2.push('admin'); return { ok: false, code: 'cancelled', admin: false }; };
      em._setProxyStatus({ ...base, ok: false, code: 'replaced', lost: ['Wi-Fi'], replacedFrom: base });
      const r2 = await em.reapplyProxy({ userAsked: true });
      t.ok(!r2.status.ok && r2.status.code === 'cancelled' && em.proxyStatus.code === 'cancelled', 'EngineManager (P4): …and a dismissed dialog is reported as such, not as set again');
      // A background settings change while taken over (no button) must never
      // pop a password dialog: only the PAC's answer changes, status stays replaced.
      calls2.length = 0;
      em.proxy.applyAsAdmin = async () => { calls2.push('admin'); return { ok: true, code: 'ok', admin: true }; };
      em._setProxyStatus({ ...base, ok: false, code: 'replaced', lost: ['Wi-Fi'], replacedFrom: base });
      const r3 = await em.reapplyProxy();
      t.ok(calls2.join(',') === 'pac' && em.proxyStatus.code === 'replaced',
        `EngineManager (P4): a settings change while taken over only updates the PAC, no password dialog (${calls2.join(',') || 'none'})`);
      em.active = false;
    }

    // Issue #27: "Set Shroudly again" over a takeover Shroudly would set back
    // by itself sets it back the same way (the record of the user's own
    // settings kept, no restore and apply, no PAC server moved); over a newer
    // choice of the user's (retakeNow says null) it is set again as before.
    {
      const calls3 = [];
      const base = { ok: true, code: 'ok', system: 'windows' };
      let answer = base;
      em.proxy = {
        retakeNow: async () => { calls3.push('retake'); return answer; },
        updateRouting: () => { calls3.push('pac'); return true; },
        restore: async () => { calls3.push('restore'); return true; },
        apply: async () => { calls3.push('apply'); return base; },
        checkSoon: () => { calls3.push('soon'); },
      };
      em.active = true;
      em._setProxyStatus({ ...base, ok: false, code: 'replaced', lost: ['AutoConfigURL'], replacedFrom: base });
      let r = await em.reapplyProxy({ userAsked: true });
      t.ok(calls3.join(',') === 'retake,pac' && r.status.ok && em.proxyStatus.code === 'ok', `EngineManager (issue #27): "Set Shroudly again" sets it back in place (${calls3.join(',')})`);
      calls3.length = 0;
      answer = { ...base, ok: false, code: 'replaced', lost: ['AutoConfigURL'], replacedFrom: base };
      em._setProxyStatus({ ...base, ok: false, code: 'replaced', lost: ['AutoConfigURL'], replacedFrom: base });
      r = await em.reapplyProxy({ userAsked: true });
      t.ok(calls3.join(',') === 'retake,pac' && !r.status.ok && em.proxyStatus.code === 'replaced', 'EngineManager (issue #27): …taken again at once: still shown as taken over');
      calls3.length = 0;
      answer = null;
      em._setProxyStatus({ ...base, ok: false, code: 'replaced', lost: ['AutoConfigURL'], replacedFrom: base });
      r = await em.reapplyProxy({ userAsked: true });
      t.ok(calls3.join(',') === 'retake,restore,apply' && r.status.ok, `EngineManager (issue #27): a newer choice of the user's is set over with a new record (${calls3.join(',')})`);
      calls3.length = 0;
      em.checkProxySoon();
      em.active = false;
      em.checkProxySoon();
      t.ok(calls3.join(',') === 'soon', 'EngineManager (issue #27): a look ahead of the timer only while protection is on');
    }

    // P6: settings a restart of the Mac left for the administrator's password.
    {
      const asked = [];
      const origRecover = SystemProxy.recoverAsAdmin;
      const origPending = SystemProxy.pendingAdminRecovery;
      let pending = { declined: false };
      SystemProxy.pendingAdminRecovery = () => pending;
      SystemProxy.recoverAsAdmin = async (opts) => { asked.push(!!opts.userAsked); pending = { declined: true }; return false; };
      const seenRecovery = [];
      em.onProxyRecovery = (r) => seenRecovery.push(r);
      try {
        em.proxyRecovery = { declined: false };
        em.proxyRecoveryPending = true;
        t.ok(await em.recoverProxyAsAdmin({ windowShown: false }) === false && asked.length === 0 && em.proxyRecoveryPending,
          'EngineManager (P6): no password dialog while there is no window on screen (started into the tray); still due');
        await em.recoverProxyAsAdmin({ windowShown: true });
        t.ok(asked.join() === 'false' && em.proxyRecovery.declined && seenRecovery.length === 1 && seenRecovery[0].declined,
          'EngineManager (P6): asked once the window is up; dismissed, the window is told (its banner offers it)');
        await em.recoverProxyAsAdmin({ windowShown: true });
        em.proxyRecoveryPending = true;
        await em.recoverProxyAsAdmin({ windowShown: true });
        t.ok(asked.length === 1, 'EngineManager (P6): once declined, never asked again by itself');
        SystemProxy.recoverAsAdmin = async (opts) => { asked.push(!!opts.userAsked); pending = null; return true; };
        t.ok(await em.recoverProxyAsAdmin({ user: true }) === true && asked.join() === 'false,true' && em.proxyRecovery === null && seenRecovery[seenRecovery.length - 1] === null,
          'EngineManager (P6): the banner\'s button asks, and a success clears the banner');
      } finally {
        SystemProxy.recoverAsAdmin = origRecover;
        SystemProxy.pendingAdminRecovery = origPending;
        em.onProxyRecovery = () => {};
      }
    }

    // P18: a system DNS that answered nothing at the start is reported only
    // when, a little later, it still answers nothing with the network up.
    {
      const diagnostics = require(path.join(ROOT, 'electron', 'diagnostics.js'));
      const origCollect = diagnostics.collect;
      const origDead = diagnostics.dnsDead;
      const lines = [];
      em.log = (level, msg) => lines.push(msg);
      em.dnsRecheckMs = 50;
      em.active = true;
      let dead = false;
      let rechecks = 0;
      diagnostics.collect = async () => ({ os: 'test', iface: { name: 'en0', kind: 'Wi-Fi' }, dnsServers: ['192.168.1.1'], localDns: null,
        dnsAnswered: 0, dnsAsked: 6, conflicts: [], idleVpns: [], forgedDns: [], region: null, needRestart: [] });
      diagnostics.dnsDead = async () => { rechecks++; return dead; };
      const DEAD = 'The system DNS answered none of the test names';
      try {
        await em._describeEnvironment();
        t.ok(!lines.some((l) => l.startsWith(DEAD)), 'EngineManager (P18): nothing answering at the start (the network not up yet) is not reported at once');
        await sleep(150);
        t.ok(rechecks === 1 && !lines.some((l) => l.startsWith(DEAD)), 'EngineManager (P18): looked at again later; the network came up and the DNS answers: no warning');
        dead = true;
        await em._describeEnvironment();
        await sleep(150);
        t.ok(rechecks === 2 && lines.filter((l) => l.startsWith(DEAD)).length === 1, 'EngineManager (P18): still nothing with the network up: then it is said');
      } finally {
        diagnostics.collect = origCollect;
        diagnostics.dnsDead = origDead;
        clearInterval(em._conflictTimer);
        em.active = false;
      }
    }

    // Programs already running when protection starts: asked to restart only
    // where a restart is really the fix for that program on that system, and
    // only once per session (a later Stop/Start keeps the same address).
    {
      const diagnostics = require(path.join(ROOT, 'electron', 'diagnostics.js'));
      const origCollect = diagnostics.collect;
      const RUNNING = 'was already running when protection started';
      const lines = []; const told = [];
      em.log = (level, msg) => lines.push(msg);
      em.onNeedRestart = (apps) => told.push(apps.join(','));
      em.active = true;
      diagnostics.collect = async () => ({ os: 'test', iface: { name: 'en0', kind: 'Wi-Fi' }, dnsServers: ['1.1.1.1'], localDns: null,
        dnsAnswered: 6, dnsAsked: 6, conflicts: [], idleVpns: [], forgedDns: [], region: null, needRestart: ['Discord', 'Firefox', 'Roblox', 'Telegram'] });
      const run = async (status) => { em._restartTold = false; lines.length = 0; told.length = 0; em.proxyStatus = status; await em._describeEnvironment(); };
      try {
        await run({ ok: true, code: 'ok', system: 'windows' });
        t.ok(told.join('|') === 'Firefox' && lines.some((l) => l.startsWith('Firefox ' + RUNNING) || l.includes('Firefox was already running')),
          `restart (Windows): only Firefox, which loads the proxy file once at start; Discord follows the setting, Roblox and Telegram do not use it (${told.join('|') || 'none'})`);
        await em._describeEnvironment();
        t.ok(told.length === 1, 'restart (Windows): not asked again on a later Stop/Start in the same session');
        for (const system of ['macos', 'gnome', 'kde', 'xfce', 'lxqt', 'other']) {
          await run({ ok: true, code: 'ok', system });
          t.ok(!told.length && !lines.some((l) => l.includes(RUNNING)), `restart (${system}): every program follows the setting or a restart would not help: none asked`);
        }
        await run({ ok: false, code: 'partial_env', system: 'xfce' });
        t.ok(!told.length, 'restart (XFCE, needs a re-login): not asked to restart, which would not help');
        await run({ ok: false, code: 'needs_admin', system: 'macos' });
        t.ok(!told.length, 'restart (macOS, needs an administrator): nothing set yet, none asked');
        t.ok(diagnostics.restartHelps(['Discord', 'Firefox'], 'windows').join() === 'Firefox' && diagnostics.restartHelps(['Discord'], 'gnome').length === 0,
          'diagnostics.restartHelps: per program and per system');
      } finally {
        diagnostics.collect = origCollect;
        clearInterval(em._conflictTimer);
        em.active = false;
        em.proxyStatus = null;
        em._restartTold = false;
      }
    }

    // A6: an engine crash with an administrator-set proxy keeps it and
    // only points the PAC at the restarted engine; any other is restored.
    const ev = [];
    em.proxy = { applied: true, updatePort: () => true, restore: async () => { ev.push('restore'); }, clearEnv: () => ev.push('clearEnv') };
    em.start = async () => { ev.push('start'); };
    em._setProxyStatus({ ok: true, code: 'ok', admin: true });
    em.active = true; em.restarts = 0;
    await em._onClose(1);
    t.ok(!ev.includes('restore') && em.proxyStatus && em.proxyStatus.admin, 'EngineManager (A6): crash with an administrator-set proxy: it stays');
    await sleep(700);
    t.ok(ev.join() === 'start', 'EngineManager (A6): …and the engine is restarted (its new port goes into the PAC)');
    ev.length = 0;
    em._setProxyStatus({ ok: true, code: 'ok' });
    em.active = true;
    await em._onClose(1);
    t.ok(ev[0] === 'restore' && em.proxyStatus === null, 'EngineManager: any other system proxy is restored at once on a crash');
    // Stop while that restart is still waiting: no restart afterwards.
    ev.length = 0;
    await em.stop({ user: true });
    await sleep(1200);
    t.ok(!ev.includes('start') && ev.includes('clearEnv'), 'EngineManager: a Stop while a crash restart waits cancels it (and is the user\'s stop)');
    // P2: a Stop pressed while the crash's own restore is still running: no
    // restart is scheduled after it either.
    ev.length = 0;
    em.proxy = { applied: true, updatePort: () => true, restore: async () => { await sleep(60); ev.push('restore'); }, clearEnv: () => ev.push('clearEnv') };
    em._setProxyStatus({ ok: true, code: 'ok' });
    em.active = true; em.restarts = 0; em.expectingStop = false;
    const crash = em._onClose(1);
    await sleep(10);
    await Promise.all([em.stop({ user: true }), crash]);
    await sleep(1200);
    t.ok(!ev.includes('start') && ev.includes('restore') && !em.active, 'EngineManager (P2): a Stop during a crash\'s restore: the engine is not restarted after it');
    em.expectingStop = false;
    // A port change in settings with an administrator-set proxy: the engine
    // is stopped and started, the system setting kept.
    ev.length = 0;
    const stops = [];
    // A settings restart runs its stop and start itself (one lifecycle step).
    em._stop = async (o) => { stops.push(o || {}); em.active = false; return { success: true }; };
    em._start = async () => { ev.push('start'); };
    em._settings = () => ({ port: 20000, routeMode: 'all', siteList: [] });
    em.configuredPort = 10808;
    em._setProxyStatus({ ok: true, code: 'ok', admin: true });
    em.active = true;
    await em.restart();
    t.ok(stops.length === 1 && stops[0].keepProxy === true && ev.join() === 'start', 'EngineManager (A6): a port change keeps the administrator-set proxy across the restart');
    em._setProxyStatus({ ok: true, code: 'ok' });
    em.active = true;
    await em.restart();
    t.ok(stops.length === 2 && !stops[1].keepProxy, 'EngineManager: …any other is restored and set again');
    em.active = false;
  }
  {
    // A9: a recovery left for the administrator's password is not mistaken
    // for 2.0.0's leftover and switched off blindly.
    SystemProxy._setExec(fakeExec({ networksetup: () => { throw new Error('denied'); } }));
    const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
    const file = stateFile('em-recover');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 2, platform: 'darwin', port: 10808, pacUrl: 'http://127.0.0.1:4321/proxy.pac',
      snapshot: { mode: 'admin', form: 'pac', helperPid: 0, services: [{ name: 'Wi-Fi', applied: true, prevAuto: { enabled: false, url: '' } }] } }));
    const mem = { runtimeActive: true };
    const store = { get: (k, dflt) => (k in mem ? mem[k] : dflt), set: (k, v) => { mem[k] = v; } };
    const em = new EngineManager(store, { proxyOptions: { stateFile: file, platform: 'darwin' } });
    const orig = SystemProxy.resetLegacySync;
    const origRecover = SystemProxy.recoverSync;
    let resets = 0;
    SystemProxy.resetLegacySync = () => { resets++; return false; };
    SystemProxy.recoverSync = () => 'kept';
    try { await em.recover({ protectionOn: true }); } finally { SystemProxy.resetLegacySync = orig; SystemProxy.recoverSync = origRecover; }
    t.ok(resets === 0 && em.proxyRecoveryPending === true && fs.existsSync(file) && mem.runtimeActive === false,
      'EngineManager (A9): "kept" skips the legacy reset; the password is asked once the window is up');
    mem.runtimeActive = true;
    SystemProxy.resetLegacySync = () => { resets++; return false; };
    SystemProxy.recoverSync = () => false;
    try { await em.recover({ protectionOn: true }); } finally { SystemProxy.resetLegacySync = orig; SystemProxy.recoverSync = origRecover; }
    t.ok(resets === 1 && em.proxyRecoveryPending === false, 'EngineManager: nothing recorded and the flag set: the legacy reset still runs');
    fs.rmSync(file, { force: true });
  }

  SystemProxy._setExec(null);
  // No helper may be left waiting.
  for (const f of fs.readdirSync(TMP, { recursive: true })) if (String(f).endsWith('.hold')) fs.rmSync(path.join(TMP, f), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`system-proxy: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });

/* Gone, or exited and never waited for (in a container nothing reaps it). */
function alive(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s[s.lastIndexOf(')') + 2] !== 'Z'; } catch { return true; }
}
