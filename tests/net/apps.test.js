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
const { ROOT, startEngine, freePort, sleep, suite } = require('./helpers');

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

function download(url, file) {
  return new Promise((resolve, reject) => {
    require('https').get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(file);
      res.pipe(out); out.on('finish', () => out.close(resolve)); out.on('error', reject);
    }).on('error', reject);
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

async function robloxInstaller(proxy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-roblox-'));
  const exe = path.join(dir, 'RobloxPlayerInstaller.exe');
  try {
    const fetchInstaller = async () => {
      const v = await new Promise((resolve, reject) => require('https').get('https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer', (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b).clientVersionUpload); } catch (e) { reject(e); } });
      }).on('error', reject));
      await download(`https://setup.rbxcdn.com/${v}-RobloxPlayerInstaller.exe`, exe);
    };
    await Promise.race([fetchInstaller(), sleep(60000).then(() => { throw new Error('download took over a minute'); })]);
  } catch (e) {
    console.log(`  --  Roblox installer not downloadable here (${e.message}); skipped`);
    return;
  }
  const before = proxy.tunnels;
  const env = { ...process.env, NO_PROXY: AppEnv.NO_PROXY_VALUE };
  for (const k of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(k)) delete env[k];
  env.HTTPS_PROXY = proxy.url;
  const child = require('child_process').spawn(exe, [], { env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  // A minute of watching, whatever the machine's speed.
  const direct = new Set();
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    await sleep(3000);
    for (const c of await robloxDirect()) direct.add(c);
  }
  spawnSync('taskkill', ['/F', '/T', '/IM', 'RobloxPlayerInstaller.exe']);
  spawnSync('taskkill', ['/F', '/T', '/IM', 'RobloxPlayerBeta.exe']);
  const through = proxy.tunnels - before;
  if (direct.size) console.log(`  !!  direct: ${[...direct].slice(0, 8).join(', ')}`);
  t.ok(through > 0 && direct.size === 0, `real Roblox installer: ${through} connections through Shroudly, ${direct.size} around it`);
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
      'public.example': ['93.184.216.34'], 'mixed.example': ['10.0.0.5', '93.184.216.34'], 'v6corp.example': ['fd12::1'] };
    p.lookup = async (h) => answers[h] || null;
    const r = async (h) => { p.decisions.clear(); return p.route(h); };
    t.ok((await r('127.0.0.1')) === 'refuse' && (await r('::1')) === 'refuse' && (await r('localhost')) === 'refuse' && (await r('169.254.169.254')) === 'refuse' && (await r('::ffff:127.0.0.1')) === 'refuse', 'refused: this machine, link-local (cloud metadata), however written');
    t.ok((await r('192.168.1.10')) === 'direct' && (await r('nas')) === 'direct' && (await r('printer.local')) === 'direct', 'direct: the local network');
    t.ok((await r('git.corp.example')) === 'direct' && (await r('v6corp.example')) === 'direct', "direct: a name this machine's DNS puts on a private network (an internal server, never asked of public DNS)");
    t.ok((await r('blocked.example')) === 'engine', "engine: a private answer that is a known block page (Iran's 10.10.34.34)");
    t.ok((await r('www.roblox.com')) === 'engine' && (await r('public.example')) === 'engine' && (await r('mixed.example')) === 'engine' && (await r('nowhere.example')) === 'engine', 'engine: public names, forged answers, and names local DNS does not know');
    listed = ['roblox.com'];
    t.ok((await r('www.roblox.com')) === 'engine' && (await r('public.example')) === 'direct', 'only listed sites: listed ones through the engine, the rest direct');
    listed = null; on = false;
    t.ok((await r('public.example')) === 'direct' && (await r('127.0.0.1')) === 'refuse', 'protection off: direct (and still never to this machine)');
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
    const code = `const AppEnv=require(${JSON.stringify(path.join(ROOT, 'electron', 'app-env.js'))});
      new AppEnv({stateFile:${JSON.stringify(sf)},watchdog:{execPath:process.execPath,script:${JSON.stringify(path.join(ROOT, 'electron', 'proxy-watchdog.js'))}}}).applySync('http://127.0.0.1:1');
      console.log('READY'); setInterval(()=>{},1000);`;
    const app = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => app.stdout.on('data', (d) => { if (String(d).includes('READY')) r(); }));
    t.ok(AppEnv.backend().get('HTTPS_PROXY') === 'http://127.0.0.1:1', 'crash test: the mode is on in the real session');
    const t0 = Date.now();
    app.kill('SIGKILL');
    while (Date.now() - t0 < 15000 && (AppEnv.backend().get('HTTPS_PROXY') || fs.existsSync(sf))) await sleep(100);
    const took = Date.now() - t0;
    const be = AppEnv.backend();
    t.ok(!be.get('HTTPS_PROXY') && !be.get(AppEnv.MARK) && !fs.existsSync(sf), `crash test: killed outright, everything put back within ${took} ms`);

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
    t.ok(!fs.existsSync(pf), `crash test: the system proxy's state is handled by the same watchdog (${Date.now() - t1} ms)`);
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
  if (process.platform === 'win32' && process.env.CI) await robloxInstaller(proxy);

  engineOn = false;
  const d = await getWithRetry(port, 'www.wikipedia.org');
  t.ok(d.tunnel === 200 && d.status >= 200 && d.status < 500, `[direct] protection off: still works (HTTP ${d.status})`);

  engineOn = true;
  eng.stop();
  await sleep(300);
  t.ok((await raw(port, 'CONNECT www.wikipedia.org:443 HTTP/1.1\r\n\r\n')).startsWith('HTTP/1.1 502'), 'engine gone: clean 502, proxy keeps running');
  proxy.stop();
  t.ok(!proxy.running && (await raw(port, 'x')) === '', 'stops cleanly');
  console.log(`apps: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
