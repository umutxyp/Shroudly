'use strict';

/* Repair, and Reset all settings (electron/repair.js, issue #46): what each
 * does and in which order, what it leaves alone, and what it says. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const R = require(path.join(ROOT, 'electron', 'repair.js'));
const t = suite('repair');

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), m };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-repair-'));
  try {
    const whole = path.join(dir, 'shroudly-core');
    const empty = path.join(dir, 'empty');
    fs.writeFileSync(whole, 'ELF');
    fs.writeFileSync(empty, '');
    t.ok(R.missingFiles([{ name: 'core', path: whole }, { name: 'empty', path: empty }, { name: 'gone', path: path.join(dir, 'gone') }, { name: 'dir', path: dir }]).join() === 'empty,gone,dir',
      'a file missing, empty, or not a file is named; a whole one is not');

    // ── Repair ──
    const did = [];
    const logs = [];
    const deps = (over = {}) => ({
      files: () => [{ name: 'shroudly-core', path: whole }],
      forgetLearned: () => did.push('forget'),
      engineOn: () => true,
      restartEngine: async () => { did.push('restart'); },
      flushDns: async () => { did.push('flush'); return true; },
      adblock: async () => { did.push('adblock'); },
      winHttp: async () => { did.push('winhttp'); },
      log: (l, m) => logs.push(`${l}: ${m}`),
      ...over,
    });
    let r = await R.repair(deps());
    t.ok(did.join() === 'forget,restart,flush,adblock,winhttp', `every step, in order: ${did.join(', ')}`);
    t.ok(!r.missing.length && r.restarted && r.flushed, 'nothing missing, the engine started anew, the DNS cache emptied');
    t.ok(logs[0].startsWith('info: Repair (Settings):') && logs[logs.length - 1] === 'success: Repair done: Shroudly\'s files are all there, and its network settings were set again',
      'said at the start and at the end');

    did.length = 0; logs.length = 0;
    r = await R.repair(deps({ engineOn: () => false, files: () => [{ name: 'shroudly-core', path: path.join(dir, 'gone') }, { name: 'WinDivert', path: '' }] }));
    t.ok(!did.includes('restart') && did.includes('forget') && did.includes('flush'), 'protection off: the engine is not started; the rest is still done');
    t.ok(r.missing.join() === 'shroudly-core,WinDivert' && logs.some((l) => l === "warning: Repair: Shroudly's files are missing or damaged (shroudly-core, WinDivert); install Shroudly again over this one"),
      'missing files are named, with what to do');

    did.length = 0; logs.length = 0;
    r = await R.repair(deps({ restartEngine: async () => { throw new Error('Engine failed to restart'); }, flushDns: async () => { throw new Error('x'); }, adblock: async () => { throw new Error('y'); } }));
    t.ok(!r.restarted && !r.flushed && did.includes('winhttp') && logs.includes('warning: Repair: the engine did not start again (Engine failed to restart)'),
      'a step that fails is said, and the others still run');

    // ── Reset all settings ──
    const store = memStore({
      language: 'tr', protectionOn: true, listenPort: 10808, storeAppsOurs: ['x'], pacPort: 20171,
      autoMode: false, strategy: 'split(sni)', adBlock: true, routeMode: 'listed', siteList: ['a.com'], autoStart: true,
      learnedTechniques: [['a.com', { s: 'tlsrec-sni' }]], advancedModeOffAt: 1, discordModeOffAt: 2,
      discordMode: true, appMode: true, storeAppsMode: true,
    });
    const order = [];
    logs.length = 0;
    await R.resetSettings({
      store,
      // The modes are turned off while their settings are still there.
      turnOffModes: async () => { order.push(`modes(${store.get('discordMode')},${store.get('appMode')})`); },
      relaunch: () => order.push('relaunch'),
      log: (l, m) => logs.push(m),
    });
    t.ok(order.join() === 'modes(true,true),relaunch', `the modes turned off first, then the app restarts (${order.join(', ')})`);
    const left = [...store.m.keys()].sort().join(',');
    t.ok(left === 'language,listenPort,pacPort,protectionOn,storeAppsOurs', `every setting gone; the language and what Shroudly keeps for itself stay (${left})`);
    t.ok(logs[0].startsWith('Reset all settings (Settings):'), 'said in the log');

    const s2 = memStore({ adBlock: true });
    logs.length = 0;
    await R.resetSettings({ store: s2, turnOffModes: async () => { throw new Error('declined'); }, relaunch: () => {}, log: (l, m) => logs.push(m) });
    t.ok(!s2.m.has('adBlock') && logs.includes('Reset: a mode could not be turned off (declined)'), 'a mode that cannot be turned off is said, and the settings are still reset');

    // ── the DNS cache ──
    const calls = [];
    const run = (cmd, args, opts, cb) => { calls.push(`${cmd} ${args.join(' ')}`); cb(null); };
    t.ok(await R.flushDnsCache('win32', run) && await R.flushDnsCache('darwin', run) && await R.flushDnsCache('linux', run)
      && calls.join('; ') === 'ipconfig /flushdns; dscacheutil -flushcache; resolvectl flush-caches', `each system's own command, no password: ${calls.join('; ')}`);
    t.ok(await R.flushDnsCache('linux', (c, a, o, cb) => cb(new Error('denied'))) === false, 'refused: said as not done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`repair: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
