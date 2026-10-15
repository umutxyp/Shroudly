'use strict';

/* Real browsers and the system's own HTTP clients, pointed at Shroudly the
 * way the app does it (electron/system-proxy.js applies its PAC to this
 * machine's real setting), with a logging SOCKS server standing in for the
 * engine. For each client: did the page load, did it come through the proxy,
 * and with which SOCKS version and which name or address.
 *
 * Hard checks are the ones every user depends on: Chromium browsers (Edge,
 * Chrome) reach a routed site through SOCKS5 with the name, the setting is
 * gone after a restore, and a PAC nobody answers (Shroudly not running) lets
 * the browser go direct instead of cutting it off. The rest is reported for
 * reading in the log: programs that cannot speak SOCKS5 at all.
 *
 * Changes this machine's proxy setting while it runs: CI only. */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const SystemProxy = require('../../electron/system-proxy');

if (!process.env.CI) { console.log('browsers.test.js changes the system proxy; run in CI only (CI=1).'); process.exit(0); }

const TARGET = 'example.com';
const URL_ = `https://${TARGET}/`;
const seen = [];
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

/* SOCKS4, 4a and 5, forwarding for real, every request logged. */
function socksServer() {
  return net.createServer((c) => {
    let buf = Buffer.alloc(0);
    let stage = 'hello';
    c.on('error', () => {});
    const go = (host, port, ver, reply) => {
      seen.push({ ver, host, port, at: Date.now() });
      const up = net.connect(port, host, () => { c.write(reply(true)); if (buf.length) up.write(buf); buf = Buffer.alloc(0); up.pipe(c); c.pipe(up); });
      up.on('error', () => { try { c.end(reply(false)); } catch {} });
    };
    c.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (stage === 'hello') {
        if (buf[0] === 4) {
          const z = buf.indexOf(0, 8);
          if (z < 0) return;
          const port = buf.readUInt16BE(2);
          let host = [...buf.slice(4, 8)].join('.');
          let end = z + 1;
          let ver = 'socks4';
          if (buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && buf[7] !== 0) {
            const z2 = buf.indexOf(0, end);
            if (z2 < 0) return;
            host = buf.slice(end, z2).toString();
            end = z2 + 1;
            ver = 'socks4a';
          }
          buf = buf.slice(end);
          stage = 'done';
          c.removeListener('data', onData);
          go(host, port, ver, (good) => Buffer.from([0, good ? 0x5a : 0x5b, 0, 0, 0, 0, 0, 0]));
          return;
        }
        if (buf[0] !== 5) { seen.push({ ver: `not-socks:${buf[0]}`, host: '', port: 0, at: Date.now() }); c.destroy(); return; }
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.slice(2 + buf[1]);
        c.write(Buffer.from([5, 0]));
        stage = 'req';
      }
      if (stage === 'req') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host; let off;
        if (atyp === 1) { if (buf.length < 10) return; host = [...buf.slice(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const n = buf[4]; if (buf.length < 5 + n + 2) return; host = buf.slice(5, 5 + n).toString(); off = 5 + n; }
        else if (atyp === 4) { if (buf.length < 22) return; host = buf.slice(4, 20).toString('hex').match(/.{4}/g).join(':'); off = 20; }
        else { c.destroy(); return; }
        const port = buf.readUInt16BE(off);
        buf = buf.slice(off + 2);
        stage = 'done';
        c.removeListener('data', onData);
        go(host, port, atyp === 3 ? 'socks5-name' : 'socks5-ip', (good) => Buffer.from([5, good ? 0 : 1, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  });
}

function run(cmd, args, { timeoutMs = 60000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20, env: env || process.env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ err: err ? (err.killed ? 'timeout' : String(err.code || err.message).slice(0, 80)) : null, out: String(stdout || ''), errOut: String(stderr || '') });
    });
  });
}
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromium(name, exe, extra = []) {
  return {
    name, chromium: true, available: exists(exe),
    run: async (env) => {
      const r = await run(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${tmp('cr')}`, ...extra, '--dump-dom', URL_], { timeoutMs: 60000, env });
      return /Example Domain/.test(r.out) ? 'OK' : `FAIL ${r.err || ''} ${(r.errOut.match(/net::ERR_\w+/) || [''])[0]}`.trim();
    },
  };
}
function firefox(exe) {
  return {
    name: 'firefox', available: exists(exe),
    run: async (env) => {
      const dir = tmp('ff');
      const shot = path.join(dir, 'shot.png');
      // A new profile follows the system proxy (network.proxy.type 5).
      const r = await run(exe, ['-headless', '-no-remote', '-profile', dir, '--screenshot', shot, URL_], { timeoutMs: 90000, env: { ...(env || process.env), MOZ_HEADLESS: '1' } });
      return exists(shot) && fs.statSync(shot).size > 1000 ? 'OK' : `FAIL ${r.err || ''}`.trim();
    },
  };
}
function ps(name, exe, script) {
  return {
    name, available: true,
    run: async () => {
      const r = await run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 60000 });
      return (r.out.trim().split(/\r?\n/).pop() || r.err || r.errOut.trim().split(/\r?\n/)[0] || '?').slice(0, 160);
    },
  };
}

async function measure(label, client, env) {
  const from = Date.now();
  let result;
  try { result = await client.run(env); } catch (e) { result = `EXC ${e.message}`; }
  const via = [...new Set(seen.filter((s) => s.at >= from).map((s) => `${s.ver}:${s.host}:${s.port}`))];
  console.log(`  [${label}] ${client.name}: ${result} | ${via.join(' ') || 'direct'}`);
  return { result, via, loaded: /^OK/.test(result), named: via.includes(`socks5-name:${TARGET}:443`) };
}

function clients() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      chromium('edge', [path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')].find(exists)),
      chromium('chrome', path.join(pf, 'Google\\Chrome\\Application\\chrome.exe')),
      firefox(path.join(pf, 'Mozilla Firefox\\firefox.exe')),
      ps('powershell 5 (.NET Framework)', 'powershell.exe', `$u=[Uri]'${URL_}'; try { $p=[System.Net.WebRequest]::GetSystemWebProxy().GetProxy($u) } catch { $p='?' }; try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 25 $u; "OK $($r.StatusCode) proxy=$p" } catch { "ERR $($_.Exception.Message) proxy=$p" }`),
      ps('pwsh 7 (.NET HttpClient)', 'pwsh.exe', `$u=[Uri]'${URL_}'; try { $p=[System.Net.Http.HttpClient]::DefaultProxy.GetProxy($u) } catch { $p='?' }; try { $r = Invoke-WebRequest -TimeoutSec 25 $u; "OK $($r.StatusCode) proxy=$p" } catch { "ERR $($_.Exception.Message) proxy=$p" }`),
      ps('WinINET (MSXML2.XMLHTTP)', 'powershell.exe', `try { $x = New-Object -ComObject MSXML2.XMLHTTP.6.0; $x.open('GET','${URL_}',$false); $x.send(); "OK $($x.status)" } catch { "ERR $($_.Exception.Message)" }`),
      ps('BITS', 'powershell.exe', `try { $d = Join-Path $env:TEMP ('b' + [guid]::NewGuid() + '.html'); Start-BitsTransfer -Source '${URL_}' -Destination $d -ErrorAction Stop; "OK $((Get-Item $d).Length) bytes" } catch { "ERR $($_.Exception.Message)" }`),
    ];
  }
  if (process.platform === 'darwin') {
    return [chromium('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), firefox('/Applications/Firefox.app/Contents/MacOS/firefox')];
  }
  return [
    chromium('chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(exists), ['--no-sandbox']),
    firefox(['/usr/bin/firefox', '/usr/lib/firefox/firefox'].find(exists)),
  ];
}

async function main() {
  const socks = socksServer();
  await new Promise((r) => socks.listen(0, '127.0.0.1', r));
  const port = socks.address().port;
  const dir = tmp('sp');
  const proxy = new SystemProxy((level, msg) => console.log(`  (${level}) ${msg}`), { stateFile: path.join(dir, 'proxy-state.json') });
  const list = clients().filter((c) => c.available);
  console.log(`clients here: ${list.map((c) => c.name).join(', ') || 'none'}`);

  const status = await proxy.apply(port, 'listed', [TARGET]);
  console.log(`apply: ${JSON.stringify(status)}`);
  if (process.platform === 'win32') ok(status.ok, 'the system proxy is set on Windows');
  // A CI Mac may refuse the change without a password, as a Standard account
  // would; that path has its own tests. Nothing to measure then.
  if (process.platform === 'darwin' && !status.ok) {
    console.log(`system proxy not set here (${status.code}); browser checks skipped`);
    await proxy.restore();
    socks.close();
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
    return;
  }
  await sleep(2000);

  if (process.platform === 'linux') {
    // GNOME's setting where the runner has it, and the variable that Chromium
    // reads on desktops without a system proxy (XFCE, LXQt).
    const clean = { ...process.env };
    for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'auto_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) delete clean[k];
    const gnomeSet = (await run('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'], { timeoutMs: 8000 })).out.includes(proxy.pacUrl);
    console.log(`gsettings points at our PAC: ${gnomeSet}`);
    for (const c of list) {
      const env = await measure('XFCE with auto_proxy', c, { ...clean, XDG_CURRENT_DESKTOP: 'XFCE', DESKTOP_SESSION: 'xfce', auto_proxy: proxy.pacUrl });
      if (c.chromium) ok(env.loaded && env.named, `${c.name} on XFCE with auto_proxy loads through SOCKS5 with the name`);
      if (gnomeSet) {
        const g = await measure('GNOME', c, { ...clean, XDG_CURRENT_DESKTOP: 'GNOME', DESKTOP_SESSION: 'gnome' });
        if (c.chromium) ok(g.loaded && g.named, `${c.name} on GNOME loads through SOCKS5 with the name`);
        await measure('XFCE, GNOME setting only', c, { ...clean, XDG_CURRENT_DESKTOP: 'XFCE', DESKTOP_SESSION: 'xfce' });
      }
    }
  } else {
    for (const c of list) {
      const m = await measure('applied', c);
      if (c.chromium) ok(m.loaded && m.named, `${c.name} loads ${TARGET} through SOCKS5 with the name`);
    }
  }

  // Shroudly not running: the PAC address answers nobody. A browser must go
  // direct, not lose the internet.
  const pacUrl = proxy.pacUrl;
  proxy.stopPacServer();
  await sleep(1000);
  const crs = list.filter((c) => c.chromium);
  for (const c of crs) {
    const env = process.platform === 'linux' ? { ...process.env, XDG_CURRENT_DESKTOP: 'XFCE', auto_proxy: pacUrl } : undefined;
    const m = await measure('PAC server gone', c, env);
    ok(m.loaded && !m.via.length, `${c.name} goes direct when the PAC cannot be fetched`);
  }

  const restored = await proxy.restore();
  ok(restored !== false, 'restore() reports success');
  if (process.platform === 'win32') {
    const q = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'AutoConfigURL'], { timeoutMs: 8000 });
    ok(!q.out.includes(pacUrl), 'the PAC address is gone from the Windows setting');
  } else if (process.platform === 'darwin') {
    const q = await run('scutil', ['--proxy'], { timeoutMs: 8000 });
    ok(!q.out.includes(pacUrl), 'the PAC address is gone from the macOS setting');
  } else {
    const q = await run('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'], { timeoutMs: 8000 });
    const m = await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], { timeoutMs: 8000 });
    ok(!(q.out.includes(pacUrl) && m.out.includes('auto')), 'GNOME no longer points at the PAC');
  }

  socks.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}

main().catch((e) => { console.log(`FAIL ${e.stack}`); process.exit(1); });
