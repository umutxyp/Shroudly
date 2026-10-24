'use strict';

/* The ad and tracker list Shroudly publishes (scripts/adblock-list/build.js):
 * what it takes from each source, the exceptions, the names it leaves out as
 * covered, the checks that keep a bad week from reaching anyone, and that the
 * engine takes the file it writes. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, startEngine, freePort, sleep, suite } = require('./helpers');

const B = require(path.join(ROOT, 'scripts', 'adblock-list', 'build.js'));
const t = suite('adblock-build');

const MUST = B.MUST.map((h) => `||${h}^`).join('\n');
/* Each source's text, the given lines added to what every list has. */
function texts(extra = {}) {
  const base = { 'adguard-dns': MUST, 'hagezi-pro': '', easylist: '', easyprivacy: '', stevenblack: '' };
  for (const [k, v] of Object.entries(extra)) base[k] = `${base[k]}\n${v}`;
  return base;
}
const lines = (r) => new Set([...r.blocks, ...r.allows.map((h) => `@@${h}`)]);

(async () => {
  // ── what each source gives ──
  const p = B.parse(['! comment', '||ads.example.com^', '||imp.example.com^$important', '||opt.example.com^$third-party',
    '@@||ok.example.com^', '@@||scoped.example.com^$domain=a.com', '||path.example.com/x^', 'example.org##.ad', '||1.2.3.4^'].join('\n'), 'abp');
  t.ok([...p.block].sort().join() === 'ads.example.com,imp.example.com' && [...p.allow].join() === 'ok.example.com',
    'ad-blocker rules: a whole name with no options (or $important) blocks, @@ the same takes back; options, paths, page rules and addresses are not names');
  const h = B.parse('0.0.0.0 a.example.net b.example.net\n127.0.0.1 localhost\n# c.example.net\n0.0.0.0 0.0.0.0\n', 'hosts');
  t.ok([...h.block].sort().join() === 'a.example.net,b.example.net', 'a hosts file: every name after the address, not localhost nor addresses');

  // ── combining ──
  let r = B.combine(texts({
    'adguard-dns': '||tracker.example.com^\n||cdn.tracker.example.com^\n@@||good.tracker.example.com^\n@@||alone.example.org^\n||gone.example.net^\n@@||gone.example.net^',
    easylist: '||ads.someone.blogspot.com^\n||blogspot.com^\n||x.ads.co.uk^\n||co.uk^',
    stevenblack: '0.0.0.0 malware.example.biz',
  }), { min: false });
  const L = lines(r);
  t.ok(L.has('tracker.example.com') && !L.has('cdn.tracker.example.com'), 'a name under another entry is left out: the entry above blocks it');
  t.ok(L.has('@@good.tracker.example.com') && !L.has('@@alone.example.org'), 'an exception under an entry is kept; one with nothing to take back is not');
  t.ok(!L.has('gone.example.net'), 'an entry an exception takes back is left out');
  t.ok(L.has('ads.someone.blogspot.com') && L.has('x.ads.co.uk'), 'a name under one the engine skips as an entry (blogspot.com, co.uk) is kept');
  t.ok(L.has('malware.example.biz') && B.MUST.every((m) => L.has(m)), 'the hosts list\'s names and what every list has are there');

  // ── the checks ──
  const fails = (extra, opts, re, msg) => {
    let err = '';
    try { B.combine(extra, opts); } catch (e) { err = e.message; }
    t.ok(re.test(err), `${msg} (${err || 'no error'})`);
  };
  fails(texts({ 'hagezi-pro': '||googlevideo.com^' }), { min: false }, /would block googlevideo\.com/, 'a source that would block a site everyone needs fails the run');
  fails(texts({ easylist: '||facebook.com^' }), { min: false }, /would block .*facebook\.com/, 'so does one under it');
  t.ok((() => { try { B.combine(texts({ easylist: '||facebook.com^\n@@||facebook.com^' }), { min: false }); return true; } catch { return false; } })(),
    '…unless an exception takes it back');
  fails({ ...texts(), 'adguard-dns': '||doubleclick.net^' }, { min: false }, /does not block/, 'a result without what every ad list has fails');
  fails(texts(), {}, /fewer than/, 'a source that brings too little (an error page, a cut download) fails');
  const { stevenblack, ...noHosts } = texts();
  fails(noHosts, { min: false }, /missing/, 'a source not fetched fails');
  fails(texts(), { min: false, previous: 1000 }, /less than half/, 'a list less than half the size of the last one fails');

  // ── the file, and the engine reading it ──
  const many = Array.from({ length: 12000 }, (_, i) => `||ad${i}.tracker${i % 50}.example${i % 7}.com^`).join('\n');
  r = B.combine(texts({ 'adguard-dns': `${many}\n||blocked.example.org^\n@@||kept.blocked.example.org^` }), { min: false });
  const text = B.render(r, '2026-10-24');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-abl-'));
  const file = path.join(dir, 'adblock.txt');
  fs.writeFileSync(file, text);
  t.ok(B.entriesOf(file) === r.blocks.length && /^! Combined from/m.test(text) && /GPL-3\.0/.test(text) && /StevenBlack\/hosts \(unified\) \(MIT\)/.test(text),
    'the file says what it holds, where it comes from and under which licences');
  const P = await freePort();
  const eng = await startEngine(P, []);
  try {
    eng.proc.stdin.write(`ADBLOCK-CHECK ${file}\n`);
    let line = null;
    for (let i = 0; i < 100 && !line; i++) { await sleep(50); line = eng.out.split('\n').find((l) => l.includes('"adblock_check"')); }
    const v = line ? JSON.parse(line) : {};
    t.ok(v.ok === true && v.entries === r.blocks.length, `the engine takes the file as a list (${line})`);
  } finally { eng.stop(); fs.rmSync(dir, { recursive: true, force: true }); }

  console.log(`adblock-build: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
