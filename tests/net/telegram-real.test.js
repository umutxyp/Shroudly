'use strict';

/* Telegram, for real, the way its desktop app reaches it through Shroudly:
 *  - the PAC Shroudly sets as the system proxy sends a Telegram data centre's
 *    address to the engine, in both routing modes (Telegram Desktop's default
 *    connection type is "use system proxy", which reads that PAC on Windows
 *    and macOS);
 *  - the engine carries MTProto to a real data centre: the obfuscated
 *    opening and req_pq_multi, answered by resPQ with our nonce;
 *  - with each raw technique forced, the real server still gets exactly
 *    what the app sent (it answers resPQ), so none of them can break an app;
 *  - behind a filter that resets MTProto by its first bytes (local, in front
 *    of the real data centre), the app's next connections get through, and
 *    the engine says so once;
 *  - over IPv6 too, where this computer has it.
 * Needs the internet; on a runner that cannot reach Telegram at all, it says
 * so and checks only the PAC. */

const net = require('net');
const vm = require('vm');
const path = require('path');
const { execFile } = require('child_process');
const { startEngine, sleep, freePort, socks, suite } = require('./helpers');
const SystemProxy = require('../../electron/system-proxy');
const mt = require('./mtproto');

const t = suite('telegram-real');
const DC = '149.154.167.50';            // DC 2
const DC_V6 = '2001:67c:4e8:f002::a';   // DC 2 over IPv6
const lines = (eng, from) => eng.out.slice(from).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function pacFor(mode, port) {
  const sp = new SystemProxy(() => {}, { platform: 'darwin' });
  sp.mode = mode; sp.list = ['example.com'];
  const ip4 = (h) => h.split('.').map(Number);
  const ctx = {
    isPlainHostName: (h) => h.search(/(\.)|:/) === -1,
    shExpMatch: (s, p) => new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(s),
    isInNet: (h, n, m) => { const a = ip4(h), b = ip4(n), c = ip4(m); return a.every((x, i) => (x & c[i]) === (b[i] & c[i])); },
  };
  vm.createContext(ctx);
  vm.runInContext(sp.pacBody(port), ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}:443/`, host);
}

/* Windows: what WinHTTP makes of Shroudly's PAC for a connection to a
 * Telegram data centre, which is exactly what Telegram Desktop (Qt) gets on
 * "use system proxy": Qt asks WinHttpGetProxyForUrl and reads a "socks="
 * entry as SOCKS5 and an untagged one as an HTTP proxy
 * (qtbase/src/network/kernel/qnetworkproxy_win.cpp, parseServerList). */
function winhttpProxyFor(pacUrl, url) {
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class WH {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Opts { public int dwFlags; public int dwAutoDetectFlags; public string lpszAutoConfigUrl; public IntPtr lpvReserved; public int dwReserved; public bool fAutoLogonIfChallenged; }
  [StructLayout(LayoutKind.Sequential)]
  public struct Info { public int dwAccessType; public IntPtr lpszProxy; public IntPtr lpszProxyBypass; }
  [DllImport("winhttp.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr WinHttpOpen(string a, int t, string p, string b, int f);
  [DllImport("winhttp.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool WinHttpGetProxyForUrl(IntPtr h, string u, ref Opts o, out Info i);
  public static string Get(string pac, string url) {
    IntPtr h = WinHttpOpen("shroudly-test", 1, null, null, 0);
    Opts o = new Opts(); o.dwFlags = 2; o.lpszAutoConfigUrl = pac;
    Info i;
    if (!WinHttpGetProxyForUrl(h, url, ref o, out i)) return "ERROR " + Marshal.GetLastWin32Error();
    return i.dwAccessType + " " + Marshal.PtrToStringUni(i.lpszProxy);
  }
}
'@
[WH]::Get('${pacUrl}', '${url}')`;
  const { powershellEnv } = require(path.join(__dirname, '..', '..', 'electron', 'win-powershell.js'));
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, timeout: 30000, env: powershellEnv() }, (err, out, errOut) => resolve(String(out || errOut || err || '').trim())));
}

/* macOS: what CFNetwork makes of the PAC for a URL (Qt on macOS asks it,
 * and reads kCFProxyTypeSOCKS as SOCKS5: qnetworkproxy_darwin.cpp). */
function cfnetworkProxyFor(pacText, url) {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-cf-'));
  fs.writeFileSync(path.join(dir, 'pac.js'), pacText);
  fs.writeFileSync(path.join(dir, 'pac.swift'), `import Foundation
let script = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
var err: Unmanaged<CFError>?
let arr = CFNetworkCopyProxiesForAutoConfigurationScript(script as CFString, URL(string: CommandLine.arguments[2])! as CFURL, &err)?.takeRetainedValue() as? [[String: Any]] ?? []
print(arr.map { "\\($0[kCFProxyTypeKey as String] ?? "") \\($0[kCFProxyHostNameKey as String] ?? ""):\\($0[kCFProxyPortNumberKey as String] ?? "")" }.joined(separator: "; "))
`);
  return new Promise((resolve) => execFile('swift', [path.join(dir, 'pac.swift'), path.join(dir, 'pac.js'), url], { timeout: 180000 },
    (err, out, errOut) => { fs.rmSync(dir, { recursive: true, force: true }); resolve(err ? `error: ${String(errOut || err).slice(0, 200)}` : String(out).trim()); }));
}

