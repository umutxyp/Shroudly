'use strict';

/* The Connections list in the desktop app (electron/engine-manager.js,
 * system-hosts.js; issue #74), with a stand-in for the engine's stdin and
 * its lines: CONNS asked and answered, the user's blocks kept and sent to the
 * running engine, sent again after a start, and Shroudly's own names known. */

const EngineManager = require('../../electron/engine-manager');
const SystemHosts = require('../../electron/system-hosts');
const H = require('./helpers');

const t = H.suite('conns-manager');
const mem = {};
const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, delete: (k) => { delete mem[k]; } };

(async () => {
  const em = new EngineManager(store, {});
  const sent = [];
  em.proc = { stdin: { writable: true, write: (s) => { sent.push(...s.split('\n').filter(Boolean)); return true; } } };

  // The list: CONNS goes out, the rows come back until conns_end.
  const p = em.connsList();
  t.ok(sent.at(-1) === 'CONNS', 'CONNS asked of the engine');
  em._onLine(JSON.stringify({ type: 'conn', host: 'a.example', active: 1, conns: 2, up: 10, down: 20, route: 'tor', blocked: 0, refused: 0, ago: 5 }));
  em._onLine(JSON.stringify({ type: 'conn', host: 'b.example', active: 0, conns: 1, up: 1, down: 2, route: 'direct', blocked: 1, refused: 3, ago: 9 }));
  em._onLine(JSON.stringify({ type: 'conns_end', n: 2 }));
  const rows = await p;
  t.ok(rows.length === 2 && rows[0].route === 'tor' && rows[1].refused === 3, 'the rows come back as the engine gave them');

  // Not answered: an empty list, not a wait forever.
  const late = await em.connsList(200);
  t.ok(Array.isArray(late) && late.length === 0, 'an engine that does not answer: an empty list in time');

  // Blocks: kept, and into the running engine at once.
  let r = em.setBlocked('Tracker.Example.', true);
  t.ok(r.ok && sent.at(-1) === 'BLOCK tracker.example' && mem.userBlocked.includes('tracker.example'), 'a block is kept and sent at once (name made lower case, no trailing dot)');
  em.setBlocked('x.example', true);
  r = em.setBlocked('x.example', false);
  t.ok(r.ok && sent.at(-1) === 'UNBLOCK x.example' && !mem.userBlocked.includes('x.example'), 'allowed again: dropped and sent');
  t.ok(!em.setBlocked('bad name;rm', true).ok, 'a malformed name is refused');

  // A new engine: the blocks again, after BLOCK-CLEAR.
  sent.length = 0;
  em._applyBlocks();
  t.ok(sent[0] === 'BLOCK-CLEAR' && sent.includes('BLOCK tracker.example'), 'after a start the blocks are given to the engine again');

  // Through Tor (a site that turns the user's country away itself): kept,
  // sent at once, taken back, given again after a start.
  r = em.setTorSite('Geo.Example.', true);
  t.ok(r.ok && sent.at(-1) === 'TOR geo.example' && mem.torSites.includes('geo.example'), 'a site sent through Tor is kept and sent at once');
  em.setTorSite('other.example', true);
  r = em.setTorSite('other.example', false);
  t.ok(r.ok && sent.at(-1) === 'UNTOR other.example' && !mem.torSites.includes('other.example'), 'back the usual way: dropped and sent');
  t.ok(!em.setTorSite('bad name;rm', true).ok, 'a malformed name is refused');
  sent.length = 0;
  em._applyTorSites();
  t.ok(sent[0] === 'TOR-CLEAR' && sent.includes('TOR geo.example'), 'after a start the Tor sites are given to the engine again');

  // Not running: nothing asked, an empty list.
  em.proc = null;
  t.ok((await em.connsList()).length === 0, 'not running: an empty list');

  // Shroudly's own names.
  t.ok(SystemHosts.isSystemHost('dns.google') && SystemHosts.isSystemHost('snowflake-broker.torproject.net') && SystemHosts.isSystemHost('shroudly.codeshare.me')
    && SystemHosts.isSystemHost('my.server.example', ['server.example']) && !SystemHosts.isSystemHost('google.com') && !SystemHosts.isSystemHost('notgithub.com'),
    'Shroudly\'s own names are known (DNS, Tor, codeshare.me, the user\'s own server), and only those');

  // ...have no Block anywhere: blocking one would only break Shroudly.
  const fs = require('fs');
  const read = (...p) => fs.readFileSync(require('path').join(H.ROOT, ...p), 'utf8');
  const sp = read('components', 'StatsPanel.js');
  const main = read('electron', 'main.js');
  t.ok(/: !r\.system && <button[\s\S]{0,80}block\(r\.host, true\)/.test(sp) && /ownNames/.test(sp) && !/connsSystemConfirm/.test(sp)
    && /if \(SystemHosts\.isSystemHost\(host, \[own\]\)\) return \{ ok: false, why: 'system' \}/.test(main),
    'desktop: no Block button for Shroudly\'s own names, none offered when typed, and refused if asked anyway');
  const ca = read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'ConnectionsActivity.kt');
  t.ok(/if \(blocked \|\| !system\) r\.addView\(Button/.test(ca) && /if \(on && Conns\.isSystem\(host/.test(ca) && /!Conns\.isSystem\(typed, own\)/.test(ca),
    'Android: the same');
  const cv = read('apple', 'App', 'ConnectionsView.swift');
  t.ok(/if isBlocked \|\| !Conns\.isSystem\(host, own: own\)/.test(cv) && /if on && Conns\.isSystem\(host, own: own\) \{ return \}/.test(cv) && /!Conns\.isSystem\(typed, own: own\)/.test(cv),
    'Apple: the same');

  console.log(`conns-manager: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
