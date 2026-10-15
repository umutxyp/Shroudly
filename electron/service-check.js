'use strict';

/*
 * After the site test has got past the network: does the site itself let
 * this user in? Some sites turn whole countries away on their own, because a
 * law there makes them (Roblox in Vietnam must send people to Roblox VN) or
 * by policy. That is decided from the user's address, which Shroudly never
 * changes, so no technique can help, and the test should say so instead of
 * looking like Shroudly failed.
 *
 * One HTTPS request through the engine, the way a browser would make it:
 *   'region'  HTTP 451, or a 403 page that says the visitor is blocked or
 *             not served where they are;
 *   'stall'   the TLS handshake completes and the request is sent, then no
 *             answer comes at all (how Roblox treats Vietnam today);
 *   null      anything else (the site answered, or the network is the issue).
 */

const tls = require('tls');
const https = require('https');

const REFUSAL = /sorry, you have been blocked|you are unable to access|access denied|not available in your (country|region|location)|unavailable in your (country|region)|is not available in your area|this content is not available in your country|451 unavailable for legal reasons|error 1009|has banned the country/i;

function serviceCheck(host, socksPort, connect, { timeoutMs = 10000, ca } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let secured = false;
    let req = null;
    let raw = null;
    let sock = null;
    // Every socket goes when the answer is in, whatever the answer was.
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const x of [req, sock, raw]) { try { if (x) x.destroy(); } catch {} }
      resolve(v);
    };
    const timer = setTimeout(() => finish(secured ? 'stall' : null), timeoutMs);
    connect(socksPort, host, 443).then((r) => {
      raw = r;
      if (done) { raw.destroy(); return; }
      sock = tls.connect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'], ...(ca ? { ca } : {}) });
      sock.once('secureConnect', () => { secured = true; });
      sock.on('error', () => finish(null));
      req = https.request({
        host, path: '/', method: 'GET', createConnection: () => sock,
        port: 443,
        headers: { host, 'user-agent': 'Mozilla/5.0 (Shroudly site test)', accept: 'text/html,*/*', 'accept-encoding': 'identity' },
      }, (res) => {
        if (res.statusCode === 451) { res.resume(); finish('region'); return; }
        if (res.statusCode !== 403) { res.resume(); finish(null); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 65536) body += d; if (body.length >= 65536) finish(REFUSAL.test(body) ? 'region' : null); });
        res.on('end', () => finish(REFUSAL.test(body) ? 'region' : null));
        res.on('error', () => finish(REFUSAL.test(body) ? 'region' : null));
      });
      req.on('error', () => finish(null));
      req.end();
    }, () => finish(null));
  });
}

module.exports = { serviceCheck, REFUSAL };
