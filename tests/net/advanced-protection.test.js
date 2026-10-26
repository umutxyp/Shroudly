'use strict';

/* Advanced mode as part of protection (electron/advanced-protection.js): it
 * stops with protection, comes back at the user's next Start, and a Stop wins
 * over a start on protection's behalf (that return, the autopilot's ask)
 * still looking for a game's anti-cheat or waiting for its permission prompt:
 * WinDivert / NFQUEUE must never stay on after the user stopped protection. */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const AdvancedProtection = require(path.join(ROOT, 'electron', 'advanced-protection.js'));
const t = suite('advanced-protection');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

// A start that never answers would let the process end quietly, as if passed.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) { console.error('FAIL advanced-protection: ended before the last test (a start never answered)'); process.exitCode = 1; }
});

/* A backend whose permission prompt waits for the test (answer(true|false)),
 * an anti-cheat look that can be held (holdScan), and Stop and Start as
 * main.js's safeStop and safeStart do them. */
function rig({ antiCheat = null, holdScan = false } = {}) {
  const b = { active: false, prompts: 0, stops: 0, answer: null, scanDone: null };
  let on = true;
  const logs = [];
  let declines = 0;
  const g = new AdvancedProtection({
    active: () => b.active,
    start: () => {
      if (b.active) return Promise.resolve({ success: true, alreadyActive: true });
      b.prompts++;
      return new Promise((res) => {
        b.answer = (yes) => { b.answer = null; if (yes) b.active = true; res(yes ? { success: true } : { success: false, code: 'declined' }); };
      });
    },
    stop: async () => { b.stops++; b.active = false; },
    protectionOn: () => on,
    antiCheat: () => (holdScan ? new Promise((res) => { b.scanDone = () => res(antiCheat); }) : Promise.resolve(antiCheat)),
    declined: () => { declines++; },
    log: (l, m) => logs.push(m),
  });
  return {
    g, b, logs,
    get declines() { return declines; },
    get on() { return on; },
    stop: async (user = true) => { await g.stopped({ user }); on = false; },
    start: () => { on = true; return g.started(); },
  };
}

