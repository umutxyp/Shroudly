'use strict';

/* Windows' WinHTTP proxy read from the registry (electron/winhttp.js): none,
 * one server, one per scheme; and found gone only when every server is on
 * this computer and none listens (never when that cannot be told). On
 * Windows, the real value is read too. */

const path = require('path');
const { ROOT, suite } = require('./helpers');
const W = require(path.join(ROOT, 'electron', 'winhttp.js'));

const t = suite('winhttp');

/* What "reg query ... /v WinHttpSettings" prints for a proxy list. */
function regOut(list) {
  const s = Buffer.from(list || '', 'latin1');
  const b = Buffer.alloc(16 + s.length + 4);
  b.writeUInt32LE(list ? 0x28 : 0x18, 0);
  b.writeUInt32LE(list ? 3 : 1, 8);
  b.writeUInt32LE(s.length, 12);
  s.copy(b, 16);
  return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections\r\n    WinHttpSettings    REG_BINARY    ${b.toString('hex').toUpperCase()}\r\n\r\n`;
}

(async () => {
  t.ok(W.parse(regOut('')) === '' && W.parse('    WinHttpSettings    REG_BINARY    1800000000000000010000000000000000000000') === '',
    'direct access (no proxy): none');
  t.ok(W.parse(regOut('127.0.0.1:1080')) === '127.0.0.1:1080', 'one server read');
  t.ok(W.parse(regOut('http=127.0.0.1:8080;https=127.0.0.1:8080')) === 'http=127.0.0.1:8080;https=127.0.0.1:8080', 'one per scheme read');
  t.ok(W.parse('') === null && W.parse('    WinHttpSettings    REG_BINARY    0102') === null, 'unreadable: null, never taken for none');
  const off = () => false;
  t.ok(W.goneList('127.0.0.1:1080', off) === '127.0.0.1:1080', "a server here where nothing listens: gone");
  t.ok(W.goneList('http=127.0.0.1:8080;https=localhost:8080', off) !== null, 'every one here and none listening: gone');
  t.ok(W.goneList('127.0.0.1:1080', (p) => p === 1080) === null, 'one that listens: not gone');
  t.ok(W.goneList('127.0.0.1:1080', () => null) === null, 'whether it listens unknown: not said to be gone');
  t.ok(W.goneList('http=127.0.0.1:8080;https=proxy.corp:8080', off) === null && W.goneList('proxy.corp:8080', off) === null,
    "a server elsewhere (a company's proxy): never ours to judge");
  t.ok(W.goneList('', off) === null, 'none set: nothing to say');
  if (process.platform === 'win32') {
    const now = await W.read();
    t.ok(now === '' || typeof now === 'string', `Windows: the real setting is read (${now === '' ? 'none' : now})`);
  }
  console.log(`winhttp: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
