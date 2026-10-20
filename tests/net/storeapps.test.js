'use strict';

/* Microsoft Store apps and Shroudly's loopback proxy (electron/store-apps.js,
 * issue #26): reading the app containers (the firewall's list, the registry,
 * CheckNetIsolation's), which of them need a loopback exemption, and the
 * autopilot's rules: one prompt, said in one line, what Shroudly added
 * remembered and nothing else ever taken out, a decline respected for two
 * weeks, the switch and the uninstaller taking out Shroudly's own only.
 * Runs everywhere against a fake Windows; on Windows it also reads the real
 * ones (no change made: tests/lab/uwp-loopback.js changes them, on CI). */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, suite } = require('./helpers');

const StoreApps = require(path.join(ROOT, 'electron', 'store-apps.js'));
const t = suite('storeapps');
const {
  containerSid, familyOf, isPackage, usesNetwork, parseMappings, parseExemptList, parseScan, candidates, decide, appNames,
  elevatedScript, launcherScript, RESPECT_MS,
} = StoreApps;

// Published SIDs: Microsoft Edge's (the loopback flag in about:flags) and the
// WebView host's (exempt on every Windows 10 and 11).
const EDGE = 'S-1-15-2-3624051433-2125758914-1423191267-1740899205-1073925389-3782572162-737981194';
const WEBVIEW = 'S-1-15-2-1310292540-1029022339-4008023048-2190398717-53961996-4257829345-603366646';
const STORE = containerSid('microsoft.windowsstore_8wekyb3d8bbwe');
const XBOX = containerSid('microsoft.gamingapp_8wekyb3d8bbwe');
const XBOXID = containerSid('microsoft.xboxidentityprovider_8wekyb3d8bbwe');
const WHATSAPP = containerSid('5319275a.whatsappdesktop_cv1g1gvanyjgm');
const CALC = containerSid('microsoft.windowscalculator_8wekyb3d8bbwe');
const AAD = containerSid('microsoft.aad.brokerplugin_cw5n1h2txyewy');
const CHROME = containerSid('cr.sb.net9a1fd3');
const CHILD = `${STORE}-1-2-3-4`;
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf16le');

