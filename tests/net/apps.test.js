'use strict';

/* Games and apps mode: the HTTPS_PROXY that programs such as Roblox read is
 * set and removed without ever touching a proxy that is not ours, and the
 * local proxy it points at carries real HTTPS through the engine (protection
 * on) or directly (off). curl reads HTTPS_PROXY exactly the way Roblox's own
 * libcurl does, so it stands in for Roblox here. */

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { ROOT, enginePath, startEngine, freePort, sleep, suite, fixture } = require('./helpers');

const AppProxy = require(path.join(ROOT, 'electron', 'app-proxy.js'));
const AppEnv = require(path.join(ROOT, 'electron', 'app-env.js'));
const { socksAddress } = require(path.join(ROOT, 'electron', 'discord-relay.js'));
const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
const t = suite('apps');

/* An OS environment in memory: the session, and what the machine sets. */
function fakeBackend(session = {}, machine = {}) {
  const env = new Map(Object.entries(session));
  let commits = 0;
  return {
    env, get commits() { return commits; },
    names: { proxy: ['HTTPS_PROXY', 'https_proxy'], noProxy: ['NO_PROXY', 'no_proxy'] },
    get: (k) => env.get(k) || null,
    set: (k, v) => { env.set(k, v); },
    del: (k) => { env.delete(k); },
    machine: (k) => machine[k] || null,
    commit: () => { commits++; },
  };
}

