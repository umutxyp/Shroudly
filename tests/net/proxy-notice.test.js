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
const { proxyNotice, chromiumNote } = load('components/proxyNotice.js');
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

const missing = [...new Set(used)].filter((k) => !(k in en));
t.ok(!missing.length, missing.length ? `keys missing in English: ${missing.join(', ')}` : `every key it names is in English (${new Set(used).size})`);
console.log(`proxy-notice: ${t.count} passed`);
