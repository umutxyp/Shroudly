'use strict';

/*
 * shroudly.codeshare.me: the live user counter and the always-latest download
 * links. Plain Node, no dependencies. It runs on the Codeshare server behind
 * nginx and the Cloudflare tunnel; it replaced a Cloudflare Worker + Durable
 * Object whose free tier (100,000 requests a day) the counter outgrew.
 *
 * Anonymous by design: each running app picks a random id when it starts (not
 * stored on the device) and pings every `interval` seconds. An id that stops
 * pinging expires; quitting removes it at once. Only the ids and their
 * last-seen times are kept: no IPs, headers or anything else about the user is
 * read, stored or logged (nginx keeps no access log for this host, and behind
 * the tunnel it never sees the user's address anyway).
 *
 *   POST /v1/ping   {"id": "<random>"}  -> {"online": n, "interval": s}
 *   POST /v1/leave  {"id": "<random>"}  -> {"online": n, "interval": s}
 *   GET  /v1/online                     -> {"online": n, "interval": s}
 *   GET  /dl                            -> 302 to the latest release page
 *   GET  /dl/<key>                      -> 302 to that installer in the latest release
 *                                          (HEAD too: download managers and link checkers ask first)
 *
 *   node server.js [--port 8787] [--state /var/lib/shroudly-stats/seen.json]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.PORT || 8787));
const STATE = arg('--state', process.env.STATE_FILE || '');

// ── presence ─────────────────────────────────────────────────────────────────
const ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const MAX_IDS = 500000;        // memory bound against a flood of made-up ids
const seen = new Map();        // id -> last ping (ms)

// The interval the apps are asked to ping at, widening as the count grows.
function interval() {
  const n = seen.size;
  return n < 500 ? 60 : n < 3000 ? 180 : 300;
}

// Expire ids that missed more than two pings.
function prune(now = Date.now()) {
  const ttl = interval() * 2.5 * 1000;
  for (const [id, t] of seen) if (now - t > ttl) seen.delete(id);
}

// A restart (an update, a reboot) keeps the count: the ids are written out
// now and then and read back at start. Nothing but ids and times.
function load() {
  if (!STATE) return;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const [id, t] of Object.entries(saved)) if (ID_RE.test(id) && Number.isFinite(t)) seen.set(id, t);
    prune();
  } catch {}
}
function save() {
  if (!STATE) return;
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    const tmp = `${STATE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(seen)));
    fs.renameSync(tmp, STATE);
  } catch {}
}

// ── downloads ────────────────────────────────────────────────────────────────
/* No GitHub API (60 requests an hour per IP): the version comes from the
 * redirect github.com itself serves for /releases/latest, and the file name
 * from the fixed shape electron-builder gives every release. Each built URL is
 * checked once with a HEAD before it is handed out, so a release whose assets
 * are still uploading falls back to the release page rather than to a 404.
 * Answers are kept for five minutes; a failed lookup is not kept. */
const DL_FILES = {
  'windows-x64':     (v) => `Shroudly-${v}-Windows-x64-Setup.exe`,
  'windows-arm64':   (v) => `Shroudly-${v}-Windows-arm64-Setup.exe`,
  'macos-arm64':     (v) => `Shroudly-${v}-macOS-arm64.dmg`,
  'macos-x64':       (v) => `Shroudly-${v}-macOS-x64.dmg`,
  'macos-arm64-zip': (v) => `Shroudly-${v}-macOS-arm64.zip`,
  'macos-x64-zip':   (v) => `Shroudly-${v}-macOS-x64.zip`,
  'linux-x64':       (v) => `Shroudly-${v}-Linux-x86_64.AppImage`,
  'linux-arm64':     (v) => `Shroudly-${v}-Linux-arm64.AppImage`,
  'linux-deb':       (v) => `Shroudly-${v}-Linux-amd64.deb`,
  // electron-builder names these two differently from each other: x64 for the
  // Arch package, x86_64 for the RPM. Copied from what it actually produces.
  'linux-pacman':    (v) => `Shroudly-${v}-Linux-x64.pacman`,
  'linux-rpm':       (v) => `Shroudly-${v}-Linux-x86_64.rpm`,
};
const REPO = 'https://github.com/umutxyp/Shroudly';
const RELEASES_LATEST = `${REPO}/releases/latest`;
const CACHE_MS = 5 * 60 * 1000;
const TAG_RE = /\/releases\/tag\/(v?(\d+\.\d+\.\d+[^/?#]*))$/;
const cache = new Map();       // name -> { value, until }

async function cached(name, produce) {
  const hit = cache.get(name);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await produce();
  if (value) cache.set(name, { value, until: Date.now() + CACHE_MS });
  if (cache.size > 200) for (const [k, v] of cache) if (v.until <= Date.now()) cache.delete(k);
  return value;
}

async function head(url) {
  return fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'shroudly-dl' }, signal: AbortSignal.timeout(10000) });
}

async function latestTag() {
  const tag = await cached('latest-tag', async () => {
    const m = ((await head(RELEASES_LATEST)).headers.get('location') || '').match(TAG_RE);
    return m ? m[1] : null;
  });
  return tag ? { tag, version: tag.replace(/^v/, '') } : null;
}

async function assetExists(url) {
  // github.com answers an existing asset with a redirect to its storage.
  return (await cached(`asset:${url}`, async () => {
    const s = (await head(url)).status;
    return s === 302 || s === 200 ? '1' : null;
  })) === '1';
}

async function download(pathname) {
  const key = pathname.replace(/^\/dl\/?/, '');
  if (!key) return RELEASES_LATEST;
  const file = DL_FILES[key];
  if (!file) return null;
  try {
    const latest = await latestTag();
    if (latest) {
      const url = `${REPO}/releases/download/${latest.tag}/${file(latest.version)}`;
      if (await assetExists(url)) return url;
    }
  } catch { /* github.com unreachable: the release page is still the right answer */ }
  return RELEASES_LATEST;
}

// ── http ─────────────────────────────────────────────────────────────────────
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function readId(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1024) { req.destroy(); resolve(''); } });
    req.on('end', () => { try { resolve(String(JSON.parse(body).id || '')); } catch { resolve(''); } });
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const route = `${req.method} ${pathname}`;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/dl' || pathname.startsWith('/dl/'))) {
      const to = await download(pathname);
      if (!to) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('unknown download key'); return; }
      res.writeHead(302, { location: to, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (route === 'POST /v1/ping' || route === 'POST /v1/leave') {
      const id = await readId(req);
      if (!ID_RE.test(id)) { send(res, 400, { error: 'bad id' }); return; }
      if (route === 'POST /v1/leave') seen.delete(id);
      else if (seen.has(id) || seen.size < MAX_IDS) seen.set(id, Date.now());
      send(res, 200, { online: seen.size, interval: interval() });
      return;
    }
    if (route === 'GET /v1/online') { send(res, 200, { online: seen.size, interval: interval() }); return; }
    send(res, 404, { error: 'not found' });
  } catch {
    if (!res.headersSent) send(res, 500, { error: 'error' });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 30000;

load();
setInterval(prune, 30000).unref();
setInterval(save, 60000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); });
server.listen(PORT, '127.0.0.1', () => console.log(`shroudly-stats on 127.0.0.1:${PORT}`));
