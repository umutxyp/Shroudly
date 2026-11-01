'use strict';

/* What the window says about the system proxy (components/proxyNotice.js),
 * for every status system-proxy.js reports: which banner, which words, and
 * which button. What it proves:
 *   - a dismissed administrator password dialog keeps its button (P14)
 *   - a session that does not read what was written for the next login gets
 *     the PAC's address to set by hand, not a promise (P8)
 *   - Chromium browsers and apps opened before Shroudly answered are told
 *     about where they read its address from the environment (P1)
 *   - settings a restart of the Mac left behind are offered once the user
 *     dismissed the dialog, with protection off (P6)
 *   - while browsers are not going through Shroudly the window says "Not
 *     working yet" with the button that fixes it, and the background
 *     process (SystemProxy.routes: the tray, the start's notification)
 *     decides the same for every status; a proxy that could not be set has
 *     a button to try again
 *   - a proxy the computer's administrator set for all its users (Windows'
 *     Group Policy, M3) is "Not working yet" with Advanced mode's button,
 *     not "Protected"; with Advanced mode on, said and not alarming; where
 *     there is no Advanced mode, Firefox's own setting and a button that
 *     copies the address
 *   - every key it names exists in English */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT, suite } = require('./helpers');

const t = suite('proxy-notice');

