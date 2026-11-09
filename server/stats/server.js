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
 *   GET  /dl/<key>?mirror               -> 302 to /dl/<its file name>: served from here
 *                                          (HEAD too: download managers and link checkers ask first)
 *   GET  /dl/<latest release file name> -> that file itself, served from here: the
 *                                          updater's mirror where github.com is blocked
 *   GET  /v1/bridges                    -> Tor bridges for the asker's country (see below)
 *
 *   node server.js [--port 8787] [--state /var/lib/shroudly-stats/seen.json]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable, Transform, pipeline } = require('stream');

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
  // 32-bit Windows 10/11; Windows 7, 8 and 8.1 (one installer for 32- and
  // 64-bit, Electron 22).
  'windows-ia32':    (v) => `Shroudly-${v}-Windows-ia32-Setup.exe`,
  'windows7':        (v) => `Shroudly-${v}-Windows7-8-Setup.exe`,
  'macos-arm64':     (v) => `Shroudly-${v}-macOS-arm64.dmg`,
  'macos-x64':       (v) => `Shroudly-${v}-macOS-x64.dmg`,
  'macos-arm64-zip': (v) => `Shroudly-${v}-macOS-arm64.zip`,
  'macos-x64-zip':   (v) => `Shroudly-${v}-macOS-x64.zip`,
  'linux-x64':       (v) => `Shroudly-${v}-Linux-x86_64.AppImage`,
  'linux-arm64':     (v) => `Shroudly-${v}-Linux-arm64.AppImage`,
  // 32-bit ARM (armhf): Raspberry Pi OS 32-bit and the like.
  'linux-armv7l':    (v) => `Shroudly-${v}-Linux-armv7l.AppImage`,
  'linux-armhf-deb': (v) => `Shroudly-${v}-Linux-armv7l.deb`,
  'linux-deb':       (v) => `Shroudly-${v}-Linux-amd64.deb`,
  // electron-builder names these two differently from each other: x64 for the
  // Arch package, x86_64 for the RPM. Copied from what it actually produces.
  'linux-pacman':    (v) => `Shroudly-${v}-Linux-x64.pacman`,
  'linux-rpm':       (v) => `Shroudly-${v}-Linux-x86_64.rpm`,
  // One APK for every Android phone (ARM 64/32-bit, x86_64).
  'android':         (v) => `Shroudly-${v}-Android.apk`,
  // 64-bit ARM phones only, and without Tor (issue #75).
  'android-arm64':   (v) => `Shroudly-${v}-Android-arm64.apk`,
  'android-lite':    (v) => `Shroudly-${v}-Android-lite.apk`,
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
  return fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'shroudly-dl' }, signal: AbortSignal.timeout(6000) });
}

/* The newest release's tag, from github.com's redirect, else GitHub's API;
 * while neither answers, the last one known (a release is not taken back),
 * so the links keep naming the right files. It is kept next to the state
 * file, for a restart while GitHub is down, and a failed ask is not repeated
 * for a minute, so a visitor does not wait on it each time. */
