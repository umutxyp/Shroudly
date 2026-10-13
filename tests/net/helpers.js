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

/* GET https://host/ through the engine; resolves { status, bytes }. */
async function getViaEngine(socksPort, host, timeoutMs = 20000) {
  const raw = await socks(socksPort, host, 443);
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

/* Minimal assertions with a running count, so every test prints what it proved. */
function suite(name) {
  let n = 0;
  return {
    ok(cond, msg) { if (!cond) throw new Error(`${name}: ${msg}`); n++; console.log(`  ok  ${msg}`); },
    get count() { return n; },
  };
}

module.exports = { ROOT, enginePath, startEngine, sleep, socks, getViaEngine, fixture, suite };
