'use strict';

/* 2.6.48, without a window:
 *   - the card asking for help (components/helpNudge.js): first after three
 *     days, then each "Not now" doubles the wait from a week, never where
 *     Tor itself is blocked; the Android and iPhone apps keep the same
 *     numbers and countries
 *   - what changed, once after an update (electron/whats-new.js): never on a
 *     new install, also for an install from before 2.6.48
 *   - the address sites see through the user's own server (issue #66):
 *     Cloudflare's trace page read the same way on every platform, and asked
 *     over a real TLS connection through a SOCKS5 server here
 *   - Shroudly on a server (electron/helper-server.js): its own folder, and
 *     the service script's checks
 *   - the wiring: the panel, the main window, Settings' tabs */

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, suite } = require('./helpers');

const t = suite('help-nudge');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// helpNudge.js is an ES module for the web UI; load it as CommonJS here.
function load(rel) {
  const code = src(rel).replace(/export (const|function) /g, '$1 ').replace(/^import .*$/gm, '');
  const names = [...code.matchAll(/^(?:const|function) (\w+)/gm)].map((m) => m[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-hn-'));
  const f = path.join(dir, 'm.js');
  fs.writeFileSync(f, `${code}\nmodule.exports = { ${names.join(', ')} };`);
  try { return require(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  const N = load('components/helpNudge.js');
  const DAY = N.DAY;
  {
    const s = N.begin(null, 1000);
    t.ok(s.next === 1000 + 3 * DAY && s.refusals === 0, 'first asked after three days of use');
    t.ok(!N.isDue(s, 1000 + 3 * DAY - 1, '') && N.isDue(s, 1000 + 3 * DAY, ''), 'not before, and then');
    t.ok(N.begin(s, 99999) === s, 'a state kept is kept (an update, a restart)');
    let x = N.refuse(s, 0);
    const waits = [x.next];
    for (let i = 0; i < 4; i++) { x = N.refuse(x, 0); waits.push(x.next); }
    t.ok(JSON.stringify(waits.map((w) => w / DAY)) === JSON.stringify([7, 14, 28, 56, 112]) && x.refusals === 5,
      `each "Not now" doubles the wait from a week (${waits.map((w) => w / DAY).join(', ')} days)`);
    const yes = N.accept(x, 5);
    t.ok(yes.next === 5 + 224 * DAY && yes.accepted === 5 && yes.refusals === 5, 'turned on: asked again only after the next wait, if it is off by then');
    let long = s;
    for (let i = 0; i < 40; i++) long = N.refuse(long, 0);
    t.ok(long.next === 7 * DAY * 1024 && Number.isFinite(long.next), 'the wait stops growing after ten doublings');
    const any = { first: 0, next: 0, refusals: 0 };
    t.ok(['IR', 'ru', 'CN', 'TM', 'BY', 'MM'].every((c) => !N.isDue(any, 1, c)) && ['TR', 'DE', 'AZ', ''].every((c) => N.isDue(any, 1, c)),
      'never where Tor itself is blocked (Iran, Russia, China, Turkmenistan, Belarus, Myanmar); elsewhere, yes');
    t.ok(!N.isDue(null, 1, '') && !N.isDue({}, 1, ''), 'nothing kept yet: not due');
  }
  {
    // The phones keep the same numbers and countries.
    const kt = src('android/app/src/main/java/me/codeshare/shroudly/HelpNudge.kt');
    const sw = src('apple/Shared/HelpNudge.swift');
    t.ok(/const val FIRST_DAYS = 3\b/.test(kt) && /const val WAIT_DAYS = 7\b/.test(kt) && /const val MAX_DOUBLINGS = 10\b/.test(kt)
      && /setOf\("BY", "CN", "IR", "MM", "RU", "TM"\)/.test(kt), 'Android: the same numbers and countries');
    t.ok(/firstDays = 3\.0/.test(sw) && /waitDays = 7\.0/.test(sw) && /maxDoublings = 10\b/.test(sw)
      && /\["BY", "CN", "IR", "MM", "RU", "TM"\]/.test(sw), 'iPhone: the same numbers and countries');
    const NN = require(path.join(ROOT, 'electron', 'national-net.js'));
    const zones = N.NOT_FROM.flatMap((c) => NN.ZONES[c].map((z) => [z, c]));
    t.ok(zones.length > 30 && zones.every(([z]) => sw.includes(`"${z}"`)), `iPhone: every time zone of those countries, as the desktop has them (${zones.length})`);
  }
  {
    const WN = require(path.join(ROOT, 'electron', 'whats-new.js'));
    const store = (init = {}) => { const m = { ...init }; return { get: (k) => m[k], set: (k, v) => { m[k] = v; }, m }; };
    let s = store();
    t.ok(WN.note(s, { current: '2.6.48', firstRun: true }) === null && s.m.lastVersionSeen === '2.6.48' && s.m.whatsNew === undefined, 'a new install: nothing to tell');
    s = store({ language: 'tr' });
    t.ok(WN.note(s, { current: '2.6.48', firstRun: false }) === '2.6.48' && s.m.whatsNew === '2.6.48', 'from before 2.6.48 (no version kept): told');
    t.ok(WN.note(s, { current: '2.6.48' }) === null && s.m.whatsNew === '2.6.48', 'the same version again: kept until the card is closed');
    s.m.whatsNew = null;
    t.ok(WN.note(s, { current: '2.6.48' }) === null && s.m.whatsNew === null, 'closed: not again');
    t.ok(WN.note(s, { current: '2.6.49' }) === '2.6.49' && s.m.whatsNew === '2.6.49' && s.m.lastVersionSeen === '2.6.49', 'the next update: told again');
    const ktW = src('android/app/src/main/java/me/codeshare/shroudly/WhatsNew.kt');
    const swW = src('apple/Shared/WhatsNew.swift');
    t.ok(/lastSeen == null -> if \(updatedSinceInstall\) current else null/.test(ktW) && /if lastSeen == nil \{ return usedBefore \? current : nil \}/.test(swW),
      'Android and iPhone decide the same way');
  }
  {
    // One line each, in every language, for each platform.
    const en = JSON.parse(src('locales/en.json'));
    const lines = (k) => en[k].split('\n').filter(Boolean).length;
    t.ok(lines('whatsNewDesktop') === 5 && lines('whatsNewAndroid') === 3 && lines('whatsNewApple') === 4, 'the notes, a line each');
    for (const f of fs.readdirSync(path.join(ROOT, 'locales'))) {
      const j = JSON.parse(src(`locales/${f}`));
      if (['whatsNewDesktop', 'whatsNewAndroid', 'whatsNewApple'].some((k) => j[k].split('\n').filter(Boolean).length !== lines(k))) t.ok(false, `${f}: as many lines as English`);
    }
    t.ok(true, 'every language has as many lines as English');
  }
  {
    const Own = require(path.join(ROOT, 'electron', 'own-server.js'));
    t.ok(Own.traceIp('fl=1\nh=cloudflare.com\nip=203.0.113.7\nts=1\n') === '203.0.113.7' && Own.traceIp('ip=2001:db8::1\r\nts=1') === '2001:db8::1',
      'the trace page: the address on its own line, IPv4 or IPv6');
    t.ok(Own.traceIp('xip=1.2.3.4\n') === null && Own.traceIp('ip=999.1.1.1\n') === null && Own.traceIp('ip=<b>\n') === null && Own.traceIp('') === null,
      'anything else: nothing');
    const kt = src('android/app/src/main/java/me/codeshare/shroudly/OwnServer.kt');
    t.ok(/fun traceIp\(body: String\): String\?/.test(kt) && /fun exitAddress\(/.test(kt) && /\/cdn-cgi\/trace/.test(kt) && /nameOk\(host, it\.session\)/.test(kt),
      'Android asks the same page, its certificate and name checked');
    t.ok(/static func traceIp/.test(src('apple/Shared/OwnServer.swift')) && /cloudflare\.com\/cdn-cgi\/trace/.test(src('apple/Shared/OwnServer.swift')), 'and the iPhone');

    // Over a real TLS connection, through a SOCKS5 server here, to a stand-in
    // for the site that answers as Cloudflare's trace page does.
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-trace-'));
    let haveCert = true;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'),
        '-days', '1', '-subj', '/CN=trace.test', '-addext', 'subjectAltName=DNS:trace.test'], { stdio: 'ignore' });
    } catch { haveCert = false; }
    if (haveCert) {
      const key = fs.readFileSync(path.join(certDir, 'k.pem'));
      const cert = fs.readFileSync(path.join(certDir, 'c.pem'));
      const site = tls.createServer({ key, cert }, (c) => {
        c.once('data', (d) => {
          const req = d.toString();
          const body = /^GET \/cdn-cgi\/trace HTTP\/1\.1\r\nHost: trace\.test\r\n/.test(req) ? 'fl=1\nh=trace.test\nip=198.51.100.23\nts=1\n' : 'no';
          c.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        });
      }).listen(0, '127.0.0.1');
      await new Promise((r) => site.once('listening', r));
      const sitePort = site.address().port;
      // SOCKS5 with no password, sending every name to the stand-in site.
      const socks = net.createServer((c) => {
        let st = 0;
        c.on('data', function on(b) {
          if (st === 0) { st = 1; c.write(Buffer.from([5, 0])); return; }
          c.removeListener('data', on);
          const up = net.connect(sitePort, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(up); up.pipe(c); });
          up.on('error', () => c.destroy());
        });
      }).listen(0, '127.0.0.1');
      await new Promise((r) => socks.once('listening', r));
      const p = { kind: 'socks5', host: '127.0.0.1', port: socks.address().port, user: '' };
      const r = await Own.test(p, { host: 'trace.test', ca: cert, trace: true, timeout: 8000 });
      t.ok(r.ok && r.ip === '198.51.100.23' && r.ms >= 0, `through the server, with the site's certificate: the address sites see (${JSON.stringify(r)})`);
      const plain = await Own.test(p, { host: 'trace.test', ca: cert, timeout: 8000 });
      t.ok(plain.ok && !('ip' in plain), 'without trace: the test as before, nothing asked of the page');
      const wrong = await Own.test(p, { host: 'trace.test', trace: true, timeout: 8000 });
      t.ok(!wrong.ok && wrong.why === 'tls', `a certificate that is not the site's: not taken for it (${JSON.stringify(wrong)})`);
      site.close(); socks.close();
    } else {
      t.ok(true, 'no openssl here: the live trace is left to machines that have it');
    }
    fs.rmSync(certDir, { recursive: true, force: true });
  }
  {
    const H = require(path.join(ROOT, 'electron', 'helper-server.js'));
    t.ok(H.ARG === '--help-others', 'started with --help-others');
    t.ok(H.dataDir(['x', '--data-dir=/var/lib/h/data'], '/home/u/.config') === path.resolve('/var/lib/h/data')
      && H.dataDir(['x'], '/home/u/.config') === path.join('/home/u/.config', 'Shroudly Helper'), 'its own folder, never the desktop app\'s');
    const main = src('electron/main.js');
    const at = main.indexOf('if (process.argv.includes(HelperServer.ARG))');
    t.ok(at > 0 && at < main.indexOf('const settingsOpened = SettingsFile.open') && at < main.indexOf('requestSingleInstanceLock'),
      'it is decided before the desktop app opens its settings or takes its single-instance lock');
    const sh = src('scripts/server/install-helper.sh');
    t.ok(/ExecStart=\$APP --help-others --ozone-platform=headless --data-dir=\$HOME_DIR\/data/.test(sh) && /^User=\$NAME$/m.test(sh)
      && /useradd --system/.test(sh) && /sha256sum/.test(sh) && /OnCalendar=weekly/.test(sh) && /--remove\)/.test(sh) && !/--no-sandbox/.test(sh),
    'the service: its own user, no display, its own folder, checksum checked, updated weekly, removable, Chromium\'s sandbox kept');
    let shOk = true;
    try { execFileSync('sh', ['-n', path.join(ROOT, 'scripts', 'server', 'install-helper.sh')]); } catch { shOk = false; }
    t.ok(shOk, 'the script parses');
  }
  {
    const panel = src('components/SettingsPanel.js');
    const page = src('app/page.js');
    const control = src('components/ControlPanel.js');
    t.ok(/{ id: 'general', key: 'tabGeneral' }/.test(panel) && /role="tablist"/.test(panel) && /role="tab"/.test(panel) && /aria-selected=\{tab === id\}/.test(panel)
      && /useState\('general'\)/.test(panel) && !/moreOpen/.test(panel), 'Settings: four tabs, the first shown first, no fold left');
    t.ok(panel.indexOf("tab === 'general'") < panel.indexOf('data-tour="sitetest"') && panel.indexOf('data-tour="sitetest"') < panel.indexOf("tab === 'connection'"),
      'the site test the tour points at is on the first tab');
    t.ok(/<WhatsNewBanner show=\{activeTab === 'control'\} news=\{news\} \/>\s*<SupportBanner/.test(page) && /<SupportBanner[^\n]*\/>\s*<HelpBanner show=\{helpCard\} help=\{help\} \/>/.test(page)
      && /const helpCard = activeTab === 'control' && active && !notRouting && !offline && !ownServerDown;/.test(page),
    'the main window: what changed, then the support card, then the card asking for help, one at a time and only while protection works');
    t.ok(/ownServerExit \? t\('ownServerExit', \{ ip: ownServerExit\.ip \}\)/.test(control) && /path: \[t\('navSettings'\), t\('tabSharing'\), t\('ownServer'\)\]/.test(control),
      'the panel: the address sites see under "Protected"; the way to the server by its tab');
    t.ok(/ownServerExit: \(engine && engine\.isActive\(\) && engine\.advice && engine\.advice\.ownServerExit\) \|\| null/.test(src('electron/main.js'))
      && /this\._watchExit\(\);\n    return \{ success: true \};/.test(src('electron/engine-manager.js')), 'main.js and the engine: the address watched after each start, and passed on');
  }
  console.log(`help-nudge: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
