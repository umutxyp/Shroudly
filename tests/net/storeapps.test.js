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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, suite } = require('./helpers');

const StoreApps = require(path.join(ROOT, 'electron', 'store-apps.js'));
const t = suite('storeapps');
const {
  containerSid, familyOf, isPackage, usesNetwork, parseMappings, parseExemptList, parseScan, candidates, decide, appNames,
  runningFamilies, hasAdministrators, parseRecord, recordReg, elevatedScript, launcherScript, RESPECT_MS,
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
const XBOX_APP = 'microsoft.gamingapp_8wekyb3d8bbwe';
const XBOX_ID = 'microsoft.xboxidentityprovider_8wekyb3d8bbwe';
const TERMINAL = 'microsoft.windowsterminal_8wekyb3d8bbwe';
// Desktop programs in a package: outside any app container.
const DESKTOP = new Set([XBOX_APP, TERMINAL]);
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

  // ── which apps are open, and whether this account can say Yes ──
  const TASKLIST = [
    '"XboxPcApp.exe","8120","182,340 K","Microsoft.GamingApp_2410.1001.11.0_x64__8wekyb3d8bbwe"',
    '"StartMenuExperienceHost.exe","5520","61,204 K","Microsoft.Windows.StartMenuExperienceHost_10.0.22621.3672_neutral_neutral_cw5n1h2txyewy"',
    '"SearchHost.exe","6012","120,004 K","MicrosoftWindows.Client.CBS_1000.22700.1009.0_x64__cw5n1h2txyewy"',
    '"RuntimeBroker.exe","7740","9,012 K","Microsoft.GamingApp_2410.1001.11.0_x64__8wekyb3d8bbwe"',
    '"WhatsApp.exe","9001","90,000 K","5319275A.WhatsAppDesktop_2.2430.6.0_x64__cv1g1gvanyjgm"',
  ].join('\r\n');
  t.ok(runningFamilies(TASKLIST).join() === 'microsoft.gamingapp_8wekyb3d8bbwe,5319275a.whatsappdesktop_cv1g1gvanyjgm',
    "the open apps' packages (tasklist /apps); Windows' own parts, always running, are no sign of anything");
  const PATHS = [
    'C:\\Program Files\\WindowsApps\\Microsoft.WindowsStore_22305.1401.6.0_x64__8wekyb3d8bbwe\\WinStore.App.exe',
    'C:\\Windows\\SystemApps\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\StartMenuExperienceHost.exe',
    'C:\\Program Files\\WindowsApps\\MicrosoftWindows.Client.WebExperience_524.24800.0.0_x64__cw5n1h2txyewy\\Dashboard\\Widgets.exe',
    'D:\\WindowsApps\\Microsoft.MinecraftUWP_1.21.4401.0_x64__8wekyb3d8bbwe\\Minecraft.Windows.exe',
    'C:\\Users\\Me\\AppData\\Local\\Programs\\Shroudly\\Shroudly.exe',
  ].join('\r\n');
  t.ok(runningFamilies(PATHS).join() === 'microsoft.windowsstore_8wekyb3d8bbwe,microsoft.minecraftuwp_8wekyb3d8bbwe', "…or from the programs' paths, on any drive");
  t.ok(!runningFamilies('INFO: No tasks are running which match the specified criteria.').length && !runningFamilies('').length, 'none open: none');
  const WHO = (attrs) => [
    '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
    '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
    ...(attrs ? [`"BUILTIN\\Administrators","Alias","S-1-5-32-544","${attrs}"`] : []),
    '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
  ].join('\r\n');
  t.ok(hasAdministrators(WHO('Group used for deny only')) && hasAdministrators(WHO('Mandatory group, Enabled by default, Enabled group, Group owner')),
    'an administrator can say Yes to a prompt, under UAC (the group for deny only) or not');
  t.ok(!hasAdministrators(WHO('')) && !hasAdministrators('"x","Alias","S-1-5-32-5440",""') && !hasAdministrators(''), 'a standard user cannot');

  // ── the uninstaller's record, in either form ──
  const REC = [
    '', 'HKEY_CURRENT_USER\\Software\\Shroudly',
    `    LoopbackExempt    REG_SZ    ${STORE};${XBOX}`, '',
    'HKEY_CURRENT_USER\\Software\\Shroudly\\LoopbackExemptions',
    `    ${XBOXID}    REG_SZ    `, `    ${WHATSAPP}    REG_SZ    `, '',
    'HKEY_CURRENT_USER\\Software\\Shroudly\\Something',
    `    Other    REG_SZ    ${CALC}`, '',
  ].join('\r\n');
  t.ok(parseRecord(REC).sort().join() === [STORE, XBOX, XBOXID, WHATSAPP].sort().join(), 'the record: one value per SID, and the single value of before');
  const many = Array.from({ length: 300 }, (_, i) => containerSid(`contoso.app${i}_0123456789abc`));
  const regText = recordReg(many);
  t.ok(many.join(';').length > 8192 && regText.split('\r\n').every((l) => l.length < 100) && many.every((s) => regText.includes(`\r\n"${s}"=""\r\n`))
    && regText.includes('[-HKEY_CURRENT_USER\\Software\\Shroudly\\LoopbackExemptions]') && regText.includes('[HKEY_CURRENT_USER\\Software\\Shroudly]\r\n"LoopbackExempt"=-'),
    `any number of SIDs (${many.length}: ${many.join(';').length} characters joined, past NSIS's 8192): one short value each, the list replaced, the old value gone`);

  // ── what runs elevated ──
  const odd = "C:\\Users\\D\u2019Angelo O'Brien $x \u2018y\u201B\\AppData\\Local\\Temp\\shroudly-lb-0123456789abcdef.txt";
  const inner = elevatedScript('add', odd);
  const b64 = inner.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  t.ok(b64 && decode(b64[1]) === odd && !inner.includes('Angelo') && !/[\u2018\u2019\u201B]/.test(inner),
    "the list file's path reaches the elevated script as base64, never inside quotes: any character in a user name or TEMP works");
  t.ok(/\$l = \[IO\.File\]::ReadAllLines\(\$f\)\nRemove-Item -LiteralPath \$f -Force/.test(inner), '…and the script deletes the file as soon as it has read it');
  t.ok(/-match '\^S-1-15-2\(-\\d\{1,10\}\)\{7\}\$'/.test(inner) && /LoopbackExempt -a \('-p=' \+ \$s\)/.test(inner), 'each line is checked to be a package SID before CheckNetIsolation gets it');
  t.ok(/LoopbackExempt -d /.test(elevatedScript('remove', 'x')), 'removal uses -d');
  const outer = launcherScript(inner);
  const enc = outer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  t.ok(/-Verb RunAs/.test(outer) && /-Wait/.test(outer) && /1223\) \{ exit 2 \}/.test(outer) && enc && decode(enc[1]) === inner,
    'one UAC prompt runs exactly that script, waited for; a declined prompt is exit 2');
  t.ok(StoreApps.psQuote("a'b\u2019c\u2018d") === "'a''b\u2019\u2019c\u2018\u2018d'", 'quoting for PowerShell doubles every character it takes for a single quote');

  // ── the autopilot, on a fake Windows ──
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-sa-'));
  const readList = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const scriptOf = (cmd, args) => (/powershell\.exe$/i.test(String(cmd)) ? decode(args[args.indexOf('-EncodedCommand') + 1] || '') : '');
  const tick = async (n = 50, until = () => false) => { for (let i = 0; i < n && !until(); i++) await new Promise((r) => setImmediate(r)); };
  // open: the Store apps this account has open, a window of each on screen
  // (family names): a UWP app runs in its app container, a desktop one
  // (DESKTOP: the Xbox app, Windows Terminal) in none. brokers: programs in
  // an app container with no window started after those were opened (by
  // default the Xbox app's sign-in, XboxIdentityProvider, once Xbox is open);
  // before: programs in an app container that were running before anything
  // was opened (an app's background task). Start's host always runs, in an
  // app container with a window. background: packaged desktop programs of
  // this account running with no window (widgets, Phone Link); system:
  // packaged services running as SYSTEM, which only an unfiltered process
  // list shows. procsFails: the programs cannot be looked at (Add-Type
  // refused). admin: 'yes', 'no' or 'fails'.
  // answer: 'now', or 'late' (nobody answers in time; w.late[i]() is the Yes
  // that comes afterwards).
  function fakeWindows({ containers, exempt = [], accept = true, works = () => true, psFails = false, cniList = true,
    open = ['microsoft.gamingapp_8wekyb3d8bbwe'], brokers = null, before = [], background = [], system = [], procsFails = false, admin = 'yes', tasklist = true, answer = 'now' } = {}) {
    const w = { containers, exempt: new Set(exempt), prompts: [], calls: [], scripts: [], accept, open, brokers, before, background, system, procsFails, admin, tasklist, answer, late: [] };
    // Every program of this account's in a package or an app container.
    w.procs = () => {
      const brk = w.brokers || (w.open.includes(XBOX_APP) ? [XBOX_ID] : []);
      const list = [{ fam: 'microsoft.windows.startmenuexperiencehost_cw5n1h2txyewy', win: true, ac: true, start: 100 }];
      for (const f of w.background) list.push({ fam: f, win: false, ac: false, start: 500 });
      for (const f of w.before) list.push({ fam: f, win: false, ac: true, start: 500 });
      for (const f of w.open) list.push({ fam: f, win: true, ac: !DESKTOP.has(f), start: 2000 });
      for (const f of brk) list.push({ fam: f, win: false, ac: true, start: 3000 });
      return list.map((p, i) => ({ ...p, pid: 100 + i }));
    };
    const full = (fam) => { const [n, p] = fam.split('_'); return `${n}_1.0.0.0_x64__${p}`; };
    const apply = (verb, sids) => { for (const s of sids) if (StoreApps.SID_RE.test(s) && works(s)) { if (verb === 'add') w.exempt.add(s); else w.exempt.delete(s); } };
    w.run = async (cmd, args) => {
      const exe = path.basename(String(cmd)).toLowerCase();
      w.calls.push(exe);
      if (exe === 'tasklist.exe') {
        if (!w.tasklist) return { code: 1, stdout: '', stderr: 'ERROR: Invalid argument/option - \'/apps\'.' };
        const own = args.some((a) => /^USERNAME eq \S/.test(a));
        const procs = [...w.procs(), ...(own ? [] : w.system.map((fam, i) => ({ fam, pid: 900 + i })))];
        return { code: 0, stdout: procs.map((p) => `"app${p.pid}.exe","${p.pid}","1,000 K","${full(p.fam)}"`).join('\r\n'), stderr: '' };
      }
      if (exe === 'whoami.exe') {
        if (w.admin === 'fails') return { code: 1, stdout: '', stderr: 'blocked by policy' };
        return { code: 0, stdout: WHO(w.admin === 'yes' ? 'Group used for deny only' : ''), stderr: '' };
      }
      if (exe === 'powershell.exe') {
        const script = scriptOf(cmd, args);
        if (script.includes('ShroudlyProcs')) {
          w.scripts.push('procs');
          if (psFails || w.procsFails) return { code: 1, stdout: '', stderr: 'Add-Type: Cannot add type. Constrained language' };
          return { code: 0, stdout: w.procs().map((p) => `P\t${p.pid}\t${p.win ? 1 : 0}\t${p.ac ? 1 : 0}\t${p.ac ? containerSid(p.fam) : ''}\t${full(p.fam)}\t${p.start}\tapp`).join('\r\n'), stderr: '' };
        }
        if (script.includes('ShroudlyNetIso')) {
          w.scripts.push('scan');
          if (psFails) return { code: 1, stdout: '', stderr: 'Add-Type: Cannot add type. Constrained language' };
          const lines = w.containers.map((c) => `C\t${c.sid}\t${c.name}\t${c.display || ''}\t\t${(c.caps || []).join(',')}`);
          return { code: 0, stdout: [...lines, ...[...w.exempt].map((s) => `X\t${s}`)].join('\r\n'), stderr: '' };
        }
        const body = decode(script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1]);
        const b64 = body.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
        const file = b64 ? decode(b64[1]) : body.match(/ReadAllLines\('(.*?)'\)/)[1].replace(/''/g, "'");
        const verb = /LoopbackExempt -d/.test(body) ? 'remove' : 'add';
        // What the elevated script does once Yes is clicked: reads the list
        // (gone by then: nothing), deletes it if it says so, runs the tool.
        const yes = () => {
          if (!fs.existsSync(file)) return [];
          const sids = readList(file);
          if (/Remove-Item -LiteralPath \$f/.test(body)) fs.rmSync(file);
          apply(verb, sids);
          return sids;
        };
        w.prompts.push({ verb, sids: readList(file), file });
        if (w.answer === 'late') { w.late.push(yes); return { code: -1, timedOut: true, stdout: '', stderr: '' }; }
        if (!w.accept) return { code: 2, stdout: '', stderr: '' };
        yes();
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
  function rig(w, { store = memStore(), record = { list: [] }, on = true, busy = false, clock = { t: 1e12 }, run = w.run } = {}) {
    const told = [];
    const logs = [];
    const sa = new StoreApps({
      store, platform: 'win32', run, now: () => clock.t, protectionOn: () => on, busy: () => busy, tmpdir: TMP,
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
      'Xbox open, protection on: one prompt adds every app that needs it (the Store and the sign-in broker too), nothing else');
    t.ok(r.told.map((x) => x.id).join() === 'autoStoreAppsAsk,autoStoreAppsOn' && r.told[1].p.apps === 'Xbox, Microsoft Store',
      `the user is told before the prompt, and after, in one line each ("${r.told[1].p.apps}")`);
    t.ok(r.sa.ours().join() === [STORE, XBOX, XBOXID].join() && r.record.list.join() === r.sa.ours().join(),
      'what was added is remembered, in the settings and for the uninstaller');
    t.ok(!r.sa.ours().includes(WEBVIEW), 'an exemption that was there before is never counted as Shroudly\'s');
    t.ok(r.store.get('storeAppsMode') === true && !r.store.get('storeAppsPending') && !r.store.get('storeAppsHandled'), 'the switch shows on; nothing left pending, nothing kept as refused');
    t.ok(!fs.existsSync(w.prompts[0].file), 'the list handed to the prompt is gone');
    t.ok(r.logs.some((l) => l === 'info: Store apps: 3 cannot reach Shroudly (Xbox, Microsoft Store); asking for permission')
      && r.logs.some((l) => l === 'success: Store apps: 3 can now reach Shroudly'), 'the log says what happened');
    w.containers.push({ sid: WHATSAPP, name: '5319275a.whatsappdesktop_cv1g1gvanyjgm', caps: net });
    w.open.push('5319275a.whatsappdesktop_cv1g1gvanyjgm');
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
    // No Store app open (a cafe PC whose customers never open one): nobody
    // is asked, and the list is not even read. Windows' own parts always run.
    const GS = containerSid('microsoft.gamingservices_8wekyb3d8bbwe');
    const w = fakeWindows({ containers: [...MACHINE(), { sid: AAD, name: 'microsoft.aad.brokerplugin_cw5n1h2txyewy', caps: ['S-1-15-3-3'] },
      { sid: GS, name: 'microsoft.gamingservices_8wekyb3d8bbwe', caps: net }], exempt: [WEBVIEW], open: [], system: ['microsoft.gamingservices_8wekyb3d8bbwe'] });
    const r = rig(w);
    const idle = await r.sa.survey();
    t.ok(!idle.asked && idle.why === 'idle' && !w.prompts.length && !w.calls.includes('powershell.exe') && !r.told.length && !r.logs.length,
      `no Store app open (Gaming Services running as SYSTEM is none): no prompt, no line, the list not even read, the windows not looked at (${idle.why})`);
    // Xbox opened later: noticed at the next look (every ten minutes), and
    // every app that needs it goes in the one prompt, the sign-in brokers too.
    w.open.push('microsoft.gamingapp_8wekyb3d8bbwe');
    r.clock.t += 10 * 60 * 1000;
    const res = await r.sa.survey();
    t.ok(res.result === 'on' && w.prompts.length === 1 && w.prompts[0].sids.join() === [STORE, XBOX, XBOXID, AAD, GS].join(),
      'Xbox opened later: one prompt at the next look, with the Store and the sign-in brokers');
  }

  {
    // Only an app that needs nothing is open: no prompt, and the list is read
    // again only for an app not seen open before (or every half hour).
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], open: ['microsoft.windowscalculator_8wekyb3d8bbwe'] });
    const r = rig(w);
    const scans = () => w.scripts.filter((c) => c === 'scan').length;
    const a = await r.sa.survey();
    const n1 = scans();
    r.clock.t += 10 * 60 * 1000;
    const b = await r.sa.survey();
    t.ok(!a.asked && !b.asked && !w.prompts.length && n1 === 1 && scans() === n1, `an app that needs nothing open: no prompt, and the list is not read again every ten minutes (${a.why}, ${b.why})`);
    w.open.push('microsoft.windowsstore_8wekyb3d8bbwe');
    r.clock.t += 10 * 60 * 1000;
    const c = await r.sa.survey();
    t.ok(c.result === 'on' && w.prompts[0].sids.join() === [STORE, XBOX, XBOXID].join(), '…the Store opened then: noticed at the next look');
    // tasklist /apps refused: the programs are looked at all the same.
    const w2 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], tasklist: false });
    t.ok((await rig(w2).sa.survey()).result === 'on' && w2.scripts.includes('procs'), 'no tasklist /apps: the programs are looked at all the same');
    // The programs cannot be looked at (a locked-down PowerShell): nothing
    // tells a Store app in use, so nothing is asked by itself; the switch still asks.
    const w3 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], procsFails: true });
    const r3 = rig(w3);
    t.ok((await r3.sa.survey()).why === 'idle' && !w3.prompts.length && !w3.scripts.includes('scan'), 'the programs not readable: not asked by itself');
    t.ok((await r3.sa.setMode(true)).success && w3.prompts.length === 1, '…the switch still asks');
  }

  {
    // What tells a Store app in use: only programs in an app container, the
    // one place Windows keeps off loopback addresses.
    const P = (pid, win, ac, fam, start) => `P\t${pid}\t${win ? 1 : 0}\t${ac ? 1 : 0}\t${ac ? containerSid(fam) : ''}\t${fam.replace('_', '_1.0.0.0_x64__')}\t${start}\tx`;
    const procs = StoreApps.parseProcs([
      P(1, true, true, 'microsoft.windows.startmenuexperiencehost_cw5n1h2txyewy', 100),
      P(2, true, false, TERMINAL, 1000),
      P(3, false, true, 'microsoft.windowsstore_8wekyb3d8bbwe', 500),
      `P\t4\t1\t1\t${STORE}-1-2-3-4\t\t900\tchild`,
      'garbage',
    ].join('\r\n'));
    t.ok(procs.length === 4 && procs[1].family === TERMINAL && !procs[1].appContainer && procs[3].sid === STORE,
      "the programs' lines: window, app container, its SID (a child container's parent), package, start");
    t.ok(StoreApps.openSigns(procs).size === 1 && StoreApps.openSigns(procs).has(STORE),
      "signs: a program in an app container with a window; not Windows' own, not a desktop program in a package, not one in an app container running before by itself");
    const later = StoreApps.parseProcs([P(2, true, false, XBOX_APP, 1000), P(5, false, true, XBOX_ID, 1500), P(6, false, true, 'microsoft.aad.brokerplugin_cw5n1h2txyewy', 1600)].join('\n'));
    t.ok([...StoreApps.openSigns(later)].join() === XBOXID, "…and one in an app container started after a desktop Store app was opened (its sign-in), Windows' own excepted");
  }

  {
    // Windows Terminal open alone: a desktop program in a package, outside
    // any app container. Its container may list the network, it needs no
    // exemption: nobody is asked.
    const TERM = containerSid(TERMINAL);
    const containers = [...MACHINE(), { sid: TERM, name: TERMINAL, caps: net }];
    const w = fakeWindows({ containers, exempt: [WEBVIEW], open: [TERMINAL] });
    const r = rig(w);
    const a = await r.sa.survey();
    t.ok(a.why === 'idle' && !w.prompts.length && !r.logs.length, `Windows Terminal open alone: no prompt (${a.why})`);
    // An app's background task in an app container, running before: no sign either.
    const w2 = fakeWindows({ containers, exempt: [WEBVIEW], open: [TERMINAL], before: ['microsoft.windowsstore_8wekyb3d8bbwe'] });
    t.ok((await rig(w2).sa.survey()).why === 'idle' && !w2.prompts.length, '…nor with a Store background task that was running before');
    // The Xbox app, a desktop program too: its sign-in (XboxIdentityProvider,
    // in an app container) is what cannot reach Shroudly. Asked once that runs.
    const w3 = fakeWindows({ containers, exempt: [WEBVIEW], open: [XBOX_APP], brokers: [] });
    const r3 = rig(w3);
    t.ok((await r3.sa.survey()).why === 'idle' && !w3.prompts.length, 'Xbox open, its sign-in not started yet: not yet');
    w3.brokers = [XBOX_ID];
    r3.clock.t += 60 * 1000;
    const x = await r3.sa.survey();
    t.ok(x.result === 'on' && w3.prompts[0].sids.includes(XBOXID) && w3.prompts[0].sids.includes(STORE) && w3.prompts[0].sids.includes(TERM),
      'Xbox open and signing in: one prompt at the next look (a minute), every app that needs it in it');
    // A UWP app open: it runs in its app container.
    const w4 = fakeWindows({ containers, exempt: [WEBVIEW], open: ['microsoft.windowsstore_8wekyb3d8bbwe'] });
    t.ok((await rig(w4).sa.survey()).result === 'on' && w4.prompts.length === 1, 'the Microsoft Store (a UWP app, in its app container) open: asked');
  }

  {
    // Packaged programs that run by themselves with no window (widgets, Phone
    // Link, a sync client, Teams at sign-in): no Store app is open, nobody is
    // asked, and the windows are looked at again only once that changes, or
    // after half an hour.
    const BG = ['microsoft.widgetsplatformruntime_8wekyb3d8bbwe', 'microsoft.yourphone_8wekyb3d8bbwe', 'msteams_8wekyb3d8bbwe'];
    const w = fakeWindows({ containers: [...MACHINE(), ...BG.map((n) => ({ sid: containerSid(n), name: n, caps: net }))], exempt: [WEBVIEW], open: [], background: BG });
    const r = rig(w);
    const a = await r.sa.survey();
    r.clock.t += 10 * 60 * 1000;
    const b = await r.sa.survey();
    t.ok(a.why === 'idle' && b.why === 'idle' && !w.prompts.length && !w.scripts.includes('scan') && w.scripts.join() === 'procs' && !r.logs.length,
      `programs of Store packages running in the background, no window: nobody asked, the list not read, the programs looked at once (${w.scripts.join()})`);
    r.clock.t += 30 * 60 * 1000;
    await r.sa.survey();
    t.ok(w.scripts.join() === 'procs,procs' && !w.prompts.length, '…and again after half an hour');
    w.open.push('microsoft.windowsstore_8wekyb3d8bbwe');
    r.clock.t += 10 * 60 * 1000;
    const c = await r.sa.survey();
    t.ok(c.result === 'on' && w.prompts.length === 1 && w.prompts[0].sids.includes(STORE) && BG.every((n) => w.prompts[0].sids.includes(containerSid(n))),
      'the Store opened: noticed at the next look, and every app that needs it goes in the one prompt');
  }

  {
    // A standard user: never asked by itself (Windows would ask for an
    // administrator's password); one line says so once a session, with what
    // an administrator can do.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], admin: 'no' });
    const r = rig(w);
    const a = await r.sa.survey();
    r.clock.t += 10 * 60 * 1000;
    const b = await r.sa.survey();
    t.ok(a.why === 'not_admin' && b.why === 'not_admin' && !w.prompts.length && r.told.length === 1 && r.told[0].id === 'autoStoreAppsNoAdmin' && r.told[0].p.apps === 'Xbox, Microsoft Store',
      "a standard user's account: no prompt by itself; told once which apps cannot get through, and what an administrator can do");
    t.ok(r.logs.filter((l) => l === 'warning: Store apps: Xbox, Microsoft Store cannot go through Shroudly until an administrator allows it (the Microsoft Store apps switch in Settings)').length === 1
      && r.logs.length === 1, '…the log says once what an administrator can do');
    const on = await r.sa.setMode(true);
    t.ok(on.success && w.prompts.length === 1 && r.sa.ours().length === 3, 'the switch still asks at once (an administrator can type their password)');
    const wf = fakeWindows({ containers: MACHINE(), admin: 'fails' });
    t.ok((await rig(wf).sa.survey()).why === 'not_admin' && !wf.prompts.length, 'whoami not readable: not asked by itself either');
  }

  {
    // Shroudly's own exemptions taken out by an uninstall (the settings stay
    // in %APPDATA%), another tool, or these settings on another PC: they are
    // asked about again.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    const r = rig(w);
    await r.sa.survey();
    for (const s of r.record.list) w.exempt.delete(s);   // the uninstaller
    r.record.list = [];
    const r2 = rig(w, { store: r.store, record: r.record });
    const again = await r2.sa.survey();
    t.ok(again.result === 'on' && w.prompts.length === 2 && w.prompts[1].sids.join() === [STORE, XBOX, XBOXID].join() && [STORE, XBOX, XBOXID].every((s) => w.exempt.has(s)),
      'uninstalled and installed again: asked again, and the exemptions are back');
    t.ok(r2.sa.ours().length === 3 && r2.record.list.join() === r2.sa.ours().join(), '…and recorded again');
    // Settings from before this change kept every SID added as "handled".
    for (const s of [STORE, XBOX, XBOXID]) w.exempt.delete(s);
    const old = memStore({ storeAppsOurs: [STORE, XBOX, XBOXID], storeAppsHandled: [STORE, XBOX, XBOXID], storeAppsMode: true });
    const r3 = rig(w, { store: old });
    const res3 = await r3.sa.survey();
    t.ok(res3.result === 'on' && w.prompts[2].sids.join() === [STORE, XBOX, XBOXID].join() && !r3.store.get('storeAppsHandled'),
      'settings of the version before (each one added kept as handled): asked again too');
    // One gone while the others stay: only that one.
    w.exempt.delete(XBOXID);
    const r4 = rig(w, { store: r3.store, record: r3.record });
    const res4 = await r4.sa.survey();
    t.ok(res4.result === 'on' && w.prompts[3].sids.join() === XBOXID && r4.sa.ours().length === 3, 'one of them taken out by another tool: only that one is asked for');
  }

  {
    // Written down before the prompt: Shroudly quits or crashes after the Yes.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    const record = { list: [] };
    const store = memStore();
    let atPrompt = null;
    const dies = async (c, a) => {
      if (!/RunAs/.test(scriptOf(c, a))) return w.run(c, a);
      atPrompt = { record: [...record.list], pending: store.get('storeAppsPending') };
      await w.run(c, a);
      return new Promise(() => {});    // never comes back
    };
    rig(w, { store, record, run: dies }).sa.survey();
    await tick(200, () => atPrompt);
    t.ok(atPrompt && atPrompt.record.join() === [STORE, XBOX, XBOXID].join() && atPrompt.pending.join() === atPrompt.record.join(),
      "before the prompt, what is asked for is in the settings and in the uninstaller's record");
    const r2 = rig(w, { store, record });
    const next = await r2.sa.survey();
    t.ok(r2.sa.ours().join() === [STORE, XBOX, XBOXID].join() && record.list.join() === r2.sa.ours().join() && !store.get('storeAppsPending') && w.prompts.length === 1 && next.why === 'none',
      'Shroudly gone after the Yes: the next start takes them in as its own, without asking');
    t.ok(r2.logs.includes('success: Store apps: 3 can now reach Shroudly') && store.get('storeAppsMode') === true, '…and says so; the switch shows on');
    // Gone before the answer, which was No: forgotten, the record too.
    const w2 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], accept: false });
    const record2 = { list: [] };
    const store2 = memStore();
    let asked2 = false;
    rig(w2, { store: store2, record: record2, run: async (c, a) => { if (/RunAs/.test(scriptOf(c, a))) { asked2 = true; await w2.run(c, a); return new Promise(() => {}); } return w2.run(c, a); } }).sa.survey();
    await tick(200, () => asked2);
    const r3 = rig(w2, { store: store2, record: record2 });
    await r3.sa.survey();
    t.ok(record2.list.length === 0 && !r3.sa.ours().length && !store2.get('storeAppsPending'), '…gone before a No: the next start forgets them, in the record too');
    // The record held them (pending) while the settings had nothing of
    // Shroudly's: not taken for its own. The user then exempts Xbox with
    // another tool; the switch turned off leaves it.
    const w3 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], accept: false });
    const record3 = { list: [] };
    const store3 = memStore();
    let asked3 = false;
    rig(w3, { store: store3, record: record3, run: async (c, a) => { if (/RunAs/.test(scriptOf(c, a))) { asked3 = true; await w3.run(c, a); return new Promise(() => {}); } return w3.run(c, a); } }).sa.survey();
    await tick(200, () => asked3);
    t.ok(record3.list.join() === [STORE, XBOX, XBOXID].join() && !store3.get('storeAppsOurs'), '(the record holds what is pending, the settings nothing of Shroudly\'s)');
    const r4 = rig(w3, { store: store3, record: record3 });
    await r4.sa._adopt();
    w3.exempt.add(XBOX);   // the user's own, later
    const off4 = await r4.sa.setMode(false);
    t.ok(!r4.sa.ours().length && off4.removed === 0 && w3.prompts.length === 1 && w3.exempt.has(XBOX),
      "…what was only pending is not adopted from the record as Shroudly's: an exemption the user adds later stays");
  }

  {
    // Shroudly's own all gone (an uninstall) while the switch still showed
    // on: it shows off until they are added again.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], accept: false });
    const store = memStore({ storeAppsOurs: [STORE, XBOX, XBOXID], storeAppsMode: true });
    const r = rig(w, { store });
    const res = await r.sa.survey();
    t.ok(res.result === 'declined' && store.get('storeAppsMode') === false && !r.sa.ours().length, 'reinstalled and the prompt declined: the switch shows off, as it is');
    const w2 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], admin: 'no' });
    const store2 = memStore({ storeAppsOurs: [STORE, XBOX, XBOXID], storeAppsMode: true });
    let changed = 0;
    const r2 = rig(w2, { store: store2 });
    r2.sa.onChange = () => { changed++; };
    t.ok((await r2.sa.survey()).why === 'not_admin' && store2.get('storeAppsMode') === false && changed === 1, '…and so for an account that cannot say Yes; the window is told');
    const w3 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    const store3 = memStore({ storeAppsOurs: [STORE, XBOX, XBOXID], storeAppsMode: true });
    const r3 = rig(w3, { store: store3 });
    t.ok((await r3.sa.survey()).result === 'on' && store3.get('storeAppsMode') === true, '…a Yes: on again');
    // Turned on by the user with nothing needing it: stays on.
    const w4 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW, STORE, XBOX, XBOXID] });
    const store4 = memStore({ storeAppsOurs: [CALC] });
    const on4 = await rig(w4, { store: store4 }).sa.setMode(true);
    t.ok(on4.success && store4.get('storeAppsMode') === true && !w4.prompts.length, 'switched on with nothing to add: it stays on');
  }

  {
    // Nobody answers the prompt (away from the PC): no two weeks' wait, no
    // "Windows did not let…", asked again next session; a Yes that comes later is taken in.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], answer: 'late' });
    const r = rig(w);
    const res = await r.sa.survey();
    t.ok(res.result === 'noanswer' && !r.store.get('storeAppsDeclinedAt') && r.told.map((x) => x.id).join() === 'autoStoreAppsAsk'
      && r.logs.includes('info: Store apps: the permission prompt was not answered; Shroudly will ask again next time'), 'no answer: said in the log only, and nothing blocked');
    t.ok(fs.existsSync(w.prompts[0].file) && r.store.get('storeAppsPending').length === 3 && !r.sa.ours().length && r.record.list.join() === [STORE, XBOX, XBOXID].join(),
      '…the list stays for a later Yes, and the record keeps it for the uninstaller meanwhile (nothing counted as added)');
    r.clock.t += 10 * 60 * 1000;
    t.ok((await r.sa.survey()).why === 'asked' && w.prompts.length === 1, '…not asked again this session');
    w.late[0]();   // back at the PC: Yes
    t.ok(!fs.existsSync(w.prompts[0].file), 'the elevated script deletes its list once read');
    const r2 = rig(w, { store: r.store, record: r.record, clock: r.clock });
    const next = await r2.sa.survey();
    t.ok(r2.sa.ours().join() === [STORE, XBOX, XBOXID].join() && r2.record.list.join() === r2.sa.ours().join() && w.prompts.length === 1 && next.why === 'none',
      "the late Yes is taken in at the next start: Shroudly's own, recorded, nothing asked");
    const w2 = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], answer: 'late' });
    const s1 = rig(w2);
    await s1.sa.survey();
    w2.answer = 'now';
    const s2 = rig(w2, { store: s1.store, record: s1.record, clock: s1.clock });
    t.ok((await s2.sa.survey()).result === 'on' && w2.prompts.length === 2 && !s2.store.get('storeAppsPending'), '…never answered: asked again the next session');
    const w3 = fakeWindows({ containers: MACHINE(), answer: 'late' });
    const on = await rig(w3).sa.setMode(true);
    t.ok(!on.success && on.code === 'noanswer', 'the switch turned on and the prompt left unanswered: the switch goes back off');
  }

  {
    // A program stopped for taking too long (the prompt nobody answers) is
    // told apart from one that failed.
    const sa = new StoreApps({ store: memStore() });
    const slow = await sa.run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], 300);
    const bad = await sa.run(process.execPath, ['-e', 'process.exit(3)'], 10000);
    t.ok(slow.timedOut === true && bad.code === 3 && !bad.timedOut, 'a prompt nobody answered in time is not taken for a failure');
  }

  {
    // Declined.
    const w = fakeWindows({ containers: MACHINE(), accept: false });
    const clock = { t: 1e12 };
    const r = rig(w, { clock });
    const res = await r.sa.survey();
    t.ok(res.result === 'declined' && r.store.get('storeAppsDeclinedAt') === clock.t && !r.sa.ours().length && !r.record.list.length && !r.store.get('storeAppsPending'),
      'declined: nothing remembered as added, nothing left in the record');
    t.ok(r.told.map((x) => x.id).join() === 'autoStoreAppsAsk,autoStoreAppsDeclined' && r.told[1].p.apps === 'Xbox, Microsoft Store',
      'the user is told which apps cannot go through Shroudly');
    t.ok(!fs.existsSync(w.prompts[0].file), '…and the list is gone');
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
    // Not asked by itself (declined, or the switch turned off by hand) while
    // a Store app that cannot reach Shroudly is open: the user is told once,
    // in the window, with the date and what to do; nothing with none open.
    const day = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    const at = 1e12 - 3 * 24 * 3600 * 1000;
    const idle = fakeWindows({ containers: MACHINE(), open: [] });
    const r0 = rig(idle, { store: memStore({ storeAppsModeOffAt: at }) });
    const q = await r0.sa.survey();
    t.ok(q.why === 'off_by_hand' && !r0.told.length && !r0.logs.some((l) => /turned off by hand/.test(l)), 'switched off by hand, no Store app open: nothing said');
    const w = fakeWindows({ containers: MACHINE() });
    const r = rig(w, { store: memStore({ storeAppsModeOffAt: at }) });
    await r.sa.survey();
    await r.sa.survey();
    t.ok(!w.prompts.length && r.told.length === 1 && r.told[0].id === 'autoStoreAppsOffBefore' && r.told[0].p.apps === 'Xbox, Microsoft Store' && r.told[0].p.date === day(at)
      && r.logs.filter((l) => l === `info: Store apps: Xbox, Microsoft Store cannot go through Shroudly; the switch was turned off by hand on ${day(at)}; turn it on in Settings to let them through`).length === 1,
    'switched off by hand, Xbox open: not asked, but told once, with the date and what to do');
    const d = fakeWindows({ containers: MACHINE() });
    const rd = rig(d, { store: memStore({ storeAppsDeclinedAt: at }) });
    await rd.sa.survey();
    t.ok(!d.prompts.length && rd.told.length === 1 && rd.told[0].id === 'autoStoreAppsDeclinedBefore' && rd.told[0].p.date === day(at),
      'declined three days ago, Xbox open: not asked, but told in the window too');
    // Declined earlier, and no Store app open at first: the log names the
    // apps, and the window says so once one of them is opened, later in the
    // same session (not silent for the rest of it).
    const late = fakeWindows({ containers: MACHINE(), open: [] });
    const rl = rig(late, { store: memStore({ storeAppsDeclinedAt: at }) });
    await rl.sa.survey();
    t.ok(!rl.told.length && rl.logs.filter((l) => /cannot go through Shroudly; permission was not given$/.test(l)).length === 1,
      'declined earlier, no Store app open: the log names the apps, nothing in the window yet');
    late.open = ['microsoft.gamingapp_8wekyb3d8bbwe'];
    rl.clock.t += 60 * 1000;
    await rl.sa.survey();
    await rl.sa.survey();
    t.ok(!late.prompts.length && rl.told.length === 1 && rl.told[0].id === 'autoStoreAppsDeclinedBefore'
      && rl.logs.filter((l) => /permission was not given$/.test(l)).length === 1,
    'Xbox opened a minute later: told once in the window, with what to do; the log line not repeated');
  }

  {
    // Elevated, but nothing took (a standard account with UAC off, a locked-down system).
    const w = fakeWindows({ containers: MACHINE(), works: () => false });
    const r = rig(w);
    const res = await r.sa.survey();
    t.ok(res.result === 'failed' && r.told[1].id === 'autoStoreAppsFailed' && r.store.get('storeAppsDeclinedAt') && !r.record.list.length, 'nothing added: said as a failure, and not retried for two weeks');
  }

  {
    // One Windows will not exempt (a container left by a removed app).
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], works: (s) => s !== XBOXID });
    const r = rig(w);
    await r.sa.survey();
    t.ok(r.sa.ours().join() === [STORE, XBOX].join() && r.store.get('storeAppsHandled').join() === XBOXID, "only what took is Shroudly's; only the one refused is kept as such");
    const r2 = rig(w, { store: r.store, record: r.record });
    const next = await r2.sa.survey();
    t.ok(!next.asked && next.why === 'none' && w.prompts.length === 1, '…and the one that did not take is not asked about at every start');
  }

  {
    // The user turns the switch on: asked at once, even with protection off.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW], open: [] });
    const r = rig(w, { on: false, store: memStore({ storeAppsDeclinedAt: 1e12 - 1000, storeAppsModeOffAt: 1e12 - 1000 }) });
    t.ok((await r.sa.survey()).why === 'protection_off' && !w.prompts.length, 'protection off: nothing by itself');
    const on = await r.sa.setMode(true);
    t.ok(on.success && w.prompts.length === 1 && r.sa.ours().length === 3, 'switched on by the user: asked now, whatever was declined before, no app open needed');
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
    // One of Shroudly's the user took out by hand meanwhile is not asked
    // about again by the removal.
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
    const slow = async (c, a) => { const x = await w.run(c, a); if (/RunAs/.test(scriptOf(c, a))) await gate; return x; };
    const { sa } = rig(w, { run: slow });
    const a = sa.survey();
    const b = sa.survey();
    let settled = false;
    const s = sa.settled().then(() => { settled = true; });
    await tick(50);
    t.ok(a === b && !settled && w.prompts.length === 1, 'a second survey while the first is under way is the same one; settled() waits for the prompt');
    release();
    await s;
    t.ok(settled && (await a).result === 'on', '…and resolves once it is done');
  }

  {
    // The switch turned on while Shroudly reads by itself (here: which apps
    // a decline left out): it asks all the same.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    let release;
    const gate = new Promise((res) => { release = res; });
    let held = false;
    const slowScan = async (c, a) => {
      if (scriptOf(c, a).includes('ShroudlyNetIso') && !held) { held = true; await gate; }
      return w.run(c, a);
    };
    const r = rig(w, { run: slowScan, store: memStore({ storeAppsDeclinedAt: 1e12 - 1000 }) });
    const auto = r.sa.survey();
    await tick(50, () => held);
    const on = r.sa.setMode(true);
    await tick(50);
    release();
    const [ra, ro] = await Promise.all([auto, on]);
    t.ok(held && ra.why === 'declined' && ro.success && w.prompts.length === 1 && r.sa.ours().length === 3 && r.store.get('storeAppsMode') === true,
      'switched on while Shroudly was reading by itself: asked all the same');
  }

  {
    // The switch turned off while Shroudly's own prompt is on screen: what
    // the Yes then adds is taken out again, and the switch stays off.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    let release;
    const gate = new Promise((res) => { release = res; });
    let atPrompt = false;
    const slowPrompt = async (c, a) => {
      if (/RunAs/.test(scriptOf(c, a)) && !atPrompt) { atPrompt = true; await gate; }
      return w.run(c, a);
    };
    const r = rig(w, { run: slowPrompt });
    const auto = r.sa.survey();
    await tick(200, () => atPrompt);
    const off = r.sa.setMode(false);
    let offDone = false;
    off.then(() => { offDone = true; });
    await tick(50);
    t.ok(atPrompt && !offDone, 'switched off while the prompt is open: the removal waits for it');
    release();
    const [ra, ro] = await Promise.all([auto, off]);
    t.ok(ra.result === 'changed' && ro.success && r.store.get('storeAppsMode') === false && !r.told.some((x) => x.id === 'autoStoreAppsOn'),
      '…the Yes that follows does not turn the switch back on, nor say so');
    t.ok([STORE, XBOX, XBOXID].every((s) => !w.exempt.has(s)) && !r.sa.ours().length && !r.record.list.length && w.prompts.map((p) => p.verb).join() === 'add,remove',
      '…and what it added is taken out again');
  }

  {
    // Another prompt on screen, or protection gone while reading.
    const w = fakeWindows({ containers: MACHINE() });
    const busy = rig(w, { busy: true });
    t.ok((await busy.sa.survey()).why === 'busy' && !w.prompts.length && !w.calls.length, 'Advanced mode\'s prompt open: not even read now');
    let on = true;
    const { sa } = rig(w, { run: async (c, a) => { const x = await w.run(c, a); on = false; return x; } });
    sa.protectionOn = () => on;
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
    t.ok((await r.sa.survey()).why === 'idle' && !w.prompts.length, '…nothing tells a Store app in use there: not asked by itself');
    const res = await r.sa.setMode(true);
    t.ok(res.success && w.prompts[0].sids.join() === [STORE, XBOX, XBOXID, CALC].join(), '…the switch: every package without an exemption is given one');
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
    // The uninstaller's record is written (reg.exe, a moment later) before a
    // survey or a removal is over: checked right after, it is there.
    const w = fakeWindows({ containers: MACHINE(), exempt: [WEBVIEW] });
    let written = null;
    const slowRecord = { get: async () => [], set: (v) => new Promise((r) => setTimeout(() => { written = v; r(); }, 50)) };
    const sa = new StoreApps({ store: memStore(), platform: 'win32', protectionOn: () => true, run: w.run, record: slowRecord, tmpdir: TMP });
    await sa.survey();
    t.ok(written && written.join() === sa.ours().join() && written.length === 3, 'after a survey the record holds exactly what was added');
    await sa.setMode(false);
    t.ok(written && written.length === 0, '…and after switching off, nothing');
  }

  {
    // A list left by a prompt nobody ever answered is cleared a day later.
    const old = path.join(TMP, 'shroudly-lb-00112233445566778899aabbccddeeff.txt');
    const fresh = path.join(TMP, 'shroudly-lb-0011223344556677.txt');
    const other = path.join(TMP, 'notes.txt');
    for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
    const past = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, past, past);
    await rig(fakeWindows({ containers: MACHINE(), open: [] })).sa.survey();
    t.ok(!fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(other), "a prompt's list left a day ago is cleared at the next start; nothing else");
  }

  {
    // Not Windows: nothing runs.
    let ran = 0;
    const sa = new StoreApps({ store: memStore(), platform: 'darwin', protectionOn: () => true, run: async () => { ran++; return { code: 0, stdout: '' }; } });
    const r = await sa.survey();
    t.ok(r.why === 'unsupported' && !ran && (await sa.scan()) === null && (await sa.runningApps()) === null && !(await sa.setMode(true)).success, 'other systems: nothing is run');
  }

  {
    // The uninstaller's record in the registry, as reg.exe is told: one value
    // per SID under a key of its own, however many, in one call.
    const calls = [];
    let imported = null;
    const sa = new StoreApps({ store: memStore(), platform: 'win32', tmpdir: TMP, run: async (c, a) => {
      calls.push([path.basename(c), ...a]);
      if (a[0] === 'import') imported = fs.readFileSync(a[1]);
      return { code: 0, stdout: '' };
    } });
    await sa._setOurs([...many, 'S-1-15-2-1;calc']);
    await sa._setOurs([]);
    t.ok(calls[0][0] === 'reg.exe' && calls[0][1] === 'import' && imported && imported[0] === 0xff && imported[1] === 0xfe
      && imported.slice(2).toString('utf16le') === recordReg(many) && !fs.existsSync(calls[0][2]),
      `written with one reg import (a UTF-16 .reg file, deleted after): ${many.length} SIDs, nothing else`);
    t.ok(calls[1].join(' ') === 'reg.exe delete HKCU\\Software\\Shroudly\\LoopbackExemptions /f' && calls[2].join(' ') === 'reg.exe delete HKCU\\Software\\Shroudly /v LoopbackExempt /f' && calls.length === 3,
      'empty: the list and the old single value deleted');
    const rd = new StoreApps({ store: memStore(), platform: 'win32', run: async (c, a) => ({ code: 0, stdout: a.join(' ') === 'query HKCU\\Software\\Shroudly /s' ? REC : '' }) });
    t.ok((await rd._regRecordGet()).length === 4, '…and read back in either form');
  }

  // ── the uninstaller's command (scripts/installer.nsh) ──
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8');
  const cmd = [...nsh.matchAll(/nsExec::Exec `powershell (.*?) -Command "(.*?)"`/gs)].find((x) => /LoopbackExempt/.test(x[2]));
  t.ok(!!cmd, 'the uninstaller takes Shroudly\'s exemptions out');
  const unin = cmd ? cmd[2].replace(/\$\$/g, '$') : '';
  t.ok(!/"/.test(unin) && unin.includes("Name LoopbackExempt") && /-match '\^S-1-15-2\(-\\d\{1,10\}\)\{7\}\$'/.test(unin)
    && /''\^S-1-15-2\(-\\d\{1,10\}\)\{7\}\$''/.test(unin) && /-Verb RunAs/.test(unin) && /LoopbackExempt -d/.test(unin) && !/LoopbackExempt -a/.test(unin),
  '…only the SIDs in its record, checked twice, removed with one prompt; nothing added');
  const mStart = nsh.indexOf('!macro shroudlyLoopbackCleanup');
  const macro = nsh.slice(mStart, nsh.indexOf('!macroend', mStart));
  t.ok(!/ReadRegStr|\$\{If\}/.test(macro), "…always run: NSIS itself reads none of the list (its strings end at 8192 characters, a longer value reads as nothing)");
  t.ok(/'LoopbackExemptions'/.test(unin) && /GetValueNames\(\)/.test(unin) && /Remove-Item -LiteralPath \$r -Recurse/.test(unin) && /Remove-ItemProperty -LiteralPath \$k -Name LoopbackExempt/.test(unin),
    '…the list read in both forms, and both removed once done');
  t.ok(/FromBase64String\(''' \+ \$b \+ '''\)\)/.test(unin) && !/-replace/.test(unin) && /ReadAllLines\(\$f\); Remove-Item -LiteralPath \$f/.test(unin),
    "…the file's path reaches the elevated script as base64, never inside quotes, and the script deletes the file once read");
  t.ok(/\$\{ifNot\} \$\{isUpdated\}[\s\S]*?shroudlyLoopbackCleanup[\s\S]*?\$\{endIf\}/.test(nsh.slice(nsh.indexOf('!macro customUnInstall'))), '…and not on an update');

  // ── on Windows: the real thing, read only ──
  if (process.platform === 'win32') {
    const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
    // Each PowerShell script parses.
    const scripts = { scan: StoreApps.SCAN_PS, procs: StoreApps.PROCS_PS, elevated: elevatedScript('add', odd), launcher: outer, uninstaller: unin };
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
    // The programs, for real (compiled and run, whatever runs here).
    const pr = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(StoreApps.PROCS_PS, 'utf16le').toString('base64')],
      { encoding: 'utf8', env: powershellEnv(), timeout: 120000 });
    const seen = StoreApps.parseProcs(pr.stdout);
    t.ok(pr.status === 0 && seen.length > 0, `the programs are looked at (${pr.status ? String(pr.stderr).trim().slice(0, 200) : `${seen.length} in a package or an app container, ${seen.filter((p) => p.appContainer).length} in an app container, ${seen.filter((p) => p.window).length} with a window`})`);
    const open = await sa.runningApps();
    t.ok(open instanceof Set, `the open Store apps are read (${open ? open.size : 'none'})`);
    t.ok([true, false].includes(await sa.canConsent()), 'whether this account can say Yes is read');
  } else {
    console.log('  --  the real app containers are read on Windows only');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`storeapps: ${t.count} passed`);
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
