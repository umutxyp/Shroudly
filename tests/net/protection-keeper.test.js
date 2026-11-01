'use strict';

/* Protection the user left on that is not running, put back by itself
 * (electron/protection-keeper.js), on a clock the test moves:
 *   - nothing is tried at once: a start or a crash restart may still come
 *   - then after 15 s, 1 min, 5 min and every 15 min, while it lasts
 *   - a wake or another network tries at once, and the pauses start over
 *   - started (or no longer wanted: Stop, an antivirus, a quit): nothing more
 *   - the first try in a session is told once
 * and main.js asks it with what must hold it back. */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');
const { ProtectionKeeper } = require(path.join(ROOT, 'electron', 'protection-keeper.js'));

const t = suite('protection-keeper');

(async () => {
  let clock = 0;
  let wanted = true;
  let startWorks = false;
  const starts = [];
  let told = 0;
  const logs = [];
  const k = new ProtectionKeeper({
    due: () => wanted,
    start: async () => { starts.push(clock); if (startWorks) wanted = false; else throw new Error('engine start timeout'); },
    log: (lvl, msg) => logs.push(msg),
    onFirst: () => { told++; },
    now: () => clock,
  });
  const at = async (ms) => { clock = ms; await k.look(); };

  await at(0);
  t.ok(starts.length === 0, 'first seen: nothing at once (a start or a crash restart may still be on its way)');
  await at(14e3);
  t.ok(starts.length === 0, 'not before 15 s');
  await at(15e3);
  t.ok(starts.join() === '15000' && told === 1, 'after 15 s: started again, and the user told');
  await at(60e3);
  t.ok(starts.length === 1, 'the next not before a minute after');
  await at(75e3);
  await at(76e3);
  t.ok(starts.join() === '15000,75000', 'a minute after the first try: the second');
  await at(75e3 + 5 * 60e3);
  await at(75e3 + 5 * 60e3 + 15 * 60e3);
  await at(75e3 + 5 * 60e3 + 30 * 60e3);
  t.ok(starts.length === 5 && told === 1, 'then 5 min, then every 15 min; told only once');
  t.ok(logs.length === 5 && /try 5\)$/.test(logs[4]), 'each try logged with its number');

  // A wake or another network: at once, and the pauses start over.
  const n = starts.length;
  clock += 1000;
  await k.poke();
  t.ok(starts.length === n + 1, 'a wake or another network: tried at once');
  await at(clock + 15e3);
  t.ok(starts.length === n + 2, 'and the short pauses again after it');

  // Started: nothing more, and a later loss starts from the beginning.
  startWorks = true;
  clock += 1000;
  await k.poke();
  const done = starts.length;
  await at(clock + 60 * 60e3);
  t.ok(!wanted && starts.length === done, 'once it is running, nothing more is tried');
  wanted = true;
  startWorks = false;
  await at(clock + 1000);
  await at(clock + 1000);
  t.ok(starts.length === done, 'gone again later: first a pause, as the first time');

  // Not wanted any more (Stop, an antivirus, a quit): a poke does nothing.
  wanted = false;
  await k.poke();
  await at(clock + 60 * 60e3);
  t.ok(starts.length === done, 'not wanted (Stop, an antivirus block, quitting): never started');

  // One start at a time, however the looks and pokes fall.
  {
    let c = 0;
    let open = 0;
    let most = 0;
    const k2 = new ProtectionKeeper({
      due: () => true,
      start: () => { open++; most = Math.max(most, open); return new Promise((r) => setTimeout(() => { open--; r(); }, 20)); },
      now: () => c,
    });
    await k2.look();
    c = 20e3;
    await Promise.all([k2.look(), k2.look(), k2.poke(), k2.poke()]);
    t.ok(most === 1, 'never two starts at once');
  }

  // main.js: what holds it back, and what pokes it.
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const due = (main.match(/due: \(\) => ([^\n]+\n[^\n]+)/) || [])[1] || '';
  t.ok(['exitInProgress', 'app.isQuitting', 'protectionWanted()', 'engine.isActive()', 'engineComing()', "part === 'engine'"].every((w) => due.includes(w)),
    'main.js: not while quitting or installing, after a Stop, while a start is on its way, or after an antivirus block');
  t.ok(/function onWake[\s\S]{0,800}keeper\.poke\(\)/.test(main) && /now !== networkPrint && keeper\) keeper\.poke\(\)/.test(main),
    'main.js: a wake and another network try at once');
  t.ok(/tr\(\)\.notifyProtectionRetrying/.test(main), 'main.js: the user is told, in their language');

  console.log(`protection-keeper: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
