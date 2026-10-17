'use strict';

/* The autopilot (electron/autopilot.js): what Shroudly turns on by itself,
 * and when it must not. Also the two things it relies on: telling a blocked
 * service from one that is down (blockcheck.js), and reading which programs
 * hold a connection to Shroudly (procnet.js). */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const Autopilot = require(path.join(ROOT, 'electron', 'autopilot.js'));
const BlockCheck = require(path.join(ROOT, 'electron', 'blockcheck.js'));
const ProcNet = require(path.join(ROOT, 'electron', 'procnet.js'));
const t = suite('autopilot');

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), m };
}

function rig({ store = memStore(), present = { discord: true, roblox: true }, check = async () => ({ blocked: false, detail: 'direct ok' }), adv = null } = {}) {
  let clock = 1e12;
  const told = [];
  const logs = [];
  const enabled = [];
  let on = true;
  const svc = (id, mode, needsApp, probe) => ({
    id, name: id, probe, mode, needsApp,
    present: () => present[id],
    enable: async () => { enabled.push(id); store.set(mode, true); return { success: true }; },
    logOn: `${id} on`, told: `auto-${id}`,
  });
  const ap = new Autopilot({
    store, log: (l, m) => logs.push(m), tell: (id, p) => told.push({ id, p }),
    protectionOn: () => on, check,
    services: [svc('discord', 'discordMode', true, 'discord.com'), svc('roblox', 'appMode', false, 'clientsettingscdn.roblox.com')],
    advanced: adv, now: () => clock,
  });
  return { ap, store, told, logs, enabled, tick: (ms) => { clock += ms; }, off: () => { on = false; }, setPresent: (id, v) => { present[id] = v; } };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── which service a host belongs to ──
  t.ok(Autopilot.familyOf('gateway.discord.gg') === 'discord' && Autopilot.familyOf('cdn.discordapp.com') === 'discord'
    && Autopilot.familyOf('clientsettingscdn.roblox.com') === 'roblox' && Autopilot.familyOf('setup.rbxcdn.com') === 'roblox',
  "a service's own names are recognised (Discord's gateway and CDN, Roblox's settings and setup hosts)");
  t.ok(Autopilot.familyOf('notdiscord.com') === null && Autopilot.familyOf('roblox.com.evil.example') === null && Autopilot.familyOf('') === null,
    'look-alikes are not');

  // ── evidence from the engine turns the mode on, and says so ──
  {
    const r = rig();
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(r.enabled.join() === 'discord' && r.told.map((x) => x.id).join() === 'auto-discord', 'a Discord name that needed a technique: Discord app mode turned on, and the user told');
    r.ap.noteHost('cut', 'gateway.discord.gg');
    await settle();
    t.ok(r.enabled.length === 1 && r.told.length === 1, 'more evidence for the same service changes nothing (told once)');
  }
  {
    const r = rig();
    r.ap.noteHost('blocked', 'www.roblox.com', { alert: true });
    r.ap.noteHost('blocked', 'apis.roblox.com', { siteOk: true });
    r.ap.noteHost('blocked', 'www.roblox.com', { note: 'silent' });
    r.ap.noteHost('unreachable', 'www.roblox.com');
    await settle();
    t.ok(!r.enabled.length && !r.ap.isBlocked('roblox'), "the server's own refusal, one address of a working site, silence and an unreachable host are not taken for a block");
    r.ap.noteHost('blocked', 'www.roblox.com', {});
    await settle();
    t.ok(r.enabled.join() === 'roblox', 'a Roblox name no technique opened: Games and apps mode turned on');
  }
  {
    const r = rig({ present: { discord: false, roblox: false } });
    r.ap.noteHost('bypass', 'discord.com');
    r.ap.noteHost('bypass', 'www.roblox.com');
    await settle();
    t.ok(r.enabled.join() === 'roblox', "Discord's mode needs a Discord app here; Roblox's is turned on anyway (its installer is the next thing the user runs)");
    r.setPresent('discord', true);
    await r.ap.survey();
    t.ok(r.enabled.join() === 'roblox,discord', 'a Discord app installed later gets the mode at the next look');
  }
  {
    const r = rig();
    r.off();
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(!r.enabled.length, 'nothing is turned on while protection is off');
  }
  {
    const r = rig({ store: memStore({ discordMode: true }) });
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(!r.enabled.length && !r.told.length, 'a mode that is already on is left alone, and nothing is said');
  }

  // ── the user's own choice ──
  {
    const r = rig();
    r.ap.userSet('discordMode', false);
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(!r.enabled.length && r.logs.some((l) => /turned off by hand/.test(l)), 'a switch the user turned off stays off (and the log says why)');
    r.tick(Autopilot.RESPECT_OFF_MS + 1000);
    await r.ap.consider('discord');
    t.ok(r.enabled.join() === 'discord', 'two weeks later, the same problem turns it on again');
    r.ap.userSet('appMode', false);
    r.ap.userSet('appMode', true);
    r.ap.noteHost('bypass', 'www.roblox.com');
    await settle();
    t.ok(r.enabled.join() === 'discord,roblox', 'turned back on by hand: the hold is gone');
  }

  // ── its own check, before the app is opened ──
  {
    const asked = [];
    const r = rig({ check: async (h) => { asked.push(h); return h === 'discord.com' ? { blocked: true, how: 'dns', detail: '195.175.254.2' } : { blocked: false, detail: 'direct ok' }; } });
    await r.ap.survey();
    await settle();
    t.ok(asked.join() === 'discord.com,clientsettingscdn.roblox.com' && r.enabled.join() === 'discord', "each installed app's service is checked; only the blocked one gets its mode");
    await r.ap.survey();
    t.ok(asked.length === 2, 'not checked again within hours');
    r.tick(Autopilot.CHECK_AGAIN_MS + 1);
    await r.ap.survey();
    t.ok(asked.length === 3 && asked[2] === 'clientsettingscdn.roblox.com', 'checked again later, only what is still off');
  }
  {
    const asked = [];
    const r = rig({ present: { discord: false, roblox: false }, check: async (h) => { asked.push(h); return { blocked: true, how: 'tls' }; } });
    await r.ap.survey();
    t.ok(!asked.length && !r.enabled.length, 'no app, no check');
  }
  {
    // Left on by an earlier session: still checked, so that a program going
    // around Shroudly is dealt with where the service is blocked.
    const asked = [];
    const r = rig({ store: memStore({ appMode: true, discordMode: true }), check: async (h) => { asked.push(h); return { blocked: h !== 'discord.com', how: 'tls' }; } });
    await r.ap.survey();
    await settle();
    t.ok(asked.length === 2 && r.ap.isBlocked('roblox') && !r.ap.isBlocked('discord') && !r.enabled.length && !r.told.length,
      'modes already on: the services are still checked (Roblox known blocked), nothing is turned on twice and nothing said');
  }

  // ── Advanced mode ──
  {
    let started = 0;
    const adv = { available: () => true, active: () => started > 0, start: async () => { started++; return { success: true }; } };
    const r = rig({ adv });
    t.ok(await r.ap.needAdvanced('blocked.example') === true && started === 1, 'a site no technique opens: Advanced mode is started');
    t.ok(r.told.map((x) => x.id).join() === 'autoAdvancedAsk,autoAdvancedOn' && r.told[0].p.host === 'blocked.example', 'the user is told before the permission prompt, and after');
    t.ok(await r.ap.needAdvanced('other.example') === false && started === 1, 'never twice');
  }
  {
    let tries = 0;
    const adv = { available: () => true, active: () => false, start: async () => { tries++; return { success: false, code: 'declined' }; } };
    const store = memStore();
    const r = rig({ store, adv });
    t.ok(await r.ap.needAdvanced('a.example') === false && store.get('advancedDeclinedAt') > 0 && r.told.some((x) => x.id === 'autoAdvancedDeclined'), 'declined: remembered, and the window keeps a button for it');
    const r2 = rig({ store, adv });
    t.ok(await r2.ap.needAdvanced('a.example') === false && tries === 1, 'a declined prompt is not shown again by itself (next session included)');
  }
  {
    let tries = 0;
    const r = rig({ adv: { available: () => false, active: () => false, start: async () => { tries++; return { success: true }; } } });
    t.ok(await r.ap.needAdvanced('a.example') === false && tries === 0, 'not available on this system: nothing is asked');
    const r2 = rig({ adv: { available: () => true, active: () => false, start: async () => { tries++; return { success: true }; } } });
    r2.ap.userSet('advancedMode', false);
    t.ok(await r2.ap.needAdvanced('a.example') === false && tries === 0, 'turned off by hand: not started by itself');
  }

  // ── blocked, or down? ──
  {
    const engineOk = { socksPort: 1, connect: async () => ({}) };
    const hsBoth = (direct, through) => async (o) => (o.socket ? through : direct);
    const c1 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['195.175.254.2'], handshake: hsBoth('ok', 'ok') });
    t.ok(c1.blocked && c1.how === 'dns', `DNS answering with a block page: blocked (${c1.detail})`);
    const c2 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['0.0.0.0'], handshake: hsBoth('ok', 'ok') });
    t.ok(c2.blocked && c2.how === 'dns', 'DNS answering 0.0.0.0: blocked');
    const c3 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => null, handshake: hsBoth('ok', 'ok') });
    t.ok(c3.blocked && c3.how === 'dns', 'no DNS answer for a name that works through Shroudly: blocked');
    const c4 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['162.159.128.233'], handshake: hsBoth('reset', 'ok') });
    t.ok(c4.blocked && c4.how === 'tls' && c4.detail === 'reset', 'handshake reset directly, fine through Shroudly: blocked');
    const c5 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['162.159.128.233'], handshake: hsBoth('timeout', 'timeout') });
    t.ok(!c5.blocked, `failing the same way through Shroudly: down, not blocked (${c5.detail})`);
    const c6 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['162.159.128.233'], handshake: hsBoth('ok', 'reset') });
    t.ok(!c6.blocked && c6.detail === 'direct ok', 'working directly: not blocked');
    const c7 = await BlockCheck.check('discord.com', { resolve: async () => ['195.175.254.2'], handshake: hsBoth('ok', 'ok') });
    t.ok(!c7.blocked, 'without the engine nothing is called blocked (it cannot be told from down)');
  }

  // ── who is connected to Shroudly ──
  {
    const net = '\r\n  Proto  Local Address          Foreign Address        State           PID\r\n'
      + '  TCP    127.0.0.1:52341        127.0.0.1:10810        ESTABLISHED     4120\r\n'
      + '  TCP    10.0.0.5:52342         162.159.1.1:443        ESTABLISHED     4121\r\n'
      + '  TCP    [::1]:5000             [::1]:10811            ESTABLISHED     4122\r\n'
      + '  TCP    0.0.0.0:10810          0.0.0.0:0              LISTENING       900\r\n'
      + '  TCP    127.0.0.1:52343        127.0.0.1:10810        TIME_WAIT       0\r\n';
    const rows = ProcNet.parseNetstat(net);
    t.ok(rows.length === 3 && rows[0].pid === 4120 && rows[0].remote.port === 10810 && rows[2].remote.host === '::1', 'Windows (netstat): established connections with their process and peer, IPv6 included; listening and closing ones left out');
    const lsof = ProcNet.parseLsof('p812\nf33\nn127.0.0.1:61000->127.0.0.1:10810\nf34\nn192.168.1.5:61001->162.159.1.1:443\np813\nf5\nn[::1]:6000->[::1]:10811\n');
    t.ok(lsof.length === 3 && lsof[0].pid === 812 && lsof[2].pid === 813 && lsof[2].remote.host === '::1', 'macOS (lsof): the same');
    const ss = ProcNet.parseSs('0      0      127.0.0.1:41000   127.0.0.1:10810 users:(("Discord",pid=700,fd=40),("Discord",pid=701,fd=41))\n');
    t.ok(ss.length === 2 && ss[1].pid === 701 && ss[0].remote.port === 10810, 'Linux (ss): every process sharing the connection');
    t.ok(await ProcNet.connectsTo([], [1]) === false && await ProcNet.connectsTo([process.pid], []) === false, 'nothing asked, nothing found');
    // For real: this process connected to a port on this computer, and not
    // to another one.
    const netm = require('net');
    const srv = netm.createServer((c) => c.on('error', () => {})).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const c = netm.connect(port, '127.0.0.1');
    await new Promise((r) => c.once('connect', r));
    // Another port this process listens on but never connects to (not
    // port + 1: that may be the client's own ephemeral port).
    const idle = netm.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => idle.once('listening', r));
    const yes = await ProcNet.connectsTo([process.pid], [port]);
    const no = await ProcNet.connectsTo([process.pid], [idle.address().port]);
    c.destroy(); srv.close(); idle.close();
    t.ok(yes && !no, `${process.platform}: a process holding a connection to the port is seen, and only to that port`);
  }

  console.log(`autopilot: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
