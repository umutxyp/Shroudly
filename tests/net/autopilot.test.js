'use strict';

/* The autopilot (electron/autopilot.js): what Shroudly turns on by itself,
 * and when it must not. Also what it relies on: telling a blocked service
 * from one that is down (blockcheck.js), reading which programs hold a
 * connection to Shroudly (procnet.js), and deciding which of Roblox's
 * programs go around Shroudly (roblox-app.js decide). */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const Autopilot = require(path.join(ROOT, 'electron', 'autopilot.js'));
const BlockCheck = require(path.join(ROOT, 'electron', 'blockcheck.js'));
const ProcNet = require(path.join(ROOT, 'electron', 'procnet.js'));
const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
const t = suite('autopilot');

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), m };
}

/* blocked: the hosts the check finds blocked (a function or a list). */
function rig({ store = memStore({ autopilotSince: 1 }), present = { discord: true, roblox: true }, blocked = [], adv = null, enableResult = null } = {}) {
  let clock = 1e12;
  const told = [];
  const logs = [];
  const enabled = [];
  const asked = [];
  let on = true;
  const isBlocked = typeof blocked === 'function' ? blocked : (h) => blocked.includes(h);
  const svc = (id, mode, needsApp, probe) => ({
    id, name: id, probe, mode, needsApp,
    present: () => present[id],
    enable: async () => { enabled.push(id); if (enableResult) return enableResult; store.set(mode, true); return { success: true }; },
    logOn: `${id} on`, told: `auto-${id}`,
  });
  const ap = new Autopilot({
    store, log: (l, m) => logs.push(m), tell: (id, p) => told.push({ id, p }),
    protectionOn: () => on,
    check: async (h) => { asked.push(h); return isBlocked(h) ? { blocked: true, how: 'tls', detail: 'reset' } : { blocked: false, detail: 'direct ok' }; },
    services: [svc('discord', 'discordMode', true, 'discord.com'), svc('roblox', 'appMode', false, 'clientsettingscdn.roblox.com')],
    advanced: adv, now: () => clock,
  });
  return { ap, store, told, logs, enabled, asked, tick: (ms) => { clock += ms; }, off: () => { on = false; }, setPresent: (id, v) => { present[id] = v; } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
  // ── which service a host belongs to ──
  t.ok(Autopilot.familyOf('gateway.discord.gg') === 'discord' && Autopilot.familyOf('cdn.discordapp.com') === 'discord'
    && Autopilot.familyOf('clientsettingscdn.roblox.com') === 'roblox' && Autopilot.familyOf('setup.rbxcdn.com') === 'roblox',
  "a service's own names are recognised (Discord's gateway and CDN, Roblox's settings and setup hosts)");
  t.ok(Autopilot.familyOf('notdiscord.com') === null && Autopilot.familyOf('roblox.com.evil.example') === null && Autopilot.familyOf('') === null,
    'look-alikes are not');
  t.ok(['media.giphy.com', 'tenor.com', 'withpersona.com', 'www.guilded.gg', 'hcaptcha.com'].every((h) => Autopilot.familyOf(h) === null),
    'third parties the services embed (GIFs, identity checks, captchas) say nothing about the service itself');

  // ── the engine's word, checked before it counts ──
  {
    const r = rig({ blocked: ['discord.com'] });
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(r.asked.join() === 'discord.com' && r.enabled.join() === 'discord' && r.told.map((x) => x.id).join() === 'auto-discord',
      'a Discord name that needed a technique is checked; found blocked: Discord app mode on, and the user told');
    r.ap.noteHost('bypass', 'gateway.discord.gg');
    await settle();
    t.ok(r.enabled.length === 1 && r.told.length === 1 && r.asked.length === 1, 'more events for the same service change nothing (no second check, told once)');
  }
  {
    const r = rig({ blocked: [] });
    r.ap.noteHost('bypass', 'www.roblox.com');
    await settle();
    t.ok(r.asked.join() === 'www.roblox.com' && !r.enabled.length && !r.ap.isBlocked('roblox'), 'an engine event the check does not confirm (it works directly) turns nothing on');
    r.ap.noteHost('bypass', 'apis.roblox.com');
    await settle();
    t.ok(r.asked.length === 1, 'and for hours after, events about that service are not checked again');
  }
  {
    const r = rig({ blocked: ['www.roblox.com'] });
    r.ap.noteHost('cut', 'www.roblox.com', { note: 'stall' });
    r.ap.noteHost('blocked', 'www.roblox.com', { alert: true });
    r.ap.noteHost('blocked', 'apis.roblox.com', { siteOk: true });
    r.ap.noteHost('blocked', 'www.roblox.com', { note: 'silent' });
    r.ap.noteHost('unreachable', 'www.roblox.com');
    r.ap.noteHost('bypass', 'tenor.com');
    await settle();
    t.ok(!r.asked.length && !r.enabled.length, "a single cut, the server's own refusal, one address of a working site, silence, an unreachable host and a third party: nothing is even checked");
    r.ap.noteHost('cut', 'www.roblox.com', { believed: true });
    await settle();
    t.ok(r.enabled.join() === 'roblox', 'a cut the engine believes (enough of them) is checked, and counts once confirmed');
  }
  {
    const r = rig({ present: { discord: false, roblox: false }, blocked: ['discord.com', 'www.roblox.com'] });
    r.ap.noteHost('bypass', 'discord.com');
    r.ap.noteHost('bypass', 'www.roblox.com');
    await settle();
    t.ok(r.enabled.join() === 'roblox', "Discord's mode needs a Discord app here; Roblox's is turned on anyway (its installer is the next thing the user runs)");
    r.setPresent('discord', true);
    await r.ap.survey();
    t.ok(r.enabled.join() === 'roblox,discord', 'a Discord app installed later gets the mode at the next look');
  }
  {
    const r = rig({ blocked: ['discord.com'] });
    r.off();
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(!r.enabled.length, 'nothing is turned on while protection is off');
  }
  {
    const r = rig({ store: memStore({ autopilotSince: 1, discordMode: true }), blocked: ['discord.com'] });
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(!r.enabled.length && !r.told.length && r.ap.isBlocked('discord'), 'a mode that is already on is left alone, and nothing is said (the service is still known blocked)');
  }

  // ── the user's own choice ──
  {
    const r = rig({ blocked: ['discord.com', 'www.roblox.com'] });
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
  {
    // 2.5.9 and older: a mode turned off by hand, an offer put off.
    const now = 1e12;
    const store = memStore({ discordMode: false, discordOfferDeclinedAt: now - 86400000, appOfferDeclinedAt: now - 3600000 });
    const r = rig({ store, blocked: ['discord.com', 'www.roblox.com'] });
    r.ap.noteHost('bypass', 'discord.com');
    r.ap.noteHost('bypass', 'www.roblox.com');
    await settle();
    t.ok(!r.enabled.length && store.get('discordModeOffAt') === now && store.get('appModeOffAt') === now - 3600000 && !store.m.has('discordOfferDeclinedAt'),
      'after the update, a mode turned off by hand and an offer put off with "Not now" are still respected');
    const again = memStore({ autopilotSince: 5, discordMode: false });
    rig({ store: again });
    t.ok(!again.m.has('discordModeOffAt'), 'that is done once, not at every start');
  }
  {
    const r = rig({ blocked: ['discord.com'], enableResult: { success: false, code: 'permission' } });
    r.ap.noteHost('bypass', 'discord.com');
    await settle();
    for (let i = 0; i < 4; i++) { r.tick(10 * 60 * 1000); await r.ap.survey(); }
    t.ok(r.enabled.length === 1 && !r.told.length, 'a mode that could not be turned on (a permission panel cancelled, a proxy of the user\'s own) is not tried again by itself every few minutes');
  }

  // ── its own check, before the app is opened, and again later ──
  {
    const r = rig({ blocked: ['discord.com'] });
    await r.ap.survey();
    await settle();
    t.ok(r.asked.join() === 'discord.com,clientsettingscdn.roblox.com' && r.enabled.join() === 'discord', "each installed app's service is checked; only the blocked one gets its mode");
    await r.ap.survey();
    t.ok(r.asked.length === 2, 'not checked again within hours');
    r.tick(Autopilot.CHECK_AGAIN_MS + 1);
    await r.ap.survey();
    t.ok(r.asked.length === 4, 'checked again later, blocked or not');
  }
  {
    let blockedNow = true;
    const r = rig({ blocked: (h) => blockedNow && h === 'discord.com' });
    await r.ap.survey();
    t.ok(r.ap.isBlocked('discord'), 'found blocked');
    blockedNow = false;
    r.tick(Autopilot.CHECK_AGAIN_MS + 1);
    await r.ap.survey();
    t.ok(!r.ap.isBlocked('discord'), 'no longer blocked hours later (another network): forgotten, so nothing is restarted for it');
    blockedNow = true;
    await r.ap.survey();
    r.ap.networkChanged();
    t.ok(!r.ap.isBlocked('discord') && r.logs.some((l) => /network changed/.test(l)), 'a network change forgets what was learnt');
    await r.ap.survey();
    t.ok(r.ap.isBlocked('discord'), 'and the next look finds out afresh');
  }
  {
    const r = rig({ present: { discord: false, roblox: false }, blocked: ['discord.com'] });
    await r.ap.survey();
    t.ok(!r.asked.length && !r.enabled.length, 'no app, no check');
  }
  {
    // Started at login before the Wi-Fi is up: nothing can be learnt.
    let online = false;
    const store = memStore({ autopilotSince: 1 });
    let clock = 1e12;
    const asked = [];
    const ap = new Autopilot({
      store, log: () => {}, tell: () => {}, protectionOn: () => true, now: () => clock,
      check: async (h) => { asked.push(h); return online ? { blocked: true, how: 'tls', detail: 'reset' } : { blocked: false, unknown: true, detail: 'dns: no answer; through Shroudly too (timeout)' }; },
      services: [{ id: 'discord', name: 'discord', probe: 'discord.com', mode: 'discordMode', needsApp: true, present: () => true, enable: async () => { store.set('discordMode', true); return { success: true }; }, logOn: '', told: 'x' }],
    });
    await ap.survey();
    t.ok(!ap.isBlocked('discord') && !ap.clear.has('discord'), 'offline at the first look: neither blocked nor "works without Shroudly"');
    online = true;
    clock += 3 * 60 * 1000;
    ap.noteHost('bypass', 'discord.com');
    await settle();
    t.ok(ap.isBlocked('discord') && store.get('discordMode') === true, 'once online, the engine\'s next event is checked and counts (not ignored for hours)');
  }
  {
    // A check that finishes after the network changed belongs to the old one.
    let release;
    const store = memStore({ autopilotSince: 1 });
    const ap = new Autopilot({
      store, log: () => {}, tell: () => {}, protectionOn: () => true,
      check: () => new Promise((ok) => { release = () => ok({ blocked: true, how: 'tls', detail: 'reset' }); }),
      services: [{ id: 'roblox', name: 'roblox', probe: 'x.roblox.com', mode: 'appMode', needsApp: false, present: () => true, enable: async () => ({ success: true }), logOn: '', told: 'x' }],
    });
    const pending = ap.survey();
    await settle();
    ap.networkChanged();
    release();
    await pending;
    t.ok(!ap.isBlocked('roblox'), 'a check from before a network change is dropped');
  }
  {
    // After a network change, a check for the new network runs at once, not
    // folded into the dropped one from the old network.
    const releases = [];
    const store = memStore({ autopilotSince: 1 });
    const ap = new Autopilot({
      store, log: () => {}, tell: () => {}, protectionOn: () => true,
      check: () => new Promise((ok) => releases.push(ok)),
      services: [{ id: 'roblox', name: 'roblox', probe: 'x.roblox.com', mode: 'appMode', needsApp: false, present: () => true, enable: async () => ({ success: true }), logOn: '', told: 'x' }],
    });
    const first = ap.survey();
    await settle();
    ap.networkChanged();
    const second = ap.survey();
    await settle();
    t.ok(releases.length === 2, 'a network change starts a new check instead of waiting for the old one');
    releases[0]({ blocked: false, detail: 'direct ok' });
    releases[1]({ blocked: true, how: 'tls', detail: 'reset' });
    await Promise.all([first, second]);
    t.ok(ap.isBlocked('roblox'), 'and the new network\'s answer is the one kept');
  }
  {
    const NF = Autopilot.networkFingerprint;
    t.ok(Autopilot.ipv6Groups('fd00::1c2d:3e4f:5a6b:7c8d').join(':') === 'fd00:0:0:0:1c2d:3e4f:5a6b:7c8d' && Autopilot.ipv6Groups('::1').join(':') === '0:0:0:0:0:0:0:1',
      'IPv6 addresses are read in their eight groups, however they are written');
    const day1 = { 'Wi-Fi': [{ family: 'IPv4', address: '192.168.178.23', netmask: '255.255.255.0' }, { family: 'IPv6', address: 'fd00::1c2d:3e4f:5a6b:7c8d' }, { family: 'IPv6', address: '2a02:810d:4b40:7a00:a1b2:c3d4:e5f6:1' }, { family: 'IPv6', address: 'fe80::1' }] };
    const day2 = { 'Wi-Fi': [...day1['Wi-Fi'], { family: 'IPv6', address: 'fd00::9f8e:7d6c:1:2' }, { family: 'IPv6', address: '2a02:810d:4b40:7a00:9:8:7:6' }] };
    const other = { 'Wi-Fi': [{ family: 'IPv4', address: '10.20.30.40', netmask: '255.255.0.0' }] };
    t.ok(NF(day1) === NF(day2) && NF(day1) !== NF(other), 'the same network after a daily privacy-address change is the same network (fd00:: prefixes too); another network is not');
  }
  {
    // Before a program is restarted, an old verdict is checked again.
    let blockedNow = true;
    const r = rig({ blocked: (h) => blockedNow && h === 'discord.com' });
    await r.ap.survey();
    t.ok(await r.ap.stillBlocked('discord') === true && r.asked.length === 2, 'a fresh verdict is used as it is');
    blockedNow = false;
    r.tick(11 * 60 * 1000);
    t.ok(await r.ap.stillBlocked('discord') === false && r.asked.length === 3 && !r.ap.isBlocked('discord'),
      'an older one is checked again first: on a network that does not block it (it looked the same from here), nothing is restarted');
  }
  {
    const r = rig({ store: memStore({ autopilotSince: 1, appMode: true, discordMode: true }), blocked: ['clientsettingscdn.roblox.com'] });
    await r.ap.survey();
    await settle();
    t.ok(r.asked.length === 2 && r.ap.isBlocked('roblox') && !r.ap.isBlocked('discord') && !r.enabled.length && !r.told.length,
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
    const store = memStore({ autopilotSince: 1 });
    const r = rig({ store, adv });
    t.ok(await r.ap.needAdvanced('a.example') === false && store.get('advancedDeclinedAt') > 0 && r.told.some((x) => x.id === 'autoAdvancedDeclined'), 'declined: remembered, and the window keeps a button for it');
    const r2 = rig({ store, adv });
    t.ok(await r2.ap.needAdvanced('a.example') === false && tries === 1, 'a declined prompt is not shown again by itself (next session included)');
  }
  {
    const adv = { available: () => true, active: () => false, start: async () => ({ success: false, code: 'start_failed' }) };
    const r = rig({ adv });
    await r.ap.needAdvanced('a.example');
    t.ok(r.told.map((x) => x.id).join() === 'autoAdvancedAsk,autoAdvancedFailed', 'failed for another reason: the "allow it" line is followed by one that says it did not start (with its button)');
  }
  {
    let tries = 0;
    const adv = { available: () => true, active: () => false, start: async () => { tries++; return { success: true }; } };
    const r = rig({ adv });
    r.ap.recordDecline();
    t.ok(await r.ap.needAdvanced('a.example') === false && tries === 0, 'declined at a prompt the user started: not asked by itself either');
    t.ok(r.ap.willAskAdvanced() === false, 'and the window is told it will not ask, so it offers its own button');
    const r1 = rig({ adv: { available: () => false, active: () => false, start: async () => { tries++; return { success: true }; } } });
    t.ok(await r1.ap.needAdvanced('a.example') === false && tries === 0, 'not available on this system: nothing is asked');
    const r2 = rig({ adv });
    r2.ap.userSet('advancedMode', false);
    t.ok(await r2.ap.needAdvanced('a.example') === false && tries === 0, 'turned off by hand: not started by itself');
  }

  // ── a game's anti-cheat: no packet driver loaded beside it by itself ──
  {
    const list = '"svchost.exe","900","Services","0","9,000 K"\r\n"vgc.exe","4100","Services","0","30,000 K"';
    t.ok(Autopilot.antiCheatIn(list) === 'vgc.exe', 'an anti-cheat service in the process list is found');
    t.ok(Autopilot.antiCheatIn('"svchost.exe","900","Services","0","9,000 K"') === null, 'and nothing else is taken for one');
    let tries = 0;
    const r = rig({ adv: { available: () => true, active: () => false, start: async () => { tries++; return { success: true }; }, antiCheat: async () => 'vgc.exe' } });
    t.ok(await r.ap.needAdvanced('a.example') === false && tries === 0, 'with an anti-cheat running, Advanced mode is not started by itself');
  }

  // ── Roblox's programs: who is restarted, who is told ──
  {
    const base = { studios: [], installers: { player: [], studio: [] }, quiet: [], before: [], handled: [], restarts: [], now: 1e9 };
    const d1 = RobloxApp.decide({ ...base, players: [1, 2], quiet: [2] });
    t.ok(JSON.stringify(d1.restartPlayers) === '[2]', 'only the player that goes around Shroudly is restarted, never another one in a game through it');
    const d2 = RobloxApp.decide({ ...base, players: [1], studios: [3], installers: { player: [4], studio: [5] }, quiet: [4, 5], before: [3] });
    t.ok(JSON.stringify(d2.installers) === '{"player":[4],"studio":[5]}' && JSON.stringify(d2.tellStudios) === '[3]' && !d2.restartPlayers.length,
      "installers around Shroudly are started again; Studio is only ever told about; a player that uses Shroudly is left alone");
    const d3 = RobloxApp.decide({ ...base, players: [2], quiet: [2], handled: [2] });
    t.ok(!d3.restartPlayers.length, 'a process already dealt with is not dealt with again');
    const d4 = RobloxApp.decide({ ...base, players: [7], quiet: [7], restarts: [1e9 - 60000, 1e9 - 120000] });
    t.ok(!d4.restartPlayers.length && JSON.stringify(d4.stuckPlayers) === '[7]', 'after two restarts in ten minutes, a player is left to Advanced mode, not restarted in a loop');
  }

  // ── blocked, or down? ──
  {
    const engineOk = { socksPort: 1, connect: async () => ({}), retryMs: 0 };
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
    let n = 0;
    const flaky = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['162.159.128.233'], handshake: async (o) => (o.socket ? 'ok' : (n++ === 0 ? 'timeout' : 'ok')) });
    t.ok(!flaky.blocked && n === 2, 'one direct handshake lost on a weak network, the next one fine: not blocked');
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
    // Windows translates the State column.
    const local = ProcNet.parseNetstat('  TCP    127.0.0.1:52341        127.0.0.1:10810        HERGESTELLT     4120\r\n'
      + '  TCP    127.0.0.1:52342        127.0.0.1:10810        KURULDU         4121\r\n'
      + '  TCP    127.0.0.1:52343        127.0.0.1:10810        УСТАНОВЛЕНО     4122\r\n'
      + '  TCP    0.0.0.0:10810          0.0.0.0:0              ABHÖREN         900\r\n'
      + '  TCP    127.0.0.1:52344        127.0.0.1:10810        WARTEND         0\r\n');
    t.ok(JSON.stringify(local.map((r) => r.pid)) === '[4120,4121,4122]', 'German, Turkish and Russian Windows: connections still found whatever the state is called; listening and closed ones still left out');
    const lsof = ProcNet.parseLsof('p812\nf33\nn127.0.0.1:61000->127.0.0.1:10810\nf34\nn192.168.1.5:61001->162.159.1.1:443\np813\nf5\nn[::1]:6000->[::1]:10811\n');
    t.ok(lsof.length === 3 && lsof[0].pid === 812 && lsof[2].pid === 813 && lsof[2].remote.host === '::1', 'macOS (lsof): the same');
    const ss = ProcNet.parseSs('0      0      127.0.0.1:41000   127.0.0.1:10810 users:(("Discord",pid=700,fd=40),("Discord",pid=701,fd=41))\n');
    t.ok(ss.length === 2 && ss[1].pid === 701 && ss[0].remote.port === 10810, 'Linux (ss): every process sharing the connection');
    t.ok(await ProcNet.connectsTo([], [1]) === false && await ProcNet.connectsTo([process.pid], []) === false, 'nothing asked, nothing found');
    // Linux reads the kernel's tables: a fake /proc with one established
    // IPv4 loopback connection, one IPv6 one, and one that is listening.
    {
      const os = require('os'); const fs = require('fs');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-proc-'));
      fs.mkdirSync(path.join(root, 'net')); fs.mkdirSync(path.join(root, '700', 'fd'), { recursive: true });
      const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      fs.writeFileSync(path.join(root, 'net', 'tcp'), head
        + '   0: 0100007F:A028 0100007F:2A3A 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0 20 4 30 10 -1\n'
        + '   1: 00000000:2A3A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0 100 0 0 10 0\n');
      fs.writeFileSync(path.join(root, 'net', 'tcp6'), head
        + '   0: 00000000000000000000000001000000:B000 00000000000000000000000001000000:2A3B 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0 20 4 30 10 -1\n');
      if (process.platform !== 'win32') {
        fs.symlinkSync('socket:[11111]', path.join(root, '700', 'fd', '5'));
        fs.symlinkSync('socket:[22222]', path.join(root, '700', 'fd', '6'));
        fs.symlinkSync('socket:[33333]', path.join(root, '700', 'fd', '7'));
        fs.symlinkSync('/dev/null', path.join(root, '700', 'fd', '0'));
        const rows = ProcNet.procConnections([700], root).sort((a, b) => a.remote.port - b.remote.port);
        t.ok(rows.length === 2 && rows[0].remote.host === '127.0.0.1' && rows[0].remote.port === 10810 && rows[1].remote.host === '::1' && rows[1].remote.port === 10811,
          `Linux (/proc): established connections of the process, IPv4 and IPv6, in the kernel's byte order (${JSON.stringify(rows.map((r) => r.remote))})`);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  // Issue #27: the program listening where the PAC that replaced Shroudly's
  // is served, to name it (procnet.listener).
  {
    const os = require('os'); const fs = require('fs');
    const net = '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040\r\n'
      + '  TCP    127.0.0.1:7890         0.0.0.0:0              ABHÖREN         5150\r\n'
      + '  TCP    127.0.0.1:7890         127.0.0.1:61000        HERGESTELLT     5150\r\n'
      + '  TCP    127.0.0.1:61000        127.0.0.1:7890         HERGESTELLT     812\r\n';
    t.ok(ProcNet.parseNetstatListeners(net, 7890).join() === '5150' && ProcNet.parseNetstatListeners(net, 61000).length === 0,
      'Windows: the listening process of a port, whatever language netstat speaks, not a process merely connected to it');
    t.ok(ProcNet.parseTasklistName('"clash-verge.exe","5150","Console","1","48,120 K"\r\n', 5150) === 'clash-verge.exe'
      && ProcNet.parseTasklistName('INFO: No tasks are running which match the specified criteria.\r\n', 5150) === null, 'Windows: its name from tasklist');
    t.ok(JSON.stringify(ProcNet.parseLsofListener('p901\ncClashX Pro\nf9\n')) === '{"pid":901,"name":"ClashX Pro"}' && ProcNet.parseLsofListener('') === null, 'macOS: the listener from lsof');
    if (process.platform !== 'win32') {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-proc-l-'));
      fs.mkdirSync(path.join(root, 'net'), { recursive: true });
      fs.mkdirSync(path.join(root, '900', 'fd'), { recursive: true });
      fs.writeFileSync(path.join(root, '900', 'comm'), 'mihomo\n');
      const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      fs.writeFileSync(path.join(root, 'net', 'tcp'), `${head}   0: 0100007F:1ED2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0 100 0 0 10 0\n`);
      fs.writeFileSync(path.join(root, 'net', 'tcp6'), head);
      fs.symlinkSync('socket:[44444]', path.join(root, '900', 'fd', '3'));
      t.ok(JSON.stringify(ProcNet.procListener(7890, root)) === '{"pid":900,"name":"mihomo"}' && ProcNet.procListener(7891, root) === null, 'Linux (/proc): the listener of a port and its name');
      fs.rmSync(root, { recursive: true, force: true });
    }
    const srv = require('net').createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const who = await ProcNet.listener(srv.address().port);
    srv.close();
    t.ok(process.platform === 'linux' ? (!who || who.pid === process.pid) : (who && who.pid === process.pid && !!who.name),
      `${process.platform}: this process is found listening on its port (${JSON.stringify(who)})`);
  }

  console.log(`autopilot: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