function direct(host, port, ms = 8000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: ms });
    s.once('connect', () => mt.telegramHello(s).then(() => resolve(true), () => resolve(false)));
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

async function viaEngine(P, host, port) {
  let s;
  try { s = await socksAny(P, host, port); } catch { return false; }
  try { await mt.telegramHello(s); return true; } catch { return false; }
}

/* An HTTP CONNECT tunnel through the engine's port, then MTProto. */
function viaConnect(P, host, port) {
  return new Promise((resolve) => {
    const s = net.connect(P, '127.0.0.1');
    let b = Buffer.alloc(0);
    s.on('error', () => resolve(false));
    s.on('connect', () => s.write(`CONNECT ${net.isIPv6(host) ? `[${host}]` : host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const on = (d) => {
      b = Buffer.concat([b, d]);
      const end = b.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.removeListener('data', on);
      if (!/^HTTP\/1\.1 200 /.test(b.toString('latin1'))) { s.destroy(); resolve(false); return; }
      mt.telegramHello(s).then(() => resolve(true), () => resolve(false));
    };
    s.on('data', on);
  });
}

/* SOCKS5 CONNECT to an IPv4 or IPv6 literal. */
function socksAny(P, host, port) {
  if (!net.isIPv6(host)) return socks(P, host, port);
  return new Promise((resolve, reject) => {
    const s = net.connect(P, '127.0.0.1');
    let b = Buffer.alloc(0), st = 0;
    s.once('error', reject);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    const on = (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) {
        b = b.subarray(2); st = 1;
        const full = new URL(`http://[${host}]/`).hostname.slice(1, -1);
        const groups = (() => {
          const [h, tl] = full.split('::');
          const a = h ? h.split(':') : [], z = tl !== undefined && tl ? tl.split(':') : [];
          return [...a, ...Array(8 - a.length - z.length).fill('0'), ...z];
        })();
        const addr = Buffer.alloc(16);
        groups.forEach((g, i) => addr.writeUInt16BE(parseInt(g, 16), i * 2));
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 4]), addr, Buffer.from([port >> 8, port & 255])]));
      }
      if (st === 1 && b.length >= 22) {
        s.removeListener('data', on);
        if (b[1] !== 0) { s.destroy(); reject(new Error(`SOCKS reply ${b[1]}`)); return; }
        resolve(s);
      }
    };
    s.on('data', on);
  });
}

