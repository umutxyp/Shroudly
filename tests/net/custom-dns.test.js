'use strict';

/* A DNS server of the user's own (electron/custom-dns.js, issue #34): what is
 * typed for each kind is read or refused with the reason; then each kind
 * answers for real against a server on this computer (plain UDP, plain TCP,
 * DNS over TLS, DNS over HTTPS with HTTP/2 and with HTTP/1.1 only), a name is
 * looked up through the bootstrap (never the network's DNS), a certificate
 * that is not the server's is refused, and the forwarder asks only that
 * server while it is set and the built-in routes again once it is not.
 * Questions asked at once are not mixed up (the same id twice on one
 * connection, an HTTP/1.1-only server), a chunked answer is read, and a
 * server that does not answer leaves the built-in routes answering, said
 * once in the log, until it answers again. Through the user's own proxy
 * (issue #58): SOCKS5 (with and without a login) and HTTP CONNECT, the
 * server's name handed to the proxy and nothing looked up here. */

const net = require('net');
const tls = require('tls');
const http2 = require('http2');
const https = require('https');
const dgram = require('dgram');
const path = require('path');
const { ROOT, suite, testServerOptions } = require('./helpers');
const C = require(path.join(ROOT, 'electron', 'custom-dns.js'));
const DohForwarder = require(path.join(ROOT, 'electron', 'doh-forwarder.js'));

const t = suite('custom-dns');

/* An answer to `q` with one A record, `ip`. */
function answer(q, ip) {
  const head = Buffer.from(q.subarray(0, 12));
  head[2] = 0x81; head[3] = 0x80;          // response, recursion
  head.writeUInt16BE(1, 6);                // one answer
  const rr = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ip.split('.').map(Number)]);
  return Buffer.concat([head, q.subarray(12), rr]);
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function framed(sock, ip) {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
      const q = buf.subarray(2, 2 + buf.readUInt16BE(0)); buf = buf.subarray(2 + q.length);
      const a = answer(q, ip); const h = Buffer.alloc(2); h.writeUInt16BE(a.length, 0);
      sock.write(Buffer.concat([h, a]));
    }
  });
  sock.on('error', () => {});
}
/* The question name in a DNS message, to tell answers apart. */
const qname = (m) => { const out = []; let p = 12; while (m[p]) { out.push(m.subarray(p + 1, p + 1 + m[p]).toString()); p += 1 + m[p]; } return out.join('.'); };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

/* A SOCKS5 proxy (RFC 1928/1929) that resolves test.local itself, as a real
 * one resolves the names it is given; `asked` collects the targets. */
function socks5Proxy(asked, login = null) {
  return net.createServer((c) => {
    let buf = Buffer.alloc(0);
    let step = 'hello';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 'hello') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (login && !methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; }
        c.write(Buffer.from([5, login ? 2 : 0]));
        step = login ? 'login' : 'connect';
      }
      if (step === 'login') {
        if (buf.length < 2) return;
        const ul = buf[1]; if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const user = buf.subarray(2, 2 + ul).toString(); const pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (user !== login.user || pass !== login.pass) { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0])); step = 'connect';
      }
      if (step === 'connect') {
        if (buf.length < 5) return;
        let host; let off;
        if (buf[3] === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (buf[3] === 3) { if (buf.length < 5 + buf[4] + 2) return; host = buf.subarray(5, 5 + buf[4]).toString(); off = 5 + buf[4]; }
        else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        asked.push(`${host}:${port}`);
        step = 'pipe';
        const up = net.connect({ host: host === 'test.local' ? '127.0.0.1' : host, port }, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          c.removeAllListeners('data'); c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    });
  });
}

/* An HTTP proxy that takes CONNECT, with an optional Basic login. */
function httpProxy(asked, auth = null) {
  return net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      c.removeListener('data', onData);
      const head = buf.subarray(0, end).toString();
      const m = /^CONNECT (\S+):(\d+) HTTP\/1\.1/.exec(head);
      if (!m) { c.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      if (auth && !head.includes(`Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}`)) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      asked.push(`${m[1]}:${m[2]}`);
      const up = net.connect({ host: m[1] === 'test.local' ? '127.0.0.1' : m[1], port: Number(m[2]) }, () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    };
    c.on('data', onData);
  });
}

