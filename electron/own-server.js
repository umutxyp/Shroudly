'use strict';

/*
 * "Use my own server": a server the user names, which carries every
 * connection to a name (the engine's --upstream-file). In a shutdown, a
 * server inside the country whose own connection to the world still works
 * (a data centre's, or a friend's sharing theirs, share.js) is then the way
 * out; at other times, a server of one's own abroad.
 *
 * Given as one link, as such servers are passed around:
 *   socks5://[user[:password]@]host:port
 *   http://[user[:password]@]host:port        (CONNECT)
 *   ss://BASE64URL(method:password)@host:port[#name]   (SIP002)
 *   ss://BASE64(method:password@host:port)[#name]      (the older form)
 *   host:port                                  (SOCKS5)
 * Shadowsocks goes through a client of Shroudly's own on this computer
 * (shadowsocks.js), which the engine is pointed at.
 */

const net = require('net');
const tls = require('tls');
const SS = require('./shadowsocks');

const { METHODS } = SS;

const fromB64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function hostPort(text) {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text) || /^([^\s:/@[\]]+):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1], port };
}

/* { ok: true, kind, host, port, user, pass, method, password, name } or
 * { ok: false, error } with error one of: empty, format, method, user. */
function parseLink(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, error: 'empty' };
  let m = /^(socks5h?|socks|http):\/\/(?:([^@/]*)@)?([^/?#]+)\/?$/i.exec(text);
  if (m) {
    const hp = hostPort(m[3]);
    if (!hp) return { ok: false, error: 'format' };
    let user = '';
    let pass = '';
    if (m[2] !== undefined) {
      const i = m[2].indexOf(':');
      try {
        user = decodeURIComponent(i < 0 ? m[2] : m[2].slice(0, i));
        pass = i < 0 ? '' : decodeURIComponent(m[2].slice(i + 1));
      } catch { return { ok: false, error: 'format' }; }
      if (!user || /[:@\r\n]/.test(user) || user.length > 255 || pass.length > 255 || /[\r\n]/.test(pass)) return { ok: false, error: 'user' };
    }
    return { ok: true, kind: /^http$/i.test(m[1]) ? 'http' : 'socks5', ...hp, user, pass };
  }
  m = /^ss:\/\/([^#]+)(?:#(.*))?$/i.exec(text);
  if (m) {
    let name = '';
    try { name = m[2] ? decodeURIComponent(m[2]) : ''; } catch {}
    // Plugin options and the like ("/?plugin=…") are not used. Cut at the
    // first "?" without a pattern that backtracks on a run of them.
    let body = m[1].includes('?') ? m[1].slice(0, m[1].indexOf('?')) : m[1];
    while (body.endsWith('/')) body = body.slice(0, -1);
    let method;
    let password;
    let hp;
    const at = body.lastIndexOf('@');
    if (at > 0) {
      // SIP002: userinfo is BASE64URL(method:password), or plain for 2022 methods.
      let info = body.slice(0, at);
      try { info = decodeURIComponent(info); } catch {}
      const plain = info.includes(':') ? info : fromB64(info);
      const i = plain.indexOf(':');
      if (i < 1) return { ok: false, error: 'format' };
      method = plain.slice(0, i).toLowerCase();
      password = plain.slice(i + 1);
      hp = hostPort(body.slice(at + 1));
    } else {
      // The older form: all of it in base64.
      const plain = fromB64(body);
      const mm = /^([^:]+):(.*)@([^@]+)$/.exec(plain);
      if (!mm) return { ok: false, error: 'format' };
      method = mm[1].toLowerCase();
      password = mm[2];
      hp = hostPort(mm[3]);
    }
    if (!hp || !password) return { ok: false, error: 'format' };
    if (!METHODS[method]) return { ok: false, error: 'method', method };
    return { ok: true, kind: 'ss', ...hp, method, password, name };
  }
  const hp = hostPort(text);
  if (hp) return { ok: true, kind: 'socks5', ...hp, user: '', pass: '' };
  return { ok: false, error: 'format' };
}

/* What the log and the window show: never the password. */
function describe(p) {
  if (!p || !p.ok) return '';
  const where = p.host.includes(':') ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`;
  return p.kind === 'ss' ? `Shadowsocks ${where}` : `${p.kind === 'http' ? 'HTTP' : 'SOCKS5'} ${where}`;
}

/* The engine's --upstream-file line for a SOCKS5 or HTTP server (or, for
 * Shadowsocks, the local client on `localPort`, with its { user, pass }). */
function engineLine(p, localPort, auth = null) {
  if (p.kind === 'ss') return `socks5://${auth ? `${auth.user}:${auth.pass}@` : ''}127.0.0.1:${localPort}`;
  const where = p.host.includes(':') ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`;
  const who = p.user ? `${p.user}${p.pass ? `:${p.pass}` : ''}@` : '';
  return `${p.kind}://${who}${where}`;
}

/* A Shadowsocks link (SIP002), as share.js gives one out. */
function ssLink({ method, password, host, port, name = 'Shroudly' }) {
  const info = Buffer.from(`${method}:${password}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const where = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return `ss://${info}@${where}#${encodeURIComponent(name)}`;
}

/* Why a server could not be used, as the engine says it (engine.c,
 * upstream_report) and as the test below finds it: a code the window
 * translates. */
const WHY = {
  'does not answer': 'noAnswer',
  'refused the user name or password': 'auth',
  'asks for a user name and password': 'asks',
  'refused the connection': 'refused',
  'does not speak the protocol chosen': 'protocol',
};
const whyCode = (text) => WHY[text] || 'protocol';
const WHY_TEXT = Object.fromEntries(Object.entries(WHY).map(([k, v]) => [v, k]));
WHY_TEXT.silent = 'nothing came back (the password or the method may be wrong)';
WHY_TEXT.tls = 'it answers, but no site\'s certificate came through it';

class Why extends Error {
  constructor(code) { super(WHY_TEXT[code] || code); this.why = code; }
}

/* Reads from `s` until `done(buf)` returns a result (not undefined). */
function readUntil(s, done) {
  return new Promise((resolve, reject) => {
    let b = Buffer.alloc(0);
    const off = () => { s.removeListener('data', on); s.removeListener('close', closed); s.removeListener('error', closed); };
    const closed = () => { off(); reject(new Why('protocol')); };
    const on = (d) => {
      b = Buffer.concat([b, d]);
      let r;
      try { r = done(b); } catch (e) { off(); reject(e); return; }
      if (r !== undefined) { off(); resolve(r); }
    };
    s.on('data', on);
    s.once('close', closed);
    s.once('error', closed);
  });
}

function tcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Why('noAnswer')); }, timeout);
    s.once('error', () => { clearTimeout(t); reject(new Why('noAnswer')); });
    s.once('connect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve(s); });
  });
}

