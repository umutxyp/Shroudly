'use strict';

/* "Help people in censored countries" (electron/snowflake.js) in the real
 * app, on whatever OS this runs on, driven as a person would (Settings →
 * Server and sharing), against stand-ins for Tor's broker and relay on this
 * computer (main.js, SHROUDLY_E2E with SHROUDLY_SNOWFLAKE_TEST):
 *   - off until turned on; on, it asks the broker for someone to help, as
 *     Tor's own proxy does (version 1.3, its NAT type, Tor's relays only)
 *   - its hidden window: not shown, no Node.js, nothing but the broker and
 *     the relay reachable from it
 *   - a person using Tor (a WebRTC peer in another window of the app) is
 *     matched by the broker: the proxy answers under the poll's session id,
 *     the data channel opens over real WebRTC, and what the person sends
 *     reaches the relay and the relay's answer comes back
 *   - the window counts them (now and since it was turned on), and a local
 *     address is never passed to the relay
 *   - off closes the hidden window and the relay connection; left on, it is
 *     on again at the next start
 *   - screenshots (test-results/): off, waiting, helping, a narrow window,
 *     Persian (right to left)
 *   - on a server ("shroudly --help-others", electron/helper-server.js): no
 *     window at all (on Linux no display either, Chromium's headless
 *     platform), a person helped through it as above, said on its output,
 *     and it stops when told to */

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { _electron } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'test-results');
const tag = `${process.platform}-${process.arch}`;
let count = 0;
const ok = (cond, label) => { if (!cond) throw new Error(`not ok: ${label}`); count++; console.log(`  ok  ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
const lang = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${code}.json`), 'utf8'));
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

/* Tor's Snowflake relay, standing in: a WebSocket server (RFC 6455, enough
 * for this) that answers each message with "relay:" in front. */
function relayStandIn() {
  const conns = [];
  const send = (sock, op, data) => {
    const len = data.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    sock.write(Buffer.concat([head, data]));
  };
  const srv = http.createServer((q, r) => { r.writeHead(426); r.end(); });
  srv.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { url: req.url, got: [], closed: false };
    conns.push(conn);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 0x80;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + len);
        if (op === 8) { conn.closed = true; try { send(sock, 8, Buffer.alloc(0)); } catch {} sock.end(); return; }
        if (op === 9) { send(sock, 10, payload); continue; }
        if (op === 1 || op === 2) { conn.got.push(payload.toString()); send(sock, 2, Buffer.from(`relay:${payload.toString()}`)); }
      }
    });
    sock.on('close', () => { conn.closed = true; });
    sock.on('error', () => {});
  });
  srv.conns = conns;
  return srv;
}

/* Tor's broker, standing in: proxies poll it; the test's person hands it an
 * offer and waits for the answer the proxy sends back. */
function brokerStandIn(relayUrl) {
  const polls = []; const answers = [];
  let pending = null;
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8' };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-headers': '*' }); res.end(); return; }
    if (req.url === '/proxy') {
      let j = null;
      try { j = JSON.parse(body); } catch {}
      polls.push(j);
      if (pending && !pending.sid && j) {
        pending.sid = j.Sid;
        res.writeHead(200, cors);
        res.end(JSON.stringify({ Status: 'client match', Offer: pending.offer, NAT: 'unrestricted', RelayURL: relayUrl, NextPoll: 300 }));
        return;
      }
      setTimeout(() => { res.writeHead(200, cors); res.end(JSON.stringify({ Status: 'no match', NextPoll: 300 })); }, 150);
      return;
    }
    if (req.url === '/answer') {
      let j = null;
      try { j = JSON.parse(body); } catch {}
      answers.push(j);
      if (pending && j && j.Sid === pending.sid) pending.resolve(j.Answer);
      res.writeHead(200, cors); res.end(JSON.stringify({ Status: 'success' }));
      return;
    }
    if (req.url === '/client') {
      const answer = await new Promise((resolve) => { pending = { offer: body, resolve, sid: null }; setTimeout(() => resolve(null), 20000); });
      res.writeHead(200, cors); res.end(JSON.stringify({ Answer: answer }));
      return;
    }
    res.writeHead(404, cors); res.end();
  });
  srv.polls = polls; srv.answers = answers;
  srv.matchedSid = () => (pending ? pending.sid : null);
  return srv;
}

