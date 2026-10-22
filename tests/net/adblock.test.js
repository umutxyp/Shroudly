'use strict';

/* "Block ads and trackers": the engine blocks the names of the list and
 * nothing else (core/src/adblock.c, unit-tested in core/test/test_adblock.c);
 * the app fetches the list through the engine, has the engine check it, and
 * puts it to use without a restart (electron/adblock.js, engine-manager.js). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const net = require('net');
const https = require('https');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');
const { AdblockList, cleanAllow, dechunk } = require('../../electron/adblock');

const t = suite('adblock');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-adblock-'));

/* A hosts list like the real one: enough names for ADBLOCK-CHECK, the ones
 * every ad list lists, and a site that must never be taken. */
function hostsList(n = 12000) {
  const lines = ['# test list', '0.0.0.0 doubleclick.net', '0.0.0.0 googlesyndication.com', '0.0.0.0 ads.example-tracker.net'];
  for (let i = 0; i < n; i++) lines.push(`0.0.0.0 ad${i}.tracker-test-${i % 97}.com`);
  return lines.join('\n') + '\n';
}

/* What the engine does with a TLS connection to name through its SOCKS port:
 * 'alert' when it ends it itself (a fatal TLS alert), or 'pong' when it
 * reached the local server at port. */
async function tlsVia(socksPort, name, target, port) {
  const raw = await socks(socksPort, target, port);
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: name, ca: testServerOptions().cert, checkServerIdentity: () => undefined }, () => s.write('ping'));
    s.on('data', (d) => { if (String(d).includes('pong')) { s.end(); resolve('pong'); } });
    s.on('error', (e) => resolve(/alert|unrecognized_name|ECONNRESET|socket hang up/i.test(e.message) ? 'alert' : `error: ${e.message}`));
    s.on('close', () => resolve('closed'));
    setTimeout(() => { s.destroy(); resolve('timeout'); }, 5000);
  });
}