/* A SOCKS5 connection on `s` to host:port, the name sent as a name. */
async function socks5(s, p, host, port) {
  s.write(Buffer.from(p.user ? [5, 2, 0, 2] : [5, 1, 0]));
  const m = await readUntil(s, (b) => (b.length >= 2 ? b[1] : undefined));
  if (m === 2) {
    if (!p.user) throw new Why('asks');
    const u = Buffer.from(p.user);
    const pw = Buffer.from(p.pass || '');
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const ok = await readUntil(s, (b) => (b.length >= 2 ? b[1] === 0 : undefined));
    if (!ok) throw new Why('auth');
  } else if (m !== 0) {
    throw new Why(m === 0xff && !p.user ? 'asks' : 'protocol');
  }
  const h = Buffer.from(host);
  const req = Buffer.alloc(7 + h.length);
  req.set([5, 1, 0, 3, h.length]);
  h.copy(req, 5);
  req.writeUInt16BE(port, 5 + h.length);
  s.write(req);
  const rep = await readUntil(s, (b) => {
    if (b.length < 5) return undefined;
    if (b[0] !== 5) throw new Why('protocol');
    const need = b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? 7 + b[4] : -1;
    if (need < 0) throw new Why('protocol');
    return b.length >= need ? b[1] : undefined;
  });
  if (rep !== 0) throw new Why('refused');
}

/* An HTTP CONNECT on `s` to host:port. */
async function connectHttp(s, p, host, port) {
  const auth = p.user ? `Proxy-Authorization: Basic ${Buffer.from(`${p.user}:${p.pass || ''}`).toString('base64')}\r\n` : '';
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const code = await readUntil(s, (b) => {
    const end = b.indexOf('\r\n\r\n');
    if (end < 0) { if (b.length > 8192) throw new Why('protocol'); return undefined; }
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(b.subarray(0, end).toString('latin1'));
    if (!m) throw new Why('protocol');
    return Number(m[1]);
  });
  if (code === 407) throw new Why(p.user ? 'auth' : 'asks');
  if (code !== 200) throw new Why('refused');
}

/* Does the server carry a connection to a site? Opens one through it to
 * `host` and checks the site's certificate (a server that only answers,
 * or a network that hands back something else, is not taken for one):
 * { ok: true, ms } or { ok: false, why } (WHY codes, plus 'silent' and
 * 'tls'). */
async function test(p, { host = 'cloudflare.com', port = 443, ca, timeout = 12000 } = {}) {
  const t0 = Date.now();
  let s = null;
  let client = null;
  let clientError = null;
  const deadline = new Promise((_, reject) => { setTimeout(() => reject(new Why(s ? 'silent' : 'noAnswer')), timeout).unref(); });
  try {
    await Promise.race([deadline, (async () => {
      if (p.kind === 'ss') {
        client = await SS.startClient({ server: p.host, port: p.port, method: p.method, password: p.password, onError: (e) => { clientError = e; } });
        s = await tcp('127.0.0.1', client.port, timeout);
        try { await socks5(s, { user: '' }, host, port); } catch { throw new Why(clientError && /authenticate/.test(clientError.message) ? 'silent' : 'noAnswer'); }
      } else {
        s = await tcp(p.host, p.port, timeout);
        if (p.kind === 'http') await connectHttp(s, p, host, port);
        else await socks5(s, p, host, port);
      }
      await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: s, servername: host, ALPNProtocols: ['http/1.1'], ...(ca ? { ca } : {}) });
        t.once('secureConnect', () => { t.destroy(); resolve(); });
        t.once('error', () => reject(new Why(p.kind === 'ss' ? (clientError ? 'noAnswer' : 'silent') : 'tls')));
      });
    })()]);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, why: e instanceof Why ? e.why : 'noAnswer' };
  } finally {
    if (s) s.destroy();
    if (client) client.close();
  }
}

module.exports = { parseLink, describe, engineLine, ssLink, test, whyCode, WHY_TEXT };