const TAG_FILE = STATE ? path.join(path.dirname(STATE), 'latest-tag.txt') : '';
let lastTag = null;
try { if (TAG_FILE) lastTag = (fs.readFileSync(TAG_FILE, 'utf8').trim().match(/^v?\d+\.\d+\.\d+[\w.-]*$/) || [null])[0]; } catch { /* none yet */ }
let tagFailedUntil = 0;
async function latestTag() {
  let tag = null;
  if (lastTag && Date.now() < tagFailedUntil) return { tag: lastTag, version: lastTag.replace(/^v/, '') };
  try {
    tag = await cached('latest-tag', async () => {
      try {
        const m = ((await head(RELEASES_LATEST)).headers.get('location') || '').match(TAG_RE);
        if (m) return m[1];
      } catch { /* the API next */ }
      const r = await fetch(`${API}/releases/latest`, {
        headers: { 'user-agent': 'shroudly-dl', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
      const t = r.ok ? (await r.json()).tag_name : null;
      return typeof t === 'string' && /^v?\d+\.\d+\.\d+/.test(t) ? t : null;
    });
  } catch { /* neither answered */ }
  if (tag && tag !== lastTag) {
    lastTag = tag;
    if (TAG_FILE) fs.writeFile(TAG_FILE, `${tag}\n`, () => {});
  }
  if (!tag) tagFailedUntil = Date.now() + 60000;
  tag = tag || lastTag;
  return tag ? { tag, version: tag.replace(/^v/, '') } : null;
}

/* What github.com says about an asset: 'ok' (a redirect to its storage),
 * 'down' (a 5xx: GitHub's download address failing for everyone, as on
 * 2026-11-08, while the file is there), or null. Only 'ok' is kept. */
async function assetState(url) {
  let state = null;
  try {
    return await cached(`asset:${url}`, async () => {
      const s = (await head(url)).status;
      if (s >= 500) state = 'down';
      return s === 302 || s === 200 ? 'ok' : null;
    }) || state;
  } catch { return 'down'; }   // no answer in time: the same
}

/* The same file by its asset id, through GitHub's API, which sends to the
 * same storage: the way round github.com's download address while that
 * fails. Only an asset of the given release, by a name already checked. */
const API = 'https://api.github.com/repos/umutxyp/Shroudly';
async function apiAssetUrl(tag, name) {
  const ids = await cached(`assets:${tag}`, async () => {
    const r = await fetch(`${API}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { 'user-agent': 'shroudly-dl', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    return Object.fromEntries((j.assets || []).map((a) => [a.name, a.id]));
  });
  const id = ids && ids[name];
  return Number.isInteger(id) ? `${API}/releases/assets/${id}` : null;
}

/* own: the file from here (the mirror below) instead of GitHub's address,
 * as codeshare.me's download buttons ask (?mirror): GitHub is blocked on
 * some of the networks Shroudly is for, and the visitor stays on our host. */
async function download(pathname, own = false) {
  const key = pathname.replace(/^\/dl\/?/, '');
  if (!key) return RELEASES_LATEST;
  const file = DL_FILES[key];
  if (!file) return null;
  try {
    const latest = await latestTag();
    if (latest) {
      const name = file(latest.version);
      if (own) return `/dl/${name}`;
      const url = `${REPO}/releases/download/${latest.tag}/${name}`;
      const state = await assetState(url);
      if (state === 'ok') return url;
      // github.com's downloads failing: the file from here, by the API.
      if (state === 'down') return `/dl/${name}`;
    }
  } catch { /* github.com unreachable: the release page is still the right answer */ }
  return RELEASES_LATEST;
}

/* The update mirror. Some networks block github.com's addresses outright, and
 * an app on the device cannot get past that; the desktop updater (2.6.31+) then
 * asks here for the same files by name, and they are passed through from GitHub
 * instead of redirected to it. Only the latest release's own files pass, the
 * feeds and the installers from one release, and the URL is built from this
 * list, never from what was asked. Cloudflare may keep the installers (a
 * versioned file never changes); the feeds are never kept. */
const FEEDS = ['latest.yml', 'legacy.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-linux-arm.yml', 'latest-mac.yml'];

async function mirrorUrl(pathname) {
  const name = pathname.replace(/^\/dl\//, '');
  if (!FEEDS.includes(name) && !/^Shroudly-[\d.]+-[\w.-]+$/.test(name)) return null;
  const latest = await latestTag();
  if (!latest) return null;
  const file = [...FEEDS, ...Object.values(DL_FILES).map((f) => f(latest.version))].find((n) => n === name);
  return file ? `${REPO}/releases/download/${latest.tag}/${file}` : null;
}

/* A file from which nothing more has come for this long is cut off: GitHub
 * stalling partway kept the updater on the other end "downloading" for good. */
const BODY_IDLE_MS = 30000;

async function mirror(req, res, url) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  const ctl = new AbortController();
  const slow = setTimeout(() => ctl.abort(), 15000);   // for the answer to start, not for the whole file
  res.on('close', () => ctl.abort());
  let up;
  try {
    // No answer at all from github.com counts as its 5xx.
    up = await fetch(url, { method: req.method, headers: { 'user-agent': 'shroudly-dl' }, signal: ctl.signal })
      .catch((e) => { if (ctl.signal.aborted) throw e; return new Response(null, { status: 502 }); });
    // github.com's download address failing (a 5xx for every file, every
    // repository, 2026-11-08): the same file by its asset id, through the API.
    if (up.status >= 500) {
      const tag = url.split('/releases/download/')[1]?.split('/')[0];
      const alt = tag && await apiAssetUrl(decodeURIComponent(tag), name);
      if (alt) {
        if (up.body) up.body.cancel().catch(() => {});
        up = await fetch(alt, { method: req.method, headers: { 'user-agent': 'shroudly-dl', accept: 'application/octet-stream' }, signal: ctl.signal });
      }
    }
  } finally {
    clearTimeout(slow);
  }
  if (!up.ok) {
    if (up.body) up.body.cancel().catch(() => {});
    res.writeHead(up.status === 404 ? 404 : 502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(up.status === 404 ? 'not found' : 'github.com did not answer');
    return;
  }
  const feed = name.endsWith('.yml');
  const headers = {
    'content-type': up.headers.get('content-type') || 'application/octet-stream',
    'cache-control': feed ? 'no-store' : 'public, max-age=86400, immutable',
  };
  if (!feed) headers['content-disposition'] = `attachment; filename="${name}"`;
  if (up.headers.get('content-length') && !up.headers.get('content-encoding')) headers['content-length'] = up.headers.get('content-length');
  res.writeHead(200, headers);
  if (req.method === 'HEAD' || !up.body) { res.end(); return; }
  let idle = null;
  const alive = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), BODY_IDLE_MS); };
  alive();
  const watch = new Transform({ transform(chunk, enc, cb) { alive(); cb(null, chunk); } });
  pipeline(Readable.fromWeb(up.body), watch, res, () => clearTimeout(idle));
}

// ── http ─────────────────────────────────────────────────────────────────────
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

// ── Tor bridges for the asker's country ─────────────────────────────────────
// The bridges Tor's bundle ships (Snowflake, meek, seven obfs4) are all
// blocked in Russia, and Tor never got through there. The Tor Project hands
// out others by country (its "Moat" circumvention settings: WebTunnel, obfs4
// that are in no bundle, Snowflake tuned to the country), which is how Tor
// Browser connects there; but bridges.torproject.org itself is blocked where
// they are needed. So the apps ask here: the country is Cloudflare's for the
// connection (CF-IPCountry), nothing about the asker is kept, and the answer
// is cached an hour per country. A country the Tor Project has nothing
// particular for (or none known) gets its defaults: WebTunnel and obfs4 that
// are in no bundle either, the same for everyone.
const MOAT = 'https://bridges.torproject.org/moat/circumvention/settings';
const MOAT_DEFAULTS = 'https://bridges.torproject.org/moat/circumvention/defaults';
const BRIDGE_KINDS = ['webtunnel', 'obfs4', 'snowflake', 'meek'];
const BRIDGES_MS = 60 * 60 * 1000;
const bridgeCache = new Map();   // country -> { at, bridges }

// The bridge lines of a Moat answer, by transport.
function moatBridges(j) {
  const out = {};
  // Those in no bundle first: the bundle's are the first a censor blocks.
  const settings = (Array.isArray(j && j.settings) ? j.settings : []).slice()
    .sort((a, b) => Number((a && a.bridges && a.bridges.source) === 'builtin') - Number((b && b.bridges && b.bridges.source) === 'builtin'));
  for (const s of settings) {
    const b = s && s.bridges;
    if (!b || !BRIDGE_KINDS.includes(b.type) || !Array.isArray(b.bridge_strings)) continue;
    const lines = b.bridge_strings.filter((l) => typeof l === 'string' && l.startsWith(`${b.type} `) && l.length < 2000 && !/[\r\n]/.test(l));
    if (lines.length) out[b.type] = [...new Set([...(out[b.type] || []), ...lines])].slice(0, 8);
  }
  return out;
}

async function moat(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/vnd.api+json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  return r.ok ? moatBridges(await r.json()) : null;
}

async function bridgesFor(cc) {
  const key = cc || 'defaults';
  const hit = bridgeCache.get(key);
  if (hit && Date.now() - hit.at < BRIDGES_MS) return hit.bridges;
  let bridges = hit ? hit.bridges : {};
  try {
    let got = cc ? await moat(MOAT, { country: cc.toLowerCase(), transports: BRIDGE_KINDS }) : null;
    if (!got || !Object.keys(got).length) got = await moat(MOAT_DEFAULTS, { transports: BRIDGE_KINDS });
    if (got) bridges = got;
  } catch { /* the last answer, or none */ }
  bridgeCache.set(key, { at: Date.now(), bridges });
  if (bridgeCache.size > 300) bridgeCache.delete(bridgeCache.keys().next().value);
  return bridges;
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
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  const route = `${req.method} ${pathname}`;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/dl' || pathname.startsWith('/dl/'))) {
      const from = await mirrorUrl(pathname);
      if (from) { await mirror(req, res, from); return; }
      const to = await download(pathname, searchParams.has('mirror'));
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
    if (route === 'GET /v1/bridges') {
      const head = String(req.headers['cf-ipcountry'] || '').toUpperCase();
      const asked = String(searchParams.get('cc') || '').toUpperCase();
      const cc = /^[A-Z]{2}$/.test(head) && head !== 'XX' && head !== 'T1' ? head : /^[A-Z]{2}$/.test(asked) ? asked : '';
      send(res, 200, { country: cc || null, bridges: await bridgesFor(cc) });
      return;
    }
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
