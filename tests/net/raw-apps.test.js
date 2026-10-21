'use strict';

/* Naming the app behind a connection that is not TLS or HTTP and cannot get
 * through, and telling the user in one line (electron/raw-apps.js):
 *  - an address or name of a known service is that service;
 *  - on the desktop, the program holding the app's end of the connection to
 *    the engine is found from the port the engine reports (procnet.owner),
 *    checked here against a real connection of this very process;
 *  - a notification only for an app that can be named, once per network,
 *    and only after enough of its addresses failed; an address nothing can be
 *    said about is a line in the log, once in a while. */

const net = require('net');
const { suite } = require('./helpers');
const raw = require('../../electron/raw-apps');
const procnet = require('../../electron/procnet');

const t = suite('raw-apps');

(async () => {
  /* 1. services */
  t.ok(raw.serviceOf('149.154.167.50').id === 'telegram', 'a Telegram data centre address is Telegram');
  t.ok(raw.serviceOf('91.108.56.130').id === 'telegram', 'and one in another of its ranges');
  t.ok(raw.serviceOf('2001:67c:4e8:f002::a').id === 'telegram' && raw.serviceOf('[2001:b28:f23d:f001::a]').id === 'telegram', 'and its IPv6 ones');
  t.ok(raw.serviceOf('kws2.web.telegram.org').id === 'telegram' && raw.serviceOf('t.me').id === 'telegram', 'and its names');
  t.ok(raw.serviceOf('149.154.176.1') === null && raw.serviceOf('8.8.8.8') === null && raw.serviceOf('nottelegram.org') === null, 'nothing else is');
  t.ok(raw.serviceOf('g.whatsapp.net').name === 'WhatsApp', 'WhatsApp by its names');
  t.ok(raw.inCidr(raw.v6Bytes('::ffff:1.2.3.4'), '::ffff:0:0/96') && raw.v6Bytes('1::2::3') === null && raw.v4Bytes('1.2.3.256') === null, 'addresses are read strictly');
  const ranges = raw.pacRanges();
  t.ok(ranges.some(([n, m]) => n === '149.154.160.0' && m === '255.255.240.0') && ranges.every(([n]) => !n.includes(':')), 'the PAC gets the IPv4 ranges with their masks');
  t.ok(raw.programName('C:\\Users\\a\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe') === 'Telegram' && raw.programName('') === null, 'a program by the name people know');

  /* 2. procnet: the program at the other end of a connection to "the engine" */
  t.ok(procnet.parseNetstatOwner('  TCP    127.0.0.1:50123        127.0.0.1:10808        ESTABLISHED     4242\n  TCP    127.0.0.1:10808        127.0.0.1:50123        ESTABLISHED     900\n', 50123, 10808) === 4242, 'netstat: the app end, not the engine end');
  t.ok(procnet.parseLsofOwner('p77\ncTelegram\nn127.0.0.1:50123->127.0.0.1:10808\np900\ncshroudly\nn127.0.0.1:10808->127.0.0.1:50123\n', 50123, 10808).name === 'Telegram', 'lsof: the app end, by name');
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = net.connect(srv.address().port, '127.0.0.1');
  await new Promise((r) => c.once('connect', r));
  const o = await procnet.owner(c.localPort, srv.address().port);
  t.ok(o && o.pid === process.pid, `a real connection of this process is found (${o && o.name}, pid ${o && o.pid})`);
  c.destroy(); srv.close();

  /* 3. what the user is told */
  let now = 1e6;
  const said = [], told = [];
  const mk = (owner) => new raw.RawWatch({ log: (l, m) => said.push(m), tell: (id, p) => told.push([id, p]), owner, now: () => now });
  const w = mk(async (cport) => (cport === 7 ? 'SomeApp' : cport === 8 ? 'Telegram.exe' : null));
  // a known service: after its second address does not answer
  t.ok(await w.onEvent('unreachable', { host: '149.154.167.50', port: 443, cport: 0 }) === 'counting', 'one Telegram address: not yet');
  t.ok(await w.onEvent('unreachable', { host: '149.154.175.50', port: 443, cport: 0 }) === 'notified', 'two: told');
  t.ok(told.length === 1 && told[0][0] === 'autoRawUnreachable' && told[0][1].app === 'Telegram', 'in one line naming Telegram');
  t.ok(/^Telegram cannot reach its servers \(149\.154\.167\.50:443, 149\.154\.175\.50:443\): the network blocks those addresses themselves;/.test(said[said.length - 1]), 'and a log line with the addresses');
  t.ok(await w.onEvent('unreachable', { host: '149.154.167.91', port: 443 }) === 'told' && told.length === 1, 'not told again on this network');
  // one address that keeps failing (an app retrying the same server)
  const wa = mk(async () => null);
  t.ok(await wa.onEvent('unreachable', { host: '91.108.56.130', port: 443 }) === 'counting', 'one Telegram address once: not yet');
  now += 10 * 1000;
  t.ok(await wa.onEvent('unreachable', { host: '91.108.56.130', port: 443 }) === 'counting', 'the same one 10 s later: not yet');
  now += raw.AGAIN_MS;
  t.ok(await wa.onEvent('unreachable', { host: '91.108.56.130', port: 443 }) === 'notified', 'still failing half a minute on: told');
  const wb = mk(async () => 'SomeApp');
  for (let i = 0; i < 4; i++) { await wb.onEvent('unreachable', { host: '198.51.100.9', port: 6881, cport: 3 }); now += 60 * 1000; }
  t.ok(told.filter(([, p]) => p.app === 'SomeApp').length === 0, 'a program retrying one dead address is never told (it may be a dead peer)');
  // a program: three addresses
  told.length = 0;
  for (const h of ['198.51.100.1', '198.51.100.2']) t.ok(await w.onEvent('unreachable', { host: h, port: 6881, cport: 7 }) === 'counting', `a program's address ${h}: not yet`);
  t.ok(await w.onEvent('unreachable', { host: '198.51.100.3', port: 6881, cport: 7 }) === 'notified' && told[0][1].app === 'SomeApp', 'its third: told, by the program name');
  // spread out over more than the window: never enough at once
  told.length = 0;
  const w2 = mk(async () => 'Game');
  for (let i = 0; i < 5; i++) { await w2.onEvent('unreachable', { host: `203.0.113.${i}`, port: 7000, cport: 9 }); now += raw.WINDOW_MS + 1; }
  t.ok(told.length === 0, 'failures far apart in time are never added up');
  // every technique failed: one is enough, it is strong evidence
  t.ok(await w.onEvent('blocked', { host: '149.154.167.50', port: 443, attempts: 6, cport: 8 }) === 'notified', 'nothing got through: told at once');
  t.ok(told[0][0] === 'autoRawBlocked' && told[0][1].app === 'Telegram', 'naming the program (Telegram.exe as Telegram)');
  // nothing to name it by: a log line, rarely, never a notification
  told.length = 0;
  t.ok(await w.onEvent('unreachable', { host: '203.0.113.50', port: 9000 }) === 'logged', 'an address of no known app: a log line');
  t.ok(said[said.length - 1] === '203.0.113.50:9000: could not be reached (not a web connection)', 'saying what it is');
  t.ok(await w.onEvent('unreachable', { host: '203.0.113.50', port: 9000 }) === 'quiet', 'not again soon');
  t.ok(await w.onEvent('blocked', { host: '2001:db8::5', port: 443, attempts: 6 }) === 'logged' && said[said.length - 1] === '[2001:db8::5]:443: still blocked after 6 techniques (not a web connection)', 'an IPv6 one, bracketed');
  t.ok(told.length === 0, 'and no notification for either');
  // another network: told again there
  w.networkChanged();
  await w.onEvent('unreachable', { host: '149.154.167.50', port: 443 });
  t.ok(await w.onEvent('unreachable', { host: '149.154.175.50', port: 443 }) === 'notified', 'on another network it is told again');
  // a host learnt from a program earlier names a later line with no program
  const w3 = mk(async (cport) => (cport === 5 ? 'Signal' : null));
  await w3.onEvent('blocked', { host: '203.0.113.77', port: 443, cport: 5 });
  told.length = 0;
  const w3b = w3;
  w3b.told.clear();
  t.ok(await w3b.onEvent('blocked', { host: '203.0.113.77', port: 443, cport: 0 }) === 'notified' && told[0][1].app === 'Signal', 'an address once seen with a program keeps its name');

  console.log(`raw-apps: ${t.count} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
