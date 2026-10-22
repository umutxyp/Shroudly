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
function rig({ store = memStore({ autopilotSince: 1 }), present = { discord: true, roblox: true }, running = { discord: false, roblox: false }, blocked = [], adv = null, enableResult = null, check = null } = {}) {
  let clock = 1e12;
  const timers = [];
  const told = [];
  const logs = [];
  const enabled = [];
  const asked = [];
  let on = true;
  const isBlocked = typeof blocked === 'function' ? blocked : (h) => blocked.includes(h);
  const svc = (id, mode, needsApp, probe) => ({
    id, name: id, probe, mode, needsApp,
    present: () => present[id],
    running: async () => running[id],
    enable: async () => { enabled.push(id); if (enableResult) return enableResult; store.set(mode, true); return { success: true }; },
    logOn: `${id} on`, told: `auto-${id}`,
  });
  const ap = new Autopilot({
    store, log: (l, m) => logs.push(m), tell: (id, p) => told.push({ id, p }),
    protectionOn: () => on,
    check: async (h) => { asked.push(h); if (check) return check(h); return isBlocked(h) ? { blocked: true, how: 'tls', detail: 'reset' } : { blocked: false, detail: 'direct ok' }; },
    services: [{ ...svc('discord', 'discordMode', true, 'discord.com'), toldOff: 'autoDiscordOffByHand', toldFailed: 'autoDiscordFailed' },
      { ...svc('roblox', 'appMode', false, 'clientsettingscdn.roblox.com'), toldOff: 'autoRobloxOffByHand', toldFailed: 'autoRobloxFailed' }],
    advanced: adv, now: () => clock,
    later: (fn, ms) => { const x = { fn, at: clock + ms }; timers.push(x); return x; },
  });
  // The clock moves on, and the timers due by then run.
  const tick = (ms) => {
    clock += ms;
    for (const x of timers.filter((y) => y.at <= clock)) { timers.splice(timers.indexOf(x), 1); x.fn(); }
  };
  return { ap, store, told, logs, enabled, asked, timers, tick, off: () => { on = false; }, on: () => { on = true; }, setPresent: (id, v) => { present[id] = v; }, setRunning: (id, v) => { running[id] = v; } };
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

  // ── a network that forges DNS answers: programs that do not use the
  //    system proxy need Games and apps mode (HTTPS_PROXY) ──
  {
    const r = rig();
    t.ok(await r.ap.forgedDns(['discord.com', 'roblox.com']) === true && r.enabled.join() === 'roblox' && r.store.get('appMode') === true
      && r.told.map((x) => x.id).join() === 'autoForgedDnsOn' && r.logs.some((l) => /forges DNS answers \(discord\.com, roblox\.com\); Games and apps mode turned on/.test(l)),
    'forged DNS answers: Games and apps mode turned on by itself, and the user told why');
    t.ok(await r.ap.forgedDns(['discord.com']) === false && r.enabled.length === 1, 'once a run, and not again while it is on');
    const off = rig({ store: memStore({ autopilotSince: 1, appModeOffAt: 1e12 - 1000 }) });
    t.ok(await off.ap.forgedDns(['discord.com']) === false && off.enabled.length === 0 && off.told.map((x) => x.id).join() === 'autoForgedDnsOffByHand',
      'turned off by hand lately: left off, and said once with the date');
    const stopped = rig();
    stopped.off();
    t.ok(await stopped.ap.forgedDns(['discord.com']) === false && stopped.enabled.length === 0, 'protection off: nothing turned on');
    const fail = rig({ enableResult: { success: false, code: 'foreign' } });
    t.ok(await fail.ap.forgedDns(['discord.com']) === false && fail.logs.some((l) => /could not be turned on \(foreign\)/.test(l)), 'a mode that cannot be turned on (another proxy for programs): said, with why');
  }

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
    t.ok(r.enabled.length === 1, 'a mode that could not be turned on (a permission panel cancelled, a proxy of the user\'s own) is not tried again by itself every few minutes');
    t.ok(r.told.length === 1 && r.told[0].id === 'autoDiscordFailed'
      && r.logs.filter((l) => l === 'Autopilot: discord is blocked on this network, but its mode could not be turned on (permission); turn it on in Settings to try again').length === 1,
    'and the user is told once, with what to do');
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
    // At startup the Roblox installer a script started waits for Roblox's
    // verdict: it must not wait for Discord's check (a silent network takes a
    // whole timeout) or for Discord's mode to come on.
    const store = memStore({ autopilotSince: 1 });
    const at = {}; const t0 = Date.now(); const blockedSaid = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let ap = null;
    ap = new Autopilot({
      store, log: () => {}, tell: () => {}, protectionOn: () => true,
      check: async (h) => { await wait(h === 'discord.com' ? 400 : 60); return { blocked: true, how: 'tls', detail: 'timeout' }; },
      onBlocked: (id) => { at[id] = Date.now() - t0; blockedSaid.push([id, store.get(id === 'roblox' ? 'appMode' : 'discordMode')]); },
      services: [
        { id: 'discord', name: 'discord', probe: 'discord.com', mode: 'discordMode', needsApp: true, present: () => true, enable: async () => { await wait(300); store.set('discordMode', true); return { success: true }; }, logOn: '', told: 'x' },
        { id: 'roblox', name: 'roblox', probe: 'clientsettingscdn.roblox.com', mode: 'appMode', needsApp: false, present: () => true, enable: async () => { store.set('appMode', true); return { success: true }; }, logOn: '', told: 'y' },
      ],
    });
    await ap.survey();
    t.ok(at.roblox < 250 && at.discord >= 650, `services are checked side by side: Roblox's verdict after ${at.roblox} ms, not after Discord's check and mode (${at.discord} ms)`);
    t.ok(JSON.stringify(blockedSaid) === '[["roblox",true],["discord",true]]', 'the verdict is told once its mode is on (what then looks at its programs finds the mode on)');
  }
  {
    // A program waiting on the verdict asks for it.
    let online = false; let clock = 1e12;
    const asked = [];
    const store = memStore({ autopilotSince: 1 });
    const ap = new Autopilot({
      store, log: () => {}, tell: () => {}, protectionOn: () => true, now: () => clock,
      check: async (h) => { asked.push(h); return online ? { blocked: true, how: 'tls', detail: 'reset' } : { blocked: false, unknown: true, detail: 'offline' }; },
      services: [{ id: 'roblox', name: 'roblox', probe: 'clientsettingscdn.roblox.com', mode: 'appMode', needsApp: false, present: () => true, enable: async () => { store.set('appMode', true); return { success: true }; }, logOn: '', told: 'x' }],
    });
    t.ok(await ap.checkSoon('roblox') === false && asked.length === 1, 'no verdict yet: checked at once, without waiting for the survey');
    clock += 5000;
    t.ok(await ap.checkSoon('roblox') === false && asked.length === 1, `nothing learnt (offline): not again within ${Autopilot.SOON_MS / 1000} s`);
    online = true; clock += Autopilot.SOON_MS;
    t.ok(await ap.checkSoon('roblox') === true && asked.length === 2 && ap.isBlocked('roblox'), 'then again (not after the ten-minute survey): blocked');
    t.ok(await ap.checkSoon('roblox') === true && asked.length === 2, 'a known verdict is not checked again');
    const ap2 = new Autopilot({
      store: memStore({ autopilotSince: 1 }), log: () => {}, tell: () => {}, protectionOn: () => true, now: () => clock,
      check: async (h) => { asked.push(h); return { blocked: false, detail: 'direct ok' }; },
      services: [{ id: 'roblox', name: 'roblox', probe: 'clientsettingscdn.roblox.com', mode: 'appMode', needsApp: false, present: () => true, enable: async () => ({ success: true }), logOn: '', told: 'x' }],
    });
    await ap2.checkSoon('roblox'); clock += 60000;
    t.ok(await ap2.checkSoon('roblox') === false && asked.length === 3, 'Roblox works without Shroudly here: not asked again for hours, however many programs wait');
  }
  {
    // A filter that drops silently is known within one handshake timeout
    // (the second try is not made to wait for the first to give up), and
    // the handshake through Shroudly is made alongside.
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let through = 0;
    const silent = async (o) => { if (o.socket) { through++; await wait(40); return 'ok'; } await wait(300); return 'timeout'; };
    const t0 = Date.now();
    const c = await BlockCheck.check('clientsettingscdn.roblox.com', { socksPort: 1, connect: async () => ({}), resolve: async () => ['128.116.1.1'], handshake: silent, retryMs: 100 });
    const took = Date.now() - t0;
    t.ok(c.blocked && c.how === 'tls' && took < 470 && through === 1, `silent filter: blocked after ${took} ms (one timeout and the retry gap; was two timeouts, the gap and the engine's handshake: ${300 + 100 + 300 + 40} ms)`);
    let direct = 0;
    const fine = async (o) => { if (o.socket) { through++; return 'ok'; } direct++; await wait(20); return 'ok'; };
    const c2 = await BlockCheck.check('clientsettingscdn.roblox.com', { socksPort: 1, connect: async () => ({}), resolve: async () => ['128.116.1.1'], handshake: fine, retryMs: 100 });
    await wait(150);
    t.ok(!c2.blocked && c2.detail === 'direct ok' && direct === 1, 'working directly: one handshake, the second try never made');
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


  // ── Discord: its app stuck, or a call starting, on a network that blocks it ──
  {
    const advRig = (opts = {}) => {
      const st = { started: 0, prompts: 0 };
      const adv = {
        available: () => true, active: () => st.started > 0,
        start: async () => { st.prompts++; await new Promise((r) => setImmediate(r)); if (opts.decline) return { success: false, code: 'declined' }; st.started++; return { success: true }; },
        antiCheat: async () => opts.antiCheat || null,
      };
      return { st, r: rig({ blocked: ['discord.com'], adv, running: { discord: !!opts.running, roblox: false }, store: opts.store }) };
    };
    t.ok(['c-ist01-1a2b.discord.media', 'C-FRA06-61574A2C.Discord.Media.', 'rotterdam1234.discord.media', 'us-east123.discord.media',
      'sweetwater-12345.discord.media'].every((h) => Autopilot.voiceOf(h) === 'discord') && Autopilot.WATCH.join() === 'discord.media',
    "Discord's voice servers are recognised, in today's names and older ones, and their domain is what the engine is asked to tell");
    t.ok(['latency.discord.media', 'discord.media', 'x.c-fra06-1.discord.media', 'discord.com', 'notdiscord.media', 'c-fra06-1.discord.media.example']
      .every((h) => Autopilot.voiceOf(h) === null),
    "but no other name there: the region test every open client fetches (latency.discord.media) and the domain itself are no call");
    {
      const { st, r } = advRig({ running: true });
      await r.ap.survey();
      await settle();
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      t.ok(st.prompts === 1 && st.started === 1, "Discord blocked here, its app open, its gateway opened by no technique (silently): Advanced mode is asked for");
      const ask = r.told.find((x) => x.id === 'autoAdvancedAsk');
      // (The rig names its services by their id.)
      t.ok(ask && ask.p.host === 'discord' && r.logs.some((l) => /gateway\.discord\.gg needs Advanced mode \(discord is open and cannot reach it\)/.test(l)),
        'the user is told the service needs it, by its name; the log names the gateway and why');
      r.ap.noteHost('seen', 'c-fra06-1.discord.media');
      await settle();
      t.ok(st.prompts === 1, 'never twice in a session');
    }
    {
      const { st, r } = advRig({ running: false });
      await r.ap.survey();
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      r.ap.noteHost('blocked', 'discord.com', { siteOk: true });
      await settle();
      t.ok(st.prompts === 0, 'the same failure with no Discord app open: not asked (a browser has the window\'s own offer)');
      r.setRunning('discord', true);
      r.ap.noteHost('blocked', 'discord.com', { siteOk: true });
      await settle();
      t.ok(st.prompts === 1, 'once the app is open, its own page that does not answer counts too');
    }
    {
      const { st, r } = advRig({ running: false });
      await r.ap.survey();
      r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      await settle();
      t.ok(st.prompts === 1 && r.told.find((x) => x.id === 'autoAdvancedOn').p.host === 'discord',
        'a call starting (a voice server, from a browser too) on a network that blocks Discord: Advanced mode, for the sound that goes over UDP');
    }
    {
      // Discord's app fetches latency.discord.media to rank the regions each
      // time it connects, call or not: on a network known to block Discord,
      // with the app open, that is no call and asks nothing.
      const { st, r } = advRig({ running: true });
      await r.ap.survey();
      r.ap.noteHost('seen', 'latency.discord.media');
      r.ap.noteHost('seen', 'discord.media');
      await settle();
      t.ok(st.prompts === 0 && !r.told.some((x) => x.id === 'autoAdvancedAsk') && !r.ap.signs.size,
        'the region test seen on a network that blocks Discord, its app open: no call, no prompt');
      r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      await settle();
      t.ok(st.prompts === 1 && r.logs.some((l) => /c-ist01-77\.discord\.media needs Advanced mode \(a discord call is starting/.test(l)),
        'a voice server right after: Advanced mode is asked for, as before');
      const b = advRig({ running: true });
      b.r.ap.noteHost('seen', 'latency.discord.media');
      await settle();
      t.ok(!b.r.asked.length && b.st.prompts === 0, 'before Discord was looked at, the region test is no reason to check it either');
    }
    {
      // The call before the check: the check is of discord.com, not of the
      // voice server's own name, and its verdict brings the ask.
      const { st, r } = advRig({ running: false });
      r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      await settle();
      t.ok(r.asked.join() === 'discord.com' && r.ap.isBlocked('discord') && st.prompts === 1, 'a call starting before Discord was looked at: discord.com is checked, and found blocked, Advanced mode is asked for');
    }
    {
      const { st, r } = advRig({ running: true });
      r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      await settle();
      t.ok(st.prompts === 1, 'two signs at once: one prompt');
    }
    {
      const { st, r } = advRig({ running: true });
      await r.ap.survey();
      r.ap.noteHost('blocked', 'gateway.discord.gg', { alert: true });
      r.ap.noteHost('blocked', 'cdn.discordapp.com', { siteOk: true });
      r.ap.noteHost('blocked', 'status.discord.com', { note: 'silent' });
      r.ap.noteHost('seen', 'gateway.discord.gg');
      r.ap.noteHost('cut', 'discord.com', { note: 'stall' });
      r.ap.noteHost('seen', 'media.tenor.com');
      r.ap.noteHost('bypass', 'cdn.discordapp.com');
      await settle();
      t.ok(st.prompts === 0, "the server's own refusal, another name that does not answer while the site works, silence from a minor name, a single cut, a third party and a name that opened: none of them asks");
      r.ap.noteHost('cut', 'cdn.discordapp.com', { believed: true });
      await settle();
      t.ok(st.prompts === 1, 'a cut the engine believes, on any of its names, with the app open, does');
    }
    {
      const { st, r } = advRig({ running: true, store: memStore({ autopilotSince: 1, advancedDeclinedAt: 1e12 - 1000 }) });
      await r.ap.survey();
      r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      t.ok(st.prompts === 0, 'declined in the last two weeks: not asked by itself');
      const a2 = advRig({ running: true, antiCheat: 'vgc.exe' });
      await a2.r.ap.survey();
      a2.r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      await settle();
      t.ok(a2.st.prompts === 0 && a2.r.logs.some((l) => /anti-cheat/.test(l)), "a game's anti-cheat running: not by itself");
    }
    {
      // Discord not blocked here: a call is nobody's business.
      let started = 0;
      const r = rig({ blocked: [], adv: { available: () => true, active: () => false, start: async () => { started++; return { success: true }; } }, running: { discord: true, roblox: false } });
      r.ap.noteHost('seen', 'c-ist01-77.discord.media');
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      t.ok(started === 0 && r.asked.join() === 'discord.com', 'on a network that does not block Discord, nothing is asked (it is checked once, and found working)');
    }
    {
      // A silent failure is no reason to check by itself: the sign waits for
      // the check that comes anyway (the survey).
      const a = advRig({ running: true });
      a.r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      t.ok(!a.r.asked.length && a.st.prompts === 0, 'a sign alone, before Discord is known blocked, asks nothing and checks nothing');
      await a.r.ap.survey();
      await settle();
      t.ok(a.st.prompts === 1, 'the next look finds Discord blocked: the waiting sign is acted on');
      const b = advRig({ running: true });
      b.r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      b.r.ap.networkChanged();
      await b.r.ap.survey();
      await settle();
      t.ok(b.st.prompts === 0, 'a network change forgets the signs too');
      const c = advRig({ running: true });
      c.r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      c.r.tick(Autopilot.SIGN_MS + 1000);
      await c.r.ap.survey();
      await settle();
      t.ok(c.st.prompts === 0, 'a sign older than its time is not acted on');
    }
  }

  // ── a call's sign is never swallowed between it and the verdict, and when
  //    Advanced mode is not asked for, the user is told why and what to do ──
  {
    const day = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    const V = 'c-fra06-61574a2c.discord.media';
    const dc = (r) => r.asked.filter((h) => h === 'discord.com').length;   // a voice server's name as Discord hands it out
    const advRig2 = (opts = {}) => {
      const st = { started: 0, prompts: 0, result: opts.result || null };
      const adv = {
        available: () => true, active: () => st.started > 0,
        start: async () => { st.prompts++; await new Promise((r) => setImmediate(r)); if (st.result) return st.result; st.started++; return { success: true }; },
        antiCheat: async () => opts.antiCheat || null,
      };
      return { st, r: rig({ adv, blocked: opts.blocked || ['discord.com'], store: opts.store, check: opts.check, running: { discord: !!opts.running, roblox: false } }) };
    };
    {
      // The call starts while the check is under way; the network changes
      // (a resume's Wi-Fi coming back) before the verdict: the new network's
      // verdict still finds the call.
      let release;
      const { st, r } = advRig2({ check: (h) => (h === 'discord.com' ? new Promise((res) => { release = res; }) : { blocked: false, detail: 'direct ok' }) });
      r.ap.noteHost('seen', V);
      await settle();
      r.ap.networkChanged();
      release({ blocked: true, how: 'dns', detail: 'no answer' });
      await settle();
      t.ok(!r.ap.isBlocked('discord') && st.prompts === 0, 'a verdict from the network before the change is dropped');
      t.ok(r.ap.signs.has('discord') && r.ap.signs.get('discord').voice, "but the call's sign is kept across the network change");
      const p = r.ap.survey();
      await settle();
      release({ blocked: true, how: 'dns', detail: 'no answer' });
      await p; await settle();
      t.ok(st.prompts === 1 && r.logs.some((l) => l.includes(`${V} needs Advanced mode (a discord call is starting`)),
        "the new network's verdict asks for Advanced mode for the call that started before it");
    }
    {
      // Offline a moment ago (just woken up): the call is checked once that
      // has passed, not left to a survey ten minutes later (after the sign
      // would have run out).
      let offline = true;
      const { st, r } = advRig2({ check: (h) => (offline ? { unknown: true, detail: 'offline' } : { blocked: h === 'discord.com', how: 'dns', detail: 'no answer' }) });
      await r.ap.survey();
      t.ok(dc(r) === 1 && !r.ap.isBlocked('discord'), 'offline: nothing learnt');
      offline = false;
      r.ap.noteHost('seen', V);
      await settle();
      t.ok(dc(r) === 1 && r.timers.length === 1, 'a call right after: not checked at once (offline a moment ago), but a check is due');
      r.tick(Autopilot.SOON_MS); await settle();
      t.ok(dc(r) === 1, 'not before its time');
      r.tick(2 * 60 * 1000); await settle(); await settle();
      t.ok(dc(r) === 2 && r.ap.isBlocked('discord') && st.prompts === 1, 'then checked, found blocked, and Advanced mode asked for the call');
    }
    {
      // Woken up: no service is judged while the network comes back; the
      // check comes after.
      const { st, r } = advRig2();
      r.ap.resumed();
      r.ap.noteHost('seen', V);
      await r.ap.survey();
      await settle();
      t.ok(dc(r) === 0 && st.prompts === 0, 'just woken up: no check at all');
      r.tick(31000); await settle(); await settle();
      t.ok(dc(r) === 1 && st.prompts === 1, 'once the quiet time is over: checked, blocked, asked');
    }
    {
      // Advanced mode declined three days ago: the call is not asked about
      // by itself, and the user is told so, once, with what to do.
      const at = 1e12 - 3 * 24 * 3600 * 1000;
      const { st, r } = advRig2({ store: memStore({ autopilotSince: 1, advancedDeclinedAt: at }) });
      await r.ap.survey();
      r.ap.noteHost('seen', V);
      await settle();
      const n = r.told.filter((x) => x.id === 'autoAdvancedDeclinedBefore');
      t.ok(st.prompts === 0 && n.length === 1 && n[0].p.host === 'discord' && n[0].p.date === day(at), `declined three days ago: not asked, but told (${JSON.stringify(n[0] && n[0].p)})`);
      t.ok(r.logs.some((l) => l === `Autopilot: discord needs Advanced mode on this network (a discord call is starting; its sound goes over UDP); it was not allowed on ${day(at)}, so it is not asked for by itself; turn it on in Settings`),
        'one line in the log says what is needed, why it was not asked, and what to do');
      r.tick(60000);
      r.ap.noteHost('seen', 'c-fra06-0a0b0c0d.discord.media');
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      t.ok(r.told.filter((x) => x.id === 'autoAdvancedDeclinedBefore').length === 1, 'once a session, not once per call');
    }
    {
      // Turned off by hand yesterday: the same, with that reason.
      const { st, r } = advRig2({ store: memStore({ autopilotSince: 1, advancedModeOffAt: 1e12 - 24 * 3600 * 1000 }) });
      await r.ap.survey();
      r.ap.noteHost('seen', V);
      await settle();
      t.ok(st.prompts === 0 && r.told.some((x) => x.id === 'autoAdvancedOffBefore' && x.p.host === 'discord')
        && r.logs.some((l) => /it was turned off by hand on \d{4}-\d\d-\d\d, so it is not turned on by itself; turn it on in Settings$/.test(l)),
      'turned off by hand: not turned on by itself, and the user is told so');
    }
    {
      // Asked earlier this session for another site, and it could not
      // start: the call is told about, not silently dropped.
      const { st, r } = advRig2({ result: { success: false, code: 'start_failed' } });
      await r.ap.needAdvanced('cut.example');
      t.ok(st.prompts === 1 && r.told.some((x) => x.id === 'autoAdvancedFailed'), 'an earlier ask for another site failed');
      await r.ap.survey();
      r.ap.noteHost('seen', V);
      await settle();
      t.ok(st.prompts === 1 && r.told.some((x) => x.id === 'autoAdvancedFailedBefore' && x.p.host === 'discord'), 'the call after it: not asked again this session, but told');
    }
    {
      // An ask for another site still on screen when the call starts, then
      // declined: the call's need is said too.
      let answer;
      const st = { prompts: 0 };
      const adv = { available: () => true, active: () => false, antiCheat: async () => null,
        start: () => { st.prompts++; return new Promise((res) => { answer = res; }); } };
      const r = rig({ adv, blocked: ['discord.com'] });
      await r.ap.survey();
      const first = r.ap.needAdvanced('cut.example');
      await settle();
      r.ap.noteHost('seen', V);
      await settle();
      answer({ success: false, code: 'declined' });
      await first; await settle(); await settle();
      t.ok(st.prompts === 1 && r.told.some((x) => x.id === 'autoAdvancedDeclined' && x.p.host === 'cut.example')
        && r.told.some((x) => x.id === 'autoAdvancedDeclinedBefore' && x.p.host === 'discord'),
      'a call that joined an ask for another site, declined: the call is told about too, one prompt in all');
    }
    {
      // A Stop answered an ask: nothing was decided, and the next session asks.
      const { st, r } = advRig2({ result: { success: false, code: 'protection_off' } });
      await r.ap.needAdvanced('a.example');
      t.ok(r.ap.advancedAsked === false && r.ap.willAskAdvanced() === true && !r.told.some((x) => /Before$/.test(x.id)),
        'an ask a Stop cut short does not count as asked: a later call is asked about');
      st.result = null;
    }
    {
      // An anti-cheat running: said once, with the program and what to do.
      const { st, r } = advRig2({ antiCheat: 'vgc.exe' });
      await r.ap.survey();
      r.ap.noteHost('seen', V);
      await settle();
      t.ok(st.prompts === 0 && r.told.some((x) => x.id === 'autoAdvancedAntiCheat' && x.p.program === 'vgc.exe' && x.p.host === 'discord'),
        "a game's anti-cheat running: not started by itself, and the user is told");
    }
    {
      // Any site that needs Advanced mode (a cut the engine believes, Roblox):
      // the same line, about that site.
      const { st, r } = advRig2({ store: memStore({ autopilotSince: 1, advancedDeclinedAt: 1e12 - 1000 }) });
      t.ok(await r.ap.needAdvanced('cut.example') === false && st.prompts === 0
        && r.told.some((x) => x.id === 'autoAdvancedDeclinedBefore' && x.p.host === 'cut.example'),
      'a cut site needing Advanced mode, declined earlier: told once, about that site');
    }
    {
      // A mode turned off by hand, its service blocked: said once, with the date.
      const r = rig({ store: memStore({ autopilotSince: 1, discordModeOffAt: 1e12 - 1000, appModeOffAt: 1e12 - 2000 }), blocked: ['discord.com', 'clientsettingscdn.roblox.com'] });
      await r.ap.survey();
      await r.ap.survey();
      t.ok(!r.enabled.length && r.told.filter((x) => x.id === 'autoDiscordOffByHand').length === 1 && r.told.filter((x) => x.id === 'autoRobloxOffByHand').length === 1
        && r.logs.some((l) => /^Autopilot: discord is blocked on this network, but its mode was turned off by hand on \d{4}-\d\d-\d\d; turn it on in Settings to use its app$/.test(l)),
      'a blocked service whose mode was turned off by hand: left off, and the user is told once, with the date and what to do');
    }
    {
      // The clock set back: a choice "made in the future" counts as made
      // now, not as two weeks from some later day.
      const store = memStore({ autopilotSince: 1, advancedDeclinedAt: 1e12 + 30 * 24 * 3600 * 1000 });
      const r = rig({ store, adv: { available: () => true, active: () => false, start: async () => ({ success: true }) } });
      t.ok(r.ap.willAskAdvanced() === false && store.get('advancedDeclinedAt') === 1e12, 'a decline dated in the future (clock set back) counts from now');
      r.tick(Autopilot.RESPECT_OFF_MS + 1000);
      t.ok(r.ap.willAskAdvanced() === true, 'and ends two weeks later, not a month later');
    }
    {
      // Before restarting a program on an old verdict: a re-check that
      // learns nothing (offline) is no reason to restart it.
      let offline = false;
      const r = rig({ check: (h) => (offline ? { unknown: true, detail: 'offline' } : { blocked: h === 'discord.com', how: 'dns', detail: 'no answer' }) });
      await r.ap.survey();
      t.ok(await r.ap.stillBlocked('discord') === true, 'fresh verdict: still blocked');
      offline = true;
      r.tick(11 * 60 * 1000);
      t.ok(await r.ap.stillBlocked('discord') === false, 'an old verdict and a re-check that learns nothing: not known blocked now, nothing restarted');
    }
  }

  // ── a Stop of protection while the autopilot asks: the Stop wins ──
  {
    // advanced.session() changes with each Stop; the anti-cheat look and the
    // app check hold until the test lets them go.
    const stopRig = ({ startResult = { success: true }, running = false } = {}) => {
      const st = { session: 0, starts: [], hold: null, release: null };
      const gate = () => { st.hold = new Promise((res) => { st.release = res; }); return st.hold; };
      const adv = {
        available: () => true, active: () => false, session: () => st.session,
        start: async (since) => { st.starts.push(since); return startResult; },
        antiCheat: async () => { await gate(); return null; },
      };
      const r = rig({ blocked: ['discord.com'], adv, running: { discord: running, roblox: false } });
      return { st, r };
    };
    {
      const { st, r } = stopRig();
      const p = r.ap.needAdvanced('a.example');
      await settle();
      st.session++; r.off();                 // Stop while the anti-cheat look runs
      st.release();
      t.ok(await p === false && !st.starts.length && !r.told.length && r.ap.advancedAsked === false,
        'protection stopped while the anti-cheat look ran: no prompt, nothing told, and a later session may still ask');
    }
    {
      const { st, r } = stopRig();
      const p = r.ap.needAdvanced('a.example');
      await settle();
      st.session++;                          // Stop and a quick Start
      st.release();
      t.ok(await p === false && !st.starts.length, 'a Stop and a quick Start meanwhile: the ask belonged to the stopped session, nothing is asked');
    }
    {
      const { st, r } = stopRig();
      const p = r.ap.needAdvanced('a.example');
      await settle();
      st.release();
      t.ok(await p === true && st.starts.join() === '0', 'no Stop: asked as ever, the start carrying the session it began in');
    }
    {
      const { st, r } = stopRig({ startResult: { success: false, code: 'protection_off' } });
      const p = r.ap.needAdvanced('a.example');
      await settle();
      st.release();
      t.ok(await p === false && r.told.map((x) => x.id).join() === 'autoAdvancedAsk' && !r.store.get('advancedDeclinedAt'),
        'stopped before it came up (main.js stops it again): no "did not start" line, no decline recorded');
    }
    {
      // The app check of a stuck Discord is an await too.
      const { st, r } = stopRig({ running: true });
      let let_go = null;
      r.ap.services[0].running = () => new Promise((res) => { let_go = res; });
      await r.ap.survey();
      r.ap.noteHost('blocked', 'gateway.discord.gg', { note: 'silent' });
      await settle();
      st.session++;                          // Stop and Start while the app is looked for
      let_go(true);
      await settle();
      if (st.release) st.release();
      await settle();
      t.ok(!st.starts.length && !r.told.some((x) => x.id === 'autoAdvancedAsk'), 'a Stop while the app was looked for: nothing is asked either');
    }
  }

  // ── a game's anti-cheat: no packet driver loaded beside it by itself ──
  {
    const row = (n, pid = 100) => `"${n}","${pid}","Console","1","9,000 K"`;
    const ps = (...names) => names.map((n, i) => row(n, 100 + i)).join('\r\n');
    // The reported PC: Riot Vanguard's service and tray icon, there from the
    // boot on, no game open (and Discord, Shroudly).
    t.ok(Autopilot.antiCheatIn(ps('svchost.exe', 'vgc.exe', 'vgtray.exe', 'Discord.exe', 'Shroudly.exe')) === null,
      "an anti-cheat's service and tray icon that run whenever the PC is on, with no game open: no game being played");
    t.ok(Autopilot.antiCheatIn(ps('EasyAntiCheat_EOS.exe', 'BEService.exe', 'FACEIT.exe', 'faceitservice.exe', 'PnkBstrA.exe', 'EAAntiCheat.GameService.exe')) === null,
      'the services Easy Anti-Cheat, BattlEye, FACEIT, PunkBuster and EA leave running: not a game either');
    t.ok(Autopilot.antiCheatIn(ps('vgc.exe', 'vgtray.exe', 'VALORANT-Win64-Shipping.exe')) === 'VALORANT-Win64-Shipping.exe',
      'VALORANT open beside Vanguard: the game is found, by its name');
    t.ok(Autopilot.antiCheatIn(ps('vgc.exe', 'League of Legends.exe')) === 'League of Legends.exe', 'League beside Vanguard: found');
    t.ok(Autopilot.antiCheatIn(ps('EasyAntiCheat_EOS.exe', 'SomeNewGame-Win64-Shipping.exe')) === 'SomeNewGame-Win64-Shipping.exe',
      'an Unreal game not on the list, beside Easy Anti-Cheat: found');
    t.ok(Autopilot.antiCheatIn(ps('BEService.exe', 'DayZ_BE.exe')) === 'DayZ_BE.exe', "a BattlEye game's own program beside its service: found");
    t.ok(Autopilot.antiCheatIn(ps('faceitservice.exe', 'cs2.exe')) === 'cs2.exe', 'CS2 beside FACEIT: found');
    t.ok(Autopilot.antiCheatIn(ps('svchost.exe', 'GameMon64.des')) === 'GameMon64.des', "an anti-cheat's in-game part counts by itself");
    t.ok(Autopilot.antiCheatIn(ps('SomeIndie-Win64-Shipping.exe', 'cs2.exe')) === null, 'a game with no anti-cheat running: nothing to keep away from');
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
    // Just woken up: the computer's own network is not back yet. Its own
    // errors say nothing about the service; and a network that comes back
    // while the engine's handshake runs answers the second direct look.
    const c8 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['162.159.128.233'], handshake: hsBoth('ENETUNREACH', 'ok') });
    t.ok(!c8.blocked && c8.unknown, `this computer not on a network yet (ENETUNREACH): unknown, not blocked (${c8.detail})`);
    let looks = 0;
    const c9 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => (looks++ === 0 ? null : ['162.159.128.233']), handshake: hsBoth('ok', 'ok') });
    t.ok(!c9.blocked && looks === 2, `no DNS answer at first, an answer and a handshake a moment later: not blocked (${c9.detail})`);
    let resets = 0;
    const c10 = await BlockCheck.check('discord.com', { ...engineOk, resolve: async () => ['162.159.128.233'], handshake: async (o) => (o.socket ? 'ok' : (resets++ < 2 ? 'reset' : 'ok')) });
    t.ok(!c10.blocked, 'reset twice while the network came back, then fine: not blocked');
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

  // Whether anything still listens where the user's own PAC was served, at
  // a restore (system-proxy.js, _pacGone): every user's sockets, read at
  // once; "cannot be told" when the tool says nothing.
  {
    const os = require('os'); const fs = require('fs');
    const bsd = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n'
      + 'tcp4       0      0  127.0.0.1.7890         *.*                    LISTEN\n'
      + 'tcp4       0      0  127.0.0.1.61000        127.0.0.1.8118         ESTABLISHED\n'
      + 'tcp46      0      0  *.631                  *.*                    LISTEN\n';
    t.ok(ProcNet.parseBsdListening(bsd, 7890) === true && ProcNet.parseBsdListening(bsd, 631) === true && ProcNet.parseBsdListening(bsd, 8118) === false
      && ProcNet.parseBsdListening(bsd, 61000) === false && ProcNet.parseBsdListening('', 7890) === null,
    'macOS (netstat): a listening port, on loopback or any address; not one only connected to; nothing said: unknown');
    if (process.platform !== 'win32') {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-proc-ls-'));
      fs.mkdirSync(path.join(root, 'net'), { recursive: true });
      const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      fs.writeFileSync(path.join(root, 'net', 'tcp'), `${head}   0: 0100007F:1ED2 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 44444 1 0 100 0 0 10 0\n`
        + '   1: 0100007F:EE48 0100007F:1F96 01 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0 100 0 0 10 0\n');
      fs.writeFileSync(path.join(root, 'net', 'tcp6'), head);
      t.ok(ProcNet.procListening(7890, root) === true && ProcNet.procListening(8086, root) === false && ProcNet.procListening(7890, path.join(root, 'none')) === null,
        'Linux (/proc): a listening port of any user, not one only connected to; no tables: unknown');
      fs.rmSync(root, { recursive: true, force: true });
    }
    const srv = require('net').createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const on = ProcNet.listeningSync(port);
    await new Promise((r) => srv.close(r));
    const off = ProcNet.listeningSync(port);
    t.ok(on === true && off === false, `${process.platform}: a port this process listens on is seen at once, and no longer once it is closed (${on}, ${off})`);
  }

  console.log(`autopilot: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
