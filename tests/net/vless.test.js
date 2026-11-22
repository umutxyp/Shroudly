'use strict';

/* VLESS and Trojan for "Your own server" (electron/vless.js): the links
 * people pass around are read, the kinds that cannot be carried are said to
 * be so (never tried another way), the headers are the protocols' own bytes
 * (fixtures/vless-vectors.json, which the Android and Apple apps read too),
 * and connections really go through a server of each kind: over TCP, a
 * WebSocket and HTTPUpgrade, with TLS and without, large transfers whole in
 * both directions, a server that speaks first, a wrong key, a certificate
 * that is not the server's. */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const V = require(path.join(ROOT, 'electron', 'vless.js'));
const Server = require('./fixtures/vless-server');
const t = suite('vless');

const ID = '0f6c2c1e-7a53-4d0b-9c1d-5b8a3e2f4a67';
const IDHEX = ID.replace(/-/g, '');

// ── links ──
{
  // The shape of a link sent to us from Iran (a server behind a CDN): VLESS in a WebSocket with TLS.
  const p = V.parseLink(`vless://${ID}@edge.example.net:443?path=%2Fd917409a2b69662b&security=tls&encryption=none&insecure=0&host=edge.example.net&type=ws&allowInsecure=0&sni=edge.example.net#Cloady`);
  t.ok(p.ok && p.kind === 'vless' && p.host === 'edge.example.net' && p.port === 443 && p.net === 'ws' && p.tls === true
    && p.path === '/d917409a2b69662b' && p.wsHost === 'edge.example.net' && p.sni === 'edge.example.net' && p.id === IDHEX && p.insecure === false && p.name === 'Cloady',
  'a vless:// link for a WebSocket with TLS is read whole (address, path, Host, name of the certificate, key, name)');
  t.ok(V.describe(p) === 'VLESS edge.example.net:443 (WebSocket + TLS)' && !V.describe(p).includes(IDHEX), 'what is shown of it never has the key');
  const q = V.parseLink(`vless://${ID}@1.2.3.4:80?type=ws&path=/ws%3Fed%3D2048&host=cdn.example.org#x%20y`);
  t.ok(q.ok && q.tls === false && q.path === '/ws' && q.wsHost === 'cdn.example.org' && q.host === '1.2.3.4' && q.name === 'x y',
    'without TLS (a CDN\'s port 80), an address with the name in Host, and Xray\'s "?ed=2048" taken off the path');
  t.ok(V.parseLink(`vless://${ID}@host.example:443?type=ws&path=/a?x=1&ed=2560&security=tls`).path === '/a?x=1'
    && V.parseLink(`vless://${ID}@host.example:443?type=ws&path=${encodeURIComponent('/a?ed=2560&x=1')}&security=tls`).path === '/a?x=1',
  '…also when the path has a question of its own');
  const r = V.parseLink(`vless://${ID}@[2001:db8::1]:8443?security=tls&sni=v.example.com&alpn=h2,http/1.1&allowInsecure=1`);
  t.ok(r.ok && r.net === 'tcp' && r.host === '2001:db8::1' && r.port === 8443 && r.insecure === true && r.alpn.join() === 'h2,http/1.1' && r.path === '/',
    'plain TCP with TLS, an IPv6 address, allowInsecure and ALPN');
  const h = V.parseLink(`vless://${ID}@h.example:443?type=httpupgrade&security=tls&path=up&host=h.example`);
  t.ok(h.ok && h.net === 'httpupgrade' && h.path === '/up', 'HTTPUpgrade, a path without its slash');
  const tr = V.parseLink('trojan://p%40ss%3Aword@t.example:443?type=ws&path=/t&sni=t.example#T');
  t.ok(tr.ok && tr.kind === 'trojan' && tr.password === 'p@ss:word' && tr.tls === true && tr.net === 'ws', 'a trojan:// link: its password as written, TLS unless it says otherwise');
  t.ok(V.parseLink('  VLESS://' + ID.toUpperCase() + '@H.example:443?TYPE=ws&Security=TLS  ').ok, 'letters\' case and spaces around do not matter');

  // What cannot be carried is said, each by its name.
  const no = (link) => { const x = V.parseLink(link); return x.ok ? 'ok' : `${x.error}${x.what ? `:${x.what}` : ''}`; };
  t.ok(no(`vless://${ID}@h.example:443?security=reality&pbk=abc&sid=01&fp=chrome&type=tcp&flow=xtls-rprx-vision`) === 'unsupported:reality', 'REALITY: not supported, said so');
  t.ok(no(`vless://${ID}@h.example:443?security=tls&flow=xtls-rprx-vision`) === 'unsupported:flow', 'the Vision flow: said so');
  t.ok(no(`vless://${ID}@h.example:443?security=tls&type=grpc&serviceName=x`) === 'unsupported:transport'
    && no(`vless://${ID}@h.example:443?security=tls&type=xhttp&path=/x`) === 'unsupported:transport'
    && no(`vless://${ID}@h.example:443?type=kcp`) === 'unsupported:transport'
    && no(`vless://${ID}@h.example:80?type=tcp&headerType=http`) === 'unsupported:transport', 'gRPC, XHTTP, mKCP and the HTTP disguise: said so');
  t.ok(no(`vless://${ID}@h.example:443?security=tls&encryption=mlkem768x25519plus.native.0rtt.abc`) === 'unsupported:encryption', 'VLESS\'s own encryption: said so');
  t.ok(no(`vless://${ID}@h.example:443?security=xtls`) === 'unsupported:security', 'XTLS: said so');
  // What is no link at all.
  t.ok(no('vless://not-a-uuid@h.example:443') === 'format' && no(`vless://${ID}@h.example`) === 'format' && no(`vless://${ID}@h.example:0`) === 'format'
    && no(`vless://${ID}@h.example:99999`) === 'format' && no('vless://@h.example:443') === 'format' && no('trojan://@h.example:443') === 'format'
    && no(`vless://${ID}@h.example:443?type=ws&host=a%20b`) === 'format' && no(`vless://${ID}@h.example:443?type=ws&path=/a%0d%0aX:1`) === 'format'
    && no(`vless://${ID}@h.example:443?sni=a%0ab`) === 'format' && no('ss://abc') === 'format' && no('') === 'format',
  'a key that is no UUID, no port, a Host or a path with a line break in it: not a link');
}

