'use strict';

/* Tor fetched on a computer the first time it is needed (electron/
 * tor-download.js, issue #75), from stand-ins on this computer: an HTTPS
 * server behind the engine's SOCKS. Covered:
 *   - fetched through the engine, a redirect followed, checked, and only the
 *     needed files unpacked (programs executable), made complete or not at all
 *   - a download that is not the Tor Project's file (another SHA-256) is
 *     refused and nothing is left; the next source is tried
 *   - nothing fetched again once it is there */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const TD = require('../../electron/tor-download');
const T = require('../../electron/tor-files');
const H = require('./helpers');

const t = H.suite('tor-download');
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-tordl-'));
const target = TD.target();
const spec = T.DESKTOP[target];

(async () => {
  // A stand-in Expert Bundle with the files this computer needs.
  const src = path.join(root, 'src');
  for (const from of [...Object.keys(spec.files), ...Object.keys(T.COMMON)]) {
    fs.mkdirSync(path.join(src, path.dirname(from)), { recursive: true });
    fs.writeFileSync(path.join(src, from), from.endsWith('.json') ? '{"bridges":{}}' : `stand-in ${from}`);
  }
  const tgz = path.join(root, 'bundle.tar.gz');
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-czf', tgz, '-C', src, 'tor', 'docs']);
  const body = fs.readFileSync(tgz);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const name = T.fileName(spec.bundle);

  const asked = [];
  const site = https.createServer(H.testServerOptions(), (req, res) => {
    asked.push(req.url);
    if (req.url === `/a/${name}`) { res.writeHead(302, { Location: `/b/${name}` }); res.end(); return; }
    if (req.url === `/b/${name}`) { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); return; }
    // A network that cuts the name: the connection ends before any answer.
    if (req.url === `/cut/${name}`) { req.socket.destroy(); return; }
    if (req.url === `/bad/${name}`) { const x = Buffer.from('not the bundle'); res.writeHead(200, { 'Content-Length': x.length }); res.end(x); return; }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await listening(site);
  const socks = H.socksServer(site.address().port);
  await listening(socks);
  const opts = (sources) => ({
    target, sources, sha256: { [spec.bundle]: sha }, socksPort: socks.address().port, connect: require('../../electron/discord-relay').socksConnect,
    tlsOptions: { ca: H.fixture('test-only-cert.pem'), checkServerIdentity: () => undefined }, unsigned: true, onProgress: (p) => { last = p; },
  });
  let last = -1;

  // A wrong file first: refused, then the next source.
  const dir = path.join(root, 'tor-bin', T.VERSION);
  const logs = [];
  const got = await TD.ensure(dir, { ...opts(['https://tor.example/bad/', 'https://tor.example/a/']), log: (l, m) => logs.push(m) });
  t.ok(got === dir && logs.some((m) => /not the Tor Project's file/.test(m)), 'a download that is not the Tor Project\'s file is refused, and the next source tried');
  t.ok(asked.includes(`/b/${name}`) && socks.asked.every((a) => a.host === 'tor.example'), 'fetched through the engine, by name, a redirect followed');
  const want = [...Object.values(spec.files), ...Object.values(T.COMMON)];
  t.ok(want.every((f) => fs.existsSync(path.join(dir, f))) && fs.readdirSync(dir).length === want.length, `only the needed files, all of them (${fs.readdirSync(dir).join(', ')})`);
  t.ok(process.platform === 'win32' || (fs.statSync(path.join(dir, Object.values(spec.files)[0])).mode & 0o111) !== 0, 'programs are executable');
  t.ok(last === 100, 'progress reaches 100');
  t.ok(!fs.existsSync(`${dir}.part`), 'nothing half-made left');

  // Already there: nothing fetched.
  const before = asked.length;
  await TD.ensure(dir, opts(['https://tor.example/a/']));
  t.ok(asked.length === before, 'once it is there, nothing is fetched again');

  // Every source wrong: refused, nothing made.
  const dir2 = path.join(root, 'tor-bin', 'x');
  let err = null;
  try { await TD.ensure(dir2, opts(['https://tor.example/bad/'])); } catch (e) { err = e; }
  t.ok(err && /SHA-256/.test(err.message) && !fs.existsSync(dir2), 'no good source: refused, and no folder made');

  // Cut before any answer (Russia, torproject.org): said so, not "ENOENT
  // bundle.tar.gz", and the next source tried.
  const dir3 = path.join(root, 'tor3');
  const said = [];
  const got3 = await TD.ensure(dir3, { ...opts(['https://tor.example/cut/', 'https://tor.example/b/']), log: (l, m) => said.push(m) });
  t.ok(got3 === dir3 && said.some((m) => /cut before any answer/.test(m)) && !said.some((m) => /ENOENT/.test(m)), `a source cut before any answer is said as such, and the next one used (${said.join(' | ')})`);
  t.ok(T.SOURCES.some((u) => u.startsWith('https://github.com/umutxyp/Shroudly/releases/download/tor-')) && T.SOURCES[0].includes('torproject.org'),
    'the Tor Project first, then the same files on Shroudly\'s GitHub (checked by the same SHA-256)');

  site.close(); socks.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`tor-download: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
