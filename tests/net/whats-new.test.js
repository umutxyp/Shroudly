'use strict';

/* "What's new" after an update (electron/whats-new.js): once a version, not
 * on a new install, and never the same notes twice. */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const WhatsNew = require(path.join(ROOT, 'electron', 'whats-new.js'));
const en = require(path.join(ROOT, 'locales', 'en.json'));
const t = suite('whats-new');

function store(init = {}) {
  const m = { ...init };
  return { get: (k) => m[k], set: (k, v) => { m[k] = v; }, m };
}

let s = store({ lastVersionSeen: '2.6.59' });
t.ok(WhatsNew.note(s, { current: '2.6.60', text: 'A' }) === '2.6.60' && s.m.whatsNew === '2.6.60', 'updated: the card');
t.ok(WhatsNew.note(s, { current: '2.6.60', text: 'A' }) === null, 'the same version again: nothing');
t.ok(WhatsNew.note(s, { current: '2.6.61', text: 'A' }) === null && s.m.lastVersionSeen === '2.6.61', 'a new version with the same notes: no card');
s.m.whatsNew = undefined;
t.ok(WhatsNew.note(s, { current: '2.6.62', text: 'B' }) === '2.6.62' && s.m.whatsNew === '2.6.62', 'new notes: the card');

s = store();
t.ok(WhatsNew.note(s, { current: '2.6.61', text: 'A', firstRun: true }) === null && s.m.whatsNew === undefined, 'a new install: nothing');

s = store({ lastVersionSeen: '2.6.60' });
t.ok(WhatsNew.note(s, { current: '2.6.61', text: en.whatsNewDesktop }) === null || WhatsNew.digest(en.whatsNewDesktop) !== WhatsNew.SHOWN_BY['2.6.60'],
  'from 2.6.60 (no digest kept): the notes it showed are not shown again');
s = store({ lastVersionSeen: '2.6.60' });
t.ok(WhatsNew.note(s, { current: '2.6.61', text: 'other notes' }) === '2.6.61', 'from 2.6.60 with other notes: the card');
s = store({ lastVersionSeen: '2.6.47' });
t.ok(WhatsNew.note(s, { current: '2.6.61', text: en.whatsNewDesktop }) === '2.6.61', 'from an older version: the card');
t.ok(WhatsNew.note(store({ lastVersionSeen: '2.6.59' }), { current: '2.6.61' }) === null, 'no notes for this system: no card');

// The notes in the apps are written for the version they ship in: from 2.6.65
// to 2.6.70 they were not, and every update showed 2.6.64's notes under its
// own number on iPhone and Android. package.json's whatsNewFor says which
// version the locales' whatsNewDesktop, whatsNewAndroid, whatsNewApple and whatsNewMac (the Mac's own, when it has some)
// were written for; a new version means new notes (or "" where it changes
// nothing on that system), and then whatsNewFor set to it.
const pkg = require(path.join(ROOT, 'package.json'));
t.ok(pkg.whatsNewFor === pkg.version,
  `the in-app notes are for ${pkg.whatsNewFor}, the app is ${pkg.version}: write whatsNewDesktop/Android/Apple in locales/*.json for it, then set whatsNewFor`);
const fs = require('fs');
for (const f of fs.readdirSync(path.join(ROOT, 'locales')).filter((x) => x.endsWith('.json'))) {
  const l = require(path.join(ROOT, 'locales', f));
  for (const k of ['whatsNewDesktop', 'whatsNewAndroid', 'whatsNewApple', 'whatsNewMac']) {
    t.ok(typeof l[k] === 'string' && (l[k].trim() === '') === (en[k].trim() === ''), `${f}: ${k} there, and empty only where English is`);
  }
}

console.log(`whats-new: ${t.count} passed`);
