'use strict';

/* DNS for the Advanced mode labs (the DNS gate, core/src/dnsgate.h):
 *
 *   node lab-dns.js serve <ip> <answer-ip>
 *       a network's DNS on <ip>:53: every A question answered with
 *       <answer-ip>, the way a censor forges them;
 *   node lab-dns.js forwarder <port> <name>=<ip> ...
 *       the app's encrypted-DNS forwarder standing in, on 127.0.0.1:<port>:
 *       those names have those addresses, any other does not exist;
 *   node lab-dns.js ask <server> <name>
 *       asks <server> over UDP (Node's own resolver, not the system's) and
 *       prints the addresses, comma-separated, or the error code.
 *
 * serve and forwarder print "ready" once listening.
 */

const dgram = require('dgram');
const dns = require('dns');

function question(q) {
  let p = 12;
  const labels = [];
  while (p < q.length && q[p]) { labels.push(q.subarray(p + 1, p + 1 + q[p]).toString('latin1')); p += 1 + q[p]; }
  return { name: labels.join('.').toLowerCase(), type: q.readUInt16BE(p + 1), end: p + 5 };
}

/* The answer to q: an A record with ip, or "no such name" when ip is null. */
function answer(q, ip) {
  const { type, end } = question(q);
  const head = Buffer.from(q.subarray(0, 12));
  head[2] = 0x81; head[3] = ip ? 0x80 : 0x83;
  const rr = ip && type === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ip.split('.').map(Number)]) : Buffer.alloc(0);
  head.writeUInt16BE(rr.length ? 1 : 0, 6); head.writeUInt32BE(0, 8);
  return Buffer.concat([head, q.subarray(12, end), rr]);
}

function listen(host, port, pick) {
  const s = dgram.createSocket('udp4');
  s.on('message', (q, from) => {
    if (q.length < 17 || q[2] & 0x80) return;
    s.send(answer(q, pick(question(q).name)), from.port, from.address);
  });
  s.bind(port, host, () => console.log('ready'));
}

const [mode, a, b, ...rest] = process.argv.slice(2);
if (mode === 'serve') {
  listen(a, 53, () => b);
} else if (mode === 'forwarder') {
  const table = Object.fromEntries([b, ...rest].filter(Boolean).map((x) => x.split('=')));
  listen('127.0.0.1', Number(a), (name) => table[name] || null);
} else if (mode === 'ask') {
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  r.setServers([a]);
  r.resolve4(b, (e, addrs) => { console.log(e ? e.code : addrs.join(',')); process.exit(0); });
} else {
  console.error('usage: lab-dns.js serve <ip> <answer-ip> | forwarder <port> <name>=<ip>... | ask <server> <name>');
  process.exit(2);
}
