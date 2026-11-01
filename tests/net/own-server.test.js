'use strict';

/* "Your own server" end to end, with the real engine (the system proxy
 * stubbed out): the link in the settings reaches the engine as its file
 * (--upstream-file, only this user may read it), sites go through the
 * server by name, a Shadowsocks link goes through Shroudly's own client on
 * this computer, a server that does not work is told in the log and the
 * window, and the file and the client go with the engine. And the wiring:
 * the setting, its test and the notice, from main.js to the window. */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const H = require('./helpers');

const EngineManager = require(path.join(H.ROOT, 'electron', 'engine-manager.js'));
const SS = require(path.join(H.ROOT, 'electron', 'shadowsocks.js'));
const Own = require(path.join(H.ROOT, 'electron', 'own-server.js'));
const t = H.suite('own-server');
const src = (rel) => fs.readFileSync(path.join(H.ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const listening = (s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)));

async function fetchVia(port, host, tport) {
  let s;
  try { s = await H.socks(port, host, tport); } catch { return 'refused'; }
  return new Promise((resolve) => {
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out.split('\r\n')[0]));
    s.on('error', () => resolve('error'));
    s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => s.destroy(), 8000);
  });
}

/* What a SOCKS5 server on `port` picks for a greeting that offers no
 * password (0: none needed, 0xff: refused), or -1 for no answer. */
function socksMethodWithout(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
    s.once('data', (d) => { resolve(d.length >= 2 ? d[1] : -1); s.destroy(); });
    s.on('error', () => resolve(-1));
    s.on('close', () => resolve(-1));
    setTimeout(() => { s.destroy(); resolve(-1); }, 3000);
  });
}

