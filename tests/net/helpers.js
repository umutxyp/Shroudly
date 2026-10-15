'use strict';

/* Shared by the network tests: where the engine is, how to start it, and a
 * tiny SOCKS5 client so the tests need nothing installed (no curl). */

const path = require('path');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures');

function enginePath() {
  if (process.env.SHROUDLY_ENGINE) return process.env.SHROUDLY_ENGINE;
  const bin = process.platform === 'win32' ? 'shroudly-core.exe' : 'shroudly-core';
  return path.join(ROOT, 'electron', 'tools', 'core', `${process.platform}-${process.arch}`, bin);
}

/* Start the engine; resolves once it says it is listening. stdin stays open
 * (the engine stops when it closes, by design). */
function startEngine(port, extra = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(enginePath(), ['--listen', '127.0.0.1', '--port', String(port), ...extra], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ASAN_OPTIONS: 'halt_on_error=1:detect_leaks=0', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
    });
    const eng = { proc: p, out: '', err: '', exited: null };
    p.stdout.on('data', (d) => { eng.out += d; if (eng.out.includes('"ready"')) resolve(eng); });
    p.stderr.on('data', (d) => { eng.err += d; });
    p.on('exit', (c, s) => { eng.exited = c ?? s; reject(new Error(`engine exited (${c ?? s}): ${eng.err.slice(0, 500)}`)); });
    p.on('error', reject);
    setTimeout(() => reject(new Error('engine did not start')), 10000);
    eng.stats = async () => {
      const before = eng.out.length;
      p.stdin.write('STATS\n');
      await sleep(300);
      const line = eng.out.slice(before).split('\n').find((l) => l.includes('"stats"'));
      return line ? JSON.parse(line) : null;
    };
    eng.stop = () => { try { p.stdin.end(); } catch {} try { p.kill(); } catch {} };
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* A port nothing is listening on right now. Fixed ports make tests flaky on
 * machines whose ephemeral range is wide (servers often use 15000-65535). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/* SOCKS5 CONNECT to host:port (IPv4 literal or name) through the engine. */
function socks(socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort, '127.0.0.1');
    let st = 0; let b = Buffer.alloc(0);
    s.once('error', reject);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    const on = (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) {
        b = b.subarray(2); st = 1;
        const v4 = net.isIPv4(host);
        const addr = v4 ? Buffer.from([1, ...host.split('.').map(Number)]) : Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host)]);
        s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
      }
      if (st === 1 && b.length >= 10) {
        s.removeListener('data', on);
        if (b[1] !== 0) { s.destroy(); reject(new Error(`SOCKS reply ${b[1]}`)); return; }
        resolve(s);
      }
    };
    s.on('data', on);
  });
}

/* SOCKS4 CONNECT through the engine: an IPv4 literal is plain SOCKS4, a name
 * is SOCKS4a (0.0.0.1 plus the name, resolved by the engine). Rejects with
 * the reply code when the engine does not grant it. cmd 2 asks for BIND. */
function socks4(socksPort, host, port, { cmd = 1, user = 'shroudly-test' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort, '127.0.0.1');
    let b = Buffer.alloc(0);
    s.once('error', reject);
    s.on('connect', () => {
      const v4 = net.isIPv4(host);
      const ip = v4 ? host.split('.').map(Number) : [0, 0, 0, 1];
      s.write(Buffer.concat([
        Buffer.from([4, cmd, port >> 8, port & 255, ...ip]), Buffer.from(user), Buffer.from([0]),
        v4 ? Buffer.alloc(0) : Buffer.concat([Buffer.from(host), Buffer.from([0])]),
      ]));
    });
    const on = (d) => {
      b = Buffer.concat([b, d]);
      if (b.length < 8) return;
      s.removeListener('data', on);
      if (b[0] !== 0 || b[1] !== 0x5a) { s.destroy(); reject(new Error(`SOCKS4 reply ${b[1]}`)); return; }
      if (b.length > 8) s.unshift(b.subarray(8));
      resolve(s);
    };
    s.on('data', on);
    s.on('close', () => reject(new Error('SOCKS4: closed before a reply')));
  });
}

/* A DNS server on 127.0.0.1 that answers from a table, standing in for the
 * app's encrypted-DNS forwarder (the engine's --doh-port), so tests can give a
 * name exactly the addresses they need. table: { name: { A: [...], AAAA:
 * [...], ttl } }; a name not in it gets NXDOMAIN, a type it lacks an empty
 * answer. Counts the questions it is asked, per "name/type". */
