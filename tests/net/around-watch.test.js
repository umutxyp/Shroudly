'use strict';

/* Programs that go around Shroudly and that this network stops
 * (electron/around-watch.js): which connections count, which never do, and
 * that the autopilot then asks for Advanced mode by its own rules, naming
 * the program. Also the system tables they are read from (procnet.js). */

const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const AroundWatch = require(path.join(ROOT, 'electron', 'around-watch.js'));
const Autopilot = require(path.join(ROOT, 'electron', 'autopilot.js'));
const ProcNet = require(path.join(ROOT, 'electron', 'procnet.js'));
const t = suite('around-watch');

/* rows: the connections the system lists; dns: name -> addresses;
 * verdict: name -> blockcheck's answer. */
function rig({ rows = [], dns = {}, verdict = {}, services = [], modes = {}, own = [1], wanted = true, filtered = true } = {}) {
  let clock = 1e12;
  const asked = [];
  const checked = [];
  const logs = [];
  const listed = [];
  const w = new AroundWatch({
    wanted: () => wanted,
    connections: async (want) => { listed.push(want); return rows.filter((r) => want(r.remote.host)); },
    resolve: async (name) => dns[name] || [],
    check: async (name) => { checked.push(name); return verdict[name] || { blocked: false, detail: 'direct ok' }; },
    blockedServices: () => services,
    modeOn: (m) => !!modes[m],
    ownPids: () => own,
    need: async (host, opts) => { asked.push({ host, ...opts }); return true; },
    log: (l, m) => logs.push(m),
    now: () => clock,
  });
  // A network that shows a filter (the start-up check saw forged answers).
  if (filtered) w.forged([{ host: 'canary.example', addrs: ['10.10.34.34'] }]);
  return { w, asked, checked, logs, listed, tick: (ms) => { clock += ms; }, setWanted: (v) => { wanted = v; } };
}
const row = (pid, name, host, port = 443) => ({ pid, name, remote: { host, port } });

