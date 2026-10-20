'use strict';

/* The Windows Advanced mode engine on the real packet path (WinDivert, as
 * Administrator; CI's Windows runners are). There is no filter to get past
 * here, so this checks the other half: with the engine changing every
 * outgoing first request (decoy, then the real one cut in pieces), ordinary
 * HTTPS and HTTP still load in full, from several servers, the engine reports
 * that it really did act on them, and it stops cleanly, leaving the network as
 * it was.
 *
 * Each site gets up to three tries, a second apart. A server only a few hops
 * away (a CDN edge) can be reached by the decoy itself and fail that one
 * handshake; the engine then learns to send it no decoy (raw_stats counts
 * that as decoy_hurt, and the flows after it as nodecoy), so the next try
 * loads.
 *
 * UDP: the kernel filter must test payloads (raw_ready udp_match 1). A STUN
 * Binding request to a public STUN server and Discord's IP discovery request
 * (to an address of the documentation range, which nothing answers) each get
 * their decoys, and the STUN server still answers the real request; the
 * datagrams of a call (RTP) and QUIC short headers sent meanwhile never reach
 * the engine: its raw_stats count only the requests (udp_seen), the decoys
 * (udp_decoys) and the QUIC Initial it dropped (quic_dropped).
 *
 *   node tests/lab/advanced-windows.js electron/tools/core/win32-x64/shroudly-core-adv.exe
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { buildAdvancedArgs } = require(path.join(__dirname, '..', '..', 'electron', 'advanced-mode.js'));
const Udp = require('./lab-udp');

const engine = path.resolve(process.argv[2] || '');
let fails = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, ms = 15000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'shroudly-lab', connection: 'close' }, agent: false }, (res) => {
      let n = 0;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, complete: res.complete }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.setTimeout(ms, () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

const SITES = ['https://example.com/', 'https://www.cloudflare.com/cdn-cgi/trace', 'https://github.com/', 'https://www.wikipedia.org/', 'http://example.com/'];

const STUN = { host: 'stun.l.google.com', port: 19302 };
const NOWHERE = '192.0.2.10';   // documentation range: routed out, answered by nobody
const RTP_COUNT = 40;
const SHORT_COUNT = 10;

/* Whether the STUN server answers a Binding request (up to three tries, each
 * from a socket of its own). Resolves the number of requests sent too. */
async function stunAnswered() {
  let sent = 0;
  for (let i = 0; i < 3; i++) {
    const r = await Udp.send(STUN.host, STUN.port, 'stun', 1, 2000);
    sent += r.sent;
    if (r.answered) return { answered: true, sent };
  }
  return { answered: false, sent };
}

const TRIES = 3;
const loaded = (r) => !r.error && r.status < 500 && r.complete && r.bytes > 0;
const describe = (r) => r.error || `${r.status}, complete=${r.complete}, ${r.bytes} bytes`;

