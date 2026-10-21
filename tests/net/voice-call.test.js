'use strict';

/* A Discord call starting, end to end, as the desktop app wires it
 * (main.js): a browser's or the app's connection to a voice server
 * (c-<region><nn>-<hex>.discord.media, TLS) goes through the real engine,
 * started by EngineManager with --watch discord.media; the engine says
 * "seen"; EngineManager hands it to the autopilot (onHostEvent -> noteHost);
 * the autopilot checks whether this network blocks Discord, and then either
 * asks for Advanced mode or, when it will not ask (declined, turned off by
 * hand), says so in one line with what to do. Nothing in between may
 * swallow it. */

const path = require('path');
const tls = require('tls');
const { ROOT, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
const Autopilot = require(path.join(ROOT, 'electron', 'autopilot.js'));
const t = suite('voice-call');

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), get store() { return Object.fromEntries(m); } };
}

/* A call's first connection: TLS to the voice server's name, through the engine. */
async function call(socksPort, port, name) {
  const raw = await socks(socksPort, '127.0.0.1', port);
  return new Promise((resolve) => {
    const s = tls.connect({ socket: raw, servername: name, ca: testServerOptions().cert, checkServerIdentity: () => undefined }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
}
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; }

(async () => {
  const srv = tls.createServer(testServerOptions(), (c) => { c.on('error', () => {}); c.end(); });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));

  let ap = null;
  const P = await freePort();
  const mem = memStore({ listenPort: P, autoMode: true, dnsProtection: false });
  const em = new EngineManager(mem, {
    addLog: () => {}, watch: Autopilot.WATCH,
    // As main.js wires it.
    onHostEvent: (kind, host, detail, info) => { if (ap) ap.noteHost(kind, host, info || { note: detail }); },
  });
  em.proxy = { apply: async () => ({ ok: true, code: 'ok' }), restore: async () => true, cleanupSync() {} };
  em._describeEnvironment = async () => {};
  await em.start();

  const rig = (store) => {
    const st = { prompts: 0, told: [], logs: [], checked: [] };
    ap = new Autopilot({
      store, log: (l, m) => st.logs.push(m), tell: (id, p) => st.told.push({ id, p }),
      protectionOn: () => em.isActive(),
      // This network blocks Discord by DNS (no answer), as in the report.
      check: async (h) => { st.checked.push(h); await sleep(300); return h === 'discord.com' ? { blocked: true, how: 'dns', detail: 'no answer' } : { blocked: false, detail: 'direct ok' }; },
      services: [{ id: 'discord', name: 'Discord', probe: 'discord.com', mode: 'discordMode', needsApp: true, present: () => true, running: async () => false,
        enable: async () => { store.set('discordMode', true); return { success: true }; }, logOn: 'on', told: 'autoDiscordOn', toldOff: 'autoDiscordOffByHand' }],
      advanced: { available: () => true, active: () => false, session: () => 1, start: async () => { st.prompts++; return { success: true }; }, antiCheat: async () => null },
    });
    return st;
  };
  try {
    {
      // A call starting in the browser before the autopilot knew anything.
      const st = rig(memStore({ autopilotSince: 1 }));
      t.ok(await call(P, port, 'c-fra06-61574a2c.discord.media'), 'a web call\'s connection to its voice server goes through the engine');
      t.ok(await until(() => st.prompts === 1, 5000), `the engine's "seen" reaches the autopilot, Discord is checked (${st.checked.join()}) and found blocked: Advanced mode is asked for`);
      t.ok(st.logs.some((l) => /^Autopilot: c-fra06-61574a2c\.discord\.media needs Advanced mode \(a Discord call is starting; its sound goes over UDP\); asking for permission$/.test(l))
        && st.told.some((x) => x.id === 'autoAdvancedAsk' && x.p.host === 'Discord'), 'the log names the voice server and why; the user is told Discord needs it');
    }
    {
      // Declined two days ago: not asked by itself, and the user is told so.
      const st = rig(memStore({ autopilotSince: 1, advancedDeclinedAt: Date.now() - 2 * 24 * 3600 * 1000 }));
      await ap.survey();
      t.ok(ap.isBlocked('discord'), 'Discord known blocked on this network');
      t.ok(await call(P, port, 'c-ams12-0a1b2c3d.discord.media'), 'a call in the Discord app: its voice server through the engine');
      t.ok(await until(() => st.told.some((x) => x.id === 'autoAdvancedDeclinedBefore'), 5000) && st.prompts === 0,
        'Advanced mode declined earlier: not asked, but one line tells the user what is needed and how');
      t.ok(st.logs.some((l) => /^Autopilot: Discord needs Advanced mode on this network \(a Discord call is starting; its sound goes over UDP\); it was not allowed on \d{4}-\d\d-\d\d, so it is not asked for by itself; turn it on in Settings$/.test(l)),
        'and the log says the same, once');
    }
    {
      // Turned off by hand yesterday.
      const st = rig(memStore({ autopilotSince: 1, advancedModeOffAt: Date.now() - 24 * 3600 * 1000 }));
      await ap.survey();
      t.ok(await call(P, port, 'c-ist03-99aa88bb.discord.media'), 'another call');
      t.ok(await until(() => st.told.some((x) => x.id === 'autoAdvancedOffBefore' && x.p.host === 'Discord'), 5000) && st.prompts === 0,
        'Advanced mode turned off by hand: not turned on, and the user is told');
    }
  } finally {
    await em.stop();
    srv.close();
  }
  console.log(`voice-call: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
