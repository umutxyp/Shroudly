'use strict';

/* The settings a report carries (electron/report-settings.js): every one as
 * it acts, defaults included, which were changed, and never a link, an
 * address or a list's contents. */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const R = require(path.join(ROOT, 'electron', 'report-settings.js'));
const t = suite('report-settings');

let r = R.effective({});
t.ok(r.settings.torLastResort === true && r.settings.dnsProtection === true && r.settings.autoMode === true && r.settings.routeMode === 'all',
  'nothing stored: the defaults, as they act');
t.ok(r.changed.length === 0, 'nothing stored: nothing changed');

r = R.effective({ torLastResort: false, autoMode: true, ownServer: 'ss://secret@203.0.113.9:8388', customDns: 'https://dns.example/q',
  siteList: ['a.example', 'b.example'], userBlocked: ['x.example'], language: 'tr', dohRoute: 'google-2', reports: [{ ref: 'SR-1' }] });
t.ok(r.settings.torLastResort === false && r.changed.includes('torLastResort'), 'turned off: said, and listed as changed');
t.ok(!r.changed.includes('autoMode'), 'stored at its default: not a change');
t.ok(r.settings.ownServer === 'set' && r.settings.customDns === 'set', 'own server and DNS: only whether set');
t.ok(r.settings.siteList === 'own list of 2' && r.settings.userBlocked === 1, 'lists: how many');
t.ok(r.settings.language === 'tr' && r.settings.dohRoute === 'google-2', 'short choices kept');
const all = JSON.stringify(r);
t.ok(!/secret|203\.0\.113|dns\.example|a\.example|x\.example|SR-1/.test(all), 'no link, address, list entry or reference anywhere');

console.log(`report-settings: ${t.count} passed`);