/* A person using Tor: a WebRTC peer that offers, as Tor's Snowflake client
 * does, sends a few bytes when the channel opens and shows what came back. */
const personPage = (broker) => `<!doctype html><meta charset="utf-8"><title>WAIT</title><script>
(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('snowflake');
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => { document.title = 'OPEN'; dc.send(new TextEncoder().encode('hello-from-tor-client')); };
  dc.onmessage = (m) => { document.title = 'GOT:' + new TextDecoder().decode(m.data); };
  window.__pc = pc;
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; setTimeout(r, 5000); });
  const resp = await fetch(${JSON.stringify(broker)} + 'client', { method: 'POST', body: JSON.stringify(pc.localDescription) });
  const { Answer } = await resp.json();
  if (!Answer) { document.title = 'NOANSWER'; return; }
  await pc.setRemoteDescription(JSON.parse(Answer));
})().catch((e) => { document.title = 'ERR:' + e.message; });
</script>`;

async function launch(language, snowflakeTest, extra = {}) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-e2e-snowflake-'));
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    autoMode: false, showNotifications: false, minimizeToTray: true, autoStart: false, language, shareOnlineCount: false,
    storeAppsModeOffAt: Date.now(), ...extra,
  }));
  const env = { ...process.env, SHROUDLY_TRAY: 'present', SHROUDLY_E2E: '1', SHROUDLY_IDLE_RELEASE_MS: String(10 * 60 * 1000), SHROUDLY_SNOWFLAKE_TEST: JSON.stringify(snowflakeTest) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [ROOT, `--user-data-dir=${ud}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env,
    timeout: 60000,
  });
  // The main window: the hidden Snowflake window (left on from before) is
  // not the one to drive.
  const isMain = (w) => !w.isClosed() && /index\.html|^app:|^http:\/\/localhost/.test(w.url()) && !/snowflake[\\/]proxy\.html/.test(w.url());
  let page = await until(() => app.windows().find(isMain), 20000);
  if (!page) {
    const next = app.waitForEvent('window', { predicate: isMain, timeout: 30000 });
    await app.evaluate(({ app: a }) => a.emit('second-instance'));
    page = await next;
  }
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => localStorage.setItem('shroudly_onboarded', '1'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const t = lang(language);
  ok(!!(await until(() => page.getByText(t.navSettings, { exact: true }).first().isVisible(), 20000)), `${language}: the window is up`);
  return { app, page, t, ud };
}

/* Settings → Server and sharing, where the help is. */
async function openMore(page, t) {
  await page.getByText(t.navSettings, { exact: true }).first().click();
  const tab = page.locator('[data-settings-tab="sharing"]');
  await tab.waitFor({ timeout: 10000 });
  for (let i = 0; i < 3; i++) {
    await tab.click();
    if (await until(() => page.getByText(t.snowflake, { exact: true }).first().isVisible(), 3000)) return;
  }
  await page.screenshot({ path: path.join(SHOTS, `snowflake-openmore-failed-${tag}.png`) });
  throw new Error('Server and sharing did not open');
}

/* A person using Tor, in a hidden window of `app`; its page's title once
 * it has an outcome. */
async function person(app, brokerUrl) {
  await app.evaluate(async ({ BrowserWindow, session }, html) => {
    const ses = session.fromPartition('e2e-snowflake-person');
    await ses.setProxy({ mode: 'direct' });
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
    global.__sfPerson = w;
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }, personPage(brokerUrl));
  return until(async () => {
    const ti = await app.evaluate(() => global.__sfPerson.getTitle());
    return /^(GOT:|ERR:|NOANSWER)/.test(ti) ? ti : null;
  }, 30000, 300);
}

const section = (page, title) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

async function shot(locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await sleep(300);
  await locator.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });
}

const hiddenWindow = (app) => app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => /snowflake[\\/]proxy\.html/.test(x.webContents.getURL()));
  if (!w) return null;
  const r = await w.webContents.executeJavaScript(
    "Promise.all([typeof require, typeof process, fetch('https://example.com/', { cache: 'no-store' }).then(() => 'reached', () => 'blocked'), fetch('http://127.0.0.1:9/').then(() => 'reached', () => 'blocked')])");
  return { visible: w.isVisible(), r };
}).catch((e) => ({ error: e.message }));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const relay = relayStandIn();
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const relayUrl = `ws://127.0.0.1:${relay.address().port}/`;
  const broker = brokerStandIn(relayUrl);
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  const brokerUrl = `http://127.0.0.1:${broker.address().port}/`;
  const sfTest = { broker: brokerUrl, relay: relayUrl, relayPattern: '^127.0.0.1', pollMs: 300 };

  let { app, page, t } = await launch('en', sfTest);
  try {
    await openMore(page, t);
    const sf = section(page, t.snowflake);
    const sw = sf.getByRole('switch', { name: t.snowflakeOn });
    ok((await sw.getAttribute('aria-checked')) === 'false' && broker.polls.length === 0 && !(await hiddenWindow(app)), 'off until turned on: no window, nothing asked');
    ok(await sf.getByText(t.snowflakeDesc).isVisible(), 'what it does and costs, said before it is turned on');
    await shot(sf, 'snowflake-off');

    await sw.click();
    ok(!!(await until(() => sf.getByText(t.snowflakeWaiting).isVisible(), 15000)), 'on: waiting for someone to help');
    const p0 = broker.polls.find(Boolean);
    ok(p0 && p0.Version === '1.3' && typeof p0.Sid === 'string' && p0.Sid.length >= 8 && p0.NAT === 'unrestricted' && p0.AcceptedRelayPattern === '^127.0.0.1' && p0.Clients === 0,
      `it polls the broker as Tor's proxy does (${JSON.stringify(p0)})`);
    const sec = await hiddenWindow(app);
    ok(sec && !sec.error && sec.visible === false, 'its window is never shown');
    ok(sec && sec.r && sec.r[0] === 'undefined' && sec.r[1] === 'undefined', 'no Node.js in it');
    ok(sec && sec.r && sec.r[2] === 'blocked' && sec.r[3] === 'blocked', 'nothing but the broker and the relay reachable from it (a site, another local port: blocked)');
    await shot(sf, 'snowflake-waiting');

    // A person using Tor, in another window of the app.
    const title = await person(app, brokerUrl);
    ok(title === 'GOT:relay:hello-from-tor-client', `the person's bytes reach Tor's relay over WebRTC and its answer comes back (${title})`);
    ok(relay.conns.length === 1 && relay.conns[0].got.includes('hello-from-tor-client'), 'the relay got what the person sent');
    ok(!/client_ip=/.test(relay.conns[0].url), `a local address is not passed on to the relay (${relay.conns[0].url})`);
    const ans = broker.answers.filter(Boolean);
    ok(ans.length === 1 && ans[0].Sid === broker.matchedSid() && ans[0].Version === '1.0' && /"type":"answer"/.test(ans[0].Answer),
      'the answer goes back under the poll\'s session id');
    const helping = fill(t.snowflakeCounts, { now: 1, total: 1 });
    const counted = !!(await until(() => sf.getByText(helping).isVisible(), 20000));
    if (!counted) {
      // What the app had, and what the window showed, to tell a slow machine from a wrong count.
      const st = await app.evaluate(() => global.shroudlyE2E.snowflake.status()).catch((e) => ({ error: e.message }));
      console.log(`    (status: ${JSON.stringify(st)}; the section says: ${JSON.stringify(await sf.innerText().catch(() => ''))})`);
    }
    ok(counted, `the window counts them: "${helping}"`);
    await shot(sf, 'snowflake-helping');

    // The person leaves: the pair is closed, the count stays.
    await app.evaluate(() => { global.__sfPerson.destroy(); });
    const after = fill(t.snowflakeCounts, { now: 0, total: 1 });
    ok(!!(await until(() => sf.getByText(after).isVisible(), 40000)), `the person gone: "${after}"`);
    ok(!!(await until(() => relay.conns[0].closed, 10000)), 'and the relay connection closed with them');

    // A narrow window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible()).setSize(360, 800));
    await sleep(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, `a narrow window (360 px): nothing wider than it (${overflow} px over)`);
    await shot(sf, 'snowflake-narrow');

    // Off: the hidden window goes.
    await sw.click();
    ok(!!(await until(async () => !(await hiddenWindow(app)), 10000)), 'off: its window is closed');
    const pollsOff = broker.polls.length;
    await sleep(1500);
    ok(broker.polls.length === pollsOff, 'and the broker is not asked any more');
    ok(!(await sf.getByText(t.snowflakeWaiting).isVisible()), 'the window no longer says it is waiting');
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(30000)]);
  }

  // Left on: on again at the next start (Persian, right to left).
  ({ app, page, t } = await launch('fa', sfTest, { snowflakeOn: true }));
  try {
    await openMore(page, t);
    const sf = section(page, t.snowflake);
    ok(!!(await until(() => sf.getByText(t.snowflakeWaiting).isVisible(), 15000)), 'fa: left on, it is on again at start');
    ok(await page.evaluate(() => document.documentElement.dir) === 'rtl', 'fa: the window is right to left');
    await shot(sf, 'snowflake-fa');
    await sf.getByRole('switch', { name: t.snowflakeOn }).click();
    ok(!!(await until(async () => !(await hiddenWindow(app)), 10000)), 'fa: off again');
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(30000)]);
  }
  // On a server: "--help-others", no window at all; on Linux no display
  // either. A person helped through it, from another Shroudly's window.
  {
    const hd = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-e2e-helper-'));
    const env = { ...process.env, SHROUDLY_E2E: '1', SHROUDLY_SNOWFLAKE_TEST: JSON.stringify(sfTest) };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [ROOT, '--help-others', `--data-dir=${hd}`];
    if (process.platform === 'linux') {
      args.push('--ozone-platform=headless', '--no-sandbox');
      delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
    }
    const child = spawn(require(path.join(ROOT, 'node_modules', 'electron')), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    try {
      ok(!!(await until(() => /helping people in censored countries \(a Snowflake proxy for Tor\)/.test(out), 40000)),
        `server: it starts with no window${process.platform === 'linux' ? ' and no display' : ''}`);
      const before = broker.polls.length;
      ok(!!(await until(() => broker.polls.length > before, 15000)), 'server: it asks the broker for someone to help');
      ({ app, page, t } = await launch('en', sfTest));
      try {
        ok(!(await hiddenWindow(app)), 'the other Shroudly helps no one itself: only the server is asked');
        const conns = relay.conns.length;
        const title2 = await person(app, brokerUrl);
        ok(title2 === 'GOT:relay:hello-from-tor-client', `server: a person's bytes reach Tor's relay through it and the answer comes back (${title2})`);
        ok(relay.conns.length === conns + 1 && relay.conns[conns].got.includes('hello-from-tor-client'), 'server: the relay got what the person sent');
        ok(!!(await until(() => /someone reached Tor through this computer \(1 since/.test(out), 20000)), 'server: says so on its output');
        await app.evaluate(() => { global.__sfPerson.destroy(); });
      } finally {
        await Promise.race([app.close().catch(() => {}), sleep(30000)]);
      }
      child.kill('SIGTERM');
      const end = await Promise.race([exited, sleep(20000).then(() => null)]);
      ok(!!end, `server: it stops when told to (${JSON.stringify(end)})`);
      if (process.platform !== 'win32') ok(/Stopping\./.test(out) && end.code === 0, 'server: on SIGTERM it stops the help and exits cleanly');
    } catch (e) {
      console.log(`    (the server's output:\n${out})`);
      throw e;
    } finally {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  relay.close(); broker.close();
  console.log(`snowflake e2e: ${count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
