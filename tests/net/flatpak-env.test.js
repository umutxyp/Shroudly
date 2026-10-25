'use strict';

/*
 * Flatpak programs and the program proxy (electron/flatpak-env.js), on
 * hand-made flatpak output: what is read back, what commands are built, which
 * programs are touched and which are left alone. The real flatpak round trip
 * (set, show, unset on a machine that has it) is tests/lab/flatpak-env.sh.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'electron', 'flatpak-env.js'));

let fails = 0;
const t = { ok(c, m) { if (c) console.log(`  ok  ${m}`); else { console.log(`FAIL  ${m}`); fails++; } } };
const URL = 'http://127.0.0.1:10809';

/* ── reading flatpak's output ── */
t.ok(F.parseInstalled('org.vinegarhq.Sober\ncom.valvesoftware.Steam\n\n').length === 2, 'installed ids read');
t.ok(F.parseInstalled('Application\nnot an id!\n').length === 0, 'a header or rubbish line is not an id');

const show = '[Context]\nsockets=wayland;\n\n[Environment]\nhttps_proxy=http://127.0.0.1:10809\nSHROUDLY_APP_PROXY=http://127.0.0.1:10809\nLANG=tr_TR.UTF-8\n';
const env = F.parseShowEnv(show);
t.ok(env.get('https_proxy') === URL && env.get('LANG') === 'tr_TR.UTF-8', 'the [Environment] section is read');
t.ok(!env.has('sockets'), 'other sections are not');
t.ok(F.parseShowEnv('').size === 0, 'no output, nothing read');

/* ── ours / cleaned ── */
t.ok(F.oursIn(env), 'a marked value is ours');
t.ok(!F.oursIn(F.parseShowEnv('[Environment]\nhttps_proxy=http://127.0.0.1:9999\n')), "somebody else's proxy is not ours");
t.ok(!F.oursIn(new Map()), 'nothing set is not ours');
t.ok(F.cleanedIn(new Map()), 'nothing set counts as cleaned');
t.ok(F.cleanedIn(F.parseShowEnv('[Environment]\nhttps_proxy=\nSHROUDLY_APP_PROXY=\n')), 'emptied counts as cleaned');
t.ok(!F.cleanedIn(env), 'still set does not');

/* ── the commands ── */
const sa = F.setArgs('org.vinegarhq.Sober', URL);
t.ok(sa[0] === 'override' && sa.includes('--user') && sa.includes('org.vinegarhq.Sober'), 'set: a per-user, per-program override');
t.ok(sa.indexOf(`--env=${F.MARK}=${URL}`) === 3, 'set: the mark is written first');
t.ok(F.PROXY_VARS.every((v) => sa.includes(`--env=${v}=${URL}`)), 'set: both cases of both names');
t.ok(!sa.includes('--system') && sa.filter((a) => a === '--user').length === 1, 'set: never machine-wide');
t.ok(F.unsetArgs('x').filter((a) => a.startsWith('--unset-env=')).length === F.PROXY_VARS.length + 1, 'unset: every name and the mark');
t.ok(F.emptyArgs('x').every((a) => !a.startsWith('--unset-env=')), 'the fallback empties instead of unsetting');

/* ── a fake flatpak ── */
function fake({ installed = ['org.vinegarhq.Sober'], start = {}, noUnset = false } = {}) {
  const state = new Map(Object.entries(start).map(([k, v]) => [k, new Map(Object.entries(v))]));
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === '--version') return { ok: true, out: 'Flatpak 1.14.4\n' };
    if (args[0] === 'list') return { ok: true, out: installed.join('\n') };
    if (args[0] !== 'override') return { ok: false, out: '' };
    const app = args.includes('--show') ? args[args.length - 1] : args[2];
    if (!state.has(app)) state.set(app, new Map());
    const e = state.get(app);
    if (args.includes('--show')) {
      let out = '[Environment]\n';
      for (const [k, v] of e) out += `${k}=${v}\n`;
      return { ok: true, out };
    }
    for (const a of args.slice(3)) {
      let m = /^--env=([^=]+)=(.*)$/.exec(a);
      if (m) { e.set(m[1], m[2]); continue; }
      m = /^--unset-env=(.+)$/.exec(a);
      if (m && !noUnset) e.delete(m[1]);
    }
    return { ok: true, out: '' };
  };
  return { run, state, calls };
}

(async () => {
  // available / installed
  const f0 = fake();
  const e0 = new F({ run: f0.run });
  t.ok(await e0.available(), 'flatpak found');
  t.ok((await e0.installed()).join() === 'org.vinegarhq.Sober', 'only known programs that are installed');

  // apply then clear, round trip
  const f1 = fake();
  const e1 = new F({ run: f1.run });
  t.ok((await e1.apply(URL)).join() === 'org.vinegarhq.Sober' && e1.applied, 'apply points Sober at Shroudly');
  const after = f1.state.get('org.vinegarhq.Sober');
  t.ok(F.PROXY_VARS.every((v) => after.get(v) === URL) && after.get(F.MARK) === URL, 'every name and the mark are set');
  t.ok((await e1.clear()).join() === 'org.vinegarhq.Sober' && !e1.applied, 'clear reports it cleared');
  t.ok(F.cleanedIn(f1.state.get('org.vinegarhq.Sober')), 'and nothing of ours is left');

  // somebody else's proxy is never replaced, and never removed
  const f2 = fake({ start: { 'org.vinegarhq.Sober': { https_proxy: 'http://10.0.0.1:3128' } } });
  const e2 = new F({ run: f2.run });
  t.ok((await e2.apply(URL)).length === 0 && !e2.applied, "a program with its own proxy is left alone");
  t.ok(f2.state.get('org.vinegarhq.Sober').get('https_proxy') === 'http://10.0.0.1:3128', 'and its value is untouched');
  await e2.clear();
  t.ok(f2.state.get('org.vinegarhq.Sober').get('https_proxy') === 'http://10.0.0.1:3128', 'clear does not touch it either');

  // an old flatpak that does not understand --unset-env: emptied instead
  const f3 = fake({ noUnset: true });
  const e3 = new F({ run: f3.run });
  await e3.apply(URL);
  t.ok((await e3.clear()).join() === 'org.vinegarhq.Sober', 'clear still succeeds without --unset-env');
  const s3 = f3.state.get('org.vinegarhq.Sober');
  t.ok(F.PROXY_VARS.every((v) => s3.get(v) === '') && F.cleanedIn(s3), 'the values are emptied, so the program reads no proxy');

  // clear takes ours out even from a program this run never set
  const f4 = fake({ start: { 'org.vinegarhq.Sober': { https_proxy: URL, SHROUDLY_APP_PROXY: URL } } });
  const e4 = new F({ run: f4.run });
  t.ok((await e4.clear()).join() === 'org.vinegarhq.Sober', 'a leftover from an earlier run is taken out');

  // nothing installed: nothing done, no error
  const f5 = fake({ installed: [] });
  const e5 = new F({ run: f5.run });
  t.ok((await e5.apply(URL)).length === 0 && (await e5.clear()).length === 0, 'no Flatpak programs, nothing to do');

  // no flatpak at all
  const e6 = new F({ run: async () => ({ ok: false, out: '' }) });
  t.ok(!(await e6.available()) && (await e6.apply(URL)).length === 0, 'without flatpak nothing is attempted');

  console.log(fails ? `flatpak-env: ${fails} failed` : 'flatpak-env: all passed');
  process.exit(fails ? 1 : 0);
})();