(async () => {
  // ── the app's side, without an engine ──
  t.ok(JSON.stringify(cleanAllow(['WWW.Example.com', '*.ads.org', 'https://x.io/path', 'bad', 'a b.com', 'x.io:443', 'Example.com.']))
    === '["www.example.com","ads.org","x.io","example.com"]', 'exceptions: domains only, cleaned, without repeats');
  t.ok(dechunk(Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n')).toString() === 'hello world', 'a chunked body is read whole');
  let threw = false;
  try { dechunk(Buffer.from('5\r\nhel')); } catch { threw = true; }
  t.ok(threw, 'a cut chunked body is refused, not taken for a list');

  // ── the engine blocks listed names and only those ──
  const srv = tls.createServer(testServerOptions(), (c) => { c.on('data', () => c.write('pong')); c.on('error', () => {}); });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, hostsList());

  const P = await freePort();
  const eng = await startEngine(P, ['--adblock', listFile, '--allow', 'allowed.tracker-test-1.com']);
  try {
    await sleep(300);
    const use = eng.out.split('\n').find((l) => l.includes('"type":"adblock"'));
    t.ok(use && JSON.parse(use).on === true && JSON.parse(use).entries > 12000, `the list is read at start (${use})`);
    t.ok(!eng.out.includes(listFile), 'the engine never prints the list\'s path');

    // A listed name, asked by name: ended inside the engine with a TLS alert,
    // after a successful proxy step (a browser must not take it for a broken
    // proxy and go around Shroudly).
    t.ok(await tlsVia(P, 'ads.example-tracker.net', 'ads.example-tracker.net', 443) === 'alert', 'a listed name is ended inside the engine (TLS alert)');
    t.ok(await tlsVia(P, 'x.doubleclick.net', 'x.doubleclick.net', 443) === 'alert', 'a name under a listed one is ended too');
    // A connection by address whose server name is listed: ended as well.
    t.ok(await tlsVia(P, 'doubleclick.net', '127.0.0.1', port) === 'alert', 'a connection by address naming a listed site in its ClientHello is ended');
    // Not listed, or allowed by the user: through as ever.
    t.ok(await tlsVia(P, 'www.example.com', '127.0.0.1', port) === 'pong', 'a name not on the list goes through');
    t.ok(await tlsVia(P, 'allowed.tracker-test-1.com', '127.0.0.1', port) === 'pong', 'a name the user allowed goes through');
    const st = await eng.stats();
    t.ok(st && st.blocked === 3, `the blocked count is in the stats (${st && st.blocked})`);

    // Off, live: nothing blocked any more.
    eng.proc.stdin.write('ADBLOCK OFF\n');
    await sleep(200);
    t.ok(await tlsVia(P, 'doubleclick.net', '127.0.0.1', port) === 'pong', 'ADBLOCK OFF: nothing is blocked, no restart');
    eng.proc.stdin.write(`ADBLOCK ${listFile}\n`);
    await sleep(300);
    t.ok(await tlsVia(P, 'doubleclick.net', '127.0.0.1', port) === 'alert', 'ADBLOCK <list>: blocking again, no restart');

    // A downloaded file the engine is asked about: a short one is not a list.
    const small = path.join(dir, 'small.txt');
    fs.writeFileSync(small, '0.0.0.0 doubleclick.net\n');
    const before = eng.out.length;
    eng.proc.stdin.write(`ADBLOCK-CHECK ${small}\n`);
    await sleep(300);
    const chk = eng.out.slice(before).split('\n').find((l) => l.includes('adblock_check'));
    t.ok(chk && JSON.parse(chk).ok === false, `ADBLOCK-CHECK turns down a list that is too short (${chk})`);
    const before2 = eng.out.length;
    eng.proc.stdin.write(`ADBLOCK-CHECK ${listFile}\n`);
    await sleep(300);
    const chk2 = eng.out.slice(before2).split('\n').find((l) => l.includes('adblock_check'));
    t.ok(chk2 && JSON.parse(chk2).ok === true, `ADBLOCK-CHECK takes a real list (${chk2})`);
  } finally { eng.stop(); }

  // ── the list fetched through the engine, from a local "GitHub" ──
  const body = hostsList();
  const web = https.createServer(testServerOptions(), (req, res) => {
    if (req.url === '/list') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(body); }
    else if (req.url === '/chunked') { res.writeHead(200, { 'Transfer-Encoding': 'chunked' }); res.write(body.slice(0, 1000)); res.end(body.slice(1000)); }
    else { res.writeHead(404); res.end('Not Found'); }
  });
  const wport = await freePort();
  await new Promise((r) => web.listen(wport, '127.0.0.1', r));
  const P2 = await freePort();
  const eng2 = await startEngine(P2, []);
  try {
    // connect: through the engine's SOCKS port, to the local server.
    const connect = (sp) => socks(sp, '127.0.0.1', wport);
    const tlsOpts = { ca: testServerOptions().cert, checkServerIdentity: () => undefined };
    let now = 1e12;
    const lists = path.join(dir, 'fetch');
    const al = new AdblockList({ dir: lists, connect, now: () => now, source: { host: 'localhost', path: '/list' }, tls: tlsOpts });
    t.ok(!al.has() && al.due(), 'no list yet: due');
    const tmp = await al.fetch(P2);
    t.ok(fs.readFileSync(tmp, 'utf8') === body, 'the list arrives whole through the engine');
    al.adopt(tmp);
    t.ok(al.has() && !al.due(), 'adopted: in use, not due again');
    now = fs.statSync(al.file).mtimeMs + 7 * 24 * 3600 * 1000 + 1;
    t.ok(al.due(), 'a week later it is due again');
    const alc = new AdblockList({ dir: path.join(dir, 'c'), connect, now: () => now, source: { host: 'localhost', path: '/chunked' }, tls: tlsOpts });
    t.ok(fs.readFileSync(await alc.fetch(P2), 'utf8') === body, 'a chunked answer arrives whole too');
    const al404 = new AdblockList({ dir: path.join(dir, 'n'), connect, now: () => now, source: { host: 'localhost', path: '/nope' }, tls: tlsOpts });
    let err = '';
    try { await al404.fetch(P2); } catch (e) { err = e.message; }
    t.ok(/HTTP 404/.test(err) && !al404.has(), `an error page is no list, and nothing changes (${err})`);
    t.ok(!al404.due(), 'after a failure it waits half an hour before trying again');
  } finally { eng2.stop(); web.close(); }

  // ── EngineManager: the switch, the exceptions and the list reach the engine ──
  const EngineManager = require('../../electron/engine-manager');
  const store = { store: { adBlock: true, adBlockAllow: ['Example.com', 'nope'] }, get(k, d) { return k in this.store ? this.store[k] : d; }, set(k, v) { this.store[k] = v; } };
  const em = new EngineManager(store, { adblockFile: () => listFile });
  const args = em._args(em._settings());
  const at = args.indexOf('--adblock');
  t.ok(at !== -1 && args[at + 1] === listFile && args.join(' ').includes('--allow example.com') && !args.includes('nope'), 'on, with a list: --adblock and the cleaned exceptions');
  store.store.adBlock = false;
  t.ok(!em._args(em._settings()).includes('--adblock'), 'off: no --adblock');
  store.store.adBlock = true;
  const none = new EngineManager(store, { adblockFile: () => null });
  t.ok(!none._args(none._settings()).includes('--adblock'), 'on but no list fetched yet: nothing to block yet, no --adblock');
  const sent = [];
  em.proc = { stdin: { writable: true, write: (l) => sent.push(l.trim()) } };
  em.adblockApply();
  t.ok(JSON.stringify(sent) === JSON.stringify(['ALLOW-CLEAR', 'ALLOW example.com', `ADBLOCK ${listFile}`]), `turned on or exceptions changed: told to the running engine (${sent.join(' | ')})`);
  sent.length = 0; store.store.adBlock = false;
  em.adblockApply();
  t.ok(JSON.stringify(sent) === '["ADBLOCK OFF"]', 'turned off: ADBLOCK OFF, no restart');

  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`adblock: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
