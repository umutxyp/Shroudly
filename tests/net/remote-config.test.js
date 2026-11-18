'use strict';

/* Remote settings (electron/remote-config.js): only a signed, newer, known
 * file is used; its rules match by platform, country and version; engine
 * arguments come only from the allow-list; the desktop's engine and Tor read
 * them; remote.json in the repository is signed with the apps' key. */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { suite } = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'electron', 'remote-config.js'));
const t = suite('remote-config');

(async () => {
  // A key of the test's own: the apps' public key is never matched by it.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sign = (text) => crypto.sign('sha256', Buffer.from(text), privateKey).toString('base64');
  const file = (o) => JSON.stringify({ v: 1, issued: '2026-11-16T00:00:00Z', ...o });

  const a = file({ serial: 2, set: { quicOff: false } });
  t.ok(R.verify(a, sign(a), pub), 'a file signed with the key checks');
  t.ok(!R.verify(a + ' ', sign(a), pub) && !R.verify(a, sign(a)), 'a changed byte, or another key, does not');

  t.ok(R.parse(file({ serial: 1 })) && !R.parse('{') && !R.parse(file({ serial: 0 })) && !R.parse(JSON.stringify({ v: 2, serial: 3 })),
    'only version 1 files with a positive serial are understood');
  t.ok(!R.parse(file({ serial: 3, expires: '2020-01-01T00:00:00Z' })), 'an expired file is not used');

  const c = R.parse(file({ serial: 4, set: { reportOffer: 'fault', quicOff: true },
    rules: [{ when: { platform: ['android'], country: ['IR'] }, set: { quicOff: false } },
      { when: { appMin: '2.6.90' }, set: { reportOffer: 'never' } }] }));
  t.ok(R.effective(c, { platform: 'android', country: 'ir', app: '2.6.81' }).quicOff === false
    && R.effective(c, { platform: 'android', country: 'TR', app: '2.6.81' }).quicOff === true, 'a rule applies only where its platform and country match');
  t.ok(R.effective(c, { platform: 'windows', country: 'TR', app: '2.6.81' }).reportOffer === 'fault'
    && R.effective(c, { platform: 'windows', country: 'TR', app: '2.6.100' }).reportOffer === 'never', 'and only from its version on (2.6.100 after 2.6.90)');

  t.ok(JSON.stringify(R.engineArgs(['--strategy', 'fake(ttl=4),split(sni)', '--upstream-file', '/tmp/x', '--port', '1', '--drop-quic', '--decoy-name', 'www.digikala.com', '--decoy-name', 'bad name']))
    === JSON.stringify(['--strategy', 'fake(ttl=4),split(sni)', '--drop-quic', '--decoy-name', 'www.digikala.com']),
    'engine arguments: technique tuning only; a server, a port or a bad name is dropped');
  t.ok(JSON.stringify(R.torBridges({ torBridges: { snowflake: ['snowflake 192.0.2.3:80 ABC', 'obfs4 x'], 'bad kind!': ['x'] } })) === JSON.stringify({ snowflake: ['snowflake 192.0.2.3:80 ABC'] }),
    'Tor bridges: only lines of their own transport');

  // A restart only when what the engine starts with changes (issue #90).
  t.ok(R.engineKey({}) === R.engineKey({ reportOffer: 'never' }) && R.engineKey({}) !== R.engineKey({ engineArgs: ['--drop-quic'] })
    && R.engineKey({}) !== R.engineKey({ torAllowed: false }) && R.engineKey({ engineArgs: ['--port', '1'] }) === R.engineKey({}),
    'a file that changes nothing the engine uses (an empty first one, the report rule) does not restart it');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(/engineKey\(remoteSettings\(\)\) !== before/.test(main), 'the desktop restarts the engine only then');

  // The keeper: kept across starts, newer only, a bad signature refused.
  const kept = new Map();
  const store = { get: (k) => kept.get(k), set: (k, v) => kept.set(k, v) };
  const logs = [];
  const files = {};
  const k = new R.RemoteConfig({ store, publicKey: pub, ctx: () => ({ platform: 'linux', country: 'RU', app: '2.6.81' }), log: (l, m) => logs.push(m),
    fetchText: async (u) => { const name = u.endsWith('.sig') ? 'sig' : 'file'; if (!files[name]) throw new Error('404'); return files[name]; } });
  files.file = a; files.sig = sign(a);
  t.ok(await k.refresh({ force: true }) && k.serial() === 2 && k.settings().quicOff === false, 'a signed, newer file is taken');
  const older = file({ serial: 1, set: { quicOff: true } });
  files.file = older; files.sig = sign(older);
  t.ok(!(await k.refresh({ force: true })) && k.serial() === 2, 'an older one (a lower serial) is not');
  const forged = file({ serial: 9, set: { torAllowed: false } });
  files.file = forged; files.sig = sign(a);
  t.ok(!(await k.refresh({ force: true })) && k.serial() === 2 && logs.some((m) => /does not check/.test(m)), 'one whose signature does not check is refused, and said');
  const again = new R.RemoteConfig({ store, publicKey: pub, ctx: () => ({}), fetchText: async () => { throw new Error('offline'); } });
  t.ok(again.serial() === 2 && again.settings().quicOff === false, 'what was taken is there again at the next start, offline too');

  // Each source in turn: an HTTP 200 alone does not end the check.
  let clock = 1e12;
  const kept2 = new Map();
  const store2 = { get: (k) => kept2.get(k), set: (k, v) => kept2.set(k, v) };
  const next = file({ serial: 3, set: { quicOff: true } });
  const asked = [];
  let answer = (u) => (u.endsWith('.sig') ? sign(next) : (u.startsWith(R.SOURCES[0]) ? next + ' ' : next));
  const m = new R.RemoteConfig({ store: store2, publicKey: pub, ctx: () => ({}), now: () => clock,
    fetchText: async (u) => { asked.push(u); return answer(u); } });
  t.ok(await m.refresh({ force: true }) && m.serial() === 3 && m.settings().quicOff === true && asked.length === 4 && asked[2].startsWith(R.SOURCES[1]),
    'a first source whose file and signature do not match: the mirror is asked, and its file taken');
  t.ok(!m.due(), 'that counts as the check (six hours to the next)');
  asked.length = 0; answer = (u) => (u.endsWith('.sig') ? sign(next) : next);
  t.ok(!(await m.refresh({ force: true })) && asked.length === 2 && m.serial() === 3,
    'the one in use again from the first source: done, nothing taken, the mirror not asked');
  asked.length = 0; answer = (u) => (u.endsWith('.sig') ? sign(older) : older);
  clock += 7 * 3600e3;
  t.ok(m.due() && !(await m.refresh()) && asked.length === 4 && m.serial() === 3,
    'older files from both: both asked, the one in use kept');
  clock += 30 * 60e3;
  t.ok(!m.due(), 'and asked again in an hour, not at every look');
  clock += 31 * 60e3;
  t.ok(m.due(), 'an hour on, due again');
  asked.length = 0; answer = () => { throw new Error('offline'); };
  t.ok(!(await m.refresh()) && m.due() && m.serial() === 3, 'offline: nothing changes, still due at the next look (as before)');
  asked.length = 0; answer = (u) => (u.startsWith(R.SOURCES[0]) ? (() => { throw new Error('HTTP 404'); })() : (u.endsWith('.sig') ? sign(next) : next));
  t.ok(!(await m.refresh()) && asked.length === 4 && !m.due(), 'a first source that fails, a mirror with the one in use: the check is done');

  // The desktop's engine: the remote arguments and decoys go in.
  const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
  const em = new EngineManager({ get: () => undefined, set: () => {} }, { remote: () => ({ engineArgs: ['--strategy', 'disorder', '--upstream-file', '/x'], decoyNames: {} }) });
  const args = em._args({ port: 1, strategy: 'split(sni)', autoProbe: true, useDoh: false, adBlockAllow: [] });
  t.ok(args.join(' ').endsWith('--strategy disorder') && !args.includes('/x'), `the engine is started with the remote technique, never a remote server (${args.slice(-2).join(' ')})`);

  // Tor: turned off remotely, it does not start.
  const TorRoute = require(path.join(ROOT, 'electron', 'tor-route.js'));
  const said = [];
  const tr = new TorRoute({ dataDir: require('os').tmpdir(), log: (l, m) => said.push(m), remote: () => ({ torAllowed: false }) });
  tr.port = 9; tr.available = () => true; tr.present = () => true; let started = false; tr._start = () => { started = true; };
  tr.need();
  t.ok(!started && said.some((m) => /turned off for now by the remote settings/.test(m)), 'Tor turned off by the remote settings is not started, and that is said');

  // The repository's file: understood and signed with the apps' key.
  const text = fs.readFileSync(path.join(ROOT, 'remote.json'), 'utf8');
  t.ok(R.parse(text) && R.verify(text, fs.readFileSync(path.join(ROOT, 'remote.json.sig'), 'utf8')), 'remote.json on main is signed with the key the apps carry');

  // The phones carry the same public key and the same allow-list.
  const kt = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'RemoteConfig.kt'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'apple', 'Shared', 'RemoteConfig.swift'), 'utf8');
  t.ok(kt.includes(R.PUBLIC_KEY) && sw.includes(R.PUBLIC_KEY), 'Android and the Apple apps carry the same public key');
  for (const flag of Object.keys(R.ENGINE_ALLOWED)) t.ok(kt.includes(`"${flag}"`) && sw.includes(`"${flag}"`), `and allow ${flag} as the desktop does`);

  console.log(`remote-config: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