(async () => {
  // ── what is typed ──
  const ok = (k, s) => C.parse(k, s);
  t.ok(JSON.stringify(ok('doh', 'https://dns.google/dns-query')) === '{"kind":"doh","host":"dns.google","port":443,"path":"/dns-query"}'
    && ok('doh', 'dns.example.com').path === '/dns-query' && ok('doh', 'https://1.1.1.1:8443/q?x=1').port === 8443 && ok('doh', 'https://1.1.1.1:8443/q?x=1').path === '/q?x=1',
  'DoH: a URL, or just a name (https:// and /dns-query added), port and path kept');
  t.ok(ok('dot', 'tls://1.1.1.1').port === 853 && ok('dot', 'dns.quad9.net:8853').port === 8853 && ok('tcp', '8.8.8.8').port === 53
    && ok('tcp', 'tcp://[2001:4860:4860::8888]:53').host === '2001:4860:4860::8888' && ok('udp', 'udp://9.9.9.9').port === 53 && ok('udp', '2620:fe::fe').host === '2620:fe::fe',
  'DoT, TCP, UDP: an address or a name, its scheme optional, the usual port by default, IPv6 in brackets or bare');
  t.ok(ok('doh', '').error === 'empty' && ok('doh', 'http://dns.google/dns-query').error === 'url' && ok('dot', 'https://x.y').error === 'url'
    && ok('tcp', '8.8.8.8:99999').error === 'port' && ok('udp', 'not a host').error === 'host' && ok('ftp', '1.1.1.1').error === 'kind'
    && ok('udp', '300.1.1.1').error === 'host' && ok('doh', 'https://1.2.3/dns-query').error === 'host',
  'refused with the reason: empty, not https for DoH, another scheme, a bad port, a bad name, a mistyped address, an unknown kind');
  t.ok(C.shown(ok('doh', 'dns.google')) === 'https://dns.google/dns-query' && C.shown(ok('dot', '1.1.1.1')) === 'tls://1.1.1.1:853' && C.shown(ok('tcp', '[::1]:53')) === 'tcp://[::1]:53',
    'shown as the user would type it');

  // ── the proxy typed for it (#58) ──
  const px = (s) => C.parseProxy(s);
  t.ok(px('') === null && px('  ') === null, 'no proxy typed: none');
  t.ok(JSON.stringify(px('socks5://127.0.0.1:1080')) === '{"type":"socks5","host":"127.0.0.1","port":1080,"user":"","pass":""}'
    && px('socks5h://proxy.example:9050').type === 'socks5' && px('socks://[::1]:1080').host === '::1'
    && px('http://user:p%40ss@10.0.0.2:8080').pass === 'p@ss' && px('http://10.0.0.2:8080').type === 'http',
  'SOCKS5 (socks5://, socks5h://, socks://) and HTTP, an address or a name, IPv6 in brackets, a login with escaped characters');
  t.ok(['socks5://127.0.0.1', 'ftp://1.2.3.4:21', 'socks5://127.0.0.1:99999', '127.0.0.1:1080', 'socks5://bad host:1', 'http://300.1.1.1:80'].every((v) => px(v).error === 'proxy'),
    'refused: no port, another scheme, a bad port, no scheme, a bad name, a mistyped address');
  t.ok(C.shownProxy(px('socks5://me:secret@127.0.0.1:1080')) === 'socks5://127.0.0.1:1080' && C.shownProxy(px('http://[::1]:3128')) === 'http://[::1]:3128',
    'shown without the login (never in a log)');

  // ── each kind, against a server here ──
  const q = DohForwarder.buildQuery('example.com', 1);
  const udp = dgram.createSocket('udp4');
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  udp.on('message', (m, ri) => udp.send(answer(m, '93.184.215.14'), ri.port, ri.address));
  const tcp = net.createServer((s) => framed(s, '93.184.215.15'));
  const tcpPort = await listen(tcp);
  const dot = tls.createServer(testServerOptions(), (s) => framed(s, '93.184.215.16'));
  const dotPort = await listen(dot);
  const doh2 = http2.createSecureServer({ ...testServerOptions(), allowHTTP1: false });
  doh2.on('stream', async (st, h) => {
    const body = await readBody(st);
    if (h[':path'] !== '/dns-query' || h['content-type'] !== 'application/dns-message') { st.respond({ ':status': 400 }); st.end(); return; }
    st.respond({ ':status': 200, 'content-type': 'application/dns-message' }); st.end(answer(body, '93.184.215.17'));
  });
  const doh2Port = await listen(doh2);
  const doh1 = https.createServer({ ...testServerOptions(), ALPNProtocols: ['http/1.1'] }, async (req, res) => {
    const body = await readBody(req);
    const a = answer(body, '93.184.215.18');
    res.writeHead(200, { 'content-type': 'application/dns-message', 'content-length': a.length }); res.end(a);
  });
  const doh1Port = await listen(doh1);
  // HTTP/1.1, the answer chunked and the connection then closed.
  const chunked = tls.createServer({ ...testServerOptions(), ALPNProtocols: ['http/1.1'] }, (s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/content-length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
      if (buf.length < end + 4 + len) return;
      const a = answer(buf.subarray(end + 4, end + 4 + len), '93.184.215.19');
      const half = a.length >> 1;
      s.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/dns-message\r\ntransfer-encoding: chunked\r\n\r\n'),
        Buffer.from(`${half.toString(16)}\r\n`), a.subarray(0, half), Buffer.from(`\r\n${(a.length - half).toString(16)}\r\n`), a.subarray(half), Buffer.from('\r\n0\r\n\r\n')]));
    });
    s.on('error', () => {});
  });
  const chunkedPort = await listen(chunked);
  const ca = testServerOptions().cert;
  const boot = async (name) => (name === 'test.local' ? '127.0.0.1' : null);
  const ask = (kind, text, opts = {}) => new C.CustomDns(C.parse(kind, text), { bootstrap: boot, ca, ...opts }).query(q);
  try {
    t.ok(C.firstA(await ask('udp', `127.0.0.1:${udp.address().port}`)) === '93.184.215.14', 'plain UDP answered');
    // A lossy network: the first question is lost, the one sent again is answered.
    const lossy = dgram.createSocket('udp4');
    await new Promise((r) => lossy.bind(0, '127.0.0.1', r));
    let seen = 0;
    lossy.on('message', (m, ri) => { if (++seen > 1) lossy.send(answer(m, '93.184.215.21'), ri.port, ri.address); });
    const l0 = Date.now();
    const la = await ask('udp', `127.0.0.1:${lossy.address().port}`);
    t.ok(C.firstA(la) === '93.184.215.21' && seen === 2 && Date.now() - l0 < 2000, `plain UDP, the first question lost: sent again and answered in ${Date.now() - l0} ms`);
    lossy.close();
    t.ok(C.firstA(await ask('tcp', `127.0.0.1:${tcpPort}`)) === '93.184.215.15', 'plain TCP answered (length-prefixed)');
    t.ok(C.firstA(await ask('dot', `test.local:${dotPort}`)) === '93.184.215.16', 'DNS over TLS answered, its name looked up through the bootstrap and its certificate checked against it');
    t.ok(C.firstA(await ask('doh', `https://test.local:${doh2Port}/dns-query`)) === '93.184.215.17', 'DNS over HTTPS, HTTP/2: answered');
    t.ok(C.firstA(await ask('doh', `https://test.local:${doh1Port}/dns-query`)) === '93.184.215.18', 'DNS over HTTPS, a server with HTTP/1.1 only: answered');
    t.ok(C.firstA(await ask('doh', `https://test.local:${chunkedPort}/dns-query`)) === '93.184.215.19', 'DNS over HTTPS, HTTP/1.1, the answer chunked: read');
    const h1 = new C.CustomDns(C.parse('doh', `https://test.local:${doh1Port}/dns-query`), { bootstrap: boot, ca });
    const names = ['a.example', 'b.example', 'c.example', 'd.example'];
    const h1as = await Promise.all(names.map((n) => h1.query(DohForwarder.buildQuery(n, 1))));
    t.ok(h1as.every((a, i) => qname(a) === names[i]), 'HTTP/1.1 only: four questions at once, each on a connection of its own, each answered');
    h1.close();
    let refused = null;
    try { await ask('dot', `127.0.0.1:${dotPort}`); } catch (e) { refused = e.message; }
    t.ok(refused && /IP|altnames|match/i.test(refused), `given by an address its certificate does not name: refused, never trusted (${refused})`);
    let unknown = null;
    try { await ask('dot', `other.local:${dotPort}`); } catch (e) { unknown = e.message; }
    t.ok(/could not be looked up/.test(unknown || ''), 'a name the bootstrap cannot look up: an error, no plain lookup instead');
    // Several questions on one connection, answered by id.
    const d = new C.CustomDns(C.parse('tcp', `127.0.0.1:${tcpPort}`), {});
    const qs = [1, 2, 3].map((i) => { const m = DohForwarder.buildQuery(`n${i}.example`, 1); m.writeUInt16BE(1000 + i, 0); return m; });
    const as = await Promise.all(qs.map((m) => d.query(m)));
    t.ok(as.every((a, i) => a.readUInt16BE(0) === 1000 + i + 1), 'TCP: three questions on one connection, each answer matched by its id');
    const same = ['x.example', 'y.example'].map((n) => { const m = DohForwarder.buildQuery(n, 1); m.writeUInt16BE(77, 0); return m; });
    const sameAs = await Promise.all(same.map((m) => d.query(m)));
    t.ok(qname(sameAs[0]) === 'x.example' && qname(sameAs[1]) === 'y.example' && sameAs.every((a) => a.readUInt16BE(0) === 77),
      'the same id twice at once (two programs asking): each gets its own answer, under its own id');
    d.close();

    // ── the forwarder ──
    const f = new DohForwarder(() => {});
    let builtIn = 0;
    f.resolveRoutes = async (m) => { builtIn++; return answer(m, '127.0.0.1'); };
    f.setCustom(C.parse('dot', `test.local:${dotPort}`), { ca });
    t.ok(C.firstA(await f.resolve(q)) === '93.184.215.16' && builtIn === 1, "with one set, only it is asked; the built-in routes only looked its name up");
    t.ok(/^tls:\/\/test\.local:\d+ \d+ms$/.test(f.summary()), `the log says which server answers (${f.summary()})`);
    f.setCustom(null);
    t.ok(C.firstA(await f.resolve(q)) === '127.0.0.1' && builtIn === 2, 'none set: the built-in routes again');

    // A server that does not answer: the built-in routes do, it rests, the
    // log says so once; it is used again once it answers.
    const spare = net.createServer(); const sparePort = await listen(spare); await new Promise((r) => spare.close(r));
    const logs = [];
    const g = new DohForwarder((level, text) => logs.push(`${level}: ${text}`));
    let routed = 0;
    g.resolveRoutes = async (m) => { routed++; return answer(m, '127.0.0.2'); };
    g.setCustom(C.parse('tcp', `127.0.0.1:${sparePort}`));
    const r1 = await g.resolve(q); const r2 = await g.resolve(q);
    t.ok(C.firstA(r1) === '127.0.0.2' && C.firstA(r2) === '127.0.0.2' && routed === 2, 'not answering: every lookup still answered, by the built-in routes');
    const warned = logs.filter((l) => /^warning: Your DNS server tcp:\/\/127\.0\.0\.1:\d+ does not answer \(ECONNREFUSED\); Shroudly's built-in encrypted DNS answers until it does$/.test(l));
    t.ok(warned.length === 1 && g.custom.restUntil > Date.now(), `after the second time in a row it rests, said once (${logs.join(' | ')})`);
    const t0 = Date.now(); await g.resolve(q); await g.resolve(q);
    t.ok(Date.now() - t0 < 200 && routed === 4 && logs.length === 1, 'while it rests: not asked, no waiting, nothing more in the log');
    const back = net.createServer((s) => framed(s, '93.184.215.20'));
    await new Promise((r) => back.listen(sparePort, '127.0.0.1', r));
    g.custom.restUntil = 0;
    t.ok(C.firstA(await g.resolve(q)) === '93.184.215.20' && logs.some((l) => /^success: Your DNS server tcp:\/\/127\.0\.0\.1:\d+ answers again$/.test(l)) && g.custom.fails === 0,
      'its rest over and answering again: used, and the log says so');
    g.setCustom(null); back.close();

    // "Only this server": not answering, nothing else is asked (the
    // built-in routes neither, nor plain DNS: the engine is told the same,
    // DNS-STRICT), the lookup fails, and the log says why, once.
    const hl = [];
    const h = new DohForwarder((level, text) => hl.push(`${level}: ${text}`));
    let fellBack = 0;
    h.resolveRoutes = async (m) => { fellBack++; return answer(m, '127.0.0.3'); };
    h.setCustom(C.parse('tcp', `127.0.0.1:${sparePort}`), { strict: true });
    const failed = [await h.resolve(q).then(() => false, () => true), await h.resolve(q).then(() => false, () => true)];
    t.ok(failed.every(Boolean) && fellBack === 0 && h.usingCustom(), 'only this server, not answering: the lookup fails, nothing else is asked');
    t.ok(hl.length === 1 && /^warning: Your DNS server tcp:\/\/127\.0\.0\.1:\d+ does not answer \(ECONNREFUSED\); it is the only one used, so lookups fail until it answers$/.test(hl[0]),
      `and the log says so once (${hl.join(' | ')})`);
    h.setCustom(null);

    // ── through the user's proxy (#58) ──
    const noBoot = async () => { throw new Error('looked up here'); };
    const sAsked = [];
    const socks = socks5Proxy(sAsked);
    const socksPort = await listen(socks);
    const viaS = (kind, text) => new C.CustomDns(C.parse(kind, text), { bootstrap: noBoot, ca, proxy: C.parseProxy(`socks5://127.0.0.1:${socksPort}`) }).query(q);
    t.ok(C.firstA(await viaS('tcp', `127.0.0.1:${tcpPort}`)) === '93.184.215.15' && sAsked.includes(`127.0.0.1:${tcpPort}`), 'plain TCP through a SOCKS5 proxy: answered');
    t.ok(C.firstA(await viaS('dot', `test.local:${dotPort}`)) === '93.184.215.16' && sAsked.includes(`test.local:${dotPort}`),
      'DNS over TLS through SOCKS5: the name went to the proxy, nothing was looked up here, the certificate still checked');
    t.ok(C.firstA(await viaS('doh', `https://test.local:${doh2Port}/dns-query`)) === '93.184.215.17', 'DNS over HTTPS (HTTP/2) through SOCKS5: answered');
    const lAsked = [];
    const locked = socks5Proxy(lAsked, { user: 'me', pass: 's3cret' });
    const lockedPort = await listen(locked);
    const viaL = (cred) => new C.CustomDns(C.parse('tcp', `127.0.0.1:${tcpPort}`), { bootstrap: noBoot, proxy: C.parseProxy(`socks5://${cred}@127.0.0.1:${lockedPort}`) }).query(q);
    t.ok(C.firstA(await viaL('me:s3cret')) === '93.184.215.15', 'SOCKS5 with a user name and password: answered');
    let bad = null;
    try { await viaL('me:wrong'); } catch (e) { bad = e.message; }
    t.ok(/user name or password/.test(bad || ''), `a wrong password: refused, said so (${bad})`);
    const hAsked = [];
    const hp = httpProxy(hAsked, 'u:pw');
    const hpPort = await listen(hp);
    const viaH = (cred, text) => new C.CustomDns(C.parse('doh', text), { bootstrap: noBoot, ca, proxy: C.parseProxy(`http://${cred}127.0.0.1:${hpPort}`) }).query(q);
    t.ok(C.firstA(await viaH('u:pw@', `https://test.local:${doh1Port}/dns-query`)) === '93.184.215.18' && hAsked.includes(`test.local:${doh1Port}`),
      'DNS over HTTPS through an HTTP proxy (CONNECT, with a login): answered, the name went to the proxy');
    let refusedH = null;
    try { await viaH('', `https://test.local:${doh1Port}/dns-query`); } catch (e) { refusedH = e.message; }
    t.ok(/HTTP 407/.test(refusedH || ''), `the HTTP proxy wants a login that was not given: refused (${refusedH})`);
    const gone = net.createServer(); const gonePort = await listen(gone); await new Promise((r) => gone.close(r));
    let down = null;
    try { await new C.CustomDns(C.parse('tcp', `127.0.0.1:${tcpPort}`), { proxy: C.parseProxy(`socks5://127.0.0.1:${gonePort}`) }).query(q); } catch (e) { down = e.code || e.message; }
    t.ok(down === 'ECONNREFUSED', `the proxy not running: an error, so the built-in routes answer meanwhile (${down})`);
    socks.close(); locked.close(); hp.close();
  } finally {
    udp.close(); tcp.close(); dot.close(); doh2.close(); doh1.close(); chunked.close();
  }
  console.log(`custom-dns: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