// ── what the window shows of a link ──
{
  const vm = require('vm');
  const code = `${fs.readFileSync(path.join(ROOT, 'components', 'ownServerText.js'), 'utf8').replace(/export (const|function)/g, '$1')}\n;({ maskLink, serverShown, OWN_SERVER_ERRORS, OWN_SERVER_WHY, OWN_SERVER_UNSUPPORTED })`;
  const W = vm.runInNewContext(code, { atob: (x) => Buffer.from(x, 'base64').toString('binary'), escape, decodeURIComponent });
  const link = `vless://${ID}@edge.example.net:443?type=ws&security=tls&path=%2Fabc&host=edge.example.net#Mine`;
  t.ok(W.maskLink(link) === 'vless://••••@edge.example.net:443?type=ws&security=tls&path=%2Fabc&host=edge.example.net#Mine' && !W.maskLink(link).includes(ID),
    'the saved link is shown with its key covered');
  t.ok(W.maskLink('trojan://my%20secret@t.example:443?sni=t.example') === 'trojan://••••@t.example:443?sni=t.example', '…a Trojan link with its password covered');
  t.ok(W.serverShown(link) === 'VLESS edge.example.net:443' && W.serverShown('trojan://x@[2001:db8::1]:443') === 'Trojan [2001:db8::1]:443', 'and named by its kind and address');
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'vless.js'), 'utf8');
  const whats = [...new Set([...src.matchAll(/no\('([a-z]+)'\)/g)].map((m) => m[1]))];
  t.ok(whats.length === 5 && whats.every((w) => typeof W.OWN_SERVER_UNSUPPORTED[w] === 'string') && W.OWN_SERVER_ERRORS.unsupported === 'ownServerErrUnsupported' && W.OWN_SERVER_WHY.cert === 'ownServerWhyCert',
    `every part a link can be refused for has its name in the window (${whats.join(', ')})`);
  const locales = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
  const bad = locales.filter((f) => {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', f), 'utf8'));
    return !/\{what\}/.test(d.ownServerErrUnsupported || '') || !d.ownServerWhyCert || !/vless:\/\/…/.test(d.ownServerErrFormat) || !/trojan:\/\/…/.test(d.ownServerErrFormat) || !/VLESS/.test(d.ownServerDesc) || !/Trojan/.test(d.ownServerDesc);
  });
  t.ok(locales.length === 31 && !bad.length, `said in all 31 languages: not supported (with what), the certificate, and the kinds of link (${bad.join(', ') || 'all'})`);
}