async function loadAll(label) {
  for (const u of SITES) {
    let r;
    const missed = [];
    for (let i = 0; i < TRIES; i++) {
      if (i) await sleep(1000);
      r = await get(u);
      if (loaded(r)) break;
      missed.push(describe(r));
    }
    const note = missed.length ? ` (after ${missed.length} failed: ${missed.join('; ')})` : '';
    if (loaded(r)) ok(`${label}: ${u} -> ${r.status}, ${r.bytes} bytes${note}`);
    else bad(`${label}: ${u} -> ${describe(r)}${note}`);
  }
}

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') { console.log('advanced-windows: skipped (Windows x64 only)'); return; }
  if (!fs.existsSync(engine)) { bad(`no engine at ${engine}`); process.exit(1); }
  for (const f of ['WinDivert.dll', 'WinDivert64.sys']) {
    if (!fs.existsSync(path.join(path.dirname(engine), f))) { bad(`${f} missing next to the engine`); process.exit(1); }
  }

  await loadAll('before');
  const stunBefore = await stunAnswered();
  console.log(`  ..  the STUN server ${stunBefore.answered ? 'answers' : 'does not answer'} without the engine`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-adv-'));
  const status = path.join(dir, 'status.log');
  const args = buildAdvancedArgs({ fakeTtl: 4, statusFile: status, parentPid: process.pid, platform: 'win32' });
  const child = spawn(engine, args, { stdio: 'ignore', windowsHide: true });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const read = () => { try { return fs.readFileSync(status, 'utf8'); } catch { return ''; } };
  for (let i = 0; i < 150 && !/"raw_ready"/.test(read()) && exited === null; i++) await sleep(100);
  const ready = (read().match(/\{"type":"raw_ready"[^\n]*\}/) || [])[0];
  if (ready) ok(`engine up: ${ready}`);
  else { bad(`engine did not come up (exit ${exited}): ${read().slice(-600)}`); process.exit(1); }

  await loadAll('engine on');

  // UDP while the engine runs.
  if (/"udp_match":1/.test(ready)) ok('the kernel filter tests UDP payloads (udp_match 1)');
  else bad(`the kernel filter does not test UDP payloads, so a call's datagrams would go through the engine: ${ready}`);
  const stunOn = await stunAnswered();
  if (!stunBefore.answered) ok(`STUN: skipped the answer check (no answer without the engine either); ${stunOn.sent} request(s) sent`);
  else if (stunOn.answered) ok(`STUN: the server still answers the real request (${stunOn.sent} sent)`);
  else bad('STUN: the server answered without the engine, not with it');
  await Udp.send(NOWHERE, 50003, 'discovery', 1);
  const rtp = await Udp.send(NOWHERE, 50003, 'rtp', RTP_COUNT);
  const short = await Udp.send(NOWHERE, 443, 'quic-short', SHORT_COUNT);
  await Udp.send(NOWHERE, 443, 'quic-initial', 1);
  console.log(`  ..  sent ${rtp.sent} RTP datagrams and ${short.sent} QUIC short headers to ${NOWHERE}`);

  fs.writeFileSync(`${status}.stop`, '');
  for (let i = 0; i < 100 && exited === null; i++) await sleep(100);
  if (exited !== null) ok(`engine stopped by its stop file (exit ${exited})`);
  else { bad('engine did not stop within 10 s'); child.kill(); }

  const stats = (read().match(/\{"type":"raw_stats"[^\n]*\}/g) || []).pop();
  console.log(`raw_stats: ${stats || '(none)'}`);
  if (stats) {
    const s = JSON.parse(stats);
    const acted = Number(s.desynced ?? s.desync ?? 0);
    if (acted > 0) ok(`the engine acted on the requests: ${stats}`);
    else bad(`the engine reports it acted on nothing: ${stats}`);
    // Two flows (the STUN requests, the discovery request), six decoys each.
    if (Number(s.udp_decoys) >= 12) ok(`decoys went ahead of the STUN and discovery requests (udp_decoys ${s.udp_decoys})`);
    else bad(`udp_decoys is ${s.udp_decoys}, expected at least 12`);
    if (Number(s.quic_dropped) >= 1) ok(`the QUIC Initial was dropped (quic_dropped ${s.quic_dropped})`);
    else bad(`quic_dropped is ${s.quic_dropped}`);
    // Handed over: the STUN requests, the discovery request and the QUIC
    // Initial (and any QUIC long header another program sent meanwhile).
    if (Number(s.udp_seen) < RTP_COUNT) ok(`the engine was handed ${s.udp_seen} UDP datagrams: the ${RTP_COUNT} RTP and ${SHORT_COUNT} short headers stayed in the kernel`);
    else bad(`the engine was handed ${s.udp_seen} UDP datagrams: a call's datagrams went through it`);
  } else {
    bad('no raw_stats line when the engine stopped');
  }

  await loadAll('after stop');
  fs.rmSync(dir, { recursive: true, force: true });
  if (fails) { console.log(`advanced-windows: ${fails} failed`); process.exit(1); }
  console.log('advanced-windows: all passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
