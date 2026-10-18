'use strict';

/* The Windows Advanced mode engine on the real packet path (WinDivert, as
 * Administrator; CI's Windows runners are). There is no filter to get past
 * here, so this checks the other half: with the engine changing every
 * outgoing first request (decoy, then the real one cut in pieces), ordinary
 * HTTPS and HTTP still load in full, from several servers, the engine reports
 * that it really did act on them, and it stops cleanly, leaving the network as
 * it was.
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

async function loadAll(label) {
  for (const u of SITES) {
    let r = await get(u);
    // A public site can have a bad moment of its own: one more try.
    if (r.error || r.status >= 500) { await sleep(1000); r = await get(u); }
    if (!r.error && r.status < 500 && r.complete && r.bytes > 0) ok(`${label}: ${u} -> ${r.status}, ${r.bytes} bytes`);
    else bad(`${label}: ${u} -> ${r.error || `${r.status}, complete=${r.complete}, ${r.bytes} bytes`}`);
  }
}

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') { console.log('advanced-windows: skipped (Windows x64 only)'); return; }
  if (!fs.existsSync(engine)) { bad(`no engine at ${engine}`); process.exit(1); }
  for (const f of ['WinDivert.dll', 'WinDivert64.sys']) {
    if (!fs.existsSync(path.join(path.dirname(engine), f))) { bad(`${f} missing next to the engine`); process.exit(1); }
  }

  await loadAll('before');

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

  fs.writeFileSync(`${status}.stop`, '');
  for (let i = 0; i < 100 && exited === null; i++) await sleep(100);
  if (exited !== null) ok(`engine stopped by its stop file (exit ${exited})`);
  else { bad('engine did not stop within 10 s'); child.kill(); }

  const stats = (read().match(/\{"type":"raw_stats"[^\n]*\}/g) || []).pop();
  if (stats) {
    const s = JSON.parse(stats);
    const acted = Number(s.desynced ?? s.desync ?? 0);
    if (acted > 0) ok(`the engine acted on the requests: ${stats}`);
    else bad(`the engine reports it acted on nothing: ${stats}`);
  } else {
    console.log('  --  no raw_stats line from this engine build');
  }

  await loadAll('after stop');
  fs.rmSync(dir, { recursive: true, force: true });
  if (fails) { console.log(`advanced-windows: ${fails} failed`); process.exit(1); }
  console.log('advanced-windows: all passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