// ── the protocols' own bytes ──
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vless-vectors.json'), 'utf8'));
for (const v of vectors.vless) {
  t.ok(V.vlessHeader(v.id, v.host, v.port).toString('hex') === v.header, `VLESS header for ${v.host}:${v.port}`);
}
for (const v of vectors.trojan) {
  t.ok(V.trojanHeader(v.password, v.host, v.port).toString('hex') === v.header, `Trojan header for ${v.host}:${v.port}`);
}
{
  // Written out by hand once, so the vectors are not only what this code makes.
  const h = V.vlessHeader(IDHEX, 'example.com', 443);
  t.ok(h[0] === 0 && h.subarray(1, 17).toString('hex') === IDHEX && h[17] === 0 && h[18] === 1 && h.readUInt16BE(19) === 443 && h[21] === 2 && h[22] === 11 && h.subarray(23).toString() === 'example.com',
    'VLESS: version 0, the UUID, no additions, TCP, the port, a name with its length');
  const j = V.trojanHeader('secret', '1.2.3.4', 80);
  t.ok(j.subarray(0, 56).toString() === crypto.createHash('sha224').update('secret').digest('hex') && j.subarray(56).toString('hex') === '0d0a' + '01' + '01' + '01020304' + '0050' + '0d0a',
    'Trojan: the SHA-224 of the password in hex, CRLF, connect, the address as SOCKS5 writes it, the port, CRLF');
}

// ── WebSocket frames ──
{
  const sizes = [0, 1, 125, 126, 127, 65535, 65536, 200000];
  let allBack = true;
  for (const n of sizes) {
    const data = crypto.randomBytes(n);
    const f = V.wsFrame(data);
    // As a server reads a client's frame: masked, and the length in its three forms.
    const masked = !!(f[1] & 0x80);
    let len = f[1] & 0x7f; let at = 2;
    if (len === 126) { len = f.readUInt16BE(2); at = 4; } else if (len === 127) { len = f.readUInt32BE(6); at = 10; }
    const mask = f.subarray(at, at + 4);
    const body = Buffer.from(f.subarray(at + 4));
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    if (!masked || (f[0] & 0x8f) !== 0x82 || len !== n || !body.equals(data)) allBack = false;
  }
  t.ok(allBack, `frames to the server: binary, masked, the three forms of the length (${sizes.join(', ')} bytes)`);
  const pings = []; let closed = 0;
  const rd = new V.WsReader({ onPing: (d) => pings.push(d.toString()), onClose: () => { closed++; } });
  const parts = [crypto.randomBytes(5), crypto.randomBytes(300), crypto.randomBytes(70000)];
  const stream = Buffer.concat([Server.serverFrame(parts[0]), Server.serverFrame(Buffer.from('p1'), 9), Server.serverFrame(parts[1]), Server.serverFrame(parts[2]), Server.serverFrame(Buffer.alloc(0), 10)]);
  const got = [];
  for (let i = 0; i < stream.length; i += 777) got.push(...rd.push(stream.subarray(i, i + 777)));
  t.ok(Buffer.concat(got).equals(Buffer.concat(parts)) && pings.join() === 'p1', 'frames from the server arriving in pieces: the data in order, a ping told, a pong passed over');
  rd.push(Server.serverFrame(Buffer.alloc(0), 8));
  t.ok(closed === 1, 'a close frame: told');
  let threw = 0;
  try { new V.WsReader().push(V.wsFrame(Buffer.from('x'))); } catch { threw++; }
  try { const big = Buffer.alloc(10); big[0] = 0x82; big[1] = 127; big.writeUInt32BE(1, 2); new V.WsReader().push(big); } catch { threw++; }
  try { const big = Buffer.alloc(10); big[0] = 0x82; big[1] = 127; big.writeUInt32BE(0x7fffffff, 6); new V.WsReader().push(big); } catch { threw++; }
  t.ok(threw === 3, 'a masked frame from a server, or one of a size no tunnel sends: refused');
}

