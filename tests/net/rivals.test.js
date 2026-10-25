'use strict';

/*
 * Another program doing Shroudly's job (electron/rivals.js): the name-matching
 * and each system's process listing, on hand-made output. Nothing is run and
 * nothing of another program is touched; this is a list of names in, a list of
 * names out.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const Rivals = require(path.join(ROOT, 'electron', 'rivals.js'));

let fails = 0;
const t = { ok(c, m) { if (c) console.log(`  ok  ${m}`); else { console.log(`FAIL  ${m}`); fails++; } } };

/* ── the bare name ── */
t.ok(Rivals.bare('C:\\Tools\\GoodbyeDPI\\goodbyedpi.exe') === 'goodbyedpi', 'a Windows path and .exe come off');
t.ok(Rivals.bare('/usr/local/bin/nfqws') === 'nfqws', 'a Unix path comes off');
t.ok(Rivals.bare('  winws.exe \n') === 'winws', 'spaces and newline come off');
t.ok(Rivals.bare('') === '' && Rivals.bare(null) === '', 'nothing in, nothing out');

/* ── matching ── */
t.ok(Rivals.match(['chrome', 'goodbyedpi', 'explorer']).join() === 'GoodbyeDPI', 'GoodbyeDPI found among others');
t.ok(Rivals.match(['winws', 'nfqws']).length === 2, 'both zapret programs named');
t.ok(Rivals.match(['goodbyedpi', 'goodbyedpi']).length === 1, 'the same one is named once');
t.ok(Rivals.match([]).length === 0 && Rivals.match(null).length === 0, 'no processes, no rivals');
// our own are never a rival, however the system spells them
t.ok(Rivals.match(['shroudly', 'shroudly-core', 'shroudly-core-adv']).length === 0, 'Shroudly itself is never a rival');
// a name that merely contains one is not a match
t.ok(Rivals.match(['goodbyedpi-helperx', 'mynfqwsthing', 'notzapret']).length === 0, 'only the exact program name counts');

/* ── Windows: tasklist CSV ── */
const tasklist = '"chrome.exe","123","Console","1","200 K"\r\n"GoodbyeDPI.exe","456","Console","1","9 K"\r\n"svchost.exe","8","Services","0","5 K"\r\n';
t.ok(Rivals.namesFromTasklist(tasklist).includes('GoodbyeDPI'), 'tasklist rows read');
t.ok(Rivals.match(Rivals.namesFromTasklist(tasklist)).join() === 'GoodbyeDPI', 'and matched');
t.ok(Rivals.namesFromTasklist('').length === 0 && Rivals.namesFromTasklist('rubbish').length === 0, 'empty or unexpected tasklist output is harmless');

/* ── macOS: ps ── */
const ps = '/usr/sbin/syslogd\n/opt/homebrew/bin/ciadpi\n/Applications/Safari.app/Contents/MacOS/Safari\n';
t.ok(Rivals.match(Rivals.namesFromPs(ps)).join() === 'ByeDPI', 'ps paths read and matched');
t.ok(Rivals.namesFromPs('').length === 0, 'empty ps output is harmless');

/* ── Linux: /proc/<pid>/comm ── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivals-'));
for (const [pid, comm] of [['1', 'systemd'], ['42', 'nfqws'], ['77', 'firefox']]) {
  fs.mkdirSync(path.join(dir, pid));
  fs.writeFileSync(path.join(dir, pid, 'comm'), `${comm}\n`);
}
fs.mkdirSync(path.join(dir, 'self'));            // not a pid: skipped
fs.mkdirSync(path.join(dir, '99'));              // a pid whose comm cannot be read
const names = Rivals.namesFromProc(dir);
t.ok(names.includes('nfqws') && names.includes('systemd'), '/proc comm files read');
t.ok(Rivals.match(names).join() === 'zapret (nfqws)', 'and matched');
t.ok(Rivals.namesFromProc(path.join(dir, 'nope')).length === 0, 'a missing /proc is harmless');
fs.rmSync(dir, { recursive: true, force: true });

/* ── running(): each system asks its own tool, and never throws ── */
(async () => {
  const win = await Rivals.running('win32', { run: async (cmd) => (cmd === 'tasklist' ? tasklist : '') });
  t.ok(win.join() === 'GoodbyeDPI', 'win32 asks tasklist');
  const mac = await Rivals.running('darwin', { run: async (cmd) => (cmd === 'ps' ? ps : '') });
  t.ok(mac.join() === 'ByeDPI', 'darwin asks ps');
  const lin = await Rivals.running('linux', { procNames: () => ['tpws', 'bash'] });
  t.ok(lin.join() === 'zapret (tpws)', 'linux reads /proc');
  const boom = await Rivals.running('win32', { run: async () => { throw new Error('no tasklist here'); } });
  t.ok(boom.length === 0, 'a system that will not answer reports no rival, never throws');
  const other = await Rivals.running('sunos', {});
  t.ok(other.length === 0, 'an unknown system reports none');

  console.log(fails ? `rivals: ${fails} failed` : 'rivals: all passed');
  process.exit(fails ? 1 : 0);
})();
