'use strict';

/* The last way out (electron/tor-route.js), with a stand-in for Tor that
 * prints what Tor prints. Covered:
 *   - nothing starts until the engine needs it; the file names the port
 *   - Snowflake first; the torrc has its bridges and only its transport,
 *     the engine's port, Tor tied to Shroudly (__OwningControllerProcess)
 *   - progress and "ready" from Tor's "Bootstrapped N%" lines
 *   - no progress for a while: the other ways (meek, obfs4) with it; none
 *     either: failed, and not tried again before the wait is over
 *   - stopped after a while with nothing carried, kept while it carries
 *   - a Tor that ends by itself: failed, said once
 *   - the bridges taken only from well-formed lines of the bundle's list */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const TorRoute = require('../../electron/tor-route');
const H = require('./helpers');

const t = H.suite('tor-route');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-tor-'));
const bin = path.join(dir, 'bin');
const data = path.join(dir, 'data');
fs.mkdirSync(bin); fs.mkdirSync(data);
for (const f of ['tor', 'lyrebird']) fs.writeFileSync(path.join(bin, f), '');
const config = {
  bridges: {
    snowflake: ['snowflake 192.0.2.3:80 2B28 fingerprint=2B28 url=https://x.example/ fronts=a.example'],
    meek: ['meek_lite 192.0.2.20:80 url=https://m.example front=f.example'],
    obfs4: ['obfs4 203.0.113.1:443 AAAA cert=x iat-mode=0', 'bad\nline injected'],
  },
};
fs.writeFileSync(path.join(bin, 'pt_config.json'), JSON.stringify(config));

/* Stand-in Tor: a process-like object the test drives. */
function fakeSpawn(runs) {
  return (file, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.killed = false;
    p.kill = () => { p.killed = true; };
    p.say = (line) => p.stdout.emit('data', `${line}\n`);
    p.args = args; p.opts = opts;
    p.torrc = fs.readFileSync(args[1], 'utf8');
    runs.push(p);
    return p;
  };
}

(async () => {
  const runs = [];
  const logs = [];
  const states = [];
  const r = new TorRoute({
    dataDir: data, dir: bin, platform: 'darwin', spawn: fakeSpawn(runs), ownerPid: 4242,
    log: (l, m) => logs.push(`${l} ${m}`), onChange: (s) => states.push(s.state),
    stallMs: 300, idleMs: 400, retryMs: 500,
  });

  t.ok(r.available(), 'available with Tor, lyrebird and the bridge list in place');
  const file = await r.prepare();
  const port = Number((fs.readFileSync(file, 'utf8').match(/^socks5:\/\/127\.0\.0\.1:(\d+)\n$/) || [])[1]);
  t.ok(port > 0 && runs.length === 0 && r.status().state === 'off', 'prepare names a port for the engine and starts nothing');
  // Windows keeps no such bits: the user's own folder is what keeps it theirs.
  t.ok(process.platform === 'win32' || (fs.statSync(file).mode & 0o777) === 0o600, 'the file is this user\'s alone');

  r.need();
  const a = runs[0];
  t.ok(a && r.status().state === 'starting' && r.status().stage === 'snowflake', 'started when the engine needs it, Snowflake first');
  t.ok(a.torrc.includes(`SocksPort 127.0.0.1:${port}`) && a.torrc.includes('__OwningControllerProcess 4242') && a.torrc.includes('UseBridges 1'),
    'the torrc: the engine\'s port, tied to Shroudly');
  t.ok(/ClientTransportPlugin snowflake exec \.\/lyrebird\n/.test(a.torrc) && a.opts.cwd === bin && a.torrc.includes('Bridge snowflake 192.0.2.3:80') && !a.torrc.includes('obfs4') && !a.torrc.includes('meek'),
    'Snowflake alone at first; lyrebird by its name, run from its own folder (a path with a space would break Tor\'s line)');
  t.ok(a.args.includes('--defaults-torrc') && !a.torrc.includes('injected'), 'nothing of an installed Tor; a malformed bridge line is left out');
  r.need();
  t.ok(runs.length === 1, 'asked again while starting: still one Tor');

  a.say('Nov 05 03:20:21.000 [notice] Bootstrapped 10% (conn_done): Connected to a relay');
  t.ok(r.status().progress === 10, 'progress from Tor\'s lines');
  await H.sleep(200);
  a.say('[notice] Bootstrapped 50% (loading_descriptors)');
  await H.sleep(200);
  t.ok(runs.length === 1, 'progress keeps the stage going');
  await H.sleep(250);
  const b = runs[1];
  t.ok(b && a.killed && r.status().stage === 'all' && /ClientTransportPlugin snowflake,meek_lite,obfs4 exec/.test(b.torrc) && b.torrc.includes('Bridge obfs4 203.0.113.1:443'),
    'no progress for a while: Snowflake, meek and obfs4 together');
  await H.sleep(400);
  t.ok(r.status().state === 'failed' && b.killed && logs.some((l) => /warning The last way out: Tor did not get through/.test(l)), 'none of them either: failed, and said');
  r.need();
  t.ok(runs.length === 2, 'not tried again before the wait is over');
  await H.sleep(550);
  r.need();
  const c = runs[2];
  t.ok(c && r.status().stage === 'snowflake', 'tried again once it is over, from Snowflake');

  c.say('[notice] Bootstrapped 100% (done): Done');
  t.ok(r.status().state === 'ready' && logs.some((l) => /ready: Tor through Snowflake/.test(l)), 'ready at 100%');
  // Carrying: kept.
  for (let i = 1; i <= 3; i++) { await H.sleep(200); r.noteUse(i); }
  t.ok(r.status().state === 'ready' && !c.killed && r.status().used === 3, 'kept while it carries connections');
  await H.sleep(700);
  t.ok(r.status().state === 'off' && c.killed && logs.some((l) => /nothing has needed Tor for a while/.test(l)), 'stopped after a while with nothing carried');

  // Ends by itself: failed, once.
  await H.sleep(550);
  r.need();
  const d = runs[3];
  d.say('[notice] Bootstrapped 100% (done): Done');
  d.emit('exit', 1);
  const fails = logs.filter((l) => /Tor ended \(1\)/.test(l)).length;
  t.ok(r.status().state === 'failed' && fails === 1, 'a Tor that ends by itself: failed, said once');

  // Stop with protection.
  await H.sleep(550);
  r.need();
  r.stop();
  t.ok(runs[4].killed && r.status().state === 'off', 'stopped with protection');

  // Linux: Tor's own libraries next to it.
  const lr = new TorRoute({ dataDir: data, dir: bin, platform: 'linux', spawn: fakeSpawn(runs), ownerPid: 1 });
  await lr.prepare(); lr.need();
  const ld = runs[5].opts.env.LD_LIBRARY_PATH;
  t.ok(ld === bin || ld.startsWith(`${bin}:`), 'Linux: Tor\'s own libraries are found next to it');
  lr.stop();

  // Not in this build: nothing named to the engine.
  const none = new TorRoute({ dataDir: data, dir: path.join(dir, 'missing') });
  t.ok(!none.available() && (await none.prepare()) === null, 'not part of this build: no file, and the engine runs as before');

  t.ok(Object.keys(TorRoute.bridgesOf('{"bridges":{"snowflake":["snowflake 1.2.3.4:1 X","x\\ny"],"evil":["a b"]}}')).join() === 'snowflake', 'only the known transports\' well-formed lines');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`tor-route: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
