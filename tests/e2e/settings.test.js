'use strict';

/* Settings' tabs, "Your own server" and "Share my connection" in the real
 * app, on whatever OS this runs on, driven as a person would (Settings →
 * Server and sharing):
 *   - four tabs, each with its own sections and none of the others', in a
 *     narrow window too
 *   - a link that cannot be used: the reason, in the window's language
 *   - a SOCKS5 server on this computer that reaches the world: tested (a
 *     site's certificate through it), the address sites see said, saved,
 *     shown without its password, and stopped
 *   - sharing turned on: a Shadowsocks link shown and copied, a site opened
 *     through it with Shroudly's own client, counted; a new link ends the
 *     old one; off closes the port
 *   - with protection on (CI machines only, as it sets the system proxy):
 *     the main window says which address sites see through the server; with
 *     the server dead, that it is not working
 *   - after an update, what changed is said once on the Protection panel;
 *     with protection on, the card asking for help: "Not now" waits a week,
 *     the next "Turn on" turns the help on and doubles the wait
 *   - screenshots of each (test-results/): English, Persian (right to
 *     left), a narrow window, another accent and the glass surface
 *
 * Its own settings folder, the share on 127.0.0.1 only and no router asked
 * (main.js, SHROUDLY_E2E). Needs the internet: the server test opens a
 * real site through the stand-in. */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'test-results');
const SS = require(path.join(ROOT, 'electron', 'shadowsocks.js'));
const Own = require(path.join(ROOT, 'electron', 'own-server.js'));
const tag = `${process.platform}-${process.arch}`;
let count = 0;
const ok = (cond, label) => { if (!cond) throw new Error(`not ok: ${label}`); count++; console.log(`  ok  ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
const lang = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${code}.json`), 'utf8'));
// The words before the first placeholder: what a sentence with numbers in it starts with.
const head = (s) => s.split('{')[0].trim();

/* A SOCKS5 server on this computer that connects to whatever it is asked
 * for, for real (the user's own server, standing in). */
function socksStandIn() {
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    let b = Buffer.alloc(0);
    let st = 0;
    const on = (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2 + b[1]) { b = b.subarray(2 + b[1]); c.write(Buffer.from([5, 0])); st = 1; }
      if (st === 1 && b.length >= 5) {
        const t = b[3];
        const len = t === 3 ? 7 + b[4] : t === 1 ? 10 : 22;
        if (b.length < len) return;
        const host = t === 3 ? b.subarray(5, 5 + b[4]).toString() : t === 1 ? [...b.subarray(4, 8)].join('.') : null;
        const port = b.readUInt16BE(len - 2);
        c.removeListener('data', on);
        const up = net.connect(port, host, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(up); up.pipe(c); });
        up.on('error', () => c.destroy());
      }
    };
    c.on('data', on);
  }).listen(0, '127.0.0.1');
  return srv;
}