(async () => {
  // ── names and SIDs ──
  t.ok(containerSid('Microsoft.MicrosoftEdge_8wekyb3d8bbwe') === EDGE && containerSid('microsoft.win32webviewhost_cw5n1h2txyewy') === WEBVIEW,
    'an app container SID is derived from the family name as Windows does (the published Edge and WebView host SIDs)');
  t.ok(containerSid('MICROSOFT.WINDOWSSTORE_8WEKYB3D8BBWE') === STORE, '…whatever the case of the name');
  t.ok(familyOf('Microsoft.WindowsStore_22305.1401.6.0_x64__8wekyb3d8bbwe') === 'Microsoft.WindowsStore_8wekyb3d8bbwe'
    && familyOf('5319275A.WhatsAppDesktop_2.2430.6.0_x64__cv1g1gvanyjgm') === '5319275A.WhatsAppDesktop_cv1g1gvanyjgm'
    && familyOf('Microsoft.GamingApp_8wekyb3d8bbwe') === 'Microsoft.GamingApp_8wekyb3d8bbwe' && familyOf('nonsense') === null,
  "a package's full name gives its family name");
  t.ok(isPackage('microsoft.windowsstore_8wekyb3d8bbwe') && !isPackage('cr.sb.net9a1fd3') && !isPackage('') && !isPackage('a_b'),
    "packages are told from other app containers (a browser's sandbox)");
  t.ok(usesNetwork(['S-1-15-3-1']) && usesNetwork(['S-1-15-3-1024-1', 'S-1-15-3-3']) && usesNetwork(null) && !usesNetwork(['S-1-15-3-1024-1']) && !usesNetwork([]),
    'network capabilities: internetClient, internetClientServer, privateNetworkClientServer; unknown counts as yes');

  // ── the registry's app containers (reg query … /s) ──
  const K = 'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings';
  const REG = [
    '',
    `${K}\\${STORE}`,
    '    DisplayName    REG_SZ    @{Microsoft.WindowsStore_22305.1401.6.0_x64__8wekyb3d8bbwe?ms-resource://Microsoft.WindowsStore/Resources/StoreTitle}',
    '    Moniker    REG_SZ    microsoft.windowsstore_8wekyb3d8bbwe',
    '',
    `${K}\\${STORE}\\Children`,
    '',
    `${K}\\${STORE}\\Children\\${CHILD}`,
    '    DisplayName    REG_SZ    Store child',
    '    Moniker    REG_SZ    microsoft.windowsstore_8wekyb3d8bbwe/child',
    '    ParentMoniker    REG_SZ    microsoft.windowsstore_8wekyb3d8bbwe',
    '',
    `${K}\\${XBOX}`,
    '    DisplayName    REG_SZ    Xbox',
    '    Moniker    REG_SZ    microsoft.gamingapp_8wekyb3d8bbwe',
    '',
    `${K}\\${CHROME.toLowerCase()}`,
    '    DisplayName    REG_SZ    cr.sb.net9a1fd3',
    '    Moniker    REG_SZ    cr.sb.net9a1fd3',
    '',
  ].join('\r\n');
  const mapped = parseMappings(REG);
  t.ok(mapped.length === 3 && mapped[0].sid === STORE && mapped[0].name === 'microsoft.windowsstore_8wekyb3d8bbwe' && /^@\{/.test(mapped[0].display),
    'each app container: its SID, moniker and display name');
  t.ok(!mapped.some((c) => c.sid === CHILD || /child/i.test(c.name)), 'child containers are not packages of their own');
  t.ok(mapped[2].sid === CHROME, 'SIDs come out upper case, as the firewall writes them');
  t.ok(mapped.every((c) => containerSid(c.name) === c.sid), 'each SID is the one derived from its moniker');
  t.ok(parseMappings('') .length === 0 && parseMappings('ERROR: The system was unable to find the specified registry key or value.').length === 0, 'nothing there: none');

  // ── CheckNetIsolation LoopbackExempt -s ──
  const CNI = [
    '', 'List Loopback Exempted AppContainers', '',
    '[1] -----------------------------------------------------------------',
    '    Name: microsoft.win32webviewhost_cw5n1h2txyewy',
    `    SID:  ${WEBVIEW}`, '',
    '[2] -----------------------------------------------------------------',
    '    Name: microsoft.windowsstore_8wekyb3d8bbwe/child',
    `    SID:  ${CHILD}`, '',
    'OK.', '',
  ].join('\r\n');
  t.ok(parseExemptList(CNI).join() === WEBVIEW, 'the exempt SIDs are read; a child container\'s longer SID is not taken for its package\'s');
  const CNI_TR = ['', "Geri döngü muafiyeti olan AppContainer'lar", '', '[1] ------', '    Ad: microsoft.win32webviewhost_cw5n1h2txyewy',
    `    SID: ${WEBVIEW.toLowerCase()}`, '', 'Tamam.', ''].join('\r\n');
  t.ok(parseExemptList(CNI_TR).join() === WEBVIEW, 'the labels in another language of Windows change nothing');
  t.ok(parseExemptList('').length === 0, 'an empty list: none');

  // ── the firewall's list (the scan script's lines) ──
  const SCAN = [
    `C\t${STORE}\tmicrosoft.windowsstore_8wekyb3d8bbwe\tMicrosoft Store\tMicrosoft.WindowsStore_22305.1401.6.0_x64__8wekyb3d8bbwe\tS-1-15-3-1,S-1-15-3-1024-1`,
    `C\t${STORE}\tmicrosoft.windowsstore_8wekyb3d8bbwe\tMicrosoft Store\t\tS-1-15-3-1`,
    `C\tS-1-15-2-1\tbad\t\t\tS-1-15-3-1`,
    `C\t${CALC}\tmicrosoft.windowscalculator_8wekyb3d8bbwe\tCalculator\t\t`,
    `X\t${WEBVIEW}`,
    'E\tconfig\t5',
    'noise',
  ].join('\r\n');
  const ps = parseScan(SCAN);
  t.ok(ps.containers.length === 2 && ps.containers[0].caps.join() === 'S-1-15-3-1,S-1-15-3-1024-1' && ps.containers[1].caps.length === 0,
    'containers with their capabilities; duplicates and malformed SIDs dropped');
  t.ok(ps.exempt.join() === WEBVIEW && ps.errors.join() === 'config 5', 'exempt SIDs and failed calls');

  // ── which need an exemption ──
  const list = [
    { sid: STORE, name: 'microsoft.windowsstore_8wekyb3d8bbwe', caps: ['S-1-15-3-1'] },
    { sid: XBOX, name: 'microsoft.gamingapp_8wekyb3d8bbwe', caps: ['S-1-15-3-1'] },
    { sid: WEBVIEW, name: 'microsoft.win32webviewhost_cw5n1h2txyewy', caps: ['S-1-15-3-1'] },
    { sid: CALC, name: 'microsoft.windowscalculator_8wekyb3d8bbwe', caps: ['S-1-15-3-1024-99'] },
    { sid: CHROME, name: 'cr.sb.net9a1fd3', caps: ['S-1-15-3-1'] },
    { sid: WHATSAPP, name: '5319275a.whatsappdesktop_cv1g1gvanyjgm', caps: null },
    { sid: AAD, name: 'microsoft.aad.brokerplugin_cw5n1h2txyewy', caps: ['S-1-15-3-3'] },
    { sid: XBOX.toLowerCase(), name: 'microsoft.gamingapp_8wekyb3d8bbwe', caps: ['S-1-15-3-1'] },
  ];
  const need = candidates({ containers: list, exempt: [WEBVIEW], handled: [WHATSAPP] }).map((c) => c.sid);
  t.ok(need.join() === [STORE, XBOX, AAD].join(),
    'packages that may use the network and have no exemption; not one exempt already, without network, not a package, or tried before');

  // ── when to ask ──
  const now = 1e12;
  const base = { platform: 'win32', protectionOn: true, now };
  t.ok(decide(base) === 'ask', 'Windows, protection on: ask');
  t.ok(decide({ ...base, platform: 'darwin' }) === 'unsupported' && decide({ ...base, platform: 'linux', force: true }) === 'unsupported', 'not on other systems, even when asked to');
  t.ok(decide({ ...base, protectionOn: false }) === 'protection_off', 'not while protection is off');
  t.ok(decide({ ...base, offAt: now - 1000 }) === 'off_by_hand' && decide({ ...base, offAt: now - RESPECT_MS - 1 }) === 'ask', 'switched off by hand: two weeks, then again');
  t.ok(decide({ ...base, declinedAt: now - 1000 }) === 'declined' && decide({ ...base, declinedAt: now - RESPECT_MS - 1 }) === 'ask', 'declined: two weeks, then again');
  t.ok(decide({ ...base, asked: true }) === 'asked', 'once a session');
  t.ok(decide({ ...base, busy: true }) === 'busy', 'not while another permission prompt is open');
  t.ok(decide({ ...base, protectionOn: false, declinedAt: now, asked: true, force: true }) === 'ask', 'the user turning the switch on: ask now');

  // ── the names the user reads ──
  t.ok(appNames(list).join(', ') === 'Xbox, Microsoft Store, WhatsApp', "the apps people know, Xbox first; Windows' components never named");
  t.ok(appNames([{ sid: CALC, name: 'contoso.notes_0123456789abc', display: 'Contoso Notes' }]).join() === 'Contoso Notes', "another app's own name");
  t.ok(appNames([{ sid: CALC, name: 'contoso.notes_0123456789abc', display: '@{Contoso.Notes_1.0?ms-resource://x}' }, { sid: AAD, name: 'microsoft.aad.brokerplugin_cw5n1h2txyewy' }]).join() === 'Microsoft Store',
    'no readable name: "Microsoft Store"');

  // ── what runs elevated ──
  const inner = elevatedScript('add', "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\shroudly-lb-1\\sids.txt");
  t.ok(inner.includes("ReadAllLines('C:\\Users\\O''Brien\\AppData\\Local\\Temp\\shroudly-lb-1\\sids.txt')"), 'the list file\'s path is quoted (an apostrophe in a user name)');
  t.ok(/-match '\^S-1-15-2\(-\\d\{1,10\}\)\{7\}\$'/.test(inner) && /LoopbackExempt -a \('-p=' \+ \$s\)/.test(inner), 'each line is checked to be a package SID before CheckNetIsolation gets it');
  t.ok(/LoopbackExempt -d /.test(elevatedScript('remove', 'x')), 'removal uses -d');
  const outer = launcherScript(inner);
  const enc = outer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  t.ok(/-Verb RunAs/.test(outer) && /-Wait/.test(outer) && /1223\) \{ exit 2 \}/.test(outer) && enc && decode(enc[1]) === inner,
    'one UAC prompt runs exactly that script, waited for; a declined prompt is exit 2');

  // ── the autopilot, on a fake Windows ──
  function fakeWindows({ containers, exempt = [], accept = true, works = () => true, psFails = false, cniList = true } = {}) {
    const w = { containers, exempt: new Set(exempt), prompts: [], calls: [], accept };
    w.run = async (cmd, args) => {
      const exe = path.basename(String(cmd)).toLowerCase();
      w.calls.push(exe);
      if (exe === 'powershell.exe') {
        const script = decode(args[args.indexOf('-EncodedCommand') + 1]);
        if (script.includes('ShroudlyNetIso')) {
          if (psFails) return { code: 1, stdout: '', stderr: 'Add-Type: Cannot add type. Constrained language' };
          const lines = w.containers.map((c) => `C\t${c.sid}\t${c.name}\t${c.display || ''}\t\t${(c.caps || []).join(',')}`);
          return { code: 0, stdout: [...lines, ...[...w.exempt].map((s) => `X\t${s}`)].join('\r\n'), stderr: '' };
        }
        const innerB64 = script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
        const body = decode(innerB64);
        const file = body.match(/ReadAllLines\('(.*?)'\)/)[1].replace(/''/g, "'");
        const sids = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        const verb = /LoopbackExempt -d/.test(body) ? 'remove' : 'add';
        w.prompts.push({ verb, sids });
        if (!w.accept) return { code: 2, stdout: '', stderr: '' };
        for (const s of sids) if (StoreApps.SID_RE.test(s) && works(s)) { if (verb === 'add') w.exempt.add(s); else w.exempt.delete(s); }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (exe === 'reg.exe') {
        const lines = [''];
        for (const c of w.containers) lines.push(`${K}\\${c.sid}`, `    Moniker    REG_SZ    ${c.name}`, '');
        return { code: 0, stdout: lines.join('\r\n'), stderr: '' };
      }
      if (exe === 'checknetisolation.exe') {
        if (!cniList) return { code: 5, stdout: '', stderr: '' };
        return { code: 0, stdout: [...w.exempt].map((s, i) => `[${i + 1}] ---\r\n    Name: x\r\n    SID:  ${s}\r\n`).join('\r\n'), stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return w;
  }
  function memStore(init = {}) {
    const m = new Map(Object.entries(init));
    return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), m };
  }
  function rig(w, { store = memStore(), record = { list: [] }, on = true, busy = false, clock = { t: 1e12 } } = {}) {
    const told = [];
    const logs = [];
    const sa = new StoreApps({
      store, platform: 'win32', run: w.run, now: () => clock.t, protectionOn: () => on, busy: () => busy,
      tell: (id, p) => told.push({ id, p }), log: (l, m) => logs.push(`${l}: ${m}`),
      record: { get: async () => record.list, set: (v) => { record.list = v; } },
    });
    return { sa, store, record, told, logs, clock };
  }
  const net = ['S-1-15-3-1'];
  const MACHINE = () => [
    { sid: STORE, name: 'microsoft.windowsstore_8wekyb3d8bbwe', caps: net },
    { sid: XBOX, name: 'microsoft.gamingapp_8wekyb3d8bbwe', caps: net },
    { sid: XBOXID, name: 'microsoft.xboxidentityprovider_8wekyb3d8bbwe', caps: net },
    { sid: WEBVIEW, name: 'microsoft.win32webviewhost_cw5n1h2txyewy', caps: net },
    { sid: CALC, name: 'microsoft.windowscalculator_8wekyb3d8bbwe', caps: [] },
  ];

  {
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    const r = rig(w);
    const res = await r.sa.survey();
    t.ok(res.result === 'on' && w.prompts.length === 1 && w.prompts[0].verb === 'add' && w.prompts[0].sids.join() === [STORE, XBOX, XBOXID].join(),
      'protection on: one prompt adds every app that needs it, nothing else');
    t.ok(r.told.map((x) => x.id).join() === 'autoStoreAppsAsk,autoStoreAppsOn' && r.told[1].p.apps === 'Xbox, Microsoft Store',
      `the user is told before the prompt, and after, in one line each ("${r.told[1].p.apps}")`);
    t.ok(r.sa.ours().join() === [STORE, XBOX, XBOXID].join() && r.record.list.join() === r.sa.ours().join(),
      'what was added is remembered, in the settings and for the uninstaller');
    t.ok(!r.sa.ours().includes(WEBVIEW), 'an exemption that was there before is never counted as Shroudly\'s');
    t.ok(r.store.get('storeAppsMode') === true, 'the switch shows on');
    t.ok(r.logs.some((l) => l === 'info: Store apps: 3 cannot reach Shroudly (Xbox, Microsoft Store); asking for permission')
      && r.logs.some((l) => l === 'success: Store apps: 3 can now reach Shroudly'), 'the log says what happened');
    w.containers.push({ sid: WHATSAPP, name: '5319275a.whatsappdesktop_cv1g1gvanyjgm', caps: net });
    r.clock.t += 60 * 60 * 1000;
    const again = await r.sa.survey();
    t.ok(!again.asked && w.prompts.length === 1, `a new app later in the session waits for the next one (${again.why})`);
    const r2 = rig(w, { store: r.store, record: r.record });
    const next = await r2.sa.survey();
    t.ok(next.result === 'on' && w.prompts[1].sids.join() === WHATSAPP && r2.sa.ours().length === 4, 'next session: only the new app is asked for');
    const none = await rig(w, { store: r.store, record: r.record }).sa.survey();
    t.ok(!none.asked && none.why === 'none' && w.prompts.length === 2, 'nothing left to do: no prompt');

    // Turned off by hand: Shroudly's own taken out, the user's kept.
    w.exempt.add(CALC);   // the user exempted Calculator meanwhile
    const off = await r2.sa.setMode(false);
    t.ok(off.success && w.prompts[2].verb === 'remove' && w.prompts[2].sids.join() === [STORE, XBOX, XBOXID, WHATSAPP].join(),
      'switched off: one prompt takes out exactly what Shroudly added');
    t.ok(w.exempt.has(WEBVIEW) && w.exempt.has(CALC) && w.exempt.size === 2, 'the user\'s own exemptions stay');
    t.ok(!r2.sa.ours().length && !r2.record.list.length && r2.store.get('storeAppsMode') === false, 'nothing is left in the record; the switch shows off');
    const after = await rig(w, { store: r2.store, record: r2.record, clock: r2.clock }).sa.survey();
    t.ok(!after.asked && after.why === 'off_by_hand', 'and it is not turned on again by itself');
    r2.clock.t += RESPECT_MS + 1;
    const later = await rig(w, { store: r2.store, record: r2.record, clock: r2.clock }).sa.survey();
    t.ok(later.result === 'on' && w.prompts[3].sids.length === 4, 'two weeks later the autopilot may do it again');
  }

  {
    // Declined.
    const w = fakeWindows({ containers: MACHINE(), accept: false });
    const clock = { t: 1e12 };
    const r = rig(w, { clock });
    const res = await r.sa.survey();
    t.ok(res.result === 'declined' && r.store.get('storeAppsDeclinedAt') === clock.t && !r.sa.ours().length, 'declined: nothing remembered as added');
    t.ok(r.told.map((x) => x.id).join() === 'autoStoreAppsAsk,autoStoreAppsDeclined' && r.told[1].p.apps === 'Xbox, Microsoft Store',
      'the user is told which apps cannot go through Shroudly');
    clock.t += 24 * 60 * 60 * 1000;
    const r2 = rig(w, { store: r.store, clock });
    const next = await r2.sa.survey();
    t.ok(!next.asked && w.prompts.length === 1 && r2.logs.some((l) => l === 'warning: Store apps: Xbox, Microsoft Store cannot go through Shroudly; permission was not given'),
      'the next day: not asked again, the log names the apps once');
    await r2.sa.survey();
    t.ok(r2.logs.filter((l) => /cannot go through/.test(l)).length === 1, '…once a session');
    clock.t += RESPECT_MS;
    w.accept = true;
    const later = await rig(w, { store: r.store, clock }).sa.survey();
    t.ok(later.result === 'on', 'two weeks after a decline it asks again');
  }

  {
    // Elevated, but nothing took (a standard account with UAC off, a locked-down system).
    const w = fakeWindows({ containers: MACHINE(), works: () => false });
    const r = rig(w);
    const res = await r.sa.survey();
    t.ok(res.result === 'failed' && r.told[1].id === 'autoStoreAppsFailed' && r.store.get('storeAppsDeclinedAt'), 'nothing added: said as a failure, and not retried for two weeks');
  }

  {
    // One Windows will not exempt (a container left by a removed app).
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], works: (s) => s !== XBOXID });
    const r = rig(w);
    await r.sa.survey();
    t.ok(r.sa.ours().join() === [STORE, XBOX].join(), "only what took is Shroudly's");
    const r2 = rig(w, { store: r.store, record: r.record });
    const next = await r2.sa.survey();
    t.ok(!next.asked && next.why === 'none' && w.prompts.length === 1, '…and the one that did not take is not asked about at every start');
  }

  {
    // The user turns the switch on: asked at once, even with protection off.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    const r = rig(w, { on: false, store: memStore({ storeAppsDeclinedAt: 1e12 - 1000, storeAppsModeOffAt: 1e12 - 1000 }) });
    t.ok((await r.sa.survey()).why === 'protection_off' && !w.prompts.length, 'protection off: nothing by itself');
    const on = await r.sa.setMode(true);
    t.ok(on.success && w.prompts.length === 1 && r.sa.ours().length === 3, 'switched on by the user: asked now, whatever was declined before');
    const w2 = fakeWindows({ containers: MACHINE(), accept: false });
    const r2 = rig(w2);
    const refused = await r2.sa.setMode(true);
    t.ok(!refused.success && refused.code === 'declined' && r2.store.get('storeAppsMode') === false, 'declined then: the switch goes back off');
  }

  {
    // Removal declined: the record stays, for the next try or the uninstaller.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    const r = rig(w);
    await r.sa.survey();
    w.accept = false;
    const off = await r.sa.setMode(false);
    t.ok(!off.success && r.sa.ours().length === 3 && r.record.list.length === 3 && r.logs.some((l) => /could not be taken out/.test(l)),
      'taking them out declined: still remembered, and the log says so');
    // An exemption of Shroudly's the user took out by hand meanwhile is not
    // asked about again.
    w.accept = true;
    w.exempt.delete(XBOX);
    const off2 = await r.sa.setMode(false);
    t.ok(off2.success && w.prompts[w.prompts.length - 1].sids.join() === [STORE, XBOXID].join(), 'only those still there are taken out');
  }

  {
    // One survey at a time; Advanced mode's prompt waits for it (settled).
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (c, a) => { const x = await w.run(c, a); if (/RunAs/.test(decode(a[a.indexOf('-EncodedCommand') + 1] || ''))) await gate; return x; };
    const sa = new StoreApps({ store: memStore(), platform: 'win32', protectionOn: () => true, run: slow, record: { get: async () => [], set: () => {} } });
    const a = sa.survey();
    const b = sa.survey();
    let settled = false;
    const s = sa.settled().then(() => { settled = true; });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    t.ok(a === b && !settled && w.prompts.length === 1, 'a second survey while the first is under way is the same one; settled() waits for the prompt');
    release();
    await s;
    t.ok(settled && (await a).result === 'on', '…and resolves once it is done');
  }

  {
    // Another prompt on screen, or protection gone while reading.
    const w = fakeWindows({ containers: MACHINE() });
    const busy = rig(w, { busy: true });
    t.ok((await busy.sa.survey()).why === 'busy' && !w.prompts.length && !w.calls.length, 'Advanced mode\'s prompt open: not even read now');
    let on = true;
    const sa = new StoreApps({ store: memStore(), platform: 'win32', protectionOn: () => on, run: async (c, a) => { const x = await w.run(c, a); on = false; return x; }, record: { get: async () => [], set: () => {} } });
    t.ok((await sa.survey()).why === 'changed' && !w.prompts.length, 'protection stopped while it read: no prompt');
  }

  {
    // PowerShell locked down: the registry and CheckNetIsolation instead;
    // every package counts, capabilities unknown.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], psFails: true });
    const r = rig(w);
    const s = await r.sa.scan();
    t.ok(s.source === 'registry' && s.containers.length === 5 && s.containers.every((c) => c.caps === null) && s.exempt.join() === WEBVIEW,
      'PowerShell refused: the registry\'s app containers and CheckNetIsolation\'s list');
    const res = await r.sa.survey();
    t.ok(res.result === 'on' && w.prompts[0].sids.join() === [STORE, XBOX, XBOXID, CALC].join(), '…and every package without an exemption is given one');
    const w2 = fakeWindows({ containers: MACHINE(), psFails: true, cniList: false });
    t.ok((await rig(w2).sa.scan()) === null, 'nothing readable: nothing done');
  }

  {
    // Settings lost, the uninstaller's record kept: adopted, so the switch
    // still takes out Shroudly's own.
    const w = fakeWindows({ containers: MACHINE(), exempt: [STORE, WEBVIEW] });
    const r = rig(w, { record: { list: [STORE] } });
    const off = await r.sa.setMode(false);
    t.ok(off.success && w.prompts[0].sids.join() === STORE && w.exempt.has(WEBVIEW), 'a record from before is adopted and taken out; nothing else');
  }

  {
    // Not Windows: nothing runs.
    let ran = 0;
    const sa = new StoreApps({ store: memStore(), platform: 'darwin', protectionOn: () => true, run: async () => { ran++; return { code: 0, stdout: '' }; } });
    const r = await sa.survey();
    t.ok(r.why === 'unsupported' && !ran && (await sa.scan()) === null && !(await sa.setMode(true)).success, 'other systems: nothing is run');
  }

  {
    // The uninstaller's record in the registry, as reg.exe is told.
    const calls = [];
    const sa = new StoreApps({ store: memStore(), platform: 'win32', run: async (c, a) => { calls.push([path.basename(c), ...a]); return { code: 0, stdout: '' }; } });
    sa._setOurs([STORE, XBOX, 'S-1-15-2-1;calc']);
    sa._setOurs([]);
    t.ok(calls[0].join(' ') === `reg.exe add HKCU\\Software\\Shroudly /v LoopbackExempt /t REG_SZ /d ${STORE};${XBOX} /f`
      && calls[1].join(' ') === 'reg.exe delete HKCU\\Software\\Shroudly /v LoopbackExempt /f', 'HKCU\\Software\\Shroudly LoopbackExempt: SIDs only, removed when empty');
  }

  // ── the uninstaller's command (scripts/installer.nsh) ──
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8');
  const cmd = [...nsh.matchAll(/nsExec::Exec `powershell (.*?) -Command "(.*?)"`/gs)].find((x) => /LoopbackExempt/.test(x[2]));
  t.ok(!!cmd, 'the uninstaller takes Shroudly\'s exemptions out');
  const unin = cmd ? cmd[2].replace(/\$\$/g, '$') : '';
  t.ok(!/"/.test(unin) && unin.includes("Name LoopbackExempt") && /-match '\^S-1-15-2\(-\\d\{1,10\}\)\{7\}\$'/.test(unin)
    && /''\^S-1-15-2\(-\\d\{1,10\}\)\{7\}\$''/.test(unin) && /-Verb RunAs/.test(unin) && /LoopbackExempt -d/.test(unin) && !/LoopbackExempt -a/.test(unin),
  '…only the SIDs in its record, checked twice, removed with one prompt; nothing added');
  t.ok(/\$\{ifNot\} \$\{isUpdated\}[\s\S]*?shroudlyLoopbackCleanup[\s\S]*?\$\{endIf\}/.test(nsh.slice(nsh.indexOf('!macro customUnInstall'))), '…and not on an update');

  // ── on Windows: the real thing, read only ──
  if (process.platform === 'win32') {
    const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
    // Each PowerShell script parses.
    const scripts = { scan: StoreApps.SCAN_PS, elevated: elevatedScript('add', 'C:\\x.txt'), launcher: outer, uninstaller: unin };
    for (const [name, s] of Object.entries(scripts)) {
      const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(s, 'utf16le').toString('base64')}')), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`;
      const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', env: powershellEnv() });
      t.ok(p.status === 0, `the ${name} script is valid PowerShell${p.status ? `: ${String(p.stdout || p.stderr).trim().slice(0, 200)}` : ''}`);
    }
    const reg = spawnSync('reg.exe', ['query', StoreApps.MAPPINGS_KEY, '/s'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const real = parseMappings(reg.stdout).filter((c) => isPackage(c.name));
    t.ok(real.every((c) => containerSid(c.name) === c.sid), `this machine's app containers: each SID is the derived one (${real.length} packages)`);
    const sa = new StoreApps({ store: memStore(), platform: 'win32' });
    const s = await sa.scan();
    t.ok(!!s && Array.isArray(s.containers) && Array.isArray(s.exempt), `the real list is read (${s && s.source}: ${s && s.containers.length} app containers, ${s && s.exempt.length} exempt)`);
    if (s && s.source === 'firewall') {
      t.ok(s.containers.every((c) => StoreApps.SID_RE.test(c.sid) && Array.isArray(c.caps)), '…each with its SID and capabilities');
      const pk = s.containers.filter((c) => isPackage(c.name));
      t.ok(pk.every((c) => containerSid(c.name) === c.sid), `…and the firewall's SIDs are the derived ones too (${pk.length})`);
    }
  } else {
    console.log('  --  the real app containers are read on Windows only');
  }

  console.log(`storeapps: ${t.count} passed`);
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