(async () => {
  // ── a block page: a censor's known address, or one the start-up check saw ──
  let r = rig({ rows: [row(500, 'node.exe', '195.175.254.2')] });
  t.ok(await r.w.look() === true && r.asked.length === 1 && r.asked[0].host === 'node.exe' && r.asked[0].label === 'node.exe',
    'a program at a censor\'s known block page: Advanced mode asked for, naming it');
  t.ok(r.asked[0].told.ask === 'autoAroundAsk' && r.asked[0].told.on === 'autoAroundOn' && r.asked[0].told.params.program === 'node.exe'
    && /block page \(195\.175\.254\.2\)/.test(r.asked[0].why), `with its own lines, and why: ${r.asked[0].why}`);

  r = rig({ rows: [row(500, 'python3', '203.0.113.7'), row(501, 'curl', '192.168.1.1', 80)] });
  r.w.forged([{ host: 'discord.com', addrs: ['203.0.113.7', '192.168.1.1'] }]);
  await r.w.look();
  t.ok(r.asked.length === 1 && r.asked[0].label === 'python3' && /203\.0\.113\.7 for discord\.com/.test(r.asked[0].why),
    'an address the network\'s DNS forged (seen at the start): counted, with the name it was forged for');
  r = rig({ rows: [row(501, 'curl', '192.168.1.1', 80)] });
  r.w.forged([{ host: 'discord.com', addrs: ['192.168.1.1'] }]);
  t.ok(await r.w.look() === false && !r.asked.length, 'a forged private address is not watched (it may be the router)');

  // ── a program that failed at once: its closed connection, no process ──
  r = rig({ rows: [row(0, null, '195.175.254.2')] });
  r.w.forged([{ host: 'discord.com', addrs: ['195.175.254.2'] }]);
  t.ok(await r.w.look() === true && r.asked[0].label === 'discord.com' && r.asked[0].told.ask === 'autoAroundAskAny' && r.asked[0].told.on === 'autoAroundOnAny'
    && /^a program goes around Shroudly, and this network's DNS sent it to a block page \(195\.175\.254\.2 for discord\.com\)$/.test(r.asked[0].why),
    `a closed connection to a block page: asked for, the program unnamed (${r.asked[0].why})`);
  r = rig({ rows: [row(0, null, '195.175.254.2'), row(500, 'node.exe', '195.175.254.2')] });
  await r.w.look();
  t.ok(r.asked[0].label === 'node.exe' && r.asked[0].told.ask === 'autoAroundAsk', 'with a program holding one too: that one is named');
  r = rig({ rows: [row(0, null, '162.159.135.234')], services: ['discord'], dns: { 'gateway.discord.gg': ['162.159.135.234'] } });
  t.ok(await r.w.look() === false && !r.asked.length, 'a closed connection to a real address: never (it may have been the engine\'s)');

  // ── never Shroudly's own, never a service's program its mode carries ──
  r = rig({ rows: [row(1, 'Shroudly.exe', '195.175.254.2'), row(77, 'shroudly-core.exe', '195.175.254.2'), row(78, 'x', '195.175.254.2')], own: [1, 78] });
  t.ok(await r.w.look() === false && !r.asked.length, 'Shroudly\'s own processes (by id and by name) never count');
  r = rig({ rows: [row(600, 'Discord.exe', '162.159.135.234')], services: ['discord'], dns: { 'gateway.discord.gg': ['162.159.135.234'] }, modes: { discordMode: true } });
  t.ok(await r.w.look() === false && !r.asked.length, 'Discord\'s own app while Discord app mode is on: that mode\'s job');
  r = rig({ rows: [row(600, 'Discord.exe', '162.159.135.234')], services: ['discord'], dns: { 'gateway.discord.gg': ['162.159.135.234'] } });
  t.ok(await r.w.look() === true && r.asked[0].label === 'Discord.exe', 'with the mode off, it counts like any program');

  // ── a blocked service's own names, as the system's DNS gives them ──
  r = rig({ rows: [row(700, 'node.exe', '::ffff:162.159.135.234')], services: ['discord'], dns: { 'gateway.discord.gg': ['162.159.135.234'] } });
  t.ok(await r.w.look() === true && /straight to gateway\.discord\.gg \(162\.159\.135\.234\)/.test(r.asked[0].why) && !r.checked.length,
    'a bot straight at a blocked service\'s gateway (an IPv4-mapped address too): asked for, no check needed');
  r = rig({ rows: [row(700, 'node.exe', '162.159.135.234')], dns: { 'gateway.discord.gg': ['162.159.135.234'] } });
  t.ok(await r.w.look() === false && !r.asked.length && r.checked.join() === 'gateway.discord.gg',
    'the same with no verdict on Discord (its app not on this computer): its name checked, found working, nothing asked');
  r = rig({ rows: [row(700, 'node.exe', '162.159.135.234')], dns: { 'gateway.discord.gg': ['162.159.135.234'] }, verdict: { 'gateway.discord.gg': { blocked: true, how: 'tls', detail: 'timeout' } } });
  t.ok(await r.w.look() === true && r.asked[0].label === 'node.exe', 'and found stopped at the handshake: asked for');

  // ── a site the engine told about: checked once, then acted on ──
  r = rig({ rows: [row(800, 'java.exe', '198.51.100.20')], dns: { 'mc.example.net': ['198.51.100.20'] }, verdict: { 'mc.example.net': { blocked: true, how: 'tls', detail: 'reset' } } });
  r.w.note('bypass', 'mc.example.net', null);
  t.ok(await r.w.look() === true && r.checked.join() === 'mc.example.net' && r.asked[0].label === 'java.exe',
    'a site that needed a technique, blocked at the handshake: checked, then asked for');
  r = rig({ rows: [row(800, 'java.exe', '198.51.100.21')], dns: { 'forged.example': ['198.51.100.21'] }, verdict: { 'forged.example': { blocked: true, how: 'dns', detail: '203.0.113.9' } } });
  r.w.note('blocked', 'forged.example', {});
  t.ok(await r.w.look() === false && !r.asked.length && r.logs.some((l) => /forged\.example directly, around Shroudly; only its DNS is blocked/.test(l)),
    'one blocked only by DNS, the program at its real address: it gets through, nothing asked');
  r = rig({ rows: [row(800, 'git.exe', '198.51.100.30')], dns: { 'ok.example': ['198.51.100.30'] } });
  r.w.note('bypass', 'ok.example', null);
  t.ok(await r.w.look() === false && !r.asked.length && r.logs.some((l) => /reaches ok\.example directly, around Shroudly; it is not blocked/.test(l)),
    'one that works directly: nothing asked, one line in the log');
  await r.w.look();
  t.ok(r.checked.length === 1, 'and not checked again on this network');
  r.tick(AroundWatch.CLEAR_MS);
  await r.w.look();
  t.ok(r.checked.length === 2, 'hours later: checked again');
  r.w.networkChanged();
  await r.w.look();
  t.ok(r.checked.length === 2, 'a different network: what the engine told about the last one is not watched');
  r.w.note('bypass', 'ok.example', null);
  await r.w.look();
  t.ok(r.checked.length === 3, 'told on the new one: checked there');

  r = rig({ rows: [row(800, 'git.exe', '198.51.100.30')], dns: { 'ok.example': ['198.51.100.30'] }, verdict: { 'ok.example': { blocked: false, unknown: true, detail: 'offline' } } });
  r.w.note('bypass', 'ok.example', null);
  await r.w.look(); await r.w.look();
  t.ok(r.checked.length === 2 && !r.asked.length, 'a check that learnt nothing (offline) is not kept: asked again at the next look');

  r = rig({ rows: ['a', 'b', 'c'].map((x, i) => row(900 + i, 'tool', `198.51.100.${40 + i}`)), dns: { 'a.example': ['198.51.100.40'], 'b.example': ['198.51.100.41'], 'c.example': ['198.51.100.42'] } });
  for (const x of ['a', 'b', 'c']) r.w.note('bypass', `${x}.example`, null);
  await r.w.look();
  t.ok(r.checked.length === 2, 'at most two sites checked in one look');

  r = rig({ rows: [row(800, 'tool', '198.51.100.50')], dns: { 'x.example': ['198.51.100.50'] } });
  r.w.note('blocked', 'x.example', { alert: true });
  r.w.note('blocked', 'x.example', { siteOk: true });
  r.w.note('cut', 'x.example', { note: 'disorder' });
  r.w.note('unreachable', 'x.example', null);
  r.w.note('bypass', '198.51.100.50', null);
  t.ok(await r.w.look() === false && !r.checked.length, 'what says nothing about a filter is not noted (the server\'s refusal, one cut, an address)');

  // ── only when it is wanted, on a network that shows a filter ──
  r = rig({ rows: [row(500, 'node.exe', '195.175.254.2')], wanted: false });
  t.ok(await r.w.look() === false && !r.listed.length, 'not wanted (Advanced mode on, or nothing left to ask or say): the table is not even read');
  r = rig({ rows: [row(500, 'node.exe', '195.175.254.2')], filtered: false });
  t.ok(await r.w.look() === false && !r.listed.length, 'a network that shows no filter: not read either');
  r.w.note('bypass', 'a.example', null);
  t.ok(await r.w.look() === true && r.listed.length === 1, 'once the engine needed a technique for a site: read, and the block page found');
  r = rig({ rows: [row(500, 'node.exe', '195.175.254.2')], filtered: false, services: ['discord'] });
  t.ok(await r.w.look() === true, 'or once a service is found blocked');

  // ── with the autopilot: its rules, its lines ──
  const store = new Map([['autopilotSince', 1]]);
  const mem = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) };
  let active = false;
  let startResult = { success: true };
  const told = [];
  const ap = new Autopilot({
    store: mem, tell: (id, p) => told.push({ id, p }), protectionOn: () => true,
    advanced: { available: () => true, active: () => active, start: async () => { if (startResult.success) active = true; return startResult; }, antiCheat: async () => null, session: () => 1 },
  });
  t.ok(ap.advancedPending() === true, 'the autopilot would ask: worth looking');
  const w = new AroundWatch({
    wanted: () => !active && ap.advancedPending(), connections: async (want) => [row(500, 'node.exe', '195.175.254.2')].filter((x) => want(x.remote.host)),
    need: (h, o) => ap.needAdvanced(h, o), ownPids: () => [1],
  });
  w.forged([{ host: 'discord.com', addrs: ['195.175.254.2'] }]);
  t.ok(await w.look() === true && told.map((x) => x.id).join() === 'autoAroundAsk,autoAroundOn' && told.every((x) => x.p.program === 'node.exe'),
    `asked, then on, each said in one line naming the program (${told.map((x) => x.id).join(', ')})`);
  t.ok(ap.advancedPending() === false && await w.look() === false, 'on: nothing more to look for');

  active = false; told.length = 0; startResult = { success: false, code: 'declined' };
  const ap2 = new Autopilot({
    store: mem, tell: (id, p) => told.push({ id, p }), protectionOn: () => true,
    advanced: { available: () => true, active: () => active, start: async () => startResult, antiCheat: async () => null, session: () => 1 },
  });
  const w2 = new AroundWatch({ wanted: () => ap2.advancedPending(), connections: async (want) => [row(500, 'node.exe', '195.175.254.2')].filter((x) => want(x.remote.host)), need: (h, o) => ap2.needAdvanced(h, o), ownPids: () => [1] });
  w2.forged([{ host: 'discord.com', addrs: ['195.175.254.2'] }]);
  await w2.look();
  t.ok(told.map((x) => x.id).join() === 'autoAroundAsk,autoAdvancedDeclined', 'declined: said so');
  const ap3 = new Autopilot({
    store: mem, tell: (id, p) => told.push({ id, p }), protectionOn: () => true,
    advanced: { available: () => true, active: () => false, start: async () => ({ success: true }), antiCheat: async () => null, session: () => 1 },
  });
  told.length = 0;
  const w3 = new AroundWatch({ wanted: () => ap3.advancedPending(), connections: async (want) => [row(500, 'node.exe', '195.175.254.2')].filter((x) => want(x.remote.host)), need: (h, o) => ap3.needAdvanced(h, o), ownPids: () => [1] });
  w3.forged([{ host: 'discord.com', addrs: ['195.175.254.2'] }]);
  await w3.look();
  t.ok(told.length === 1 && told[0].id === 'autoAdvancedDeclinedBefore' && told[0].p.host === 'node.exe', 'the next session: not asked for two weeks, said once with what to do');
  t.ok(ap3.advancedPending() === false && await w3.look() === false && told.length === 1, 'and then not looked for any more');

  // ── the system's tables ──
  const nrows = ProcNet.parseNetstatAll([
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040',
    '  TCP    10.0.0.5:50112         195.175.254.2:443      HERGESTELLT     4120',
    '  TCP    10.0.0.5:50113         195.175.254.2:443      TIME_WAIT       0',
    '  TCP    [2001:db8::5]:50114    [2606:4700::6810:84e5]:443  SYN_SENT  77',
    '  UDP    0.0.0.0:123            *:*                                    1312',
  ].join('\r\n'));
  t.ok(nrows.map((x) => `${x.pid}:${x.remote.host}:${x.remote.port}`).join() === '4120:195.175.254.2:443,0:195.175.254.2:443,77:2606:4700::6810:84e5:443',
    'netstat: every TCP connection but a listening one, a closed one with process 0, whatever the State column\'s language');
  const names = ProcNet.parseTasklistNames('"node.exe","4120","Console","1","52,000 K"\r\n"python.exe","77","Console","1","9,000 K"\r\n');
  t.ok(names.get(4120) === 'node.exe' && names.get(77) === 'python.exe', 'tasklist: each process\'s name');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-aw-'));
  try {
    fs.mkdirSync(path.join(root, 'net'));
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    // 195.175.254.2:443 established (inode 111), opening (222), closing
    // (333), closed with no process (TIME_WAIT, inode 0), listening (555);
    // 1.1.1.1:443 (444)
    fs.writeFileSync(path.join(root, 'net', 'tcp'), head
      + '   0: 0100007F:C350 02FEAFC3:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 111 1\n'
      + '   1: 0100007F:C351 02FEAFC3:01BB 02 00000000:00000000 00:00000000 00000000  1000        0 222 1\n'
      + '   2: 0100007F:C352 02FEAFC3:01BB 06 00000000:00000000 00:00000000 00000000  1000        0 333 1\n'
      + '   3: 0100007F:C353 01010101:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 444 1\n'
      + '   4: 0100007F:C354 02FEAFC3:01BB 06 00000000:00000000 00:00000000 00000000     0        0 0 1\n'
      + '   5: 0100007F:01BB 02FEAFC3:01BB 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1\n');
    fs.writeFileSync(path.join(root, 'net', 'tcp6'), head);
    for (const [pid, comm, inodes] of [[4242, 'node', ['111', '444', '555']], [4243, 'python3', ['222', '333']]]) {
      fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true });
      fs.writeFileSync(path.join(root, String(pid), 'comm'), `${comm}\n`);
      inodes.forEach((ino, i) => fs.symlinkSync(`socket:[${ino}]`, path.join(root, String(pid), 'fd', String(10 + i))));
    }
    const got = ProcNet.procOutbound((ip) => ip === '195.175.254.2', root).map((x) => `${x.pid}:${x.name}:${x.remote.host}:${x.remote.port}`).sort();
    t.ok(got.join() === '0:null:195.175.254.2:443,4242:node:195.175.254.2:443,4243:python3:195.175.254.2:443,4243:python3:195.175.254.2:443',
      `Linux: every connection to the addresses asked for but a listening one, with its program, a closed one with none (${got.join(' ')})`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  t.ok((await ProcNet.outbound(() => true, 'darwin')).length === 0, 'macOS: nothing (no Advanced mode there)');

  // This system's own table: another program's connection, found with its
  // id and name (netstat and tasklist on Windows, /proc on Linux).
  if (process.platform === 'win32' || process.platform === 'linux') {
    const srv = net.createServer((c) => c.on('error', () => {}));
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const port = srv.address().port;
    const child = spawn(process.execPath, ['-e', `require('net').connect(${port}, '127.0.0.1'); setTimeout(() => {}, 60000)`], { stdio: 'ignore' });
    try {
      let found = [];
      for (let i = 0; i < 20 && !found.length; i++) {
        await new Promise((res) => setTimeout(res, 250));
        found = (await ProcNet.outbound((ip) => ip === '127.0.0.1')).filter((x) => x.pid === child.pid && x.remote.port === port);
      }
      t.ok(found.length === 1 && /^node(\.exe)?$/i.test(found[0].name || ''), `this system: another program's connection, with its id and name (${found.map((x) => `${x.pid} ${x.name}`).join(', ') || 'none'})`);
    } finally { child.kill(); srv.close(); }
  }

  console.log(`around-watch: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