// proxyNotice.js is an ES module for the web UI; load it as CommonJS here.
function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/export (const|function) /g, '$1 ').replace(/^import .*$/gm, '');
  const names = [...src.matchAll(/^(?:const|function) (\w+)/gm)].map((m) => m[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-pn-'));
  const f = path.join(dir, 'm.js');
  fs.writeFileSync(f, `${src}\nmodule.exports = { ${names.join(', ')} };`);
  try { return require(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const { proxyNotice, chromiumNote, PROXY_ACTIONS } = load('components/proxyNotice.js');
const SystemProxy = require(path.join(ROOT, 'electron', 'system-proxy.js'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const PAC = 'http://127.0.0.1:10840/proxy.pac';
const keysOf = (n) => (n ? [n.title, n.body].filter(Boolean) : []);
const used = [];
const show = (proxy, opts) => { const n = proxyNotice(proxy, opts); used.push(...keysOf(n)); return n; };

const admin = show({ ok: false, code: 'needs_admin', pacUrl: PAC }, { active: true });
t.ok(admin.action === 'admin' && admin.body === 'proxyAdminBody', 'needs_admin: the administrator banner and its button');
const cancelled = show({ ok: false, code: 'cancelled', pacUrl: PAC }, { active: true });
t.ok(cancelled && cancelled.action === 'admin' && cancelled.title === 'proxyAdminTitle' && cancelled.id === 'proxy:cancelled',
  'P14: the password dialog dismissed: the same banner, with its button to try again');
t.ok(show({ ok: false, code: 'replaced' }, { active: true }).action === 'reapply', 'replaced: "Set Shroudly again"');
// Issue #27: another program kept taking it, so Shroudly stopped setting it
// back by itself: said so, with the program when it could be told, and its
// own id (a "replaced" banner closed earlier does not hide it).
const fightNamed = show({ ok: false, code: 'replaced', fight: { by: ['V2Ray / Clash', 'Psiphon'] } }, { active: true });
const fight = show({ ok: false, code: 'replaced', fight: { by: [] } }, { active: true });
t.ok(fightNamed.body === 'proxyFightBodyNamed' && fightNamed.params.program === 'V2Ray / Clash, Psiphon' && fightNamed.action === 'reapply' && fightNamed.id === 'proxy:replaced:fight'
  && fight.body === 'proxyFightBody' && fight.action === 'reapply' && /\{program\}/.test(en.proxyFightBodyNamed) && !/\{program\}/.test(en.proxyFightBody),
'issue #27: a fight is told as one, naming the program when known, with "Set Shroudly again"');
t.ok(show({ ok: true, code: 'ok' }, { active: true }) === null && show({ ok: false, code: 'needs_admin' }, { active: false }) === null,
  'nothing while the proxy is set, or while protection is off');

const notTakenFirefox = show({ ok: false, code: 'partial_env', firefox: true, chromiumNotTaken: true, pacUrl: PAC }, { active: true });
const notTaken = show({ ok: false, code: 'no_system_proxy', firefox: false, chromiumNotTaken: true, pacUrl: PAC }, { active: true });
t.ok(notTakenFirefox.body === 'proxyEnvNotTakenFirefox' && notTaken.body === 'proxyEnvNotTaken' && notTaken.params.pac === PAC && notTakenFirefox.params.pac === PAC
  && /\{pac\}/.test(en.proxyEnvNotTaken) && /\{pac\}/.test(en.proxyEnvNotTakenFirefox) && !/log out/i.test(en.proxyEnvNotTaken + en.proxyEnvNotTakenFirefox),
'P8: a session that does not read the login settings: the address to set by hand, no "after you log out"');
t.ok(show({ ok: false, code: 'partial_env', firefox: true, chromiumAfterRelogin: true, pacUrl: PAC }, { active: true }).body === 'proxyEnvFirefoxNow'
  && show({ ok: false, code: 'partial_env', chromiumNow: true, pacUrl: PAC }, { active: true }).body === 'proxyEnvChromiumNow'
  && show({ ok: false, code: 'partial_env', firefox: true, pacUrl: PAC }, { active: true }).body === 'proxyEnvFirefoxOnly'
  && show({ ok: false, code: 'partial_env', chromiumAfterRelogin: true, pacUrl: PAC }, { active: true }).body === 'proxyEnvRelogin'
  && show({ ok: false, code: 'no_system_proxy', pacUrl: PAC }, { active: true }).body === 'proxyNoneBody'
  && show({ ok: false, code: 'apply_failed' }, { active: true }).body === 'proxyFailedBody',
'the other desktop cases keep their words');

const note = chromiumNote({ ok: true, code: 'ok', chromiumRestart: true }, { active: true });
used.push(...keysOf(note));
t.ok(note && note.body === 'proxyEnvChromiumRestart' && chromiumNote({ ok: true, code: 'ok' }, { active: true }) === null && chromiumNote({ ok: true, chromiumRestart: true }, { active: false }) === null,
  'P1: where Chromium reads Shroudly\'s address from its environment, apps opened before it answered are told about');
t.ok(en.proxyEnvChromiumRestart.length < 200, `P1: …in a short sentence (${en.proxyEnvChromiumRestart.length} characters)`);

const rec = show(null, { active: false, recovery: { declined: true } });
t.ok(rec && rec.action === 'recover' && rec.title === 'proxyRecoverTitle' && en.proxyRecoverButton,
  'P6: settings left by a restart, dialog dismissed: a banner with a button puts them back');
t.ok(show(null, { active: false, recovery: { declined: false } }) === null && show({ ok: true, code: 'ok' }, { active: true, recovery: { declined: true } }) === null,
  'P6: …not before the user was asked, and not while protection is on (its own password request covers it)');

// M3: the administrator's proxy for all users (system-proxy.js).
const policy = { ok: false, code: 'machine_policy', pacUrl: PAC };
const pAdv = show(policy, { active: true, advanced: { available: true, on: false } });
const pOn = show(policy, { active: true, advanced: { available: true, on: true } });
const pNone = show(policy, { active: true, advanced: { available: false, on: false } });
t.ok(pAdv.notRouting && pAdv.action === 'advanced' && pAdv.title === 'proxyPolicyTitle' && pAdv.body === 'proxyPolicyBody' && PROXY_ACTIONS.advanced.label === 'advancedTurnOn'
  && !pOn.notRouting && pOn.icon === 'info' && pOn.body === 'proxyPolicyAdvancedOn' && !pOn.action && pOn.id !== pAdv.id
  && pNone.notRouting && pNone.body === 'proxyPolicyBodyNoAdvanced' && pNone.params.pac === PAC && pNone.action === 'copyPac' && /\{pac\}/.test(en.proxyPolicyBodyNoAdvanced),
'M3: the administrator\'s proxy: "Not working yet" with Advanced mode\'s button; with it on, a quiet line; without it, Firefox\'s own setting and the address to copy');
const m3 = (async () => {
  const calls = [];
  global.window = { electron: { copyText: async (x) => { calls.push(['copy', x]); return true; }, startAdvanced: async () => { calls.push(['adv']); return { success: false, code: 'declined' }; } } };
  const copied = await PROXY_ACTIONS.copyPac.run(pNone);
  const adv = await PROXY_ACTIONS.advanced.run(pAdv);
  delete global.window;
  t.ok(copied.ok && calls[0][0] === 'copy' && calls[0][1] === PAC && adv.ok === false && calls[1][0] === 'adv',
    'M3: the buttons copy the address shown, and start Advanced mode (a refusal is not taken for done)');
  const src = fs.readFileSync(path.join(ROOT, 'components', 'BlockedNotice.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'components', 'ControlPanel.js'), 'utf8');
  t.ok(/a\.run\(pn\)/.test(src) && /fix\.run\(pn\)/.test(src) && /proxyNotice\(proxy, \{ active, recovery, advanced: adv \}\)/.test(src)
    && /proxyNotice\(dpiStatus\.proxy, \{ active, advanced: dpiStatus\.advanced \}\)/.test(src),
  'M3: the banner and the panel give the buttons their notice, and know whether Advanced mode is on');
})();

// "Not working yet": the window (proxyNotice) and the background process
// (SystemProxy.routes) agree for every status system-proxy.js reports.
const STATUSES = [
  null, { ok: true, code: 'ok' }, { ok: true, code: 'ok', chromiumRestart: true },
  { ok: false, code: 'needs_admin' }, { ok: false, code: 'cancelled' }, { ok: false, code: 'replaced' },
  { ok: false, code: 'replaced', fight: { by: ['Psiphon'] } }, { ok: false, code: 'replaced', fight: { by: [] } },
  { ok: false, code: 'apply_failed' }, { ok: false, code: 'apply_failed', partial: true }, { ok: false, code: 'failed' },
  { ok: false, code: 'unsupported' }, { ok: false, code: 'no_system_proxy', pacUrl: PAC },
  { ok: false, code: 'no_system_proxy', chromiumNotTaken: true, pacUrl: PAC },
  { ok: false, code: 'partial_env', firefox: true, chromiumAfterRelogin: true, pacUrl: PAC },
  { ok: false, code: 'partial_env', chromiumNow: true, pacUrl: PAC },
  { ok: false, code: 'machine_policy', pacUrl: PAC },
  { ok: false, code: 'apply_failed', refused: true, pacUrl: PAC },
];
const disagree = STATUSES.filter((st) => !!(proxyNotice(st, { active: true }) || {}).notRouting === SystemProxy.routes(st));
t.ok(!disagree.length, disagree.length ? `the window and the tray disagree on ${JSON.stringify(disagree)}`
  : `"Not working yet" in the window exactly where the tray and the notification say it (${STATUSES.length} statuses)`);
t.ok(!SystemProxy.routes({ ok: false, code: 'needs_admin' }) && !SystemProxy.routes({ ok: false, code: 'replaced' }) && !SystemProxy.routes({ ok: false, code: 'apply_failed' })
  && SystemProxy.routes({ ok: false, code: 'no_system_proxy' }) && SystemProxy.routes({ ok: false, code: 'partial_env' }) && SystemProxy.routes(null),
'not routed: a password needed, taken over, could not be set; a desktop set by hand is not called broken');
const failed = show({ ok: false, code: 'apply_failed' }, { active: true });
t.ok(failed.action === 'retry' && PROXY_ACTIONS.retry.label === 'proxyTryAgain', 'could not be set: a "Try again" button, not only "the details are in Logs"');
// Issue #64: Windows refused the setting; protection is on with its PAC
// served, so a browser can be pointed at it by hand meanwhile.
const refusedNotice = show({ ok: false, code: 'apply_failed', refused: true, system: 'windows', pacUrl: PAC }, { active: true });
t.ok(refusedNotice.notRouting && refusedNotice.action === 'retry' && refusedNotice.body === 'proxyFailedBodyPac' && refusedNotice.params.pac === PAC && /\{pac\}/.test(en.proxyFailedBodyPac),
  'issue #64: refused by Windows: "Not working yet", Try again, and the address to set in a browser by hand (with its copy button)');
const stuck = STATUSES.map((st) => proxyNotice(st, { active: true })).filter((n) => n && n.notRouting);
t.ok(stuck.length && stuck.every((n) => n.action && PROXY_ACTIONS[n.action]), 'every "Not working yet" has a button that fixes it');
// The background process: what the window asks it, the tray, the start's
// notification.
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const statusHandler = main.slice(main.indexOf("ipcMain.handle('dpi:status'"), main.indexOf('}));', main.indexOf("ipcMain.handle('dpi:status'")));
t.ok(/notRouting: notRouting\(\)/.test(statusHandler) && /proxy: engine \? engine\.proxyStatus/.test(statusHandler)
  && /function notRouting\(\) \{ return !!\(engine && engine\.isActive\(\) && !engine\.routing\(\)\); \}/.test(main),
'the window is told when browsers are not going through Shroudly, and why');
t.ok(/routed \? tr\(\)\.trayStarted : tr\(\)\.notifyStartedNotRouted/.test(main) && /notRouting\(\) \? s\.notWorkingYet : s\.trayActive/.test(main),
  'the tray and the start\'s notification say "not working yet" too, never "Protection is on" alone');
for (const a of Object.values(PROXY_ACTIONS)) used.push(a.label);
used.push('notWorkingYet', 'notifyStartedNotRouted', 'bannerMore');

const missing = [...new Set(used)].filter((k) => !(k in en));
t.ok(!missing.length, missing.length ? `keys missing in English: ${missing.join(', ')}` : `every key it names is in English (${new Set(used).size})`);
m3.then(() => console.log(`proxy-notice: ${t.count} passed`)).catch((e) => { console.error('FAIL', e.message); process.exit(1); });