/* CONNECT through the local proxy, then TLS and a GET. */
function getThrough(proxyPort, host, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1');
    let head = ''; let status = 0; let tunnel = 0;
    const done = () => { s.destroy(); resolve({ tunnel, status }); };
    const timer = setTimeout(done, timeoutMs);
    s.on('error', () => { clearTimeout(timer); done(); });
    s.on('connect', () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    s.once('data', (d) => {
      const m = d.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/);
      tunnel = m ? Number(m[1]) : 0;
      if (tunnel !== 200) { clearTimeout(timer); done(); return; }
      const ts = tls.connect({ socket: s, servername: host, ALPNProtocols: ['http/1.1'] });
      ts.on('secureConnect', () => ts.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: shroudly-test\r\nConnection: close\r\n\r\n`));
      ts.on('data', (c) => { if (!status) { head += c.toString('latin1'); const r = head.match(/^HTTP\/1\.[01] (\d{3})/); if (r) { status = Number(r[1]); clearTimeout(timer); done(); } } });
      ts.on('error', () => { clearTimeout(timer); done(); });
    });
  });
}

async function getWithRetry(proxyPort, host) {
  const a = await getThrough(proxyPort, host);
  return a.status ? a : getThrough(proxyPort, host);
}

/* Send text, resolve what came back once the response head is in (or the
 * connection closed). */
function raw(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    const done = () => { s.destroy(); resolve(out); };
    s.on('data', (d) => { out += d; if (out.includes('\r\n\r\n')) setTimeout(done, 50); });
    s.on('close', done); s.on('error', done);
    setTimeout(done, 5000);
  });
}

/* Roblox's web connections (80/443) that do not go to this machine, i.e.
 * that bypass the proxy. */
function robloxDirect() {
  // Roblox's processes first, then only their connections: walking every
  // connection on the machine is too slow on emulated (ARM) runners.
  const ps = "$ids = @(Get-Process -Name 'Roblox*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }); " +
    "if ($ids.Count) { Get-NetTCPConnection -OwningProcess $ids -ErrorAction SilentlyContinue | " +
    "Where-Object { ($_.RemotePort -eq 443 -or $_.RemotePort -eq 80) -and $_.RemoteAddress -notmatch '^(127\\.|::1)' } | " +
    "ForEach-Object { \"$($_.OwningProcess) $($_.RemoteAddress):$($_.RemotePort)\" } }";
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000, env: powershellEnv() },
    (err, out) => resolve(String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))));
}

/* What Shroudly's own "Install Roblox" does (electron/roblox-app.js): the
 * current version asked of Roblox and its installer downloaded through the
 * engine, its Roblox Corporation signature checked, then started with the
 * setting. Then a minute of watching that the installer, and the player it
 * installs, go through Shroudly and nothing goes around it.
 * Shroudly's watcher runs all along, as it does where Roblox is blocked
 * (roblox-watch.js, told so here): it must never touch what goes through
 * Shroudly. Then the same installer is started around Shroudly, as a cafe's
 * script starts it from a game disk before Shroudly has set anything, with a
 * proxy that answers nothing (a network that drops Roblox silently): the
 * watcher must stop it and start it again from its own file through
 * Shroudly. Timed from its start. */
async function robloxInstaller(proxy, socksPort) {
  const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
  const { RobloxWatch } = require(path.join(ROOT, 'electron', 'roblox-watch.js'));
  const { socksConnect } = require(path.join(ROOT, 'electron', 'discord-relay.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-roblox-'));
  const before = proxy.tunnels;
  const roblox = new Set();
  const env = { HTTPS_PROXY: proxy.url, NO_PROXY: AppEnv.NO_PROXY_VALUE };
  proxy.onTunnel = (host) => { if (RobloxApp.isRobloxHost(host)) roblox.add(host); };
  let lastReq = 0; let restarted = null; let firstThrough = 0;
  proxy.onRequest = (h) => { if (!RobloxApp.isRobloxHost(h)) return; lastReq = Date.now(); if (restarted && !firstThrough) firstThrough = lastReq; };
  const acted = [];
  const watch = new RobloxWatch({
    now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), watched: true,
    on: () => true, active: () => true, blocked: () => true, stillBlocked: async () => true, checkSoon: () => {},
    lastRequestAt: () => lastReq, list: () => RobloxApp.processes(), info: (pids) => RobloxApp.processInfo(pids), prepare: () => RobloxApp.prepare(),
    signed: (file, kind) => RobloxApp.signedInstaller(file, kind), same: (file, hash) => RobloxApp.sameFile(file, hash),
    kill: (pids) => { acted.push({ kill: pids, at: Date.now() }); return RobloxApp.kill(pids); },
    startInstaller: (file) => { const pid = RobloxApp.startInstaller(file, env); restarted = { pid, file, at: Date.now() }; return pid; },
    fetch: async () => { acted.push({ download: true }); return { success: false, code: 'not in this test' }; },
    startFetched: async () => false,
    restart: async (pids) => { acted.push({ player: pids }); return { success: false, code: 'not in this test' }; },
    log: () => {}, tell: () => {}, needAdvanced: () => {}, studioReopen: () => {},
  });
  watch.start();
  watch.modeOn(await RobloxApp.processes(), Date.now());
  const killAll = async () => {
    for (const im of ['RobloxPlayerInstaller.exe', 'RobloxPlayerBeta.exe', 'RobloxCrashHandler.exe']) spawnSync('taskkill', ['/F', '/T', '/IM', im]);
    await sleep(1500);
  };
  try {
    const r = await RobloxApp.install({ socksPort, connect: socksConnect, dir, env });
    if (!r.success && r.code === 'unreachable') {
      console.log(`  --  Roblox installer not downloadable here (${r.detail}); skipped`);
      return;
    }
    t.ok(r.success, `Install Roblox: current installer (${r.version}) downloaded through the engine, signed by Roblox, started (${r.code || 'ok'}${r.detail ? `: ${r.detail}` : ''})`);
    if (!r.success) return;
    // A minute of watching, whatever the machine's speed.
    const direct = new Set();
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      await sleep(3000);
      for (const c of await robloxDirect()) direct.add(c);
    }
    const touched = acted.filter((a) => a.kill || a.download);
    const players = acted.filter((a) => a.player);
    if (players.length) console.log(`  !!  the watcher took a player for one around Shroudly: ${JSON.stringify(players)}`);
    t.ok(!touched.length, `the installer started through Shroudly (pid ${r.pid}) was never touched by Shroudly's watcher in a minute (${JSON.stringify(touched)})`);
    await killAll();
    proxy.onTunnel = null;
    const through = proxy.tunnels - before;
    if (direct.size) console.log(`  !!  direct: ${[...direct].slice(0, 8).join(', ')}`);
    t.ok(through > 0 && direct.size === 0, `real Roblox installer: ${through} connections through Shroudly, ${direct.size} around it`);
    t.ok(roblox.size > 0, `Shroudly can tell they are Roblox's (${[...roblox].slice(0, 4).join(', ')})`);

    // What the watcher asks of Windows, timed: the PowerShell it keeps
    // running (started by the watcher above, so normally ready by now),
    // asked twice; a slow machine (ARM) shows in the first answer only.
    let t0 = Date.now();
    const info = await RobloxApp.processInfo([process.pid]);
    const infoMs = Date.now() - t0;
    t0 = Date.now();
    const info2 = await RobloxApp.processInfo([process.pid]);
    const infoMs2 = Date.now() - t0;
    const me = info.get(process.pid) || info2.get(process.pid);
    t0 = Date.now();
    const hash = await RobloxApp.signedInstaller(r.file, 'player');
    const sigMs = Date.now() - t0;
    console.log(`  ..  PowerShell reading a process: ${infoMs} ms, then ${infoMs2} ms; signature check of the installer: ${sigMs} ms`);
    t.ok(me && Math.abs(me.startedAt - (Date.now() - process.uptime() * 1000)) < 5000 && /node/i.test(me.path || ''),
      `a process's start time and file read on Windows (${me && new Date(me.startedAt).toISOString()}, ${me && me.path})`);
    t.ok(infoMs2 < 5000, `asked again, PowerShell is not started again (${infoMs2} ms)`);
    t.ok(!!hash, 'the downloaded installer is taken for Roblox\'s, signed by Roblox');

    // Around Shroudly: a proxy that takes the connection and never answers.
    const silent = net.createServer((c) => { c.on('error', () => {}); }).listen(0, '127.0.0.1');
    await new Promise((ok) => silent.once('listening', ok));
    const aroundEnv = { ...process.env };
    for (const k of Object.keys(aroundEnv)) if (/^(https?|all|no)_proxy$/i.test(k)) delete aroundEnv[k];
    aroundEnv.HTTPS_PROXY = `http://127.0.0.1:${silent.address().port}`;
    acted.length = 0;
    restarted = null; firstThrough = 0;
    const started = Date.now();
    const child = require('child_process').spawn(r.file, [], { detached: true, stdio: 'ignore', env: aroundEnv });
    child.on('error', () => {});
    child.unref();
    // How long is realistic depends on the machine: an ARM runner emulates
    // the installer and takes seconds to start PowerShell or check a
    // signature. Handled it must be, on every machine.
    const bound = process.arch === 'arm64' ? 90000 : 20000;
    while (Date.now() - started < 150000 && !(restarted && firstThrough)) await sleep(250);
    silent.close();
    const tookRestart = restarted ? restarted.at - started : null;
    const tookThrough = firstThrough ? firstThrough - started : null;
    console.log(`  ..  installer around Shroudly (pid ${child.pid}): stopped ${acted.filter((a) => a.kill).map((a) => `${a.at - started} ms`).join(', ') || 'never'}, started again ${tookRestart} ms, its first request through Shroudly ${tookThrough} ms after it started`);
    t.ok(restarted && restarted.file === r.file && acted.some((a) => a.kill && a.kill.includes(child.pid)) && !acted.some((a) => a.download),
      `an installer started around Shroudly is stopped and started again from its own file, through Shroudly, ${tookRestart} ms after it started`);
    t.ok(tookRestart != null && tookThrough != null, `…and reaches Roblox through Shroudly ${tookThrough} ms after it first started`);
    t.ok(tookRestart <= bound, `within ${bound / 1000} s on this machine (${process.arch}): ${tookRestart} ms`);
  } finally {
    watch.stop();
    await Promise.race([watch.idle(), sleep(20000)]);
    RobloxApp.release();
    proxy.onTunnel = null;
    proxy.onRequest = null;
    await killAll();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  // ── addresses ──
  t.ok(JSON.stringify(AppProxy.parseTarget('www.roblox.com:443')) === '{"host":"www.roblox.com","port":443}', 'CONNECT target parsed');
  t.ok(AppProxy.parseTarget('[2606:4700::1111]:443').host === '2606:4700::1111', 'IPv6 CONNECT target parsed');
  t.ok(!AppProxy.parseTarget('bad host:443') && !AppProxy.parseTarget('h:0') && !AppProxy.parseTarget('h:70000') && !AppProxy.parseTarget('[nope]:443'), 'malformed targets refused');
  t.ok(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.9', '::1', 'fd00::1', 'localhost', 'printer.local', 'nas'].every(AppProxy.isLocal), 'local network recognised');
  t.ok(['128.116.97.3', '172.32.0.1', 'www.roblox.com', '2606:4700::1111'].every((h) => !AppProxy.isLocal(h)), 'internet addresses are not local');
  t.ok(AppProxy.addrClass('::ffff:127.0.0.1') === 'loopback' && AppProxy.addrClass('::ffff:c0a8:101') === 'private' && AppProxy.addrClass('64:ff9b::8.8.8.8') === 'public', 'IPv4 inside IPv6 (mapped, NAT64) judged as the IPv4 it is');
  t.ok(socksAddress('1.2.3.4').equals(Buffer.from([1, 1, 2, 3, 4])), 'SOCKS: IPv4 sent as an address');
  t.ok(socksAddress('2606:4700::1111').equals(Buffer.from([4, 0x26, 0x06, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11])), 'SOCKS: IPv6 sent as an address');
  t.ok(socksAddress('::ffff:127.0.0.1').equals(Buffer.from([4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1])), 'SOCKS: IPv4-mapped IPv6 encoded correctly');

  // ── where a tunnel goes ──
  {
    let on = true; let listed = null;
    const p = new AppProxy(() => {}, () => (on ? 1 : null), (h) => !listed || listed.some((d) => h === d || h.endsWith(`.${d}`)));
    const answers = { 'git.corp.example': ['10.20.30.40'], 'www.roblox.com': ['195.175.254.2'], 'blocked.example': ['10.10.34.34'],
      'public.example': ['93.184.216.34'], 'mixed.example': ['10.0.0.5', '93.184.216.34'], 'v6corp.example': ['fd12::1'],
      'sinkholed.example': ['0.0.0.0'], 'sinkholed6.example': ['::'], 'devbox.example': ['127.0.0.1'] };
    p.lookup = async (h) => answers[h] || null;
    const r = async (h) => { p.decisions.clear(); return p.route(h); };
    t.ok((await r('127.0.0.1')) === 'refuse' && (await r('::1')) === 'refuse' && (await r('localhost')) === 'refuse' && (await r('169.254.169.254')) === 'refuse' && (await r('::ffff:127.0.0.1')) === 'refuse', 'refused: this machine, link-local (cloud metadata), however written');
    t.ok((await r('192.168.1.10')) === 'direct' && (await r('nas')) === 'direct' && (await r('printer.local')) === 'direct', 'direct: the local network');
    t.ok((await r('git.corp.example')) === 'direct' && (await r('v6corp.example')) === 'direct', "direct: a name this machine's DNS puts on a private network (an internal server, never asked of public DNS)");
    t.ok((await r('blocked.example')) === 'engine', "engine: a private answer that is a known block page (Iran's 10.10.34.34)");
    t.ok((await r('www.roblox.com')) === 'engine' && (await r('public.example')) === 'engine' && (await r('mixed.example')) === 'engine' && (await r('nowhere.example')) === 'engine', 'engine: public names, forged answers, and names local DNS does not know');
    t.ok((await r('sinkholed.example')) === 'engine' && (await r('sinkholed6.example')) === 'engine', 'engine: 0.0.0.0 / :: answers (a local DNS filter or the ISP saying "blocked")');
    t.ok((await r('devbox.example')) === 'direct', 'direct: a name a developer points at this machine (lvh.me style) is left alone');
    listed = ['roblox.com'];
    t.ok((await r('www.roblox.com')) === 'engine' && (await r('public.example')) === 'direct', 'only listed sites: listed ones through the engine, the rest direct');
    listed = null; on = false;
    t.ok((await r('public.example')) === 'direct' && (await r('127.0.0.1')) === 'refuse', 'protection off: direct (and still never to this machine)');
  }
  // Roblox: which tunnels are Roblox's, and what Shroudly may download.
  const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
  t.ok(['www.roblox.com', 'clientsettingscdn.roblox.com', 'setup.rbxcdn.com', 'tr.rbxcdn.com', 'apis.rbxinfra.net'].every(RobloxApp.isRobloxHost)
    && !['roblox.com.evil.example', 'notroblox.com', 'discord.com', ''].some(RobloxApp.isRobloxHost), "Roblox's own hosts recognised, look-alikes not");
  let refused = 0;
  for (const u of ['http://setup.rbxcdn.com/x', 'https://evil.example/x', 'https://roblox.com.evil.example/x']) {
    try { await RobloxApp.get(u, { timeoutMs: 2000 }); } catch (e) { if (/refused/.test(e.message)) refused++; }
  }
  t.ok(refused === 3, 'the installer download only ever talks HTTPS to Roblox\'s own hosts');
  t.ok(await RobloxApp.signedByRoblox(path.join(ROOT, 'package.json')) === false, 'an unsigned file is never taken for Roblox\'s installer');

  // The player, and only the player, is Roblox: for the update's wait, the
  // check below and the restart, which must never close anything else.
  const tasklist = ['"RobloxPlayerBeta.exe","4120","Console","1","412,000 K"', '"RobloxCrashHandler.exe","4180","Console","1","9,000 K"',
    '"Roblox Account Manager.exe","2200","Console","1","80,000 K"', '"RobloxStudioBeta.exe","5100","Console","1","600,000 K"',
    '"RobloxPlayerInstaller.exe","6100","Console","1","20,000 K"', '"Roblox FPS Unlocker.exe","6200","Console","1","5,000 K"',
    '"robloxplayerbeta.exe","4121","Console","1","400,000 K"'].join('\r\n');
  t.ok(JSON.stringify(RobloxApp.parsePids(tasklist, 'win32')) === '[4120,4121]', `Windows: only RobloxPlayerBeta.exe, not the crash handler, Studio, the installer or other tools (${RobloxApp.parsePids(tasklist, 'win32')})`);
  t.ok(JSON.stringify(RobloxApp.parsePids(tasklist, 'win32', 'studio')) === '[5100]', `Windows: Studio is RobloxStudioBeta.exe alone (${RobloxApp.parsePids(tasklist, 'win32', 'studio')})`);
  {
    const inst = RobloxApp.parseInstallerPids(`${tasklist}\r\n"RobloxStudioInstaller.exe","6300","Console","1","20,000 K"`);
    t.ok(JSON.stringify(inst) === '{"player":[6100],"studio":[6300]}', "Windows: the player's and Studio's installers, each by its own name");
  }
  {
    // Only this user's session: another user's Roblox on the same PC (fast
    // user switching, a terminal server) is not this Shroudly's to judge.
    const two = `${tasklist}\r\n"RobloxPlayerBeta.exe","7120","RDP-Tcp#3","2","400,000 K"\r\n"RobloxPlayerInstaller.exe","7100","RDP-Tcp#3","2","20,000 K"`;
    t.ok(JSON.stringify(RobloxApp.parseProcesses(two, 'win32', 1)) === '{"players":[4120,4121],"studios":[5100],"installers":{"player":[6100],"studio":[]}}'
      && JSON.stringify(RobloxApp.parseProcesses(two, 'win32', 2)) === '{"players":[7120],"studios":[],"installers":{"player":[7100],"studio":[]}}'
      && RobloxApp.parseProcesses(two, 'win32').players.length === 3,
    "Windows: only the programs in Shroudly's own session (every session's when it is not known)");
    t.ok(RobloxApp.parseSession('"electron.exe","8812","Console","1","90,000 K"\r\n', 8812) === 1 && RobloxApp.parseSession('"electron.exe","8812","RDP-Tcp#3","2","90,000 K"', 8812) === 2
      && RobloxApp.parseSession('INFO: No tasks are running which match the specified criteria.', 8812) === null, "Shroudly's own session read from the process list");
  }
  {
    // One look at the process list, for every program of Roblox's at once.
    const all = RobloxApp.parseProcesses(`${tasklist}\r\n"RobloxStudioInstaller.exe","6300","Console","1","20,000 K"`, 'win32');
    t.ok(JSON.stringify(all) === '{"players":[4120,4121],"studios":[5100],"installers":{"player":[6100],"studio":[6300]}}',
      `Windows: players, Studio and both installers from one process listing (${JSON.stringify(all)})`);
    t.ok(JSON.stringify(RobloxApp.parseProcesses('INFO: No tasks are running which match the specified criteria.\r\n', 'win32')) === '{"players":[],"studios":[],"installers":{"player":[],"studio":[]}}', 'none running');
    // When each started and the file it runs (PowerShell, one call).
    // Text comes as its UTF-16 code units (what a ConstrainedLanguage
    // PowerShell can still produce): ASCII whatever the console code page.
    const b = (v) => RobloxApp.toCodes(v);
    t.ok(/^[\d,]+$/.test(b('C:\\Users\\Ümit 測試 😀')) && RobloxApp.fromCodes(b('C:\\Users\\Ümit 測試 😀')) === 'C:\\Users\\Ümit 測試 😀'
      && RobloxApp.fromCodes('') === '' && RobloxApp.fromCodes('QzpcVXNlcnM=') === '' && RobloxApp.fromCodes('65,70000') === '',
    'text to and from code units: any name whole (Turkish, Chinese, an emoji), anything else read as nothing');
    const info = RobloxApp.parseProcessInfo(`mode=FullLanguage;6100|133759296000000000|${b('D:\\Games\\Roblox\\RobloxPlayerInstaller.exe')};5100||;`
      + `4120|133759296123456789|${b('C:\\Users\\Ümit Şahin\\AppData\\Local\\Roblox\\Versions\\v\\RobloxPlayerBeta.exe')};noise|x|y`);
    t.ok(info.get(6100).startedAt === Date.UTC(2024, 10, 13) && info.get(6100).path === 'D:\\Games\\Roblox\\RobloxPlayerInstaller.exe' && info.get(4120).startedAt === Date.UTC(2024, 10, 13) + 12346,
      `Windows: a process's start time (FILETIME, UTC) and its file (${new Date(info.get(6100).startedAt).toISOString()})`);
    t.ok(info.get(4120).path === 'C:\\Users\\Ümit Şahin\\AppData\\Local\\Roblox\\Versions\\v\\RobloxPlayerBeta.exe', 'a file under a user name in Turkish arrives whole (code units, whatever the console code page)');
    t.ok(info.get(5100).startedAt === null && info.get(5100).path === null && info.size === 3, "one whose start time and file cannot be read (another user's, elevated): known to be there, nothing more");
    t.ok(info.answered === true && info.restricted === null, 'answered by a PowerShell in full language mode');
    const none = RobloxApp.parseProcessInfo(null);
    t.ok(none.size === 0 && none.answered === false, 'no answer from PowerShell in time: nothing known, and said so (the watcher judges without it, and stops nothing)');
    const clm = RobloxApp.parseProcessInfo(`mode=ConstrainedLanguage;6100|133759296000000000|${b('D:\\x\\RobloxPlayerInstaller.exe')}`);
    t.ok(clm.restricted === 'ConstrainedLanguage' && clm.get(6100).startedAt === Date.UTC(2024, 10, 13), 'a PowerShell an administrator restricted (AppLocker, Device Guard) says so in its answer');
    t.ok(RobloxApp.parseSignature(`Valid|${b('CN="Roblox Corporation", O="Roblox Corporation"')}|${b('İmza doğrulandı.')}`) === 'Valid|CN="Roblox Corporation", O="Roblox Corporation"|İmza doğrulandı.'
      && RobloxApp.parseSignature(null) === 'no answer: timed out' && RobloxApp.parseSignature(`error|${b('Access denied\r\nmore')}`) === 'no answer: Access denied',
    "a signature's answer read back (signer and a Turkish Windows' message intact); no answer, or PowerShell's error, said as such");
  }
  {
    // An installer caught going around Shroudly is started again from its
    // own file only when that is Roblox's installer, validly signed by Roblox
    // (a game disk on shared machines); anything else means a fresh download.
    // A file found signed is remembered by its content, never by its name.
    const signed = 'Valid|CN="Roblox Corporation", O="Roblox Corporation", L=San Mateo, S=California, C=US|Signature verified.';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sig-'));
    const own = path.join(dir, 'RobloxPlayerInstaller.exe');
    fs.writeFileSync(own, 'MZ installer bytes');
    let asked = 0;
    const sig = (answer) => async () => { asked++; return answer; };
    const saved = [];
    const cache = RobloxApp.signedCache([], (list) => saved.push(list));
    const h = await RobloxApp.signedInstaller(own, 'player', { cache, signature: sig(signed) });
    t.ok(/^[0-9a-f]{64}$/.test(h || '') && asked === 1 && saved.length === 1 && saved[0][0] === h, 'a signed Roblox installer is started again from the same file, no download; its content is remembered (and saved)');
    t.ok(await RobloxApp.signedInstaller(own, 'player', { cache, signature: sig('NotSigned||') }) === h && asked === 1, 'the same content again: no second signature check (none can take minutes asking about revocation)');
    t.ok(await RobloxApp.sameFile(own, h), 'and right before it is started, it is still that content');
    fs.writeFileSync(own, 'MZ something else');
    t.ok(!(await RobloxApp.sameFile(own, h)), '…a file changed since is not started');
    t.ok(await RobloxApp.signedInstaller(own, 'player', { cache, signature: sig(signed.replace('Valid', 'HashMismatch')) }) === null && asked === 2, 'a changed file is checked again, whatever its name, and refused if its signature does not hold');
    t.ok(await RobloxApp.signedInstaller(own, 'player', { signature: sig('Valid|CN=Someone Else, O=Someone Else|') }) === null, 'nor one signed by anyone else');
    const other = path.join(dir, 'Setup.exe');
    fs.writeFileSync(other, 'MZ');
    t.ok(await RobloxApp.signedInstaller(other, 'player', { signature: sig(signed) }) === null && await RobloxApp.signedInstaller(own, 'studio', { signature: sig(signed) }) === null,
      "nor a file under another name, nor the player's installer for Studio");
    t.ok(await RobloxApp.signedInstaller(path.join(dir, 'gone', 'RobloxPlayerInstaller.exe'), 'player', { signature: sig(signed) }) === null && await RobloxApp.signedInstaller(null) === null, 'the file gone or not read: a fresh download');
    let swap = 0;
    const racing = async () => { swap++; fs.writeFileSync(own, `MZ swapped ${swap}`); return signed; };
    t.ok(await RobloxApp.signedInstaller(own, 'player', { signature: racing }) === null, 'a file changed while its signature was being checked is not taken');
    const c2 = RobloxApp.signedCache(['nothex', 'a'.repeat(64)]);
    t.ok(c2.has('a'.repeat(64)) && !c2.has('nothex'), 'only hashes are read back from the settings');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    // Copies of the player and Studio wherever Roblox and any bootstrapper
    // keep them, whatever the bootstrapper is called.
    const la = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-la-'));
    const put = (rel) => { fs.mkdirSync(path.dirname(path.join(la, rel)), { recursive: true }); fs.writeFileSync(path.join(la, rel), ''); };
    put('Roblox/Versions/version-a/RobloxPlayerBeta.exe');
    put('Roblox/Versions/version-s/RobloxStudioBeta.exe');
    put('Voidstrap/Versions/version-b/RobloxPlayerBeta.exe');
    put('Voidstrap/Voidstrap.exe');
    put('SomeApp/Versions/notes.txt');
    put('Other/RobloxPlayerBeta.exe');
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = la;
    try {
      const players = RobloxApp.installs('win32').map((p) => path.relative(la, p).split(path.sep).join('/')).sort();
      const studios = RobloxApp.installs('win32', 'studio').map((p) => path.relative(la, p).split(path.sep).join('/'));
      t.ok(JSON.stringify(players) === '["Roblox/Versions/version-a/RobloxPlayerBeta.exe","Voidstrap/Versions/version-b/RobloxPlayerBeta.exe"]',
        `Windows: Roblox's own player and a bootstrapper's, whatever its name (${players.join(', ')})`);
      t.ok(JSON.stringify(studios) === '["Roblox/Versions/version-s/RobloxStudioBeta.exe"]', 'Windows: Studio found apart from the player');
      t.ok(RobloxApp.isBootstrapper(path.join(la, 'Voidstrap', 'Voidstrap.exe')) && RobloxApp.isBootstrapper('C:\\x\\Bloxstrap.exe')
        && !RobloxApp.isBootstrapper(path.join(la, 'Roblox', 'Versions', 'version-a', 'RobloxPlayerBeta.exe')) && !RobloxApp.isBootstrapper(null),
      "a bootstrapper is told by the Versions folder beside it (or a known name), never Roblox's own programs");
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved;
      fs.rmSync(la, { recursive: true, force: true });
    }
  }
  t.ok(RobloxApp.parsePids('INFO: No tasks are running which match the specified criteria.\r\n', 'win32').length === 0 && JSON.stringify(RobloxApp.parsePids('812\n913\n', 'darwin')) === '[812,913]', 'none running; macOS pgrep output read');
  t.ok(RobloxApp.routeWatched('win32') && !RobloxApp.routeWatched('darwin') && !RobloxApp.routeWatched('linux'), 'a player going around Shroudly is only looked for on Windows (macOS hands every app the setting)');
  {
    // Followed from one look to the next: each judged from when it started,
    // whatever the others do (the rules: roblox-watch.test.js).
    const { RobloxWatch } = require(path.join(ROOT, 'electron', 'roblox-watch.js'));
    const T = 1e12;
    const H = 3600 * 1000;
    let clock = T; let lastReq = 0;
    const w = new RobloxWatch({ now: () => clock, watched: true, lastRequestAt: () => lastReq, studioReopen: () => {} });
    const look = (players) => w.observe({ players, studios: [], installers: { player: [], studio: [] } }, clock);
    look([]);
    clock += 2000; look([10]);
    lastReq = clock + 800;
    clock += 2 * H; look([10]);
    t.ok(w.quiet().length === 0, 'a player that sent requests at start is never reported, however long it then runs');
    clock += 2000; look([10, 20]);
    clock += 20000; look([10, 20]);
    t.ok(w.quiet().length === 0, 'a new player gets its quiet wait (long: a player can take a while to load on a slow PC)');
    clock += 6000; look([10, 20]);
    t.ok(JSON.stringify(w.quiet()) === '[20]', 'after it, only the new silent player is reported, not the one that uses Shroudly');
    clock += 60000; look([10]); clock += 60000; look([10]);
    t.ok(w.quiet().length === 0 && w.procs.size === 1, 'players coming and going never restart the clock of one that stays');
  }
  {
    // Roblox asking is the evidence, even when the server it asks for
    // cannot be reached at the moment.
    const asked = []; const carried = [];
    const p = new AppProxy(() => {}, () => deadPort, () => true);
    const deadPort = await freePort();
    p.lookup = async () => ['93.184.216.34'];
    p.onRequest = (h) => asked.push(h);
    p.onTunnel = (h) => carried.push(h);
    const pp = await p.start(await freePort());
    const r = await raw(pp, 'CONNECT clientsettingscdn.roblox.com:443 HTTP/1.1\r\nHost: clientsettingscdn.roblox.com:443\r\n\r\n');
    p.stop();
    t.ok(r.startsWith('HTTP/1.1 502') && asked.join() === 'clientsettingscdn.roblox.com' && carried.length === 0, `a request whose server cannot be reached is still seen as Roblox using Shroudly (${r.split('\r\n')[0]}, asked ${asked.length})`);
  }
  {
    // A download that fails leaves nothing open and nothing behind.
    const openFiles = () => {
      if (process.platform === 'linux') return fs.readdirSync('/proc/self/fd').map((f) => { try { return fs.readlinkSync(`/proc/self/fd/${f}`); } catch { return ''; } });
      if (process.platform === 'darwin') return spawnSync('/usr/sbin/lsof', ['-p', String(process.pid), '-Fn']).stdout.toString().split('\n');
      return [];
    };
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-dl-'));
    const srv = require('https').createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, (req, res) => {
      res.writeHead(200, { 'content-length': String(8 * 1024 * 1024) });
      if (req.url === '/big') res.write(Buffer.alloc(256 * 1024));
      else res.write(Buffer.alloc(4096));
      if (req.url === '/cut') setTimeout(() => req.socket.destroy(), 300);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const connect = () => new Promise((resolve, reject) => { const c = net.connect(srv.address().port, '127.0.0.1', () => resolve(c)); c.on('error', reject); });
    for (const [what, url, opts] of [['too large', '/big', { maxBytes: 64 * 1024 }], ['too slow', '/slow', { timeoutMs: 1500 }], ['cut off', '/cut', {}]]) {
      const name = `dl-${what.replace(/\W/g, '')}-${process.pid}.part`;
      const part = path.join(dl, name);
      let err = null;
      await RobloxApp.get(`https://setup.rbxcdn.com${url}`, { socksPort: 1, connect, toFile: part, tlsOptions: { ca: fixture('test-only-cert.pem'), servername: 'test.local' }, ...opts }).catch((e) => { err = e; });
      const stillOpen = openFiles().some((f) => f.includes(name));
      t.ok(err && !fs.existsSync(part) && !stillOpen, `installer download ${what} (${err && err.message}): file closed and removed (${stillOpen ? 'still open' : 'closed'})`);
    }
    srv.close();
    if (srv.closeAllConnections) srv.closeAllConnections();
    // Each download in a folder of its own; what earlier ones left goes.
    fs.writeFileSync(path.join(dl, 'RobloxPlayerInstaller.exe'), 'left by 2.5.4');
    fs.writeFileSync(path.join(dl, 'RobloxPlayerInstaller.exe.part'), 'cut short');
    const a = RobloxApp.newDownload(dl);
    t.ok(fs.readdirSync(dl).length === 1 && path.dirname(a.file) === a.dir && path.basename(a.file) === 'RobloxPlayerInstaller.exe' && a.part === `${a.file}.part`,
      'a download starts by removing what earlier ones left, in a folder of its own, under the installer\'s own name');
    fs.writeFileSync(a.file, 'done');
    const b = RobloxApp.newDownload(dl);
    t.ok(b.dir !== a.dir && !fs.existsSync(a.dir) && fs.existsSync(b.dir), 'the next download gets a new folder; the last installer goes');
    RobloxApp.cleanDownloads(dl);
    t.ok(fs.readdirSync(dl).length === 0, 'at start, what earlier runs left is removed');
    fs.rmSync(dl, { recursive: true, force: true });
  }
  {
    // The download really runs on the connection it is handed (the engine's),
    // never on a direct one of its own.
    const seen = [];
    const srv = require('https').createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, (req, res) => {
      seen.push(`${req.headers.host}${req.url}`); res.writeHead(200); res.end('{"clientVersionUpload":"version-0123456789abcdef"}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    let handed = 0;
    const connect = () => new Promise((resolve, reject) => { handed++; const c = net.connect(srv.address().port, '127.0.0.1', () => resolve(c)); c.on('error', reject); });
    const r = await RobloxApp.get('https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer', {
      socksPort: 1, connect, timeoutMs: 5000, tlsOptions: { ca: fixture('test-only-cert.pem'), servername: 'test.local' },
    }).catch((e) => ({ error: e.message }));
    srv.close();
    t.ok(handed === 1 && seen[0] === 'clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer' && /version-0123/.test(r.body || ''),
      `Roblox's version asked through the engine's connection (${JSON.stringify(r.error || seen)})`);
  }

  t.ok(socksAddress('roblox.com').equals(Buffer.concat([Buffer.from([3, 10]), Buffer.from('roblox.com')])), 'SOCKS: a name sent as a name (resolved by the engine)');

  // What reg.exe prints for HKCU\Environment, as Windows prints it.
  const reg = AppEnv.parseRegQuery('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;\r\n' +
    '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp\r\n    https_proxy    REG_SZ    http://127.0.0.1:10810\r\n' +
    '    NO_PROXY    REG_SZ    a, b c\r\n    EMPTY    REG_SZ    \r\n    Count    REG_DWORD    0x1\r\n\r\n');
  t.ok(reg.get('HTTPS_PROXY') === 'http://127.0.0.1:10810' && reg.get('NO_PROXY') === 'a, b c' && reg.get('PATH').startsWith('%USERPROFILE%'), 'Windows: reg query output read, names case-insensitive, data with spaces kept');
  t.ok(!reg.has('EMPTY') && !reg.has('COUNT'), 'Windows: empty and non-string values ignored');

  // ── environment, in memory ──
  const url = 'http://127.0.0.1:10810';
  let b = fakeBackend();
  let e = new AppEnv({ backend: b });
  t.ok(e.applySync(url) === 'changed' && b.get('HTTPS_PROXY') === url && b.get('https_proxy') === url && b.get(AppEnv.MARK) === url, 'sets HTTPS_PROXY (both spellings) and the mark');
  t.ok(b.get('NO_PROXY') === AppEnv.NO_PROXY_VALUE && b.commits === 1, 'sets NO_PROXY for the local network, and announces the change');
  t.ok(e.applySync(url) === 'unchanged' && b.commits === 1, 'setting twice changes nothing');
  t.ok(e.current() === url, 'recognises its own value');
  t.ok(e.clearSync() === 'changed' && b.env.size === 0, 'removing leaves nothing behind');
  t.ok(e.clearSync() === 'unchanged', 'removing twice changes nothing');

  b = fakeBackend({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
  e = new AppEnv({ backend: b });
  t.ok(e.applySync(url) === 'foreign' && b.get('HTTPS_PROXY') === 'http://127.0.0.1:7890' && !b.get(AppEnv.MARK), "another local proxy (Clash on 7890) is never replaced");
  t.ok(e.clearSync() === 'unchanged' && b.get('HTTPS_PROXY') === 'http://127.0.0.1:7890', '…nor removed');
  b = fakeBackend({}, { HTTPS_PROXY: 'http://proxy.corp:8080' });
  t.ok(new AppEnv({ backend: b }).applySync(url) === 'foreign' && b.env.size === 0, "a machine-wide proxy is never overridden");
  b = fakeBackend({ NO_PROXY: 'intranet.corp' });
  e = new AppEnv({ backend: b });
  t.ok(e.applySync(url) === 'changed' && b.get('NO_PROXY') === 'intranet.corp', "the user's own NO_PROXY is kept");
  e.clearSync();
  t.ok(b.get('NO_PROXY') === 'intranet.corp' && b.env.size === 1, '…and still there after removal');
  b = fakeBackend();
  e = new AppEnv({ backend: b });
  e.applySync(url);
  b.set('HTTPS_PROXY', 'http://user.choice:3128');
  e.clearSync();
  t.ok(b.get('HTTPS_PROXY') === 'http://user.choice:3128' && !b.get(AppEnv.MARK), 'a value the user put in after us survives removal');
  t.ok(new AppEnv({ backend: fakeBackend() }).applySync(url) === 'changed', 'a fresh session can be set');
  let threw = false; try { new AppEnv({ backend: fakeBackend() }).applySync('http://evil.example:1'); } catch { threw = true; }
  t.ok(threw, 'only a loopback address is ever written');

  // crash recovery: the state file, and a dead owner
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-appenv-'));
  const stateFile = path.join(dir, 'app-env.json');
  b = fakeBackend();
  new AppEnv({ backend: b, stateFile }).applySync(url);
  t.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).url === url, 'state file written while set');
  // The login hook is its own process; the Shroudly that set the value is
  // another one, still running (this test's parent stands in for it).
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, pid: process.ppid, url }));
  t.ok(AppEnv.recoverSync({ backend: b, stateFile }, { onlyIfDead: true }) === false && b.get('HTTPS_PROXY') === url, 'login hook leaves it while its Shroudly runs');
  // After a power cut: the old pid may belong to some other process now, but
  // a state file from an earlier boot is never "still running".
  new AppEnv({ backend: b, stateFile }).applySync(url);
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, pid: process.ppid, boot: 1, url }));
  t.ok(AppEnv.recoverSync({ backend: b, stateFile }, { onlyIfDead: true }) === true && b.env.size === 0, 'login hook after a power cut: removed, even if the old pid is in use again');
  {
    // The clock moved since (NTP at login, set by hand): the boot's own name
    // says it is still this boot, and the running Shroudly keeps its value;
    // another boot's name is a restart, whatever the clock says.
    const Boot = require(path.join(ROOT, 'electron', 'boot.js'));
    Boot._setReader(() => 'boot-A');
    try {
      new AppEnv({ backend: b, stateFile }).applySync(url);
      t.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).bootKey === 'boot-A', "the state file names this boot");
      fs.writeFileSync(stateFile, JSON.stringify({ v: 1, pid: process.ppid, boot: 1, bootKey: 'boot-A', url }));
      t.ok(AppEnv.recoverSync({ backend: b, stateFile }, { onlyIfDead: true }) === false && b.get('HTTPS_PROXY') === url, 'login hook after the clock moved: this boot by its name, its Shroudly still runs, the value stays');
      fs.writeFileSync(stateFile, JSON.stringify({ v: 1, pid: process.ppid, boot: Math.round((Date.now() - os.uptime() * 1000) / 60000), bootKey: 'boot-B', url }));
      t.ok(AppEnv.recoverSync({ backend: b, stateFile }, { onlyIfDead: true }) === true && b.env.size === 0, 'another boot by its name: removed, however close the times');
    } finally { Boot._setReader(null); }
    // Windows: the same last-shutdown name over a power cut; the record made
    // further into a boot than this one has gone is from an earlier boot.
    Boot._setReader(() => 'shutdown-01D9AB', () => 600);
    try {
      new AppEnv({ backend: b, stateFile }).applySync(url);
      t.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).uptime === 600, 'the state file keeps how long the computer had been up');
      fs.writeFileSync(stateFile, JSON.stringify({ v: 1, pid: process.ppid, bootKey: 'shutdown-01D9AB', uptime: 7200, url }));
      t.ok(AppEnv.recoverSync({ backend: b, stateFile }, { onlyIfDead: true }) === true && b.env.size === 0, 'Windows, a power cut since (same shutdown time, less uptime now): removed');
    } finally { Boot._setReader(null); }
  }
  new AppEnv({ backend: b, stateFile }).applySync(url);
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, pid: 2147483646, url }));
  t.ok(AppEnv.recoverSync({ backend: b, stateFile }, { onlyIfDead: true }) === true && b.env.size === 0 && !fs.existsSync(stateFile), 'removed once the Shroudly that set it is gone');
  fs.rmSync(dir, { recursive: true, force: true });

  // the uninstaller removes exactly these values
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8');
  t.ok(nsh.includes(`"${AppEnv.MARK}"`) && nsh.includes(`"${AppEnv.NO_PROXY_VALUE}"`), 'installer.nsh removes the same mark and NO_PROXY value');

  // ── environment, for real (CI machines only: it changes the session) ──
  if (process.env.CI && AppEnv.supported()) {
    const realUrl = 'http://127.0.0.1:1';
    const real = new AppEnv({});
    const before = AppEnv.backend().get('HTTPS_PROXY');
    if (before) {
      console.log(`  --  real session already has HTTPS_PROXY (${before}); only the refusal is checked`);
      t.ok(real.applySync(realUrl) === 'foreign', `real ${process.platform} session: existing proxy left alone`);
    } else {
      t.ok(real.applySync(realUrl) === 'changed' && AppEnv.backend().get('HTTPS_PROXY') === realUrl, `real ${process.platform} session: HTTPS_PROXY set`);
      t.ok(real.clearSync() === 'changed' && !AppEnv.backend().get('HTTPS_PROXY') && !AppEnv.backend().get(AppEnv.MARK), `real ${process.platform} session: removed again`);
    }
  }

  // ── a crash: the watchdog puts the session back (CI machines only) ──
  if (process.env.CI && AppEnv.supported() && !AppEnv.backend().get('HTTPS_PROXY')) {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-wd-'));
    const sf = path.join(dir2, 'app-env.json');
    // The watchdog as Shroudly runs it: the engine binary in its watchdog
    // mode, which starts the restore Shroudly itself runs with
    // --restore-proxy (here the same two calls, run by node).
    const restore = `const p=require('path'),E=${JSON.stringify(path.join(ROOT, 'electron'))};
      try{require(p.join(E,'system-proxy.js')).recoverSync({stateFile:${JSON.stringify(path.join(dir2, 'none.json'))}})}catch{}
      try{require(p.join(E,'app-env.js')).recoverSync({stateFile:${JSON.stringify(sf)}},{onlyIfDead:true})}catch{}`;
    const wd = { core: enginePath(), restore: { exe: process.execPath, args: ['-e', restore] } };
    const code = `const AppEnv=require(${JSON.stringify(path.join(ROOT, 'electron', 'app-env.js'))});
      new AppEnv({stateFile:${JSON.stringify(sf)},watchdog:${JSON.stringify(wd)}}).applySync('http://127.0.0.1:1');
      console.log('READY'); setInterval(()=>{},1000);`;
    const app = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => app.stdout.on('data', (d) => { if (String(d).includes('READY')) r(); }));
    t.ok(AppEnv.backend().get('HTTPS_PROXY') === 'http://127.0.0.1:1', 'crash test: the mode is on in the real session');
    const t0 = Date.now();
    app.kill('SIGKILL');
    while (Date.now() - t0 < 15000 && (AppEnv.backend().get('HTTPS_PROXY') || fs.existsSync(sf))) await sleep(100);
    const took = Date.now() - t0;
    const be = AppEnv.backend();
    t.ok(!be.get('HTTPS_PROXY') && !be.get(AppEnv.MARK) && !fs.existsSync(sf), `crash test: killed outright, everything put back within ${took} ms (engine watchdog)`);

    // The same single watchdog also looks after the system proxy's state.
    // (A state file from another system, so nothing real is changed: it is
    // just cleared, which is what shows the watchdog acted on it. GitHub's
    // machines only: clearing also removes the login hook of a Shroudly
    // installed on the machine running the tests.)
    if (process.env.GITHUB_ACTIONS) {
    const pf = path.join(dir2, 'proxy-state.json');
    fs.writeFileSync(pf, JSON.stringify({ v: 1, platform: 'elsewhere', port: 1, snapshot: {} }));
    const code2 = `const W=require(${JSON.stringify(path.join(ROOT, 'electron', 'watchdog.js'))});
      W.watch({execPath:process.execPath,script:${JSON.stringify(path.join(ROOT, 'electron', 'proxy-watchdog.js'))}},'proxy',${JSON.stringify(pf)});
      console.log('READY'); setInterval(()=>{},1000);`;
    const app2 = require('child_process').spawn(process.execPath, ['-e', code2], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => app2.stdout.on('data', (d) => { if (String(d).includes('READY')) r(); }));
    await sleep(300);
    app2.kill('SIGKILL');
    const t1 = Date.now();
    while (Date.now() - t1 < 15000 && fs.existsSync(pf)) await sleep(100);
    t.ok(!fs.existsSync(pf), `crash test: the system proxy's state is handled by the fallback watchdog too (${Date.now() - t1} ms)`);
    }
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // ── the proxy, end to end ──
  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'tlsrec(sni+1)', '--auto', '--doh']);
  let engineOn = true;
  const proxy = new AppProxy(() => {}, () => (engineOn ? P : null));
  const port = await proxy.start(await freePort());
  t.ok(proxy.url === `http://127.0.0.1:${port}`, 'proxy listens on loopback');
  t.ok((await raw(port, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n')).startsWith('HTTP/1.1 405'), 'plain requests refused (tunnels only)');
  t.ok((await raw(port, 'CONNECT bad!host:443 HTTP/1.1\r\n\r\n')).startsWith('HTTP/1.1 400'), 'bad CONNECT target refused');
  t.ok((await raw(port, 'CONNECT bad^host:443 HTTP/1.1\r\n\r\n')).startsWith('HTTP/1.1 400'), 'unparseable request refused');

  for (const host of ['www.wikipedia.org', 'clientsettingscdn.roblox.com']) {
    const s0 = await eng.stats();
    const r = await getWithRetry(port, host);
    const s1 = await eng.stats();
    t.ok(r.tunnel === 200 && r.status >= 200 && r.status < 500, `[engine] ${host} over HTTPS (HTTP ${r.status})`);
    t.ok(s1 && s0 && s1.conns_total > s0.conns_total && s1.tls > s0.tls, `[engine] ${host} went through the engine (its TLS handshake seen and desynced)`);
  }

  // This machine is never reachable through it.
  const echo = net.createServer((c) => c.pipe(c)).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  t.ok((await raw(port, `CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\n\r\nping`)).startsWith('HTTP/1.1 403'), 'a tunnel to a service on this machine is refused');
  echo.close();

  // curl, reading HTTPS_PROXY from its environment the way Roblox does
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  if (spawnSync(curl, ['--version']).status === 0) {
    const s2 = await eng.stats();
    // Not spawnSync: the proxy runs in this process and has to answer curl.
    const env = { ...process.env, NO_PROXY: AppEnv.NO_PROXY_VALUE };
    for (const k of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(k)) delete env[k];
    env[process.platform === 'win32' ? 'HTTPS_PROXY' : 'https_proxy'] = proxy.url;
    const code = await new Promise((resolve) => execFile(curl, ['-sS', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code}', '--max-time', '25', 'https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer'],
    { env, windowsHide: true }, (err, out) => resolve(String(out || '').trim())));
    const s3 = await eng.stats();
    t.ok(code === '200' && s3.conns_total > s2.conns_total && s3.tls > s2.tls, `curl with only HTTPS_PROXY set reaches Roblox through the engine (HTTP ${code})`);
  }

  // The real Roblox installer on Windows (CI machines only): the program that
  // fails with "Continue installation without flag settings from
  // clientsettingscdn.roblox.com" when the network filters Roblox. Started
  // with the proxy in its environment, as programs started after the mode is
  // turned on are, every connection it makes must go through Shroudly.
  if (process.platform === 'win32' && process.env.CI) await robloxInstaller(proxy, P);

  engineOn = false;
  const d = await getWithRetry(port, 'www.wikipedia.org');
  t.ok(d.tunnel === 200 && d.status >= 200 && d.status < 500, `[direct] protection off: still works (HTTP ${d.status})`);

  // Protection on its way up (at login): a program's first connection waits
  // for the engine instead of going out directly and failing.
  engineOn = false;
  let waited = 0;
  proxy.waitForEngine = async () => { const t0 = Date.now(); await sleep(800); engineOn = true; waited = Date.now() - t0; };
  const vias = [];
  proxy.onTunnel = (h, via) => vias.push(via);
  const w = await getWithRetry(port, 'www.wikipedia.org');
  t.ok(w.tunnel === 200 && waited >= 700 && vias[0] === 'engine', `[waits] a connection made while the engine is starting goes through it once it is up (via ${vias[0]})`);
  proxy.waitForEngine = null;
  proxy.onTunnel = null;

  // The engine restarting after a crash and not back within the wait: what
  // would go into it is held back (an error the program retries), never sent
  // straight out, where a filtering network fails it (a name its DNS does
  // not answer, a download cut). With protection off, straight out as ever.
  {
    engineOn = false;
    let due = true;
    proxy.engineDue = () => due;
    proxy.waitForEngine = async () => {};
    const held = [];
    proxy.onTunnel = (h, via) => held.push(via);
    const r1 = await raw(port, 'CONNECT www.wikipedia.org:443 HTTP/1.1\r\n\r\n');
    const r2 = await raw(port, 'CONNECT 185.15.59.224:443 HTTP/1.1\r\n\r\n');
    t.ok(r1.startsWith('HTTP/1.1 502') && r2.startsWith('HTTP/1.1 502') && !held.length,
      `[restart] a name and a public address while the engine is still restarting: held back, not sent directly (${r1.split('\r\n')[0]}; ${r2.split('\r\n')[0]})`);
    due = false;
    const r3 = await getWithRetry(port, 'www.wikipedia.org');
    t.ok(r3.tunnel === 200 && held[0] === 'direct', `[off] protection off: straight out, as before (via ${held[0]})`);
    proxy.engineDue = () => false;
    proxy.onTunnel = null;
    proxy.waitForEngine = null;
  }

  engineOn = true;
  eng.stop();
  await sleep(300);
  t.ok((await raw(port, 'CONNECT www.wikipedia.org:443 HTTP/1.1\r\n\r\n')).startsWith('HTTP/1.1 502'), 'engine gone: clean 502, proxy keeps running');
  proxy.stop();
  t.ok(!proxy.running && (await raw(port, 'x')) === '', 'stops cleanly');
  console.log(`apps: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
