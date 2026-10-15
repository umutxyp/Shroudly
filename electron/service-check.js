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
 *   'region'  HTTP 451, or a 403 page that says in so many words that the
 *             service is not offered where the visitor is (Cloudflare's
 *             error 1009 among them);
 *   'stall'   the TLS handshake completes and the request is sent, then no
 *             answer comes at all (how Roblox treats Vietnam today);
 *   null      anything else (the site answered, or the network is the issue).
 * A bare 403 or "Access denied" is not a refusal: storage and CDN hosts
 * (S3, Google Cloud Storage, Akamai) answer every request for / that way.
 */

const tls = require('tls');
const https = require('https');

const REFUSAL = new RegExp([
  "(?:\\bnot|n['’]t)(?: currently| yet)? (?:available|offered|supported) (?:in|for|from) your (?:country|region|location|area)",
  '\\bunavailable in your (?:country|region|location|area)',
  'has banned the country or region',
  '\\berror(?: code)?:? ?1009\\b',
].join('|'), 'i');

/* The text of a page, for REFUSAL: tags and runs of spaces taken out, so
 * "Error <span>1009</span>" reads as it is shown. */
function refuses(body) {
  return REFUSAL.test(String(body || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' '));
}

/* What a current browser on this OS sends. An unknown client gets pages of
 * its own on some sites, and the request should not name Shroudly to the
 * site or to anyone watching. The version is Electron's own Chromium, so it
 * stays current with every Electron update. */
function browserUserAgent(platform = process.platform, chrome = process.versions.chrome) {
  const major = /^\d+/.exec(String(chrome || ''));
  const system = platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major ? major[0] : '146'}.0.0.0 Safari/537.36`;
}

/* timeoutMs: how long the site has to answer once the handshake is done.
 * connectMs: how long reaching the site may take before that; the engine may
 * try several techniques first, some seconds each on a network that drops
 * silently, and that time is the network's, never the site's silence. */
function serviceCheck(host, socksPort, connect, { timeoutMs = 10000, connectMs = 30000, ca, userAgent = browserUserAgent() } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    let raw = null;
    let sock = null;
    let timer = null;
    // Every socket goes when the answer is in, whatever the answer was.
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const x of [req, sock, raw]) { try { if (x) x.destroy(); } catch {} }
      resolve(v);
    };
    timer = setTimeout(() => finish(null), connectMs);
    connect(socksPort, host, 443).then((r) => {
      raw = r;
      if (done) { raw.destroy(); return; }
      sock = tls.connect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'], ...(ca ? { ca } : {}) });
      sock.once('secureConnect', () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish('stall'), timeoutMs);
      });
      sock.on('error', () => finish(null));
      req = https.request({
        host, path: '/', method: 'GET', createConnection: () => sock,
        port: 443,
        headers: { host, 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-encoding': 'identity' },
      }, (res) => {
        if (res.statusCode === 451) { res.resume(); finish('region'); return; }
        if (res.statusCode !== 403) { res.resume(); finish(null); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 65536) body += d; if (body.length >= 65536) finish(refuses(body) ? 'region' : null); });
        res.on('end', () => finish(refuses(body) ? 'region' : null));
        res.on('error', () => finish(refuses(body) ? 'region' : null));
      });
      req.on('error', () => finish(null));
      req.end();
    }, () => finish(null));
  });
}

/* A site's own page, the kind a person opens: example.com, www.example.com,
 * example.co.uk. Not the hosts a page or an app loads its parts from (CDN,
 * API and storage hosts), whose answer to / says nothing about whether the
 * service lets this user in. */
function isMainName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(h) || /^[\d.]+$/.test(h)) return false;
  const labels = h.split('.');
  if (labels[0] === 'www') labels.shift();
  if (labels.some((l) => !l)) return false;
  if (labels.length === 2) return true;
  // A country domain with a common second level: example.co.uk, example.com.tr.
  return labels.length === 3 && /^[a-z]{2}$/.test(labels[2]) && /^(co|com|net|org|gov|edu|ac|or|ne|go)$/.test(labels[1]);
}

/* engine-manager.js believes a host is being cut only after several cuts in
 * a few minutes (its CUT_WINDOW_MS and CUT_NEED: two stalls or resets, or
 * four requests left unanswered, a long-poll looking the same as one); one
 * cut means little. The same count here, so the site is only asked once the
 * engine would report it too. Returns a function told of every cut that is
 * true once per host, at the cut that reaches the count. */
const CUT_WINDOW_MS = 3 * 60 * 1000;
const CUT_NEED = { strong: 2, weak: 4 };
function cutCounter() {
  const cuts = new Map();      // host -> [{ weak, t }]
  const reached = new Set();
  return (host, reason, now = Date.now()) => {
    if (!host || reached.has(host)) return false;
    const list = (cuts.get(host) || []).filter((c) => now - c.t < CUT_WINDOW_MS);
    list.push({ weak: reason === 'noreply', t: now });
    cuts.set(host, list);
    if (cuts.size > 400) cuts.clear();
    const weak = list.filter((c) => c.weak).length;
    if (list.length - weak < CUT_NEED.strong && weak < CUT_NEED.weak) return false;
    reached.add(host);
    cuts.delete(host);
    return true;
  };
}

module.exports = { serviceCheck, REFUSAL, refuses, browserUserAgent, isMainName, cutCounter };