// ── through a server of each kind ──
function socks(port, host, dport, { user = '', pass = '' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let b = Buffer.alloc(0); let st = 0;
    s.once('error', reject);
    const name = Buffer.from(host);
    const req = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([dport >> 8, dport & 0xff])]);
    s.on('connect', () => s.write(Buffer.from(user ? [5, 1, 2] : [5, 1, 0])));
    const onData = (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) {
        if (b[1] === 2) { s.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)])); st = 1; } else if (b[1] === 0) { s.write(req); st = 2; } else { s.destroy(); reject(new Error('no method')); return; }
        b = b.subarray(2);
      }
      if (st === 1 && b.length >= 2) { if (b[1] !== 0) { s.destroy(); reject(new Error('auth refused')); return; } b = b.subarray(2); s.write(req); st = 2; }
      if (st === 2 && b.length >= 10) {
        if (b[1] !== 0) { s.destroy(); reject(new Error(`socks ${b[1]}`)); return; }
        s.removeListener('data', onData); s.removeListener('error', reject);
        resolve(s);
      }
    };
    s.on('data', onData);
    s.on('close', () => reject(new Error('closed')));
  });
}
const readAll = (s, n, ms = 20000) => new Promise((resolve, reject) => {
  const parts = []; let got = 0;
  const timer = setTimeout(() => reject(new Error(`only ${got} of ${n} bytes`)), ms);
  s.on('data', (d) => { parts.push(d); got += d.length; if (got >= n) { clearTimeout(timer); resolve(Buffer.concat(parts)); } });
  s.on('close', () => { clearTimeout(timer); if (got >= n) resolve(Buffer.concat(parts)); else reject(new Error(`closed after ${got} of ${n} bytes`)); });
  s.on('error', () => {});
});

