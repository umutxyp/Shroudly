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

const tls = require('tls');
const diagnostics = require('./diagnostics');

const HANDSHAKE_MS = 7000;

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

/*
 * host: the name the service's app connects to first.
 * opts.socksPort, opts.connect(socksPort, host, port): the engine.
 * opts.resolve(host): the system's DNS answer (IPv4 list, or null).
 * opts.handshake: stands in for the TLS handshake (tests).
 * Resolves { blocked, how: 'dns' | 'tls' | null, detail, unknown }: unknown
 * when nothing could be learnt (offline, the engine not running, the service
 * down): neither blocked nor working.
 */
async function check(host, opts = {}) {
  const resolve = opts.resolve || diagnostics.systemResolve;
  const hs = opts.handshake || handshake;
  let how = null;
  let detail = '';
  const addrs = await resolve(host).catch(() => null);
  if (!addrs || !addrs.length) { how = 'dns'; detail = 'no answer'; }
  else if (addrs.some(diagnostics.looksForged)) { how = 'dns'; detail = addrs.filter(diagnostics.looksForged).join(', '); }
  else {
    // Tried twice, a second apart: one connection lost on a weak network
    // is not a filter.
    let r = await hs({ ip: addrs[0], servername: host });
    if (r !== 'ok') { await new Promise((ok) => setTimeout(ok, opts.retryMs == null ? 1000 : opts.retryMs)); r = await hs({ ip: addrs[0], servername: host }); }
    if (r !== 'ok') { how = 'tls'; detail = r; }
  }
  if (!how) return { blocked: false, how: null, detail: 'direct ok' };
  if (!opts.socksPort || !opts.connect) return { blocked: false, unknown: true, how: null, detail: `${how}: ${detail}; engine not running` };
  let through = 'error';
  try { through = await hs({ socket: await opts.connect(opts.socksPort, host, 443), servername: host }); } catch (e) { through = e.message; }
  return through === 'ok'
    ? { blocked: true, how, detail }
    : { blocked: false, unknown: true, how: null, detail: `${how}: ${detail}; through Shroudly too (${through})` };
}

module.exports = { check, handshake };
