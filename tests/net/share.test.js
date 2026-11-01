'use strict';

/* "Share my connection" (electron/share.js) and the router's way in
 * (electron/upnp.js):
 *   - on: a Shadowsocks link per way in (the internet's first, where the
 *     router opened one; this network's), which Shroudly's own client and
 *     any other takes; a site opened through it goes through the engine
 *   - never this computer or its network: a private address, a local name,
 *     or a name that leads to one is refused
 *   - a new link: the old one stops working at once
 *   - off: the port closed, the router's way in taken away
 *   - a port another program took: another one, kept
 *   - UPnP against a stand-in router: the mapping asked for this computer's
 *     address, the router's internet address; a provider's shared address
 *     is not taken for one on the internet; a router that takes only
 *     mappings without an end; the mapping taken away */

const http = require('http');
const net = require('net');
const path = require('path');
const H = require('./helpers');

const { Share, localName } = require(path.join(H.ROOT, 'electron', 'share.js'));
const UPnP = require(path.join(H.ROOT, 'electron', 'upnp.js'));
const SS = require(path.join(H.ROOT, 'electron', 'shadowsocks.js'));
const Own = require(path.join(H.ROOT, 'electron', 'own-server.js'));
const t = H.suite('share');
const listening = (s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)));

async function through(link, host, port) {
  const p = Own.parseLink(link);
  const c = await SS.startClient({ server: '127.0.0.1', port: p.port, method: p.method, password: p.password });
  let out = '';
  try {
    const s = await H.socks(c.port, host, port);
    out = await new Promise((resolve) => {
      let got = '';
      s.on('data', (d) => { got += d; });
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
      s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
      setTimeout(() => { s.destroy(); resolve(got); }, 2500);
    });
  } catch { out = 'refused'; }
  c.close();
  return out;
}

