'use strict';

/*
 * The real flatpak round trip (Linux, a machine that has flatpak).
 *
 * electron/flatpak-env.js is unit-tested against made-up output; this checks
 * the three things only real flatpak can answer:
 *   - it accepts the arguments we build (`override --user <app> --env=K=V`),
 *   - `override --user --show <app>` prints what our parser expects,
 *   - `--unset-env` really takes the value out again (and, where it is not
 *     understood, that we notice and empty it instead).
 *
 * It uses an application id of its own that nothing owns, so nothing the
 * machine actually has is touched, and removes it again at the end. No
 * application needs to be installed.
 *
 *   node tests/lab/flatpak-env.js
 */
const path = require('path');
const { execFile } = require('child_process');
const F = require(path.join(__dirname, '..', '..', 'electron', 'flatpak-env.js'));

const APP = 'me.codeshare.ShroudlyLabTest';
const URL = 'http://127.0.0.1:10899';
let fails = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { console.log(`FAIL  ${m}`); fails++; } };

const run = (args) => new Promise((resolve) => execFile('flatpak', args, { timeout: 15000 },
  (err, out) => resolve({ ok: !err, out: String(out || '') })));

(async () => {
  const v = await run(['--version']);
  if (!v.ok) { console.log('flatpak-env lab: skipped, no flatpak here'); process.exit(0); }
  console.log(`  ok  ${v.out.trim()}`);

  // Clean slate, whatever an earlier run left.
  await run(F.unsetArgs(APP));

  // set
  const set = await run(F.setArgs(APP, URL));
  ok(set.ok, 'flatpak accepts the override arguments we build');

  // show + parse
  const shown = await run(['override', '--user', '--show', APP]);
  ok(shown.ok, 'override --show runs');
  const env = F.parseShowEnv(shown.out);
  ok(F.PROXY_VARS.every((k) => env.get(k) === URL), `every proxy name came back (${[...env.keys()].join(', ')})`);
  ok(env.get(F.MARK) === URL, 'the mark came back');
  ok(F.oursIn(env), 'and the values read as ours');

  // unset
  const un = await run(F.unsetArgs(APP));
  const after = F.parseShowEnv((await run(['override', '--user', '--show', APP])).out);
  if (un.ok && F.cleanedIn(after)) {
    ok(true, '--unset-env takes them out again');
  } else {
    // The fallback this flatpak needs: empty them instead.
    await run(F.emptyArgs(APP));
    const empty = F.parseShowEnv((await run(['override', '--user', '--show', APP])).out);
    ok(F.cleanedIn(empty), 'this flatpak has no --unset-env, and emptying them works instead');
  }

  // leave nothing of ours behind
  await run(F.unsetArgs(APP));
  const end = F.parseShowEnv((await run(['override', '--user', '--show', APP])).out);
  ok(F.cleanedIn(end), 'nothing of ours is left at the end');

  console.log(fails ? `flatpak-env lab: ${fails} failed` : 'flatpak-env lab: all passed');
  process.exit(fails ? 1 : 0);
})();
