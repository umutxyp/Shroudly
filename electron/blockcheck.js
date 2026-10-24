'use strict';

/*
 * Is a service blocked on this network for a program that goes to it
 * directly? The autopilot (autopilot.js) asks this about the services of the
 * apps that are installed, so that the mode which carries them is on before
 * they are opened, not after the user has given up on them.
 *
 * A network stops such a program in one of two ways:
 *  - its DNS answers with a block page, a sinkhole (0.0.0.0, 127.x, a private
 *    address) or with nothing at all;
 *  - the name resolves, but the connection is reset or goes silent once the
 *    name has been seen (the TLS handshake never completes).
 * Either one counts only if the same name works through the engine: a
 * service that is down, or a computer that is offline, is not "blocked".
 */

const net = require('net');
const tls = require('tls');
const diagnostics = require('./diagnostics');

const HANDSHAKE_MS = 7000;
// What this computer says when it has no network itself (the Wi-Fi coming
// back after a wake, a cable out): nothing about the service.
const LOCAL_ERRORS = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'ENOTCONN', 'EACCES', 'EPERM']);

/* A TLS handshake with `servername`, over `socket` (through the engine) or
 * straight to `ip`. Resolves 'ok', or what stopped it. */
function handshake({ socket, ip, servername, ms = HANDSHAKE_MS }) {
  return new Promise((resolve) => {
    let done = false;
    const s = tls.connect({ ...(socket ? { socket } : { host: ip, port: 443 }), servername, ALPNProtocols: ['http/1.1'] });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { s.destroy(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish('timeout'), ms);
    s.once('secureConnect', () => finish('ok'));
    s.once('error', (e) => finish(e && e.code === 'ECONNRESET' ? 'reset' : (e && e.code) || 'error'));
    s.once('close', () => finish('closed'));
  });
}

/* Two direct handshakes, the second started retryMs after the first unless
 * the first already got through: 'ok' if either does, else what stopped the
 * last one. One connection lost on a weak network is not a filter; and a
 * filter that drops silently is known within one timeout, not two. */
function twoTries(hs, ip, servername, retryMs) {
  return new Promise((resolve) => {
    let left = 2;
    let done = false;
    let timer = null;
    const end = (r) => {
      if (done) return;
      if (r === 'ok') { done = true; clearTimeout(timer); resolve('ok'); return; }
      if (--left === 0) { done = true; resolve(r); }
    };
    const one = () => Promise.resolve().then(() => hs({ ip, servername })).then(end, (e) => end((e && e.message) || 'error'));
    one();
    timer = setTimeout(() => { if (!done) one(); }, retryMs);
  });
}

/*
 * host: the name the service's app connects to first.
 * opts.socksPort, opts.connect(socksPort, host, port): the engine.
 * opts.resolve(host): the system's DNS answer (IPv4 list, or null).
 * opts.handshake: stands in for the TLS handshake (tests).
 * Resolves { blocked, how: 'dns' | 'tls' | null, detail, unknown }: unknown
 * when nothing could be learnt (offline, the engine not running, the service
 * down): neither blocked nor working. The handshake through Shroudly is made
 * alongside the direct ones (it is only looked at when they fail), so a
 * blocked service is known as soon as the direct tries give up.
 */
async function check(host, opts = {}) {
  const resolve = opts.resolve || diagnostics.systemResolve;
  const hs = opts.handshake || handshake;
  const engine = !!(opts.socksPort && opts.connect);
  let through = null;
  const viaEngine = () => {
    if (!through) {
      through = Promise.resolve()
        .then(() => opts.connect(opts.socksPort, host, 443))
        .then((socket) => hs({ socket, servername: host }), (e) => (e && e.message) || 'error')
        .catch((e) => (e && e.message) || 'error');
    }
    return through;
  };
  const direct = async () => {
    const addrs = await resolve(host).catch(() => null);
    if (!addrs || !addrs.length) return { how: 'dns', detail: 'no answer' };
    if (addrs.some(diagnostics.looksForged)) return { how: 'dns', detail: addrs.filter(diagnostics.looksForged).join(', ') };
    if (engine) viaEngine();
    const r = await twoTries(hs, addrs[0], host, opts.retryMs == null ? 1000 : opts.retryMs);
    return r === 'ok' ? { how: null } : { how: 'tls', detail: r };
  };
  const first = await direct();
  if (!first.how) return { blocked: false, how: null, detail: 'direct ok' };
  const { how, detail } = first;
  if (LOCAL_ERRORS.has(detail)) return { blocked: false, unknown: true, how: null, detail: `${how}: ${detail}; this computer is not on a network yet` };
  if (!engine) return { blocked: false, unknown: true, how: null, detail: `${how}: ${detail}; engine not running` };
  const t = await viaEngine();
  if (t !== 'ok') return { blocked: false, unknown: true, how: null, detail: `${how}: ${detail}; through Shroudly too (${t})` };
  // Through Shroudly it worked. Once more directly, now: a network that was
  // only coming back (the computer just woke up, the Wi-Fi just joined)
  // answers this time, and a filter does not. Not after a silent drop: that
  // look would take a whole timeout again, and a network coming back is
  // what the autopilot's quiet time after a wake is for.
  if (how === 'tls' && detail === 'timeout') return { blocked: true, how, detail };
  const again = await direct();
  if (!again.how) return { blocked: false, how: null, detail: 'direct ok on a second look' };
  if (LOCAL_ERRORS.has(again.detail)) return { blocked: false, unknown: true, how: null, detail: `${again.how}: ${again.detail}; this computer is not on a network yet` };
  return { blocked: true, how, detail };
}

/* Addresses anyone may connect to, to tell a network that is up from one
 * that is not (each operator's DNS over HTTPS, port 443). */
const CONTROL = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

/* A TCP connection to ip:port within ms: true, or false. */
function tcpConnect(ip, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const finish = (ok) => { clearTimeout(timer); s.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), ms);
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/* Do a site's addresses take a connection at all? Its servers blocked by
 * address (no technique gets past that) look like this: none of them
 * answers, while the internet does. Resolves true (one answered), false
 * (none did, and a control address did), or null (no control answered
 * either: this computer is offline, nothing learnt). opts.connect stands in
 * for the connection (tests). */
async function addressesAnswer(addrs, { port = 443, ms = 5000, control = CONTROL, connect = tcpConnect } = {}) {
  const list = (addrs || []).slice(0, 8);
  if (!list.length) return null;
  const any = (ips, p) => Promise.all(ips.map((ip) => Promise.resolve(connect(ip, p, ms)).catch(() => false))).then((r) => r.some(Boolean));
  const [own, ctl] = await Promise.all([any(list, port), any(control, 443)]);
  if (own) return true;
  return ctl ? false : null;
}

module.exports = { check, handshake, addressesAnswer, LOCAL_ERRORS, CONTROL };
