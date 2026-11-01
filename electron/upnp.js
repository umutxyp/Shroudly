'use strict';

/*
 * A way in through the home router, for "Share my connection" (share.js):
 * UPnP IGD, which most home routers speak. Found by SSDP on the local
 * network, asked to forward one TCP port to this computer for a while
 * (renewed while sharing, taken away when it stops), and asked for its
 * address on the internet.
 *
 * Often there is no way in at all: a router with UPnP off, or a connection
 * the provider shares among many customers (CGNAT: the router's own address
 * is then a private one, 100.64.0.0/10 or 10/8...). Then only people on the
 * same network can use the share, and the window says so.
 */

const dgram = require('dgram');
const http = require('http');
const net = require('net');

const SSDP = { host: '239.255.255.250', port: 1900 };
const SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

/* Addresses nobody on the internet can reach (this computer, local
 * networks, a provider's shared range, multicast), in any way they are
 * written ("::1" and "0:0:0:0:0:0:0:1" alike). */
const PRIVATE4 = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVATE4.addSubnet(a, n, 'ipv4');
// Kept apart from the IPv4 list: a BlockList matches IPv4 addresses
// against IPv4-mapped IPv6 rules too.
const PRIVATE6 = new net.BlockList();
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE6.addSubnet(a, n, 'ipv6');

/* The IPv4 address inside an IPv4-mapped IPv6 one (::ffff:a.b.c.d), or null. */
function mappedV4(ip) {
  let h;
  try { h = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return null; }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!m) return null;
  const a = parseInt(m[1], 16);
  const b = parseInt(m[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) return PRIVATE4.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    const v4 = mappedV4(ip);
    return v4 ? PRIVATE4.check(v4, 'ipv4') : PRIVATE6.check(ip, 'ipv6');
  }
  return true;
}

/* The routers that answer an SSDP search: their description URLs. */
function discover({ timeout = 2500 } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { resolve([]); return; }
    const done = () => { try { sock.close(); } catch {} resolve([...found]); };
    sock.on('error', done);
    sock.on('message', (msg) => {
      const m = /^location:\s*(\S+)/im.exec(msg.toString('latin1'));
      if (m && /^http:\/\//i.test(m[1])) found.add(m[1]);
    });
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2']) {
        const q = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(q, SSDP.port, SSDP.host, () => {});
      }
    });
    setTimeout(done, timeout);
  });
}

function request(url, { method = 'GET', headers = {}, body = null, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 256 * 1024) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: data, local: req.socket && req.socket.localAddress }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* The router's port-forwarding service from its description: { control,
 * service, local } (local: this computer's address toward the router). */
async function service(location) {
  const r = await request(location);
  if (r.status !== 200) return null;
  for (const type of SERVICES) {
    const at = r.body.indexOf(`<serviceType>${type}</serviceType>`);
    if (at < 0) continue;
    const end = r.body.indexOf('</service>', at);
    const m = /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/.exec(r.body.slice(at, end < 0 ? undefined : end));
    if (!m) continue;
    const base = (/<URLBase>\s*([^<\s]+)\s*<\/URLBase>/.exec(r.body) || [])[1] || location;
    return { control: new URL(m[1], base).toString(), service: type, local: (r.local || '').replace(/^::ffff:/, '') };
  }
  return null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function soap(svc, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const body = '<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${svc.service}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await request(svc.control, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.service}#${action}"`, 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200) {
    const code = (/<errorCode>\s*(\d+)\s*<\/errorCode>/.exec(r.body) || [])[1];
    const e = new Error(`the router refused ${action}${code ? ` (UPnP error ${code})` : ` (HTTP ${r.status})`}`);
    e.upnpCode = code ? Number(code) : null;
    throw e;
  }
  return r.body;
}

/*
 * A TCP port forwarded to this computer: { ok: true, svc, port, local,
 * external } (external: the router's internet address, null if it would not
 * say; reachable: false when that address is a private one, as behind a
 * provider's shared connection), or { ok: false, why }. `location` skips
 * the search (the tests' stand-in router).
 */
async function map({ port, lease = 3600, description = 'Shroudly: share my connection', location = null } = {}) {
  const locations = location ? [location] : await discover();
  if (!locations.length) return { ok: false, why: 'no router answered (UPnP off, or none on this network)' };
  let last = 'the router has no port-forwarding service';
  for (const loc of locations) {
    let svc;
    try { svc = await service(loc); } catch (e) { last = e.message; continue; }
    if (!svc || !svc.local) continue;
    const add = (l) => soap(svc, 'AddPortMapping', {
      NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port,
      NewInternalClient: svc.local, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: l,
    });
    try {
      // Some routers take only mappings without an end (error 725).
      try { await add(lease); } catch (e) { if (e.upnpCode === 725) await add(0); else throw e; }
    } catch (e) { last = e.message; continue; }
    let external = null;
    try {
      const b = await soap(svc, 'GetExternalIPAddress');
      external = (/<NewExternalIPAddress>\s*([^<\s]+)\s*<\/NewExternalIPAddress>/.exec(b) || [])[1] || null;
    } catch {}
    return { ok: true, svc, port, local: svc.local, external, reachable: !!external && !privateAddress(external) };
  }
  return { ok: false, why: last };
}

async function unmap(m) {
  if (!m || !m.ok) return;
  try { await soap(m.svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.port, NewProtocol: 'TCP' }); } catch {}
}

module.exports = { map, unmap, discover, privateAddress };