(async () => {
  // ── it stops with protection, and comes back with the user's Start ──
  {
    const r = rig();
    r.b.active = true;
    await r.stop();
    t.ok(r.b.stops === 1 && !r.b.active && r.g.resume === true, "the user's Stop stops Advanced mode with it, to come back with their next Start");
    const p = r.start();
    await settle();
    t.ok(r.b.prompts === 1, 'their Start asks for it again (one permission prompt)');
    r.b.answer(true);
    await p;
    t.ok(r.b.active && r.g.resume === false && r.logs.some((l) => /turning it back on/.test(l)), 'allowed: it is on again, once');
  }
  {
    const r = rig();
    r.b.active = true;
    await r.stop(false);
    await r.start();
    t.ok(r.b.stops === 1 && r.b.prompts === 0, 'a Stop that is not the user\'s stops it too, but it does not come back by itself');
    const h = rig();
    h.b.active = true;
    await h.stop();
    h.g.offByHand();
    await h.start();
    t.ok(h.b.prompts === 0, 'turned off by hand meanwhile: it does not come back');
    const d = rig();
    d.b.active = true;
    await d.stop();
    const p = d.start();
    await settle();
    d.b.answer(false);
    await p;
    t.ok(d.declines === 1 && !d.b.active && d.g.resume === false, 'declined at the prompt: recorded as declined, and not asked again by the next Start');
    const a = rig({ antiCheat: 'vgc.exe' });
    a.b.active = true;
    await a.stop();
    await a.start();
    t.ok(a.b.prompts === 0 && a.logs.some((l) => /anti-cheat is running \(vgc\.exe\)/.test(l)), "a game's anti-cheat running: not loaded by itself beside it");
  }

  // ── a Stop while the return is under way wins ──
  {
    const r = rig({ holdScan: true });
    r.b.active = true;
    await r.stop();
    const p = r.start();
    await settle();
    await r.stop();                       // Stop while the anti-cheat look runs
    r.b.scanDone();
    await settle();
    t.ok(r.b.prompts === 0 && r.g.resume === true, 'a Stop while the anti-cheat look ran: no prompt after it, and the next Start still brings it back');
    await p;
    const q = r.start();
    await settle();
    r.b.scanDone();
    await settle();
    t.ok(r.b.prompts === 1, 'which it does');
    r.b.answer(true);
    await q;
    t.ok(r.b.active && r.on, 'on again with protection');
  }
  {
    const r = rig();
    r.b.active = true;
    await r.stop();
    const p = r.start();
    await settle();
    t.ok(r.b.prompts === 1 && !r.b.active, 'the prompt is up');
    await r.stop();                       // Stop while the prompt is up
    t.ok(r.b.stops === 1, 'nothing is running yet for the Stop to stop');
    r.b.answer(true);                     // ... and then the user allows it
    await p;
    t.ok(!r.b.active && r.b.stops === 2 && r.g.resume === true
      && r.logs.some((l) => /Protection was stopped while Advanced mode was starting/.test(l)),
    'allowed after the Stop: the backend that came up is stopped again at once, with protection off, and comes back with the next Start');
    const q = r.start();
    await settle();
    r.b.answer(true);
    await q;
    t.ok(r.b.active && r.b.prompts === 2, 'the next Start brings it back');
  }
  {
    // A Stop and a quick Start while the first prompt is up: the backend
    // belongs to the stopped session; the Start that came after brings it
    // back once the first answer is in, with its own prompt.
    const r = rig();
    r.b.active = true;
    await r.stop();
    const p1 = r.start();
    await settle();
    await r.stop();
    const p2 = r.start();
    await settle();
    t.ok(r.b.prompts === 1, 'the second Start waits for the answer to the first prompt (no second prompt over it)');
    r.b.answer(true);
    await p1;
    await settle();
    t.ok(r.b.stops === 2 && r.b.prompts === 2, 'allowed: the backend of the stopped session is stopped, and the second Start asks again');
    r.b.answer(true);
    await p2;
    t.ok(r.b.active && r.g.resume === false, 'and it is on, with protection');
  }

  // ── the autopilot's ask goes through the same door ──
  {
    const r = rig();
    const since = r.g.session();
    const p = r.g.start(since);
    await settle();
    await r.stop();
    r.b.answer(true);
    const res = await p;
    t.ok(res.code === 'protection_off' && !r.b.active && r.g.resume === true,
      "the autopilot's start allowed after a Stop: stopped again, answered protection_off, and back with the next Start");
    const r2 = rig();
    const s2 = r2.g.session();
    await r2.stop();
    await r2.start();
    const res2 = await r2.g.start(s2);
    t.ok(res2.code === 'protection_off' && r2.b.prompts === 0, 'a start from a session already stopped asks nothing, even with protection on again');
    const r3 = rig();
    const ok = await (async () => { const q = r3.g.start(r3.g.session()); await settle(); r3.b.answer(true); return q; })();
    t.ok(ok.success && r3.b.active, 'no Stop: it starts as ever');
  }
  {
    // The Settings panel's own start does not go through here and works with
    // protection off: an ask from before the Stop, answered later, leaves
    // the backend the user started by hand alone.
    const r = rig();
    const since = r.g.session();
    await r.stop();
    r.b.active = true;                    // turned on by hand in Settings
    const res = await r.g.start(since);
    t.ok(r.b.active && r.b.stops === 0 && r.b.prompts === 0 && res.code === 'protection_off',
      'Advanced mode turned on by hand with protection off is not stopped by it');
  }

  // ── a game with an anti-cheat starting while Advanced mode runs ──
  {
    const b = { active: true, prompts: 0, stops: 0 };
    let game = null;
    let on = true;
    let answer = true;
    const told = [];
    const logs = [];
    const g = new AdvancedProtection({
      active: () => b.active,
      start: async () => { b.prompts++; if (answer) b.active = true; return answer ? { success: true } : { success: false, code: 'declined' }; },
      stop: async () => { b.stops++; b.active = false; },
      protectionOn: () => on,
      antiCheat: async () => game,
      tell: (id, p) => told.push(`${id}:${p.program}`),
      log: (l, m) => logs.push(m),
    });
    await g.guard();                                  // the first look: nothing running
    game = 'GTA5_Enhanced.exe';
    await g.guard();
    t.ok(!b.active && b.stops === 1 && g.paused && told.join() === 'autoAdvancedPausedForGame:GTA5_Enhanced.exe'
      && logs.some((l) => /^Advanced mode paused: GTA5_Enhanced\.exe is running/.test(l)),
      'a game with an anti-cheat starts: Advanced mode steps aside, said in one line');
    await g.guard(); await g.guard();
    t.ok(!b.active && b.prompts === 0 && told.length === 1, 'while the game runs it stays aside, said once');
    game = null;
    await g.guard();
    t.ok(b.active && b.prompts === 1 && !g.paused && told[1] === 'autoAdvancedBackAfterGame:GTA5_Enhanced.exe',
      'the game closed: it comes back (one permission prompt), said in one line');
    // Started while the game already runs: the user's own choice.
    game = 'r5apex.exe';
    b.active = false;
    g.lastGame = undefined;                           // main.js: not looked for while it is off
    b.active = true;                                  // the user turns it on with the game open
    await g.guard(); await g.guard();
    t.ok(b.active && b.stops === 1, 'turned on while the game already runs: left alone');
    // A Stop while it waits ends the wait; the user's own brings it back with
    // the next Start (main.js's comeBack, which looks for the game again).
    game = null; await g.guard();
    game = 'VALORANT-Win64-Shipping.exe'; await g.guard();
    t.ok(!b.active && g.paused, 'paused again for the next game');
    await g.stopped({ user: true });
    t.ok(!g.paused && g.resume === true, 'a Stop meanwhile ends the wait; Advanced mode comes back with the next Start');
    on = false; game = null; await g.guard();
    t.ok(!b.active, 'nothing is started with protection off');
    // Turned off by hand while it waits: it does not come back.
    on = true; b.active = true; g.lastGame = null; game = 'cs2.exe'; await g.guard();
    t.ok(g.paused, 'paused for cs2.exe');
    g.offByHand(); game = null; const before = b.prompts; await g.guard();
    t.ok(!g.paused && !b.active && b.prompts === before, 'turned off by hand while it waited: not brought back');
    // Declined when it comes back: recorded as a decline.
    b.active = true; g.lastGame = null; game = 'GTA5.exe'; await g.guard();
    answer = false; game = null;
    let declined = 0;
    g.declined = () => { declined++; };
    await g.guard();
    t.ok(!b.active && declined === 1, 'its permission prompt declined when it comes back: recorded as a decline');
  }

  // ── never over a full-screen game: asked once the user is out of it ──
  {
    const r = rig();
    // A full-screen program in front until the test lets go (UserBusy.until's part).
    let inGame = true;
    let looks = 0;
    r.g.notBusy = async (stop) => { while (!stop() && inGame) { looks++; await new Promise((res) => setTimeout(res, 5)); } };
    const p = r.g.start(r.g.session());
    await new Promise((res) => setTimeout(res, 40));
    t.ok(r.b.prompts === 0 && looks > 1, 'a full-screen game in front: no permission prompt while it lasts');
    inGame = false;
    await settle(); await new Promise((res) => setTimeout(res, 20));
    t.ok(r.b.prompts === 1, 'out of the game: the prompt comes then');
    r.b.answer(true);
    t.ok((await p).success && r.b.active, 'allowed after the game: Advanced mode is on');

    const s = rig();
    s.g.notBusy = async (stop) => { while (!stop()) await new Promise((res) => setTimeout(res, 5)); };
    const q = s.g.start(s.g.session());
    await new Promise((res) => setTimeout(res, 20));
    await s.stop();
    const got = await q;
    t.ok(got.code === 'protection_off' && s.b.prompts === 0, 'protection stopped during the game: nothing is asked afterwards');
  }

  finished = true;
  console.log(`advanced-protection: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