(async () => {
  // What the tunnel's server connects to: an echo, a sender of a known 3 MB,
  // and a server that speaks first.
  const blob = crypto.randomBytes(3 * 1024 * 1024);
  const echo = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); }).listen(0, '127.0.0.1');
  const giver = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => c.end(blob)); }).listen(0, '127.0.0.1');
  const banner = net.createServer((c) => { c.on('error', () => {}); c.write('220 hello\r\n'); c.on('data', (d) => c.write(`got ${d.length}\r\n`)); }).listen(0, '127.0.0.1');
  // One that counts what it gets and answers only once the sender is done.
  const counted = [];
  const counter = net.createServer({ allowHalfOpen: true }, (c) => {
    let n = 0;
    c.on('error', () => {});
    c.on('data', (d) => { n += d.length; });
    c.on('end', () => { counted.push(n); c.end(`total ${n}`); });
    c.on('close', () => { if (!counted.includes(n)) counted.push(n); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 100));
  const targets = { 'echo.test': echo.address().port, 'giver.test': giver.address().port, 'banner.test': banner.address().port, 'counter.test': counter.address().port };
  const dial = (host) => net.connect({ port: targets[host] || 1, host: '127.0.0.1', allowHalfOpen: true });

  const kinds = [];
  for (const kind of ['vless', 'trojan']) for (const netKind of ['tcp', 'ws', 'httpupgrade']) for (const withTls of [true, false]) kinds.push({ kind, net: netKind, tls: withTls });
  for (const k of kinds) {
    const label = `${k.kind} over ${k.net}${k.tls ? ' + TLS' : ''}`;
    const srv = await Server.start({ ...k, id: IDHEX, password: 'the pass word', path: '/tunnel', dial, split: k.net === 'ws' ? 1000 : 0, pingEvery: k.net === 'ws' ? 40 : 0, addons: Buffer.from([1, 2, 3]) });
    const secret = k.kind === 'vless' ? ID : encodeURIComponent('the pass word');
    const link = `${k.kind}://${secret}@127.0.0.1:${srv.port}?type=${k.net}&security=${k.tls ? 'tls' : 'none'}&path=%2Ftunnel%3Fed%3D2048&host=front.example&sni=test.local#t`;
    const p = V.parseLink(link);
    const errors = [];
    const user = 'u1'; const pass = 'p-secret';
    const client = await V.startClient(p, { user, pass, ca: Server.CERT, onError: (e) => errors.push(e.why || e.message) });

    // An echo: what goes up comes back, in several writes.
    let s = await socks(client.port, 'echo.test', 7, { user, pass });
    const up = crypto.randomBytes(300000);
    const back = readAll(s, up.length);
    for (let i = 0; i < up.length; i += 40000) s.write(up.subarray(i, i + 40000));
    t.ok((await back).equals(up), `${label}: 300 KB up and back, unchanged`);
    s.destroy();
    // 3 MB down, whole.
    s = await socks(client.port, 'giver.test', 80, { user, pass });
    s.write('GET / HTTP/1.1\r\n\r\n');
    t.ok((await readAll(s, blob.length)).equals(blob), `${label}: 3 MB down, whole and in order`);
    s.destroy();
    // A server that speaks first: the header goes by itself.
    s = await socks(client.port, 'banner.test', 25, { user, pass });
    const hello = await readAll(s, 11, 5000);
    s.write('EHLO x\r\n');
    const answer = await readAll(s, 7, 5000);
    t.ok(hello.toString() === '220 hello\r\n' && /^got 8/.test(answer.toString()), `${label}: a server that speaks first is heard (the header is not kept waiting for the client)`);
    s.destroy();
    // The program writes and closes its side at once: all of it still arrives,
    // and (where the transport can say "done sending") the answer after it too.
    counted.length = 0;
    s = await socks(client.port, 'counter.test', 9, { user, pass });
    const lastWords = new Promise((resolve) => { let got = ''; s.on('data', (d) => { got += d; }); s.on('close', () => resolve(got)); setTimeout(() => resolve(got), 4000); });
    s.end(crypto.randomBytes(150000));
    const words = await lastWords;
    for (let i = 0; i < 40 && !counted.length; i++) await new Promise((r) => setTimeout(r, 100));
    if (k.net === 'ws') t.ok(true, `${label}: (a WebSocket cannot say "done sending"; the bytes written before the close are checked below)`);
    else t.ok(words === 'total 150000' && counted[0] === 150000, `${label}: written and closed at once: all 150 KB arrive, and the answer sent after them comes back (${words})`);
    s.destroy();
    for (let i = 0; i < 30 && !counted.length; i++) await new Promise((r) => setTimeout(r, 100));
    t.ok(counted[0] === 150000, `${label}: nothing the program wrote before closing is lost (${counted[0]} bytes)`);
    t.ok(srv.seen.requests.length === 4 && srv.seen.requests[0].host === 'echo.test' && srv.seen.requests[0].port === 7 && srv.seen.badAuth === 0 && !errors.length,
      `${label}: the server was told the names and ports, the key was right`);
    if (k.net !== 'tcp') {
      t.ok(srv.seen.paths.every((x) => x === '/tunnel') && srv.seen.hostHeaders.every((x) => x === 'front.example') && srv.seen.userAgents.every((x) => /Mozilla\/5\.0/.test(x || '')),
        `${label}: the opening request has the link's path (without "ed") and Host, and a browser's User-Agent`);
    }
    if (k.net === 'ws') t.ok(srv.seen.unmasked === 0 && srv.seen.pongs > 0, `${label}: every frame up is masked, and pings are answered (${srv.seen.pongs})`);
    if (k.tls) t.ok(srv.seen.sni.every((x) => x === 'test.local'), `${label}: the name asked of TLS is the link's sni`);

    // Another program of this computer cannot use the user's server through the client.
    let refused = 0;
    await socks(client.port, 'echo.test', 7, { user, pass: 'wrong' }).catch(() => { refused++; });
    await socks(client.port, 'echo.test', 7).catch(() => { refused++; });
    t.ok(refused === 2 && srv.seen.requests.length === 4, `${label}: without the client's own user name and password nothing goes to the server`);

    // A wrong key: the server closes, the program gets no answer and no hang.
    const bad = k.kind === 'vless' ? { ...p, id: crypto.randomBytes(16).toString('hex') } : { ...p, password: 'not it' };
    const c2 = await V.startClient(bad, { ca: Server.CERT });
    s = await socks(c2.port, 'echo.test', 7);
    s.write('hello');
    const end = await new Promise((resolve) => { let n = 0; s.on('data', (d) => { n += d.length; }); s.on('close', () => resolve(n)); setTimeout(() => resolve(-1), 5000); });
    t.ok(end === 0 && srv.seen.badAuth === 1, `${label}: a wrong key: closed by the server, nothing relayed`);
    c2.close();

    if (k.tls) {
      // A certificate that is not the server's (no CA given: the test's own is unknown to the system).
      const why = [];
      const c3 = await V.startClient(p, { onError: (e) => why.push(e.why) });
      const failed = await socks(c3.port, 'echo.test', 7).then(() => false, () => true);
      t.ok(failed && why[0] === 'tls', `${label}: a certificate nobody vouches for: refused (tls), nothing sent`);
      c3.close();
      // …unless the link says allowInsecure.
      const c4 = await V.startClient({ ...p, insecure: true });
      s = await socks(c4.port, 'echo.test', 7);
      s.write('ping');
      t.ok((await readAll(s, 4, 5000)).toString() === 'ping', `${label}: with allowInsecure the link's own choice is followed`);
      s.destroy(); c4.close();
      // The name of the certificate is checked too.
      const c5 = await V.startClient({ ...p, sni: 'other.example' }, { ca: Server.CERT, onError: (e) => why.push(e.why) });
      const failed2 = await socks(c5.port, 'echo.test', 7).then(() => false, () => true);
      t.ok(failed2 && why[1] === 'tls', `${label}: a certificate for another name: refused`);
      c5.close();
    }
    if (k.net !== 'tcp') {
      // A path the server does not know: its 404 is "not this protocol".
      const why = [];
      const c6 = await V.startClient({ ...p, path: '/elsewhere' }, { ca: Server.CERT, onError: (e) => why.push(e.why) });
      const failed = await socks(c6.port, 'echo.test', 7).then(() => false, () => true);
      t.ok(failed && why[0] === 'protocol', `${label}: a wrong path (the server answers 404): said as "does not speak the protocol"`);
      c6.close();
    }
    client.close();
    srv.close();
  }
  // Nothing listening there at all.
  {
    const why = [];
    const dead = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 50));
    const port = dead.address().port;
    dead.close();
    await new Promise((r) => setTimeout(r, 50));
    const c = await V.startClient(V.parseLink(`vless://${ID}@127.0.0.1:${port}?type=ws&security=tls`), { onError: (e) => why.push(e.why) });
    const failed = await socks(c.port, 'echo.test', 7).then(() => false, () => true);
    t.ok(failed && why[0] === 'noAnswer', 'a server that is not there: "does not answer"');
    c.close();
  }
  // With the real engine, as the app runs it (engine-manager.js): the link
  // in the settings, Shroudly's own client in between, sites by name.
  {
    const os = require('os');
    const H = require('./helpers');
    const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
    const web = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')); }).listen(0, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 50));
    const sitePort = web.address().port;
    const fetchVia = async (port, host, tport) => {
      let s;
      try { s = await H.socks(port, host, tport); } catch { return 'refused'; }
      return new Promise((resolve) => {
        let out = '';
        s.on('data', (d) => { out += d; });
        s.on('close', () => resolve(out.split('\r\n')[0]));
        s.on('error', () => resolve('error'));
        s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => s.destroy(), 8000);
      });
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-vless-'));
    const P = await H.freePort();
    const mem = { listenPort: P, autoMode: true, dnsProtection: false };
    const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, delete: (k) => { delete mem[k]; }, get store() { return mem; } };
    const logs = [];
    const em = new EngineManager(store, { addLog: (l, m) => logs.push(`${l}: ${m}`), dataDir: dir });
    em.proxy = { apply: async () => {}, restore: async () => {}, cleanupSync() {}, restoreSync() {} };
    const file = path.join(dir, 'own-server.txt');
    for (const k of [{ kind: 'vless', net: 'ws' }, { kind: 'trojan', net: 'tcp' }, { kind: 'vless', net: 'httpupgrade' }]) {
      const label = `${k.kind} over ${k.net} + TLS, with the engine`;
      const srv = await Server.start({ ...k, tls: true, id: IDHEX, password: 'pw', path: '/t', dial: () => net.connect(sitePort, '127.0.0.1') });
      const secret = k.kind === 'vless' ? ID : 'pw';
      const link = `${k.kind}://${secret}@127.0.0.1:${srv.port}?type=${k.net}&security=tls&path=/t&sni=test.local&allowInsecure=1#Mine`;
      mem.ownServer = link;
      logs.length = 0;
      await em.start();
      const local = em._ssClient && em._ssClient.port;
      t.ok(local && new RegExp(`^socks5://[0-9a-f]{16}:[0-9a-f]{32}@127\\.0\\.0\\.1:${local}\n$`).test(fs.readFileSync(file, 'utf8')),
        `${label}: the engine is pointed at Shroudly's client on this computer, with a password only it was given`);
      const first = await fetchVia(P, 'blocked.example', 443);
      t.ok(first === 'HTTP/1.1 200 OK' && srv.seen.requests.some((r) => r.host === 'blocked.example' && r.port === 443), `${label}: a site goes through the server, asked by name (${first})`);
      t.ok(!logs.some((l) => l.includes(IDHEX) || l.includes(ID) || / pw\b/.test(l)), `${label}: the key is in no log line`);
      // The same link kept through a restart.
      await em.restart();
      t.ok(em._ssClient && em._ssClient.port === local && await fetchVia(P, 'again.example', 443) === 'HTTP/1.1 200 OK', `${label}: a restart keeps the client, and sites still open`);
      // The server gone: said in the window and the log.
      srv.close();
      await H.sleep(100);
      const r = await fetchVia(P, 'x.example', 443);
      await H.sleep(400);
      const down = em.advice.ownServerDown;
      t.ok(r !== 'HTTP/1.1 200 OK' && down && down.why === 'noAnswer' && /^(VLESS|Trojan) 127\.0\.0\.1:\d+ \(/.test(down.server)
        && logs.some((l) => /^warning: Your own server \((VLESS|Trojan) 127\.0\.0\.1:\d+ \([A-Za-z+ ]+\)\) could not be used: does not answer$/.test(l)),
      `${label}: the server gone: told in the window and the log (${JSON.stringify(down)})`);
      await em.stop();
      t.ok(!em._ssClient && !fs.existsSync(file), `${label}: stopped: the client and the file are gone`);
    }
    // A certificate nobody vouches for, without allowInsecure: said as that.
    {
      const srv = await Server.start({ kind: 'vless', net: 'ws', tls: true, id: IDHEX, path: '/t', dial: () => net.connect(sitePort, '127.0.0.1') });
      mem.ownServer = `vless://${ID}@127.0.0.1:${srv.port}?type=ws&security=tls&path=/t&sni=test.local`;
      logs.length = 0;
      await em.start();
      const r = await fetchVia(P, 'y.example', 443);
      await H.sleep(400);
      const down = em.advice.ownServerDown;
      t.ok(r !== 'HTTP/1.1 200 OK' && down && down.why === 'cert' && logs.some((l) => /could not be used: its certificate is not one for its name/.test(l)),
        `a server whose certificate is not vouched for: told as that, nothing sent (${JSON.stringify(down)})`);
      await em.stop();
      srv.close();
    }
    const bad = await em.testOwnServer(`vless://${ID}@h.example:443?security=reality&pbk=x&type=tcp`);
    t.ok(bad.ok === false && bad.invalid === 'unsupported' && bad.what === 'reality', 'the test of a REALITY link: "not supported", with which part, without trying it');
    delete mem.ownServer;
    web.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  echo.close(); giver.close(); banner.close(); counter.close();
  console.log(`vless: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