function ip6Bytes(a) {
  let v4 = null;
  const m = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { v4 = m[2].split('.').map(Number); a = `${m[1]}0:0`; }
  const [h, t] = a.split('::');
  const head = h ? h.split(':') : []; const tail = t !== undefined && t ? t.split(':') : [];
  const groups = t === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  if (v4) out.set(v4, 12);
  return out;
}
function dnsStub(table) {
  const dgram = require('dgram');
  const sock = dgram.createSocket('udp4');
  const asked = {};
  sock.on('message', (q, from) => {
    if (q.length < 17) return;
    let p = 12; const labels = [];
    while (p < q.length && q[p]) { labels.push(q.subarray(p + 1, p + 1 + q[p]).toString()); p += 1 + q[p]; }
    const qend = p + 5; const name = labels.join('.').toLowerCase(); const type = q.readUInt16BE(p + 1) === 28 ? 'AAAA' : 'A';
    asked[`${name}/${type}`] = (asked[`${name}/${type}`] || 0) + 1;
    const e = table[name];
    const addrs = (e && e[type]) || [];
    const head = Buffer.from(q.subarray(0, 12));
    head[2] = 0x81; head[3] = e ? 0x80 : 0x83;            // response; NXDOMAIN when unknown
    head.writeUInt16BE(1, 4); head.writeUInt16BE(addrs.length, 6); head.writeUInt32BE(0, 8);
    const ans = addrs.map((a) => {
      const rd = type === 'A' ? Buffer.from(a.split('.').map(Number)) : ip6Bytes(a);
      const r = Buffer.alloc(12); r.writeUInt16BE(0xc00c, 0); r.writeUInt16BE(type === 'A' ? 1 : 28, 2);
      r.writeUInt16BE(1, 4); r.writeUInt32BE((e && e.ttl) || 60, 6); r.writeUInt16BE(rd.length, 10);
      return Buffer.concat([r, rd]);
    });
    sock.send(Buffer.concat([head, q.subarray(12, qend), ...ans]), from.port, from.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve({
    port: sock.address().port, asked, close: () => sock.close(),
  })));
}

/* GET https://host/ through the engine; resolves { status, bytes }. A real
 * site on the real internet can be slow for a moment, which says nothing
 * about the engine: one retry before calling it a failure. */
async function getViaEngine(socksPort, host, timeoutMs = 20000) {
  const first = await getOnce(socksPort, host, timeoutMs);
  if (first.status >= 200 && first.status < 400) return first;
  return getOnce(socksPort, host, timeoutMs);
}

async function getOnce(socksPort, host, timeoutMs) {
  let raw;
  try { raw = await socks(socksPort, host, 443); } catch { return { status: 0, bytes: 0 }; }
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'] });
    let head = ''; let bytes = 0; let status = 0;
    const done = () => { s.destroy(); resolve({ status, bytes }); };
    s.on('secureConnect', () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0 shroudly-test\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { bytes += d.length; if (!status) { head += d.toString('latin1'); const m = head.match(/^HTTP\/1\.[01] (\d{3})/); if (m) status = Number(m[1]); } });
    s.on('end', done); s.on('error', done);
    setTimeout(done, timeoutMs);
  });
}

function fixture(name) { return fs.readFileSync(path.join(FIX, name)); }

/* For the fake censors: follows the client's side of a TLS 1.3 connection
 * and returns true once the request itself has gone out — the second
 * encrypted record, the first being the client's Finished. Counting bytes
 * instead would depend on the size of the ClientHello, which changes between
 * Node and OpenSSL versions (373 bytes on Node 20, about 1.5 KB on Node 24). */
function requestWatcher() {
  let buf = Buffer.alloc(0); let appRecords = 0;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt16BE(3);
      if (buf.length < 5 + len) break;
      if (buf[0] === 0x17) appRecords++;
      buf = buf.subarray(5 + len);
    }
    return appRecords >= 2;
  };
}

/* The local TLS servers the censor tests stand in front of: TLS 1.3 only,
 * so requestWatcher's view of the handshake always holds. */
function testServerOptions() {
  return { key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem'), minVersion: 'TLSv1.3' };
}

/* Minimal assertions with a running count, so every test prints what it proved. */
function suite(name) {
  let n = 0;
  return {
    ok(cond, msg) { if (!cond) throw new Error(`${name}: ${msg}`); n++; console.log(`  ok  ${msg}`); },
    get count() { return n; },
  };
}

module.exports = { ROOT, enginePath, startEngine, sleep, freePort, socks, socks4, dnsStub, getViaEngine, fixture, requestWatcher, testServerOptions, suite };