(async () => {
  const web = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')); }).listen(0, '127.0.0.1');
  await listening(web);
  const sitePort = web.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-own-'));
  const P = await H.freePort();
  const mem = { listenPort: P, autoMode: true, dnsProtection: false };
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, delete: (k) => { delete mem[k]; }, get store() { return mem; } };
  const logs = [];
  const em = new EngineManager(store, { addLog: (l, m) => logs.push(`${l}: ${m}`), dataDir: dir });
  em.proxy = { apply: async () => {}, restore: async () => {}, cleanupSync() {}, restoreSync() {} };
  const file = path.join(dir, 'own-server.txt');

  // SOCKS5 with a password: the file, the engine started with it, sites by name.
  const up = H.socksServer(sitePort, { user: 'ali', pass: 'p@ss' });
  await listening(up);
  mem.ownServer = `socks5://ali:p%40ss@127.0.0.1:${up.address().port}`;
  await em.start();
  const mode = process.platform === 'win32' ? 0o600 : fs.statSync(file).mode & 0o777;
  t.ok(fs.readFileSync(file, 'utf8') === `socks5://ali:p@ss@127.0.0.1:${up.address().port}\n` && mode === 0o600
    && logs.some((l) => l.includes(`--upstream-file ${file}`)),
  `the link reaches the engine as its file, readable by this user alone (mode ${mode.toString(8)})`);
  t.ok(!logs.some((l) => l.includes('p@ss')), 'the password is in no log line');
  const first = await fetchVia(P, 'blocked.example', 443);
  t.ok(first === 'HTTP/1.1 200 OK' && up.asked.some((a) => a.host === 'blocked.example' && a.atyp === 3), `a site goes through the server, asked by name (${first})`);
  await em.stop();
  t.ok(!fs.existsSync(file), 'stopped: the file is gone');

  // Shadowsocks: Shroudly's own client in between.
  const ss = await SS.startServer({ host: '127.0.0.1', method: 'chacha20-ietf-poly1305', password: 'friends', dial: (h, p) => new Promise((res, rej) => { const s = net.connect(sitePort, '127.0.0.1', () => res(s)); s.once('error', rej); }) });
  mem.ownServer = Own.ssLink({ method: 'chacha20-ietf-poly1305', password: 'friends', host: '127.0.0.1', port: ss.port });
  await em.start();
  const line = fs.readFileSync(file, 'utf8');
  const local = em._ssClient && em._ssClient.port;
  t.ok(local && new RegExp(`^socks5://[0-9a-f]{16}:[0-9a-f]{32}@127\\.0\\.0\\.1:${local}\n$`).test(line),
    'a Shadowsocks link: the engine is pointed at Shroudly\'s client on this computer, with a password only it was given');
  t.ok(await socksMethodWithout(local) === 0xff, 'another program without that password cannot use the server through the client');
  t.ok(await fetchVia(P, 'any.example', 443) === 'HTTP/1.1 200 OK' && ss.stats().total >= 1, 'a site goes through the Shadowsocks server');
  // The same link kept through a restart, another one replaces the client.
  await em.restart();
  const kept = em._ssClient && em._ssClient.port === local;
  mem.ownServer = Own.ssLink({ method: 'aes-256-gcm', password: 'other', host: '127.0.0.1', port: ss.port });
  await em.restart();
  t.ok(kept && em._ssClient && em._ssClient.port !== local, 'a restart keeps the client for the same server, and replaces it for another');
  await em.stop();
  t.ok(!em._ssClient && !fs.existsSync(file), 'stopped: the client and the file are gone');
  await ss.close();

  // A server that does not answer: refused, told in the log and the window.
  const dead = await H.freePort();
  mem.ownServer = `socks5://127.0.0.1:${dead}`;
  await em.start();
  const r = await fetchVia(P, 'x.example', 443);
  await H.sleep(300);
  const down = em.advice.ownServerDown;
  t.ok(r !== 'HTTP/1.1 200 OK' && down && down.why === 'noAnswer' && down.server === `SOCKS5 127.0.0.1:${dead}`
    && logs.some((l) => l === `warning: Your own server (SOCKS5 127.0.0.1:${dead}) could not be used: does not answer`),
  `a server that does not answer: told in the window and the log (${JSON.stringify(down)})`);
  await em.stop();
  t.ok(em.advice.ownServerDown === null, 'and no longer once protection stops');

  // None: no file, no flag.
  delete mem.ownServer;
  await em.start();
  t.ok(!fs.existsSync(file) && !em._args(em._settings()).includes('--upstream-file'), 'no server set: the engine runs as it always has');
  await em.stop();
  t.ok((await em.testOwnServer('ftp://x')).invalid === 'format' && (await em.testOwnServer(`ss://${Buffer.from('rc4-md5:x').toString('base64')}@h:1`)).method === 'rc4-md5',
    'the test of a link that cannot be read: why, without trying it');

  // The wiring.
  const main = src('electron/main.js');
  const pre = src('electron/preload.js');
  const settings = src('components/SettingsPanel.js');
  const panel = src('components/ControlPanel.js');
  t.ok(/if \(key === 'ownServer'\) return setOwnServer\(value\);/.test(main) && /function setOwnServer[\s\S]{0,900}scheduleEngineRestart\(\)/.test(main)
    && /ipcMain\.handle\('ownserver:test'[^\n]*engine\.testOwnServer\(link\)/.test(main) && /dataDir: app\.getPath\('userData'\)/.test(main)
    && /ownServerDown: \(engine && engine\.isActive\(\) && engine\.advice && engine\.advice\.ownServerDown\) \|\| null/.test(main),
  'main.js: the setting restarts the engine, the test, the file\'s folder and the notice');
  t.ok(/testOwnServer: \(link\) => ipcRenderer\.invoke\('ownserver:test', link\)/.test(pre)
    && /<OwnServer value=\{settings\.ownServer\} onSave=\{\(v\) => save\('ownServer', v\)\} \/>/.test(settings) && /window\.electron\.testOwnServer\(v\)/.test(settings)
    && /ownServerDown \? t\('ownServerDown'\)/.test(panel) && /t\('ownServerDownBody'/.test(panel),
  'the window: Settings tests then saves, the status says when the server does not work');

  web.close(); up.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`own-server: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