(async () => {
  /* 1. the system proxy routes a Telegram address to the engine */
  for (const mode of ['all', 'listed']) {
    const pac = pacFor(mode, 10808);
    t.ok(/^SOCKS5 127\.0\.0\.1:10808; SOCKS 127\.0\.0\.1:10808/.test(pac(DC)), `PAC (${mode}): a Telegram data centre goes through the engine`);
    t.ok(pac('192.168.1.10') === 'DIRECT' && pac('fe80::1') === 'DIRECT', `PAC (${mode}): the local network stays direct`);
  }
  t.ok(/^SOCKS5/.test(pacFor('all', 10808)(DC_V6)), 'PAC (all): a Telegram IPv6 address goes through the engine');
  t.ok(pacFor('listed', 10808)('8.8.8.8') === 'DIRECT', 'PAC (listed): an address of no listed service stays direct');

  if (process.platform === 'darwin') {
    const sp = new SystemProxy(() => {}, { platform: 'darwin' });
    sp.mode = 'all';
    const got = await cfnetworkProxyFor(sp.pacBody(10808), `https://${DC}:443`);
    console.log(`  --  CFNetwork for a Telegram data centre: ${got}`);
    if (/^error/.test(got)) console.log('  --  (no Swift here: CFNetwork not checked)');
    else t.ok(/kCFProxyTypeSOCKS 127\.0\.0\.1:10808/.test(got), 'CFNetwork hands Telegram Desktop (Qt) the engine as a SOCKS proxy');
  }
  if (process.platform === 'win32') {
    /* What WinHTTP makes of PAC answers, each served at an address of its own
     * (WinHTTP keeps a script it downloaded, by address, for a while). */
    const http = require('http');
    const scripts = new Map();
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      res.end(scripts.get(req.url) || 'function FindProxyForURL(u, h) { return "DIRECT"; }');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const ask = async (name, body, url = `https://${DC}:443/`) => {
      const p = `/${name}-${Date.now()}.pac`;
      scripts.set(p, body);
      const got = await winhttpProxyFor(base + p, url);
      console.log(`  --  WinHTTP, ${name}: ${got}`);
      return got;
    };
    const fixed = (ret) => `function FindProxyForURL(url, host) { return "${ret}"; }`;
    await ask('proxy-only', fixed('PROXY 127.0.0.1:10808'));
    await ask('socks-only', fixed('SOCKS 127.0.0.1:10808'));
    await ask('socks5-socks', fixed('SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808'));
    await ask('socks5-socks-proxy', fixed('SOCKS5 127.0.0.1:10808; SOCKS 127.0.0.1:10808; PROXY 127.0.0.1:10808'));
    const sp = new SystemProxy(() => {});
    sp.mode = 'all';
    const got = await ask('shroudly', sp.pacBody(10808));
    const plain = await ask('shroudly-http', sp.pacBody(10808), 'http://neverssl.com/');
    srv.close();
    // 3 = a named proxy: Qt then tunnels through it with CONNECT, which the
    // engine takes on the same port (checked for real below).
    t.ok(/^3 .*127\.0\.0\.1:10808/.test(got), 'WinHTTP hands Telegram Desktop (Qt) the engine as its proxy (not "no proxy")');
    t.ok(!/^3 /.test(plain) || /socks/i.test(plain), 'and plain http:// gets no HTTP proxy from it');
  }


  if (!(await direct(DC, 443))) {
    console.log('  --  Telegram cannot be reached from here at all; the rest needs it');
    console.log(`telegram-real: ${t.count} checks passed (offline part only)`);
    process.exit(0);
  }
  t.ok(true, 'a real data centre answers MTProto directly');

  let P = await freePort();
  let eng = await startEngine(P, ['--auto']);
  try {
    /* 2. through the engine, untouched */
    let from = eng.out.length;
    t.ok(await viaEngine(P, DC, 443), 'through the engine: resPQ from a real data centre');
    t.ok(await viaEngine(P, DC, 80), 'and on its port 80');
    t.ok(await viaConnect(P, DC, 443), 'through the engine as an HTTP proxy (CONNECT, what WinHTTP programs get): resPQ');
    await sleep(200);
    t.ok(!lines(eng, from).some((l) => l.raw), 'and nothing is said about it');

    /* 3. every raw technique, forced: the real server still answers */
    const techniques = ['raw-split1', 'raw-disorder1', 'raw-multisplit', 'raw-disorder32', 'raw-fake'];
    for (const tech of techniques) {
      eng.proc.stdin.write(`LEARN ${DC} ${tech} 0\n`);
      await sleep(150);
      const s0 = await eng.stats();
      const ok = await viaEngine(P, DC, 443);
      const s1 = await eng.stats();
      const applied = s1 && s0 && s1.desync > s0.desync;
      if (tech === 'raw-fake' && process.platform !== 'linux') {
        t.ok(ok, `${tech}: not built here; the connection is answered all the same`);
        continue;
      }
      t.ok(ok && applied, `${tech}: applied, and the real data centre answers resPQ`);
    }

    /* 4. a filter that resets MTProto by its first bytes, in front of the real data centre */
    eng.stop(); await sleep(200);
    P = await freePort();
    eng = await startEngine(P, ['--auto']);
    const filter = mt.censor(443, { mode: 'first', host: DC });
    await new Promise((r) => filter.listen(0, '127.0.0.1', r));
    from = eng.out.length;
    const tries = [];
    // (A filter reading a stream can get two pieces in one read on a busy
    // machine; engine-raw.test.js says more. Hence room for a lost one.)
    for (let i = 0; i < 10 && !tries.includes(true); i++) tries.push(await viaEngine(P, '127.0.0.1', filter.address().port));
    t.ok(tries[0] === false && filter.resets >= 1, 'the filter resets the untouched MTProto opening');
    t.ok(tries.includes(true), `a later connection gets resPQ from the real data centre (after ${tries.indexOf(true)} failed)`);
    await sleep(200);
    const by = lines(eng, from).filter((l) => l.type === 'bypass' && l.raw);
    t.ok(by.length >= 1 && by.every((b) => /^raw-/.test(b.strategy)), `told (${by.map((b) => b.strategy).join(', ')})`);
    const again = [];
    for (let i = 0; i < 3; i++) again.push(await viaEngine(P, '127.0.0.1', filter.address().port));
    t.ok(again.filter(Boolean).length >= 2, `learned: the next connections are answered (${again.filter(Boolean).length} of 3)`);
    filter.close();

    /* 5. IPv6, where there is IPv6 */
    if (await direct(DC_V6, 443, 5000)) {
      t.ok(await viaEngine(P, DC_V6, 443), 'over IPv6 through the engine: resPQ');
    } else {
      console.log('  --  no IPv6 route to Telegram here; IPv6 not checked');
    }
    t.ok(eng.exited === null, 'the engine is still running');
  } finally {
    eng.stop();
  }
  console.log(`telegram-real: ${t.count} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
