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
 *     and the root helper restores on stop, and when the app dies
 *   - another program taking the proxy over is noticed */

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
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

function logs() { const l = []; const f = (level, msg) => l.push(`${level}: ${msg}`); f.lines = l; return f; }
const stateFile = (name) => path.join(TMP, name, 'proxy-state.json');
const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

(async () => {
  // ── the PAC ─────────────────────────────────────────────────────────
  for (const platform of ['win32', 'linux', 'darwin']) {
    const sp = new SystemProxy(() => {}, { platform });
    sp.mode = 'all';
    const find = pacEval(sp.pacBody(10808));
    const want = platform === 'darwin' ? 'SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808' : 'SOCKS5 127.0.0.1:10808';
    t.ok(find('discord.com') === want, `PAC (${platform}): a routed host gets "${want}", no DIRECT to slip around Shroudly`);
    t.ok(['nas', 'printer.local', 'router.lan', '192.168.1.1', '10.2.3.4', '172.20.0.1', '169.254.1.1', '100.100.1.1', '127.0.0.1', '[::1]']
      .every((h) => find(h) === 'DIRECT'), `PAC (${platform}): this machine and the local network stay direct`);
    t.ok(find('172.32.0.1') === want && find('8.8.8.8') === want, `PAC (${platform}): public addresses are routed`);
    sp.mode = 'listed'; sp.list = ['discord.com'];
    const listed = pacEval(sp.pacBody(10808));
    t.ok(listed('cdn.discord.com') === want && listed('example.com') === 'DIRECT', `PAC (${platform}, listed): listed sites routed with no DIRECT fallback, the rest direct`);
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
    // Ownership: another program replaces the PAC while applied.
    {
      const seen = [];
      const sp = new SystemProxy(() => {}, { platform: 'win32', stateFile: file, onOwnership: (o, i) => seen.push([o, i.lost]), ownershipIntervalMs: 40 });
      await sp.apply(10808, 'all');
      t.ok(!!sp._ownTimer, 'Windows: the ownership check runs while applied');
      const queries = () => ran(fx, 'reg.exe').filter((c) => c[1] === 'query').length;
      const q0 = queries();
      const ps0 = ran(fx, 'powershell.exe').length;
      await sleep(150);
      t.ok(seen.length === 0 && queries() > q0, 'ownership: our PAC in place, nothing reported (one reg query per check)');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: 'http://127.0.0.1:7890/pac' });
      await sleep(150);
      t.ok(seen.length === 1 && seen[0][0] === false && seen[0][1][0] === 'AutoConfigURL', 'ownership: another program\'s PAC is reported, once');
      reg.set('AutoConfigURL', { type: 'REG_SZ', data: sp.pacUrl });
      await sleep(150);
      t.ok(seen.length === 2 && seen[1][0] === true, 'ownership: and its coming back');
      t.ok(ps0 > 0 && ran(fx, 'powershell.exe').length === ps0, 'ownership: no PowerShell on the timer (WinINET is told only on apply and restore)');
      await sp.restore();
      t.ok(!sp._ownTimer, 'ownership: the check stops with the restore');
    }
  }

  // ── the Windows installer's hook (scripts/installer.nsh), interpreted ──
  {
    const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8');
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
  const osa = { calls: 0, refuse: null };
  /* osascript: undo the AppleScript string, swap networksetup for the fake,
   * and run it with a real /bin/sh, as the elevated script would be run. */
  const fakeOsascript = (args) => {
    osa.calls++;
    const m = String(args[1]).match(/^do shell script "([\s\S]*)" with administrator privileges$/);
    if (!m) throw new Error('not an administrator do shell script');
    if (osa.refuse) { const e = new Error('Command failed'); e.stderr = osa.refuse; throw e; }
    const shell = m[1].replace(/\\(["\\])/g, '$1');
    const swapped = shell.split("'/usr/sbin/networksetup'").join(`'${fakeCli}'`);
    if (swapped.includes('/usr/sbin/networksetup')) throw new Error('the real networksetup would run');
    const r = spawnSync('/bin/sh', ['-c', swapped], { env: { ...process.env, FAKE_NS_STATE: nsFile }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const macExec = () => fakeExec({
    networksetup: (args) => {
      const s = nsState();
      const out = FakeNS.handle(s, args);
      if (args[0].startsWith('-set')) FakeNS.save(nsFile, s); // never over a write the helper makes meanwhile
      return out;
    },
    osascript: fakeOsascript,
  });

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
        osa.refuse = 'execution error: User canceled. (-128)';
        const no = await sp.applyAsAdmin();
        t.ok(no.code === 'cancelled' && !fs.existsSync(file) && !fs.existsSync(`${file}.hold`), 'macOS admin: a dismissed dialog changes nothing and leaves no state');
        osa.refuse = null;

        const osa0 = osa.calls;
        const yes = await sp.applyAsAdmin();
        const svc = nsState().services;
        t.ok(yes.ok && yes.code === 'ok' && yes.admin && Object.values(svc).every((x) => x.auto.enabled && x.auto.url === sp.pacUrl),
          'macOS admin: one password sets the PAC on every service (odd service names quoted safely)');
        const helper = readState(file).snapshot.helperPid;
        t.ok(helper > 0 && fs.existsSync(`${file}.hold`) && alive(helper), 'macOS admin: the restoring helper waits in the background');
        const updated = sp.updateRouting('listed', ['discord.com']);
        t.ok(updated && sp.pacText.includes('discord.com') && osa.calls === osa0 + 1, 'macOS admin: a route-mode change is served from the PAC, no second password');
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

      // The helper is gone (a restart of the Mac) with our PAC still set:
      // the recovery asks for the password once more.
      const s2 = nsState(); s2.services['Wi-Fi'].auto = { enabled: true, url: 'http://127.0.0.1:4321/proxy.pac' }; FakeNS.save(nsFile, s2);
      const admState = { v: 2, platform: 'darwin', port: 10808, pacUrl: 'http://127.0.0.1:4321/proxy.pac', snapshot: { mode: 'admin', form: 'pac', helperPid: 0,
        holdFile: path.join(TMP, 'gone.hold'), services: [{ name: 'Wi-Fi', applied: true, prevAuto: { enabled: false, url: '' } }] } };
      fs.writeFileSync(file, JSON.stringify(admState));
      osa.refuse = 'execution error: User canceled. (-128)';
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'darwin' }) === false && fs.existsSync(file), 'macOS admin recovery: password refused, the state file stays for the next try');
      osa.refuse = null;
      const n = osa.calls;
      t.ok(SystemProxy.recoverSync({ stateFile: file, platform: 'darwin' }) === true && osa.calls === n + 1 && !nsState().services['Wi-Fi'].auto.enabled && !fs.existsSync(file),
        'macOS admin recovery: with the password, restored and cleared');
      nsInit();
    }
    if (process.platform === 'darwin') {
      // The AppleScript string escaping, through the real osascript (no
      // administrator privileges: nothing is asked, nothing is changed).
      const shell = `printf '%s' 'a"b\\c'\\''d $HOME \`x\`'`;
      const r = spawnSync('osascript', ['-e', SystemProxy._appleScriptAdmin(shell, false)], { encoding: 'utf8' });
      t.ok(r.stdout.replace(/\n$/, '') === 'a"b\\c\'d $HOME `x`', `osascript gets the shell script exactly (${JSON.stringify(r.stdout)})`);
    }
  }

  // ── Linux ───────────────────────────────────────────────────────────
  {
    const d = SystemProxy.linuxDesktop;
    t.ok(d({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }) === 'gnome' && d({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }) === 'gnome' && d({ XDG_CURRENT_DESKTOP: 'Unity' }) === 'gnome',
      'Linux: GNOME-family desktops');
    t.ok(d({ XDG_CURRENT_DESKTOP: 'KDE' }) === 'kde' && d({ KDE_FULL_SESSION: 'true' }) === 'kde', 'Linux: KDE Plasma');
    t.ok(['XFCE', 'LXQt', 'i3', 'sway', ''].every((x) => d({ XDG_CURRENT_DESKTOP: x }) === 'other'), 'Linux: XFCE, LXQt and window managers have no system proxy');
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
      const sp = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: file, onOwnership: (o, i) => seen.push([o, i.lost]) });
      await sp.apply(10808, 'all');
      t.ok((await sp.checkOwnership()).length === 0, 'GNOME ownership: ours');
      g.set('org.gnome.system.proxy mode', "'manual'");
      t.ok((await sp.checkOwnership())[0] === 'GNOME' && seen.length === 1 && seen[0][0] === false, 'GNOME ownership: a switch to manual is reported');
      await sp.restore();
      t.ok(g.get('org.gnome.system.proxy mode') === "'manual'", 'GNOME: the other program\'s choice survives the stop');
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
    const sp3 = new SystemProxy(() => {}, { platform: 'linux', env, stateFile: sf, onOwnership: () => {} });
    await sp3.apply(10808, 'all');
    const n = fx.calls.length;
    t.ok((await sp3.checkOwnership()).length === 0 && fx.calls.length === n, `KDE (${how}): ownership read from the file, no process started`);
    fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '0' }));
    t.ok((await sp3.checkOwnership())[0] === 'KDE', `KDE (${how}): another setting is noticed`);
    await sp3.restore();
    t.ok(SystemProxy._kdeRead(fs.readFileSync(file, 'utf8')).type === '0', `KDE (${how}): and not undone on stop`);
    // Reset with no state file.
    fs.writeFileSync(file, SystemProxy._kdeEdit(fs.readFileSync(file, 'utf8'), { ProxyType: '2', 'Proxy Config Script': 'http://127.0.0.1:5555/proxy.pac' }));
    t.ok(SystemProxy.resetLegacySync(() => {}, { platform: 'linux', env }) && SystemProxy._kdeRead(fs.readFileSync(file, 'utf8')).type === '0', `KDE (${how}) reset: our PAC switched off`);
  }
  {
    // KConfig escapes survive a round trip; a value with a backslash and a leading space.
    const text = SystemProxy._kdeEdit('', { 'Proxy Config Script': ' a\\b' });
    t.ok(SystemProxy._kdeRead(text).script === ' a\\b' && text === '[Proxy Settings]\nProxy Config Script=\\sa\\\\b\n', 'KDE: values escaped as KConfig does');
    t.ok(SystemProxy._kdeRead('[Proxy Settings][$i]\nProxyType=1\n').locked, 'KDE: settings locked by the administrator are recognised');
  }
  {
    // Desktops with no system proxy: told, not reported as routed.
    SystemProxy._setExec(fakeExec({}));
    const log = logs();
    const file = stateFile('xfce');
    const sp = new SystemProxy(log, { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'XFCE', HOME: process.env.HOME }, stateFile: file });
    const st = await sp.apply(10808, 'all');
    t.ok(!st.ok && st.code === 'no_system_proxy' && !st.partial && !fs.existsSync(file), 'XFCE without gsettings: no_system_proxy, nothing armed');
    t.ok(!log.lines.some((l) => l.startsWith('success')) && log.lines.some((l) => l.includes('socks') || l.includes('SOCKS5 127.0.0.1:10808')), 'XFCE: logged as a warning with the address to use by hand');
    await sp.restore();
    const g = gnomeDefaults();
    SystemProxy._setExec(fakeExec({ gsettings: fakeGsettings(g) }));
    const sp2 = new SystemProxy(() => {}, { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'XFCE', HOME: process.env.HOME }, stateFile: file });
    const st2 = await sp2.apply(10808, 'all');
    t.ok(!st2.ok && st2.code === 'no_system_proxy' && st2.partial && g.get('org.gnome.system.proxy mode') === "'auto'" && fs.existsSync(file),
      'XFCE with gsettings: GNOME\'s setting set for Firefox, still reported as no_system_proxy (partial)');
    await sp2.restore();
    t.ok(g.get('org.gnome.system.proxy mode') === "'manual'" && !fs.existsSync(file), 'XFCE with gsettings: restored');
  }

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
    em.active = false;
  }

  SystemProxy._setExec(null);
  // No helper may be left waiting.
  for (const f of fs.readdirSync(TMP, { recursive: true })) if (String(f).endsWith('.hold')) fs.rmSync(path.join(TMP, f), { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`system-proxy: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