(async () => {
  const web = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')); }).listen(0, '127.0.0.1');
  await listening(web);
  const mem = {};
  let ownAddrs = [];
  const store = { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } };
  const logs = [];
  const dialed = [];
  const upnpCalls = [];
  const share = new Share({
    store,
    log: (l, m) => logs.push(m),
    socksPort: () => 10808,
    bindHost: '127.0.0.1',
    lan: () => ['192.168.1.5'],
    own: () => ownAddrs,
    lookup: async (h) => (h === 'evil.example' ? ['93.184.216.34', '192.168.1.1'] : ['93.184.216.34']),
    // The engine stands in: every site is the local one.
    connectVia: (sp, host, port) => { dialed.push(`${sp} ${host}:${port}`); return new Promise((res, rej) => { const s = net.connect(web.address().port, '127.0.0.1', () => res(s)); s.once('error', rej); }); },
    upnp: {
      map: async ({ port }) => { upnpCalls.push(`map ${port}`); return { ok: true, port, external: '5.6.7.8', reachable: true, svc: {} }; },
      unmap: async (m) => { upnpCalls.push(`unmap ${m && m.port}`); },
    },
  });

  t.ok(share.status().on === false && !mem.share, 'off until turned on: nothing listening, nothing made');
  await share.start();
  await H.sleep(100);
  const st = share.status();
  const port = mem.share.port;
  t.ok(st.on && st.port === port && st.links.length === 2 && st.links[0].where === 'internet' && st.links[0].address === '5.6.7.8'
    && st.links[1].where === 'network' && st.links[1].address === '192.168.1.5' && upnpCalls[0] === `map ${port}`,
  `on: a link for the internet (the router opened a way in) and one for this network (${st.links.map((l) => l.where).join(', ')})`);
  const p = Own.parseLink(st.links[1].link);
  t.ok(p.ok && p.kind === 'ss' && p.method === 'aes-256-gcm' && p.password === mem.share.password && p.host === '192.168.1.5' && p.port === port,
    'the link is a Shadowsocks link any app takes (AES-256-GCM, native in Electron and Android), with the password kept for it');
  const local = st.links[1].link.replace('192.168.1.5', '127.0.0.1');
  const ok = await through(local, 'blocked.example', 443);
  t.ok(/^HTTP\/1\.1 200 OK/.test(ok) && dialed[0] === '10808 blocked.example:443', `a site through the share goes through the engine, by name (${dialed[0]})`);
  t.ok(logs.includes(`Sharing this connection: on (port ${port})`) && logs.includes(`Sharing: the router forwards port ${port} (internet address 5.6.7.8)`)
    && !logs.some((l) => l.includes('blocked.example') || l.includes(mem.share.password)), 'the log says it is on and how, never who or where to, nor the password');

  // A computer with an address on the internet itself (no router): a link for it too.
  ownAddrs = ['203.0.113.9'];
  const direct = share.status().links.filter((l) => l.where === 'internet').map((l) => l.address);
  ownAddrs = [];
  t.ok(direct.includes('203.0.113.9') && direct.includes('5.6.7.8'), `an address of its own on the internet: a link for it too (${direct.join(', ')})`);

  // Never this computer or its network.
  const before = dialed.length;
  const r = [];
  for (const target of ['127.0.0.1', '192.168.1.1', '10.0.0.1', 'router.local', 'localhost', 'evil.example', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) r.push(await through(local, target, 80));
  t.ok(r.every((x) => !/200 OK/.test(x)) && dialed.length === before, 'a private address, a local name, or a name that leads to one: refused, never dialed');
  t.ok(localName('printer') && localName('nas.lan') && localName('x.home.arpa') && !localName('example.com'), 'local names told from sites');

  // A new link: the old one stops working.
  const oldLink = local;
  await share.newLink();
  const fresh = share.status().links.find((l) => l.where === 'network').link.replace('192.168.1.5', '127.0.0.1');
  const oldTry = await through(oldLink, 'a.example', 443);
  const newTry = await through(fresh, 'a.example', 443);
  t.ok(fresh !== oldLink && !/200 OK/.test(oldTry) && /^HTTP\/1\.1 200 OK/.test(newTry), 'a new link: the old one stops working at once, the new one works');

  // Off.
  await share.stop();
  let closed = false;
  try { await new Promise((res, rej) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(); }); s.once('error', rej); }); } catch { closed = true; }
  t.ok(closed && share.status().on === false && upnpCalls.includes(`unmap ${port}`) && logs.includes('Sharing this connection: off'), 'off: the port closed, the router\'s way in taken away');

  // A port another program took: another one, kept.
  const taken = net.createServer().listen(port, '127.0.0.1');
  await listening(taken);
  await share.start();
  t.ok(share.on && mem.share.port !== port && share.status().port === mem.share.port, `its port taken: another one, kept (${port} → ${mem.share.port})`);
  await share.stop();
  taken.close();

  // UPnP against a stand-in router.
  const asked = [];
  let external = '5.6.7.8';
  let onlyForever = false;
  const igd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.end('<?xml version="1.0"?><root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3</controlURL></service>'
          + '<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>');
        return;
      }
      const action = (/#(\w+)"/.exec(req.headers.soapaction || '') || [])[1];
      asked.push({ action, path: req.url, body });
      if (action === 'AddPortMapping' && onlyForever && !/<NewLeaseDuration>0</.test(body)) {
        res.statusCode = 500;
        res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>725</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
        return;
      }
      res.end(action === 'GetExternalIPAddress' ? `<s:Envelope><s:Body><u:R><NewExternalIPAddress>${external}</NewExternalIPAddress></u:R></s:Body></s:Envelope>` : '<s:Envelope/>');
    });
  }).listen(0, '127.0.0.1');
  await listening(igd);
  const location = `http://127.0.0.1:${igd.address().port}/desc.xml`;
  const m = await UPnP.map({ port: 34567, location });
  const add = asked.find((a) => a.action === 'AddPortMapping');
  t.ok(m.ok && m.reachable && m.external === '5.6.7.8' && add && add.path === '/ctl/IPConn' && /<NewInternalClient>127\.0\.0\.1</.test(add.body)
    && /<NewExternalPort>34567</.test(add.body) && /<NewProtocol>TCP</.test(add.body), 'UPnP: port 34567 forwarded to this computer, and the router\'s internet address');
  await UPnP.unmap(m);
  t.ok(asked.some((a) => a.action === 'DeletePortMapping' && /<NewExternalPort>34567</.test(a.body)), 'UPnP: the mapping taken away');
  external = '100.72.10.4';
  const cg = await UPnP.map({ port: 34568, location });
  t.ok(cg.ok && cg.reachable === false, 'UPnP: a provider\'s shared address (100.64.0.0/10) is not taken for one on the internet');
  external = '5.6.7.8';
  onlyForever = true;
  asked.length = 0;
  const forever = await UPnP.map({ port: 34569, location });
  t.ok(forever.ok && asked.filter((a) => a.action === 'AddPortMapping').length === 2, 'UPnP: a router that takes only mappings without an end (725): asked again so');
  const none = await UPnP.map({ port: 1, location: 'http://127.0.0.1:1/x.xml' });
  t.ok(!none.ok && typeof none.why === 'string', `UPnP: no router: said why (${none.why})`);
  t.ok(UPnP.privateAddress('192.168.0.1') && UPnP.privateAddress('100.64.0.1') && UPnP.privateAddress('fd00::1') && UPnP.privateAddress('0:0:0:0:0:0:0:1')
    && UPnP.privateAddress('::ffff:10.0.0.1') && !UPnP.privateAddress('5.6.7.8') && !UPnP.privateAddress('2001:4860::8888'),
    'private addresses told from the internet\'s');
  igd.close();
  web.close();
  console.log(`share: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
