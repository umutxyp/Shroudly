'use strict';

/* Discord app mode: the settings file is edited safely, and the relay gets
 * the real updater manifest and packages through — engine on or off — while
 * refusing everything that is not Discord's. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ROOT, startEngine, suite } = require('./helpers');

const DA = require(path.join(ROOT, 'electron', 'discord-app.js'));
const DiscordRelay = require(path.join(ROOT, 'electron', 'discord-relay.js'));
const t = suite('discord');

function get(url, o = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method: o.method || 'GET', headers: o.headers || {}, agent: o.agent }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('error', reject); r.end();
  });
}

(async () => {
  // settings.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-discord-'));
  const f = path.join(dir, 'settings.json');
  const orig = { BACKGROUND_COLOR: '#202225', IS_MAXIMIZED: false, WINDOW_BOUNDS: { x: 1, y: 2, width: 3, height: 4 } };
  fs.writeFileSync(f, JSON.stringify(orig, null, 2));
  const url = DA.endpointUrl(10809);
  t.ok(DA.patchSync(f, url) === 'changed' && JSON.parse(fs.readFileSync(f, 'utf8')).NEW_UPDATE_ENDPOINT === url, 'adds the line');
  t.ok(DA.patchSync(f, url) === 'unchanged', 'adding twice changes nothing');
  t.ok(DA.patchSync(f, null) === 'changed' && fs.readFileSync(f, 'utf8') === JSON.stringify(orig, null, 2), 'removing restores the file byte for byte');
  fs.writeFileSync(f, JSON.stringify({ NEW_UPDATE_ENDPOINT: 'https://my.mirror/' }));
  t.ok(DA.patchSync(f, url) === 'foreign' && DA.patchSync(f, null) === 'foreign', "a user's own endpoint is never touched");
  fs.writeFileSync(f, '{broken');
  let threw = false; try { DA.patchSync(f, url); } catch { threw = true; }
  t.ok(threw && fs.readFileSync(f, 'utf8') === '{broken', 'broken JSON is refused and left as it was');
  t.ok(fs.readdirSync(dir).every((x) => !x.includes('.shroudly-')), 'no temporary files left behind');
  fs.rmSync(dir, { recursive: true, force: true });

  // relay
  const eng = await startEngine(29874, ['--strategy', 'tlsrec(sni+1)', '--auto']);
  let engineOn = true;
  const relay = new DiscordRelay(() => {}, () => (engineOn ? 29874 : null));
  const port = await relay.start(29875);
  const base = `http://127.0.0.1:${port}`;
  const plat = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'win' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  for (const mode of ['engine', 'direct']) {
    engineOn = mode === 'engine';
    const m = await get(`${base}/distributions/app/manifests/latest?channel=stable&platform=${plat}&arch=${arch}`, { agent, headers: { 'user-agent': 'Discord-Updater/1' } });
    t.ok(m.status === 200, `[${mode}] manifest fetched (${m.body.length} bytes)`);
    const man = JSON.parse(m.body.toString());
    const urls = m.body.toString().match(/https?:\/\/[^"]+/g) || [];
    t.ok(urls.length > 0 && urls.every((u) => u.startsWith(`${base}/__h/`)), `[${mode}] all ${urls.length} links point back at the relay`);
    const mod = Object.values(man.modules || {})[0];
    if (mod && mod.full) {
      const p = await get(mod.full.url, { agent });
      t.ok(crypto.createHash('sha256').update(p.body).digest('hex') === mod.full.package_sha256, `[${mode}] package arrives intact (SHA-256 matches)`);
    }
  }
  engineOn = true;
  t.ok((await get(`${base}/__h/example.com/`)).status === 403, 'other domains refused');
  t.ok((await get(`${base}/__h/evildiscord.com/`)).status === 403, 'look-alike domains refused');
  t.ok((await get(`${base}/x`, { method: 'POST' })).status === 403, 'anything but GET/HEAD refused');
  t.ok((await get(`${base}/x`, { headers: { host: `attacker.example:${port}` } })).status === 403, 'foreign Host header refused (DNS rebinding)');
  eng.stop();
  await new Promise((r) => setTimeout(r, 300));
  t.ok((await get(`${base}/distributions/app/manifests/latest?channel=stable&platform=${plat}`)).status === 502, 'engine gone: clean 502, relay keeps running');
  relay.stop();
  console.log(`discord: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
