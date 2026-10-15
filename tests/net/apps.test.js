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
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 },
    (err, out) => resolve(String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))));
}

/* What Shroudly's own "Install Roblox" does (electron/roblox-app.js): the
 * current version asked of Roblox and its installer downloaded through the
 * engine, its Roblox Corporation signature checked, then started with the
 * setting. Then a minute of watching that the installer, and the player it
 * installs, go through Shroudly and nothing goes around it. */
async function robloxInstaller(proxy, socksPort) {
  const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
  const { socksConnect } = require(path.join(ROOT, 'electron', 'discord-relay.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-roblox-'));
  const before = proxy.tunnels;
  const roblox = new Set();
  proxy.onTunnel = (host) => { if (RobloxApp.isRobloxHost(host)) roblox.add(host); };
  const r = await RobloxApp.install({ socksPort, connect: socksConnect, dir, env: { HTTPS_PROXY: proxy.url, NO_PROXY: AppEnv.NO_PROXY_VALUE } });
  if (!r.success && r.code === 'unreachable') {
    console.log(`  --  Roblox installer not downloadable here (${r.detail}); skipped`);
    return;
  }
  t.ok(r.success, `Install Roblox: current installer (${r.version}) downloaded through the engine, signed by Roblox, started (${r.code || 'ok'})`);
  if (!r.success) return;
  // A minute of watching, whatever the machine's speed.
  const direct = new Set();
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    await sleep(3000);
    for (const c of await robloxDirect()) direct.add(c);
  }
  spawnSync('taskkill', ['/F', '/T', '/IM', 'RobloxPlayerInstaller.exe']);
  spawnSync('taskkill', ['/F', '/T', '/IM', 'RobloxPlayerBeta.exe']);
  proxy.onTunnel = null;
  const through = proxy.tunnels - before;
  if (direct.size) console.log(`  !!  direct: ${[...direct].slice(0, 8).join(', ')}`);
  t.ok(through > 0 && direct.size === 0, `real Roblox installer: ${through} connections through Shroudly, ${direct.size} around it`);
  t.ok(roblox.size > 0, `Shroudly can tell they are Roblox's (${[...roblox].slice(0, 4).join(', ')})`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
  t.ok(RobloxApp.parsePids('INFO: No tasks are running which match the specified criteria.\r\n', 'win32').length === 0 && JSON.stringify(RobloxApp.parsePids('812\n913\n', 'darwin')) === '[812,913]', 'none running; macOS pgrep output read');
  t.ok(RobloxApp.routeWatched('win32') && !RobloxApp.routeWatched('darwin') && !RobloxApp.routeWatched('linux'), 'a player going around Shroudly is only looked for on Windows (macOS hands every app the setting)');
  {
    const seen = new Map();
    const T = 1e9;
    const H = 3600 * 1000;
    // Player 10 made its requests as it started, then kept its connections.
    t.ok(RobloxApp.silentPlayers(seen, [10], T - 5000, T).length === 0 && RobloxApp.silentPlayers(seen, [10], T - 5000, T + 2 * H).length === 0, 'a player that sent requests at start is never reported, however long it then runs');
    // Player 20 appears an hour later and sends nothing.
    RobloxApp.silentPlayers(seen, [10, 20], T - 5000, T + H);
    t.ok(RobloxApp.silentPlayers(seen, [10, 20], T - 5000, T + H + 10000).length === 0, 'a new player gets its grace period');
    t.ok(JSON.stringify(RobloxApp.silentPlayers(seen, [10, 20], T - 5000, T + H + RobloxApp.BYPASS_GRACE_MS + 1000)) === '[20]', 'after it, only the new silent player is reported, not the one that uses Shroudly');
    RobloxApp.silentPlayers(seen, [10], T - 5000, T + H + 60000);
    t.ok(RobloxApp.silentPlayers(seen, [10], T - 5000, T + H + 120000).length === 0 && seen.size === 1, 'players coming and going never restart the clock of one that stays');
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

  engineOn = true;
  eng.stop();
  await sleep(300);
  t.ok((await raw(port, 'CONNECT www.wikipedia.org:443 HTTP/1.1\r\n\r\n')).startsWith('HTTP/1.1 502'), 'engine gone: clean 502, proxy keeps running');
  proxy.stop();
  t.ok(!proxy.running && (await raw(port, 'x')) === '', 'stops cleanly');
  console.log(`apps: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
