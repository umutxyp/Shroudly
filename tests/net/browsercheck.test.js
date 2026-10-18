'use strict';

/* A browser that goes around Shroudly (electron/browser-check.js): its own
 * proxy or VPN setting, an extension. Checked: every system's process list is
 * read, each browser is found with all its processes and nothing else, the
 * verdict (direct to the internet and never to Shroudly) is right in every
 * case that is not it, and Firefox's own "no proxy" choice is put back while
 * the user's own proxy is never touched. And the real process list of this
 * machine is read without error. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const B = require(path.join(ROOT, 'electron', 'browser-check.js'));
const t = suite('browsercheck');

(async () => {
  // ── process lists ──
  const win = ['"chrome.exe","4100","Console","1","120,000 K"', '"chrome.exe","4104","Console","1","80,000 K"',
    '"msedgewebview2.exe","5000","Console","1","50,000 K"', '"firefox.exe","6000","Console","1","300,000 K"',
    '"svchost.exe","900","Services","0","9,000 K"'].join('\r\n');
  const wp = B.parseProcesses(win, 'win32');
  t.ok(wp.length === 5 && wp[0].name === 'chrome.exe' && wp[0].pid === 4100, 'Windows process list read');
  const wb = B.browsersIn(wp, 'win32');
  t.ok(wb.length === 2 && JSON.stringify(wb.find((b) => b.id === 'chrome').pids) === '[4100,4104]', 'Chrome with all its processes, Firefox found');
  t.ok(!wb.some((b) => b.id === 'edge'), "an app's embedded Edge (WebView2) is not taken for the Edge browser");

  const mac = ['  311 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  312 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper',
    '  313 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer)',
    '  400 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder'].join('\n');
  const mb = B.browsersIn(B.parseProcesses(mac, 'darwin'), 'darwin');
  t.ok(mb.length === 1 && mb[0].pids.length === 3, 'macOS: Chrome and its helpers, nothing else');
  const lin = B.browsersIn(B.parseProcesses('  10 firefox\n  11 bash\n  12 chrome\n', 'linux'), 'linux');
  t.ok(lin.map((b) => b.id).join() === 'chrome,firefox', 'Linux: by command name');

  // ── the verdict ──
  const pub = (n) => Array.from({ length: n }, (_, i) => ({ pid: 1, remote: { host: `142.250.1.${i + 1}`, port: 443 } }));
  const ours = [10808, 10840];
  t.ok(B.goesAround(pub(3), ours) === true, 'direct to the internet and never to Shroudly: going around');
  t.ok(B.goesAround([...pub(5), { pid: 1, remote: { host: '127.0.0.1', port: 10808 } }], ours) === false, 'one connection through Shroudly: not going around');
  t.ok(B.goesAround(pub(2), ours) === false, 'two connections are not enough to say');
  t.ok(B.goesAround([1, 2, 3, 4].map((i) => ({ pid: 1, remote: { host: `192.168.1.${i}`, port: 443 } })), ours) === false, 'the local network is meant to go direct');
  t.ok(B.goesAround([1, 2, 3].map((i) => ({ pid: 1, remote: { host: `1.2.3.${i}`, port: 5222 } })), ours) === false, 'other ports (not the web) do not count');
  t.ok(B.goesAround([...pub(4), { pid: 1, remote: { host: '127.0.0.1', port: 9222 } }], ours) === true, 'a local port that is not Shroudly\'s does not count as going through it');

  // ── Firefox's own setting ──
  const prefs = (type) => `user_pref("browser.startup.page", 3);\n${type == null ? '' : `user_pref("network.proxy.type", ${type});\n`}user_pref("network.proxy.http", "10.0.0.5");\n`;
  t.ok(B.firefoxProxyType(prefs(null)) === 5, 'not written down: "Use system proxy settings" (Firefox\'s default)');
  t.ok(B.firefoxProxyType(prefs(0)) === 0 && B.firefoxProxyType(prefs(1)) === 1, 'the type read');
  t.ok(B.firefoxFixed(prefs(0)) === prefs(null), '"No proxy": the line goes, everything else stays byte for byte');
  t.ok(B.firefoxFixed(prefs(4)) === prefs(null), '"Auto-detect": the same');
  t.ok(B.firefoxFixed(prefs(1)) === null && B.firefoxFixed(prefs(2)) === null, "the user's own proxy (manual, or a configuration address) is never changed");
  t.ok(B.firefoxFixed(prefs(null)) === null, 'already right: nothing to do');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-ff-'));
  const plat = process.platform;
  const env = { APPDATA: path.join(home, 'AppData', 'Roaming') };
  const root = plat === 'win32' ? path.join(env.APPDATA, 'Mozilla', 'Firefox', 'Profiles')
    : plat === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles') : path.join(home, '.mozilla', 'firefox');
  const prof = (n, type) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'prefs.js'), prefs(type)); return d; };
  const a = prof('a.default', 0); const b = prof('b.work', 1); const c = prof('c.other', 4);
  const opts = { platform: plat, home, env };
  t.ok(B.firefoxProfiles(opts).length === 3, 'every profile found');
  const done = B.fixFirefox(opts, [c]);
  t.ok(done.length === 1 && done[0] === a, 'set back in the profile that said "No proxy"; one set back before is left to the user');
  t.ok(fs.readFileSync(path.join(a, 'prefs.js'), 'utf8') === prefs(null) && fs.readFileSync(path.join(b, 'prefs.js'), 'utf8') === prefs(1),
    'the manual proxy profile untouched');
  t.ok(!fs.readdirSync(a).some((f) => f.includes('shroudly')), 'no temporary file left');
  fs.rmSync(home, { recursive: true, force: true });

  // ── this machine ──
  const real = await B.runningBrowsers();
  t.ok(Array.isArray(real), `this machine's process list read (${real.map((x) => x.name).join(', ') || 'no browser open'})`);

  console.log(`browsercheck: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
