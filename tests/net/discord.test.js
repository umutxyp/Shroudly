'use strict';

/* Discord app mode: the settings file is edited safely, and the relay gets
 * the real updater manifest and packages through — engine on or off — while
 * refusing everything that is not Discord's. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ROOT, startEngine, freePort, suite } = require('./helpers');

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
  // Issue #27: the system proxy was taken over within a minute of Discord's
  // settings being written anew, again and again. Shroudly's own part in a
  // Discord start (the line put back, Discord restarted on Windows) runs
  // only taskkill, tasklist and Discord's Update.exe: nothing that touches
  // the proxy settings (reg.exe, netsh, PowerShell, Internet Settings).
  {
    const cp = require('child_process');
    const ran = [];
    const real = { execFile: cp.execFile, spawn: cp.spawn };
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-discord-win-'));
    const prev = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
    let running = true;
    cp.execFile = (cmd, args, opts, cb) => {
      ran.push([cmd, ...args].join(' '));
      if (cmd === 'taskkill') running = false;
      const out = cmd === 'tasklist' && running ? '"Discord.exe","4242","Console","1","90,000 K"\r\n' : '';
      setImmediate(() => cb(null, out, ''));
      return { on() {} };
    };
    cp.spawn = (cmd, args) => { ran.push([cmd, ...args].join(' ')); return { unref() {}, on() {} }; };
    delete require.cache[require.resolve(path.join(ROOT, 'electron', 'discord-app.js'))];
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.APPDATA = path.join(local, 'Roaming');
      process.env.LOCALAPPDATA = local;
      const DW = require(path.join(ROOT, 'electron', 'discord-app.js'));
      const v = DW.variants('win32')[0];
      fs.mkdirSync(v.settingsDir, { recursive: true });
      fs.mkdirSync(path.dirname(v.updateExe), { recursive: true });
      fs.writeFileSync(v.updateExe, '');
      DW.patchSync(DW.settingsFile(v), DW.endpointUrl(10809));
      await DW.isRunning(v);
      const restarted = await DW.restart(v);
      t.ok(restarted && ran.some((c) => c.startsWith('taskkill')) && ran.some((c) => c.includes('--processStart Discord.exe'))
        && !ran.some((c) => /\breg(\.exe)?\b|netsh|powershell|Internet Settings|AutoConfigURL|ProxyServer/i.test(c)),
      `issue #27: Discord's line and a Discord restart touch no proxy setting (${ran.map((c) => c.split(' ')[0].split(/[\\/]/).pop()).join(', ')})`);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      cp.execFile = real.execFile; cp.spawn = real.spawn;
      for (const [k, val] of Object.entries(prev)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
      delete require.cache[require.resolve(path.join(ROOT, 'electron', 'discord-app.js'))];
      fs.rmSync(local, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(f, '{broken');
  let threw = false; try { DA.patchSync(f, url); } catch { threw = true; }
  t.ok(threw && fs.readFileSync(f, 'utf8') === '{broken', 'broken JSON is refused and left as it was');
  t.ok(fs.readdirSync(dir).every((x) => !x.includes('.shroudly-')), 'no temporary files left behind');
  // Every Discord build has its own settings folder (issue #6: Development was missing).
  for (const p of ['win32', 'darwin']) {
    const ids = DA.variants(p).map((v) => v.dir);
    t.ok(['discord', 'discordptb', 'discordcanary', 'discorddevelopment'].every((d) => ids.includes(d)), `${p}: Stable, PTB, Canary and Development builds known`);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // The line put back again and again (a program writing the file without
  // it every few minutes): said twice, then nothing, and with no writer
  // named (in 2.6.3's reports it was a second copy of Shroudly, not Discord).
  {
    const counts = new Map();
    const a = DA.healNote(counts, ['Discord']);
    const b = DA.healNote(counts, ['Discord', 'Discord PTB']);
    const c = DA.healNote(counts, ['Discord', 'Discord PTB']);
    const d = DA.healNote(counts, ['Discord']);
    t.ok(a.join() === 'Discord app mode: Discord added', 'the first time a build gets its line back, it is logged');
    t.ok(b.length === 2 && /Discord PTB added/.test(b[0]) && /^Discord app mode: Discord settings lost the line again; .*not logged again this session$/.test(b[1]),
      'the second time, once, that it keeps doing so (another build is its own first time)');
    t.ok(/Discord PTB settings lost the line/.test(c.join()) && c.length === 1 && d.length === 0, 'after that, nothing');
  }
  // Discord Drover (a version.dll beside Discord.exe, its drover.ini): read
  // in the newest app-* folder only (the one Discord runs), its proxy taken
  // from the ini; set aside by moving both files, never deleting them, and
  // with nothing left half done when one cannot be moved.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-drover-'));
    const v = DA.variants('win32')[0];
    const app = (ver) => path.join(dir, v.local, `app-${ver}`);
    for (const ver of ['1.0.9200', '1.0.9265', '1.0.10010']) fs.mkdirSync(app(ver), { recursive: true });
    t.ok(DA.drover(v, { root: dir }) === null, 'no drover.ini in the newest folder: none');
    fs.writeFileSync(path.join(app('1.0.9265'), 'drover.ini'), '[drover]\nproxy = http://127.0.0.1:1080\n');
    t.ok(DA.drover(v, { root: dir }) === null, "one in an older folder Discord no longer runs: none");
    fs.writeFileSync(path.join(app('1.0.10010'), 'drover.ini'), '[drover]\r\n; Proxy\r\nproxy = socks5://127.0.0.1:2080\r\nuse-nekobox-proxy = 0\r\n');
    fs.writeFileSync(path.join(app('1.0.10010'), 'version.dll'), 'MZ');
    const d = DA.drover(v, { root: dir });
    t.ok(d && d.file === path.join(app('1.0.10010'), 'drover.ini') && d.host === '127.0.0.1' && d.port === 2080 && d.url === 'socks5://127.0.0.1:2080',
      `the newest folder's (app-1.0.10010 after app-1.0.9265): its proxy read (${d && d.url})`);
    const backup = path.join(dir, 'aside');
    const moved = DA.setDroverAside(d, backup);
    t.ok(moved.join() === 'version.dll,drover.ini' && !fs.existsSync(path.join(app('1.0.10010'), 'version.dll')) && !fs.existsSync(d.file)
      && fs.readFileSync(path.join(backup, 'version.dll'), 'utf8') === 'MZ' && fs.existsSync(path.join(backup, 'drover.ini')),
      'set aside: both moved to the backup folder, nothing deleted');
    fs.writeFileSync(path.join(app('1.0.10010'), 'drover.ini'), 'proxy = http://127.0.0.1:1080\n');
    fs.writeFileSync(path.join(app('1.0.10010'), 'version.dll'), 'MZ');
    const failing = { ...fs, renameSync: (a, b) => { if (a.endsWith('drover.ini')) throw Object.assign(new Error('in use'), { code: 'EBUSY' }); return fs.renameSync(a, b); } };
    let threw = null;
    try { DA.setDroverAside({ file: path.join(app('1.0.10010'), 'drover.ini') }, path.join(dir, 'aside2'), failing); } catch (e) { threw = e.code; }
    t.ok(threw === 'EBUSY' && fs.existsSync(path.join(app('1.0.10010'), 'version.dll')) && fs.existsSync(path.join(app('1.0.10010'), 'drover.ini')),
      'one that cannot be moved: the other is put back, the folder as it was');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // A Discord open before this run's relay was up (it starts at login too,
  // often first, and sat on "Starting" for good: its line was there already,
  // so nothing was ever looked at). Looked at for a few minutes from then.
  {
    const now = 1e12;
    t.ok(DA.watchSince({ needsRestart: true, changedAt: now - 5000, startCheckAt: now - 60000, now }) === now - 5000,
      'the line written while it ran: watched from that write, as before');
    t.ok(DA.watchSince({ needsRestart: false, changedAt: 0, startCheckAt: now - 60000, now }) === now - 60000,
      'open already when the relay came up: watched from then, though the line did not change');
    t.ok(DA.watchSince({ needsRestart: false, changedAt: 0, startCheckAt: now - DA.START_CHECK_MS - 1, now }) === null
      && DA.watchSince({ needsRestart: false, changedAt: 0, startCheckAt: 0, now }) === null,
      'after a few minutes, or none open: nothing to look at');
  }
  // The line put back while Discord runs: only a Discord that may have read
  // the file without it is restarted, not one that started before (it read
  // the line, and keeps using it whatever is written over the file later).
  // In 2.6.3 every rewrite asked for a restart, and Discord was restarted
  // ("did not get through Shroudly") while it worked.
  {
    const seen = 1e12;
    t.ok(DA.readWithoutLine({ startedAt: seen - 60000, lineSeenAt: seen }) === false,
      'Discord running since before the line was last seen in place: it read the line, no restart');
    t.ok(DA.readWithoutLine({ startedAt: seen + 1500, lineSeenAt: seen }) === true && DA.readWithoutLine({ startedAt: seen - 1000, lineSeenAt: seen }) === true,
      'Discord started since (or just before, within the time between two looks): it may have read the file without it');
    t.ok(DA.readWithoutLine({ startedAt: null, lineSeenAt: seen }) === true && DA.readWithoutLine({ startedAt: seen - 60000, lineSeenAt: 0 }) === true,
      "its start unknown, or the line never seen yet: restarted, as before");
    t.ok(DA.etimeSeconds('05:07') === 307 && DA.etimeSeconds('02:05:07') === 7507 && DA.etimeSeconds('3-02:05:07') === 266707 && DA.etimeSeconds('x') === null,
      'macOS ps elapsed times read: mm:ss, hh:mm:ss, dd-hh:mm:ss');
    t.ok(DA.oldestStart('  05:07\n  00:09\n', { platform: 'darwin', now: 1e12 }) === 1e12 - 307000, "macOS: the build's oldest process");
    t.ok(DA.oldestStart('2026-10-22T19:15:03.1234567Z\r\n2026-10-22T19:14:58.0000000Z\r\n', { platform: 'win32' }) === Date.parse('2026-10-22T19:14:58Z')
      && DA.oldestStart('', { platform: 'win32' }) === null, "Windows: the oldest of PowerShell's start times; none: unknown");
    // The real lookup, on this machine's own processes.
    if (process.platform === 'win32') {
      const at = await DA.startedAt({ exe: path.basename(process.execPath) });
      t.ok(typeof at === 'number' && at <= Date.now() && at > Date.now() - 7 * 86400000, `Windows: when a running program started, from PowerShell (${at && new Date(at).toISOString()})`);
    } else {
      // (Minimal containers have no ps; the lookup is for macOS, where it always is.)
      const out = await new Promise((r) => require('child_process').execFile('ps', ['-o', 'etime=', '-p', String(process.pid)], (e, o) => r(e ? null : String(o || ''))));
      if (out === null && process.platform !== 'darwin') console.log('  --  no ps here: the elapsed-time lookup is checked on macOS');
      else {
        const at = DA.oldestStart(out);
        t.ok(typeof at === 'number' && Math.abs(at - (Date.now() - process.uptime() * 1000)) < 3000, 'this system: how long a program has run, from ps');
      }
    }
  }
  t.ok(typeof DA.anyRunning === 'function' && Array.isArray(DA.present()), 'builds present on any system, and whether one runs, for the autopilot');

  // relay
  const P = await freePort();
  const eng = await startEngine(P, ['--strategy', 'tlsrec(sni+1)', '--auto']);
  let engineOn = true;
  const relay = new DiscordRelay(() => {}, () => (engineOn ? P : null));
  const port = await relay.start(await freePort());
  const base = `http://127.0.0.1:${port}`;
  // A manifest Discord actually publishes for this machine (there is no
  // Linux ARM build of Discord; the relay is the same whatever is fetched).
  const plat = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'win' : 'linux';
  const arch = plat === 'linux' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64';
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
  {
    // The engine restarting after a crash and not back within the wait: the
    // updater gets an error it retries, never a direct connection (which a
    // network that blocks Discord fails, or answers falsely).
    engineOn = false;
    relay.engineDue = () => true;
    relay.waitForEngine = async () => {};
    const held = await get(`${base}/distributions/app/manifests/latest?channel=stable&platform=${plat}&arch=${arch}`, { headers: { 'user-agent': 'Discord-Updater/1' } });
    t.ok(held.status === 502, `the engine still restarting after the wait: an error the updater retries, not a direct connection (${held.status})`);
    relay.engineDue = () => false;
    relay.waitForEngine = null;
  }
  engineOn = true;
  t.ok((await get(`${base}/__h/example.com/`)).status === 403, 'other domains refused');
  t.ok((await get(`${base}/__h/evildiscord.com/`)).status === 403, 'look-alike domains refused');
  t.ok((await get(`${base}/x`, { method: 'POST' })).status === 403, 'anything but GET/HEAD refused');
  t.ok((await get(`${base}/x`, { headers: { host: `attacker.example:${port}` } })).status === 403, 'foreign Host header refused (DNS rebinding)');
  {
    // The first way through is cut during the handshake (it opens, then
    // dies): the relay tries once more on a new connection, and Discord's
    // updater never sees an error.
    const net = require('net');
    let n = 0;
    const flaky = net.createServer((c) => {
      n++;
      if (n === 1) {
        let step = 0;
        c.on('data', () => {
          step++;
          if (step === 1) c.write(Buffer.from([5, 0]));
          else { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); setTimeout(() => c.destroy(), 50); }
        });
        c.on('error', () => {});
        return;
      }
      const u = net.connect(P, '127.0.0.1');
      c.pipe(u); u.pipe(c);
      c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
    });
    await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
    const r2 = new DiscordRelay(() => {}, () => flaky.address().port);
    const p2 = await r2.start(await freePort());
    const m2 = await get(`http://127.0.0.1:${p2}/distributions/app/manifests/latest?channel=stable&platform=${plat}&arch=${arch}`, { headers: { 'user-agent': 'Discord-Updater/1' } });
    t.ok(m2.status === 200 && n >= 2, `first connection cut in the handshake: answered on the second (${m2.status}, ${n} connections)`);
    r2.stop();
    flaky.close();
  }
  eng.stop();
  await new Promise((r) => setTimeout(r, 300));
  t.ok((await get(`${base}/distributions/app/manifests/latest?channel=stable&platform=${plat}`)).status === 502, 'engine gone: clean 502, relay keeps running');
  relay.stop();
  {
    // Issue #29: the updater asks again and again; a host it cannot reach
    // is said once (then at most every half hour), not every half minute.
    const lines = [];
    const dead = await freePort();
    const r3 = new DiscordRelay((l, m) => lines.push(m), () => dead);
    const p3 = await r3.start(await freePort());
    for (let i = 0; i < 3; i++) await get(`http://127.0.0.1:${p3}/distributions/app/manifests/latest?channel=stable&platform=${plat}`);
    await get(`http://127.0.0.1:${p3}/__h/dl.discordapp.net/apps/x.zip`);
    r3.stop();
    t.ok(lines.filter((l) => l.startsWith('Discord app: could not reach updates.discord.com (')).length === 1
      && lines.filter((l) => l.startsWith('Discord app: could not reach dl.discordapp.net (')).length === 1,
    `issue #29: the Discord relay says each unreachable host once, another host at once too (${lines.join(' | ')})`);
  }
  /* Being refused Discord's settings file means different things on different
   * systems: on macOS the user has to allow it (there is a prompt), elsewhere
   * the file is in use or write-protected. A Windows user was shown the macOS
   * wording and could do nothing with it, so the two are kept apart. */
  {
    const fsx = require('fs');
    const main = fsx.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    t.ok(/discordState\.needsPermission = r\.denied\.length > 0 && process\.platform === 'darwin'/.test(main),
      'the macOS permission state is only ever set on macOS');
    t.ok(/discordState\.locked = r\.denied\.length > 0 && process\.platform !== 'darwin'/.test(main),
      'everywhere else the same refusal is reported as the file being locked');
    const notice = fsx.readFileSync(path.join(ROOT, 'components', 'BlockedNotice.js'), 'utf8');
    t.ok(notice.includes("discord?.locked") && notice.includes("t('discordLocked')"),
      'and the window has a line of its own for it');
    const en = JSON.parse(fsx.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
    t.ok(en.discordLocked && !/macOS/i.test(en.discordLocked), 'that line never mentions macOS');
  }

  console.log(`discord: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