async function launch(language, extra = {}, moreEnv = {}) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-e2e-settings-'));
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    autoMode: false, showNotifications: false, minimizeToTray: true, autoStart: false, language, shareOnlineCount: false,
    storeAppsModeOffAt: Date.now(), ...extra,
  }));
  const env = { ...process.env, SHROUDLY_TRAY: 'present', SHROUDLY_E2E: '1', SHROUDLY_IDLE_RELEASE_MS: String(10 * 60 * 1000), ...moreEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [ROOT, `--user-data-dir=${ud}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env,
    timeout: 60000,
  });
  let page = await until(() => app.windows().find((w) => !w.isClosed()), 20000);
  if (!page) {
    const next = app.waitForEvent('window', { timeout: 30000 });
    await app.evaluate(({ app: a }) => a.emit('second-instance'));
    page = await next;
  }
  await page.waitForLoadState('domcontentloaded');
  // The first-run tour, seen.
  await page.evaluate(() => localStorage.setItem('shroudly_onboarded', '1'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const t = lang(language);
  ok(!!(await until(() => page.getByText(t.navSettings, { exact: true }).first().isVisible(), 20000)), `${language}: the window is up`);
  return { app, page, t, ud };
}

/* Settings, and one of its tabs (data-settings-tab), with `expect` seen. */
async function openTab(page, t, id, expect) {
  await page.getByText(t.navSettings, { exact: true }).first().click();
  const tab = page.locator(`[data-settings-tab="${id}"]`);
  await tab.waitFor({ timeout: 10000 });
  for (let i = 0; i < 3; i++) {
    await tab.click();
    if (await until(() => page.getByText(expect, { exact: true }).first().isVisible(), 3000)) return;
  }
  throw new Error(`the ${id} tab did not open`);
}
const openMore = (page, t) => openTab(page, t, 'sharing', t.ownServer);
const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A sentence with {placeholders} as a pattern: numbers and addresses where they go.
const pattern = (x) => new RegExp(escape(x).replace(/\\\{(\w+)\\\}/g, (m, k) => (k === 'ip' ? '[0-9A-Fa-f.:]{3,45}' : '[0-9]+')));

const section = (page, title) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

async function shot(locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await sleep(300);
  await locator.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const stand = socksStandIn();
  await new Promise((r) => stand.once('listening', r));
  const sp = stand.address().port;
  // A Shadowsocks server on this computer that reaches the world.
  const realDial = (h, port) => new Promise((res, rej) => { const s = net.connect(port, h, () => res(s)); s.once('error', rej); });
  const ssServer = await SS.startServer({ host: '127.0.0.1', method: 'chacha20-ietf-poly1305', password: 'e2e-chacha', dial: realDial });
  const ssPort = ssServer.port;

  // ── English: both sections, used ──
  let { app, page, t } = await launch('en');
  try {
    // The tabs: each with its own sections, none of the others'.
    const TABS = {
      general: [t.language, t.testSite],
      connection: [t.dpiBypassTechniques, t.routing, t.adBlockSection],
      sharing: [t.ownServer, t.share, t.snowflake],
      app: [t.appSection, t.appearance],
    };
    const heads = async () => page.locator('section.card h2, section.card h3').allInnerTexts();
    for (const [id, want] of Object.entries(TABS)) {
      await openTab(page, t, id, want[0]);
      const seen = (await heads()).map((x) => x.trim());
      const others = Object.entries(TABS).filter(([k]) => k !== id).flatMap(([, v]) => v);
      ok(want.every((w) => seen.includes(w)) && !others.some((o) => seen.includes(o)) && (await page.locator(`[data-settings-tab="${id}"]`).getAttribute('aria-selected')) === 'true',
        `the ${id} tab: ${want.join(', ')}, and nothing of the others (${seen.join(' | ')})`);
      await page.screenshot({ path: path.join(SHOTS, `settings-tab-${id}-${tag}.png`) });
    }
    await page.getByText(t.navProtection, { exact: true }).first().click();
    await page.getByText(t.navSettings, { exact: true }).first().click();
    ok((await page.locator('[data-settings-tab="general"]').getAttribute('aria-selected')) === 'true' && await page.getByText(t.testSite, { exact: true }).first().isVisible(),
      'Settings opens on its first tab, where the tour points at the site test');
    await openMore(page, t);
    const own = section(page, t.ownServer);
    const input = own.locator('input');
    const use = own.getByRole('button', { name: t.dnsServerUse, exact: true });
    await shot(own, 'own-server-empty');
    ok(await use.isDisabled(), 'Your own server: nothing typed, nothing to use');

    await input.fill('ftp://1.2.3.4:21');
    await use.click();
    ok(!!(await until(() => own.getByText(t.ownServerErrFormat).isVisible(), 5000)), 'a link that cannot be used: the reason, not a test');
    await shot(own, 'own-server-invalid');

    await input.fill(`socks5://e2e:secret@127.0.0.1:${sp}`);
    await use.click();
    const worked = await until(() => own.getByText(head(t.ownServerOk)).isVisible(), 30000);
    const failed = !worked && await own.getByText(head(t.ownServerFails)).isVisible().catch(() => false);
    ok(!!worked, `a server that reaches the world: tested and in use${failed ? ' (it said it did not work)' : ''}`);
    const said = (await own.locator('p').allInnerTexts()).join(' | ');
    ok(pattern(t.ownServerOkExit).test(said), `the test says which address sites see through it (${said})`);
    const saved = await app.evaluate(() => global.shroudlyE2E.store.get('ownServer'));
    ok(saved === `socks5://e2e:secret@127.0.0.1:${sp}`, 'saved as typed');
    const inUse = t.ownServerInUse.replace('{server}', `SOCKS5 127.0.0.1:${sp}`);
    ok(!!(await until(() => own.getByText(inUse).isVisible(), 5000)), 'shown as in use, without its password');
    ok(!(await own.locator('p').allInnerTexts()).some((x) => x.includes('secret')), 'the password is in no line of the section');
    await shot(own, 'own-server-in-use');
    await own.getByRole('button', { name: t.ownServerOff, exact: true }).click();
    ok(!!(await until(async () => !(await app.evaluate(() => global.shroudlyE2E.store.get('ownServer'))), 5000)), 'stop using: gone from the settings');

    // A Shadowsocks link with ChaCha20-Poly1305, which Electron's own crypto
    // lacks: tested through Shroudly's client in the app.
    const ssLink = Own.ssLink({ method: 'chacha20-ietf-poly1305', password: 'e2e-chacha', host: '127.0.0.1', port: ssPort, name: 'e2e' });
    await input.fill(ssLink);
    await use.click();
    const ssWorked = await until(() => own.getByText(head(t.ownServerOk)).isVisible(), 30000);
    ok(!!ssWorked && !!(await until(() => own.getByText(t.ownServerInUse.replace('{server}', `Shadowsocks 127.0.0.1:${ssPort}`)).isVisible(), 5000)),
      'a Shadowsocks (ChaCha20-Poly1305) server: tested through the app\'s own client, and in use');
    await shot(own, 'own-server-ss');
    await own.getByRole('button', { name: t.ownServerOff, exact: true }).click();
    await until(async () => !(await app.evaluate(() => global.shroudlyE2E.store.get('ownServer'))), 5000);

    // Share my connection.
    const share = section(page, t.share);
    await shot(share, 'share-off');
    await share.getByRole('switch', { name: t.shareOn }).click();
    const linkBox = share.locator('input[readonly]').first();
    ok(!!(await until(async () => /^ss:\/\//.test(await linkBox.inputValue()), 10000)), 'sharing on: a Shadowsocks link shown');
    const link = await linkBox.inputValue();
    const p = Own.parseLink(link);
    ok(p.ok && p.kind === 'ss' && p.host === '127.0.0.1', `the link reads as a server any app takes (${p.method}, port ${p.port})`);
    ok(!!(await until(() => share.getByText(head(t.sharePeople)).isVisible(), 5000)) && await share.getByText(t.shareUnprotected).isVisible(),
      'who is connected, and that protection is off, said');
    // A site through it, with Shroudly's own client, as a friend's app would.
    const client = await SS.startClient({ server: '127.0.0.1', port: p.port, method: p.method, password: p.password });
    const reply = await new Promise((resolve) => {
      const s = net.connect(client.port, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
      let st = 0;
      let out = '';
      s.on('data', (d) => {
        if (st === 0) { st = 1; const h = Buffer.from('example.com'); s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([0, 80])])); return; }
        if (st === 1) { st = 2; s.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'); return; }
        out += d;
      });
      s.on('close', () => resolve(out));
      s.on('error', () => resolve(out));
      setTimeout(() => { s.destroy(); resolve(out); }, 20000);
    });
    client.close();
    ok(/^HTTP\/1\.[01] \d{3}/.test(reply), `a site opened through the share (${reply.split('\r\n')[0]})`);
    ok(!!(await until(async () => (await app.evaluate(() => global.shroudlyE2E.share.status().total)) >= 1, 5000)), 'counted');
    // Copy.
    await share.getByRole('button', { name: t.supportCopy, exact: true }).first().click();
    ok(!!(await until(() => share.getByText(t.supportCopied, { exact: true }).isVisible(), 3000)), 'copy: said copied');
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    ok(clip === link, 'the link is on the clipboard');
    await shot(share, 'share-on');
    // A new link.
    await share.getByRole('button', { name: t.shareNewLink, exact: true }).click();
    ok(!!(await until(async () => (await linkBox.inputValue()) !== link && /^ss:\/\//.test(await linkBox.inputValue()), 10000)), 'a new link replaces the old one');
    // Off.
    await share.getByRole('switch', { name: t.shareOn }).click();
    ok(!!(await until(async () => (await share.locator('input[readonly]').count()) === 0, 10000)), 'sharing off: no link shown');
    let closed = false;
    try { await new Promise((res, rej) => { const s = net.connect(p.port, '127.0.0.1', () => { s.destroy(); res(); }); s.once('error', rej); }); } catch { closed = true; }
    ok(closed, 'and its port closed');

    // Narrow window, another accent, the glass surface.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible()).setSize(360, 800));
    await share.getByRole('switch', { name: t.shareOn }).click();
    await until(async () => (await share.locator('input[readonly]').count()) > 0, 10000);
    await sleep(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, `a narrow window (360 px): nothing wider than it (${overflow} px over)`);
    const tabsBox = await page.locator('[role="tablist"]').boundingBox();
    const pageWidth = await page.evaluate(() => document.documentElement.clientWidth);
    ok(tabsBox && tabsBox.x >= 0 && tabsBox.x + tabsBox.width <= pageWidth + 0.5, `the tabs fit a narrow window (${tabsBox && Math.round(tabsBox.width)} of ${pageWidth} px)`);
    await page.screenshot({ path: path.join(SHOTS, `settings-tabs-narrow-${tag}.png`) });
    await shot(share, 'share-on-narrow');
    await shot(own, 'own-server-narrow');
    await page.evaluate(() => { localStorage.setItem('shroudly_accent', 'emerald'); localStorage.setItem('shroudly_surface', 'glass'); });
    await page.reload();
    await openMore(page, t);
    await shot(section(page, t.share), 'share-on-glass');
    await section(page, t.share).getByRole('switch', { name: t.shareOn }).click();

    // With protection on (CI only: it sets the system proxy): a site through
    // the engine and the Shadowsocks server; then the server dead, and the
    // main window says so.
    if (process.env.CI) {
      await app.evaluate((_, link2) => global.shroudlyE2E.store.set('ownServer', link2), ssLink);
      await page.evaluate(() => window.electron.startDPI());
      ok(!!(await until(() => page.evaluate(() => window.electron.getDPIStatus().then((x) => x.active)), 20000)), 'protection on, through the Shadowsocks server');
      const ePort = await app.evaluate(() => global.shroudlyE2E.engine.port);
      const viaEngine = await new Promise((resolve) => {
        const s = net.connect(ePort, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
        let st = 0;
        let got = '';
        s.on('data', (d) => {
          if (st === 0) { st = 1; const h = Buffer.from('example.com'); s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([0, 80])])); return; }
          if (st === 1) { st = 2; s.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'); return; }
          got += d;
        });
        s.on('close', () => resolve(got)); s.on('error', () => resolve(got));
        setTimeout(() => { s.destroy(); resolve(got); }, 20000);
      });
      ok(/^HTTP\/1\.[01] \d{3}/.test(viaEngine) && ssServer.stats().total >= 1,
        `a site through the engine, the app's Shadowsocks client and the server (${viaEngine.split('\r\n')[0]}; ${ssServer.stats().total} at the server)`);
      await page.getByText(t.navProtection, { exact: true }).first().click();
      const exitShown = await until(async () => {
        const txt = await page.locator('[aria-live="polite"]').first().innerText().catch(() => '');
        return pattern(t.ownServerExit).test(txt) ? txt : null;
      }, 30000);
      ok(!!exitShown, `the main window says which address sites see through the server (${exitShown})`);
      await page.screenshot({ path: path.join(SHOTS, `own-server-exit-${tag}.png`) });
      await page.evaluate(() => window.electron.stopDPI());
      await until(() => page.evaluate(() => window.electron.getDPIStatus().then((x) => !x.active)), 20000);
      const dead = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => r(q)); }); });
      await app.evaluate((_, link2) => global.shroudlyE2E.store.set('ownServer', link2), `socks5://127.0.0.1:${dead}`);
      await page.evaluate(() => window.electron.startDPI());
      ok(!!(await until(() => page.evaluate(() => window.electron.getDPIStatus().then((x) => x.active)), 20000)), 'protection on, with the dead server');
      const port = await app.evaluate(() => global.shroudlyE2E.engine.port);
      await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => { const h = Buffer.from('example.com'); s.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, h.length]), h, Buffer.from([1, 187])])); });
        s.on('error', resolve); s.on('close', resolve); setTimeout(() => { s.destroy(); resolve(); }, 8000);
      });
      await page.getByText(t.navProtection, { exact: true }).first().click();
      const down = await until(() => page.getByText(t.ownServerDown, { exact: true }).first().isVisible(), 15000);
      ok(!!down, 'protection on, the server dead: the main window says so');
      await page.screenshot({ path: path.join(SHOTS, `own-server-down-${tag}.png`) });
      await page.evaluate(() => window.electron.stopDPI());
      ok(!!(await until(() => page.evaluate(() => window.electron.getDPIStatus().then((x) => !x.active)), 20000)), 'protection off again, the system proxy put back');
      await app.evaluate(() => global.shroudlyE2E.store.delete('ownServer'));
    }
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(30000)]);
  }

  // ── After an update: what changed, once; the card asking for help ──
  ({ app, page, t } = await launch('en', { lastVersionSeen: '2.6.47', helpNudge: { first: 1, next: 1, refusals: 0 } },
    { SHROUDLY_E2E_WHATS_NEW: '1', SHROUDLY_SNOWFLAKE_TEST: JSON.stringify({ broker: 'http://127.0.0.1:9/', relay: 'ws://127.0.0.1:9/', relayPattern: '^127.0.0.1', pollMs: 500 }) }));
  try {
    const version = require(path.join(ROOT, 'package.json')).version;
    await page.getByText(t.navProtection, { exact: true }).first().click();
    const news = page.locator('[data-testid="whats-new"]');
    ok(!!(await until(() => news.isVisible(), 10000)), 'after an update: the card says what changed');
    const newsText = await news.innerText();
    const lines = t.whatsNewDesktop.split('\n').filter(Boolean);
    ok(newsText.includes(t.whatsNewTitle.replace('{version}', version)) && lines.every((l) => newsText.includes(l.trim())),
      `in the window's language, every line of it (${lines.length})`);
    await page.screenshot({ path: path.join(SHOTS, `whats-new-${tag}.png`) });
    ok(!(await page.locator('[data-testid="help-banner"]').isVisible()), 'one card at a time: the help card waits');
    await news.getByRole('button', { name: t.whatsNewOk, exact: true }).click();
    ok(!!(await until(async () => !(await news.isVisible()), 5000)) && (await app.evaluate(() => global.shroudlyE2E.store.get('whatsNew'))) == null
      && (await app.evaluate(() => global.shroudlyE2E.store.get('lastVersionSeen'))) === version, 'closed: gone, and kept as seen');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(t.navProtection, { exact: true }).first().click();
    await sleep(1500);
    ok(!(await news.isVisible()), 'and not shown again');

    if (process.env.CI) {
      await page.evaluate(() => window.electron.startDPI());
      ok(!!(await until(() => page.evaluate(() => window.electron.getDPIStatus().then((x) => x.active)), 20000)), 'protection on');
      const help = page.locator('[data-testid="help-banner"]');
      // Where this machine's system proxy could not be set (a Linux runner
      // without a desktop's proxy settings), protection is on but not
      // working yet: then the card must stay out of the way of the fix.
      const st = await page.evaluate(() => window.electron.getDPIStatus());
      if (st.notRouting) {
        await sleep(3000);
        ok(!(await help.isVisible()), 'on, but not working yet (the system proxy not set here): the card stays out of the way');
      }
    }
    if (process.env.CI && !(await page.evaluate(() => window.electron.getDPIStatus().then((x) => x.notRouting)))) {
      const help = page.locator('[data-testid="help-banner"]');
      // One card at a time: a note that came first (on a Linux desktop
      // without proxy settings, the one about reopening Chromium apps) is
      // closed as a person would, and the card comes after it.
      await sleep(2500);
      const first = page.locator('.notices > *').first();
      if (await first.isVisible().catch(() => false) && !(await help.isVisible())) {
        const shut = first.locator('button[aria-label]').last();
        const said = (await first.innerText().catch(() => '')).slice(0, 80);
        if (await shut.count()) {
          await shut.click();
          ok(true, `another note came first and the card waited behind it ("${said}"); closed`);
        }
      }
      const asked = await until(() => help.isVisible(), 15000);
      if (!asked) {
        // What the window had: to tell a rule that hid it from a fault.
        const why = await page.evaluate(async () => ({
          status: await window.electron.getDPIStatus().then((x) => ({ active: x.active, notRouting: x.notRouting, offline: x.offline, ownServerDown: x.ownServerDown })),
          nudge: await window.electron.getSetting('helpNudge'),
          snowflake: await window.electron.getSnowflakeStatus(),
          home: (await window.electron.getAppInfo()).homeCountry,
          notices: [...(document.querySelector('.notices')?.children || [])].map((c) => `${c.tagName}.${c.className}:${(c.textContent || '').slice(0, 60)}`),
        })).catch((e) => ({ error: e.message }));
        console.log(`    (the window: ${JSON.stringify(why)})`);
        await page.screenshot({ path: path.join(SHOTS, `help-banner-missing-${tag}.png`) });
      }
      ok(!!asked, 'protection working: the card asks whether the user would like to help');
      const helpText = await help.innerText();
      ok(helpText.includes(t.helpNudgeTitle) && helpText.includes(t.helpNudgeBody), 'said plainly: what it is, and that it is safe');
      await page.screenshot({ path: path.join(SHOTS, `help-banner-${tag}.png`) });
      const t0 = Date.now();
      await help.getByRole('button', { name: t.supportBannerLater, exact: true }).click();
      ok(!!(await until(async () => !(await help.isVisible()), 5000)), '"Not now": the card goes');
      const n1 = await app.evaluate(() => global.shroudlyE2E.store.get('helpNudge'));
      const DAY = 24 * 60 * 60 * 1000;
      ok(n1.refusals === 1 && n1.next >= t0 + 7 * DAY - 60000 && n1.next <= Date.now() + 7 * DAY + 60000, `and comes back in a week (${((n1.next - t0) / DAY).toFixed(2)} days)`);
      // A week on.
      await app.evaluate((_, x) => global.shroudlyE2E.store.set('helpNudge', x), { ...n1, next: 1 });
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await page.getByText(t.navProtection, { exact: true }).first().click();
      ok(!!(await until(() => help.isVisible(), 10000)), 'a week on: asked again');
      const t1 = Date.now();
      await help.getByRole('button', { name: t.helpNudgeYes, exact: true }).click();
      ok(!!(await until(async () => (await app.evaluate(() => global.shroudlyE2E.snowflake.status().on)) === true, 10000)), '"Turn on": the help is on');
      ok(!!(await until(async () => (await help.innerText()).includes(head(t.helpNudgeThanks)), 5000)), 'and the card says thank you, and where to turn it off');
      const n2 = await app.evaluate(() => global.shroudlyE2E.store.get('helpNudge'));
      ok(n2.refusals === 1 && n2.next >= t1 + 14 * DAY - 60000 && n2.next <= Date.now() + 14 * DAY + 60000 && n2.accepted >= t1 - 1000,
        `the next look waits twice as long (${((n2.next - t1) / DAY).toFixed(2)} days)`);
      ok((await app.evaluate(() => global.shroudlyE2E.store.get('snowflakeOn'))) === true, 'kept on in the settings');
      await help.getByRole('button', { name: t.whatsNewOk, exact: true }).click();
      ok(!!(await until(async () => !(await help.isVisible()), 5000)), 'closed');
      await page.evaluate(() => window.electron.setSnowflake(false));
    }
    if (process.env.CI) {
      await page.evaluate(() => window.electron.stopDPI());
      ok(!!(await until(() => page.evaluate(() => window.electron.getDPIStatus().then((x) => !x.active)), 20000)), 'protection off again');
    }
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(30000)]);
  }

  // ── Persian: right to left ──
  ({ app, page, t } = await launch('fa', { shareOn: true }));
  try {
    await openMore(page, t);
    const share = section(page, t.share);
    ok(!!(await until(async () => /^ss:\/\//.test(await share.locator('input[readonly]').first().inputValue()), 10000)), 'fa: sharing left on comes back on at start');
    ok(await page.evaluate(() => document.documentElement.dir) === 'rtl', 'fa: the window is right to left');
    const own = section(page, t.ownServer);
    await own.locator('input').fill('socks5://a%3Ab:c@h:1');
    await own.getByRole('button', { name: t.dnsServerUse, exact: true }).click();
    ok(!!(await until(() => own.getByText(t.ownServerErrUser).isVisible(), 5000)), 'fa: the reason in Persian');
    await shot(own, 'own-server-fa');
    await shot(share, 'share-on-fa');
    await share.getByRole('switch', { name: t.shareOn }).click();
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(30000)]);
  }
  stand.close();
  await ssServer.close();
  console.log(`settings e2e: ${count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
