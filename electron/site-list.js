'use strict';

/*
 * The list of sites that "only listed sites" routing sends through Shroudly,
 * kept current without an app update.
 *
 * scripts/site-list/update.js rebuilds it every week from OONI's measurements
 * (a site blocked somewhere is added, one no longer blocked anywhere for 90
 * days is dropped) and publishes it on the repository's site-list branch. The
 * app ships the list as it was at release (data/sites.json) and fetches the
 * published one about once a day.
 *
 * Only while protection is on, and through the engine: a request to GitHub
 * made in the clear would tell whoever filters the connection that this
 * machine runs circumvention software (the same rule as presence.js). The
 * answer must be a list of plain host names, of a sane size, and newer than
 * the one in use; anything else is ignored and the current list kept.
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const http = require('http');
const zlib = require('zlib');
const { socksConnect } = require('./discord-relay');
const SystemProxy = require('./system-proxy');

const LIST_URL = 'https://raw.githubusercontent.com/umutxyp/Shroudly/site-list/sites.json';
const BUNDLED = path.join(__dirname, 'data', 'sites.json');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DOMAINS = 10000;
const DAY = 24 * 60 * 60 * 1000;

/* A whole country's or a whole registry's names (com.tr, co.uk, gov.tr):
 * never one entry. */
const REGISTRY_LABELS = new Set(['com', 'net', 'org', 'gov', 'edu', 'mil', 'int', 'co', 'ac', 'or', 'ne', 'go', 'gen', 'web', 'info', 'biz', 'nom', 'k12', 'bel', 'pol', 'tv', 'av', 'dr', 'bbs', 'name', 'tel', 'kep', 'tsk']);
function isRegistry(d) {
  const labels = d.split('.');
  return labels.length === 2 && labels[1].length === 2 && REGISTRY_LABELS.has(labels[0]);
}

/* { generated, domains } from a published file, or an Error. notAfter: the
 * latest date a genuine list can carry (now, give or take a wrong clock). */
function validate(obj, notAfter = Date.now() + 2 * DAY) {
  if (!obj || obj.v !== 1 || !Array.isArray(obj.domains)) return new Error('not a site list');
  const t = Date.parse(obj.generated);
  if (!Number.isFinite(t) || t > notAfter) return new Error('bad date');
  if (obj.domains.some((d) => typeof d === 'string' && isRegistry(d))) return new Error('a whole registry listed');
  const domains = [...new Set(obj.domains.filter((d) => SystemProxy.isHostname(d)))];
  if (domains.length < 50 || domains.length > MAX_DOMAINS) return new Error(`unlikely size (${domains.length})`);
  // A list that is mostly not host names is not ours, whatever else it says.
  if (domains.length < obj.domains.length * 0.95) return new Error('too many invalid entries');
  return { generated: new Date(t).toISOString(), domains };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/* GET url through the engine (SOCKS on socksPort). Resolves
 * { status, body, etag }: 304 (unchanged since etag) has no body. */
function fetchThrough(socksPort, url, { ca, etag, timeoutMs = 30000 } = {}) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  return new Promise((resolve, reject) => {
    let done = false; let raw = null; let sock = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Nothing is left open, whatever ended the request.
      try { if (sock) sock.destroy(); else if (raw) raw.destroy(); } catch {}
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    socksConnect(socksPort, u.hostname, port).then((r) => {
      raw = r;
      if (done) { r.destroy(); return; }
      sock = tls.connect({ socket: r, servername: u.hostname, ALPNProtocols: ['http/1.1'], ...(ca ? { ca } : {}) });
      sock.on('error', (e) => finish(e));
      const headers = { host: u.host, 'user-agent': 'Shroudly', accept: 'application/json', 'accept-encoding': 'gzip' };
      if (etag) headers['if-none-match'] = etag;
      const req = http.request({ createConnection: () => sock, method: 'GET', path: `${u.pathname}${u.search}`, headers }, (res) => {
        const tag = typeof res.headers.etag === 'string' ? res.headers.etag : null;
        if (res.statusCode === 304) { res.resume(); finish(null, { status: 304, body: null, etag: tag || etag }); return; }
        if (res.statusCode !== 200) { res.resume(); finish(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) finish(new Error('too large')); else chunks.push(c); });
        res.on('end', () => {
          let body = Buffer.concat(chunks);
          try {
            if (/gzip/i.test(String(res.headers['content-encoding'] || ''))) body = zlib.gunzipSync(body, { maxOutputLength: MAX_BYTES * 4 });
          } catch (e) { finish(e); return; }
          finish(null, { status: 200, body: body.toString('utf8'), etag: tag });
        });
        res.on('error', (e) => finish(e));
      });
      req.on('error', (e) => finish(e));
      req.end();
    }, (e) => finish(e));
  });
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((d) => s.has(d));
}

class SiteList {
  /*
   * opts.cacheFile     where the last downloaded list is kept
   * opts.getSocksPort  the engine's port while protection is on, else null
   * opts.url, opts.ca, opts.bundled   stand-ins for tests
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.getSocksPort = opts.getSocksPort || (() => null);
    this.url = opts.url || LIST_URL;
    // The shipped list is trusted whatever this machine's clock says (a clock
    // running days behind must not leave "only listed sites" with nothing).
    const shipped = readJson(opts.bundled || BUNDLED);
    const bundled = shipped && validate(shipped, Infinity);
    this.bundledAt = bundled && !(bundled instanceof Error) ? Date.parse(bundled.generated) : 0;
    const cache = opts.cacheFile ? readJson(opts.cacheFile) : null;
    const cached = cache && validate(cache, this._notAfter());
    // Whichever is newer: a cache from before an app update can be older than
    // the list the update brought.
    this.current = [bundled, cached].filter((x) => x && !(x instanceof Error))
      .sort((a, b) => b.generated.localeCompare(a.generated))[0]
      || { generated: new Date(0).toISOString(), domains: [] };
    // When the published list was last looked at, and its tag: kept across
    // restarts, so starting Shroudly does not mean downloading it again.
    this.checkedAt = cache && Number.isFinite(cache.checkedAt) ? Math.min(cache.checkedAt, Date.now()) : 0;
    this.etag = cache && cached === this.current && typeof cache.etag === 'string' ? cache.etag : null;
  }

  _notAfter() { return Math.max(Date.now(), this.bundledAt || 0) + 2 * DAY; }

  get domains() { return this.current.domains; }
  info() { return { count: this.current.domains.length, generated: this.current.generated, checkedAt: this.checkedAt }; }

  _save() {
    if (!this.opts.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.cacheFile), { recursive: true });
      const tmp = `${this.opts.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, generated: this.current.generated, count: this.current.domains.length,
        checkedAt: this.checkedAt, etag: this.etag, domains: this.current.domains }));
      fs.renameSync(tmp, this.opts.cacheFile);
    } catch {}
  }

  /* Fetch the published list. Resolves true only if the sites changed. */
  async refresh() {
    const socksPort = this.getSocksPort();
    if (!socksPort) return false;
    let res;
    try {
      res = await fetchThrough(socksPort, this.url, { ca: this.opts.ca, etag: this.etag });
    } catch (e) {
      this.log('info', `Site list: could not check for a newer list (${e.message})`);
      return false;
    }
    this.checkedAt = Date.now();
    if (res.status === 304) { this._save(); return false; }
    let obj;
    try { obj = JSON.parse(res.body); } catch { obj = null; }
    const r = validate(obj, this._notAfter());
    if (r instanceof Error) { this.log('warning', `Site list: the downloaded list was refused (${r.message})`); this._save(); return false; }
    if (r.generated <= this.current.generated) { this._save(); return false; }
    // The weekly build never halves the list (scripts/site-list/update.js):
    // one that does is not what it built.
    if (r.domains.length < this.current.domains.length * 0.5) {
      this.log('warning', `Site list: the downloaded list was refused (it would drop ${this.current.domains.length - r.domains.length} sites at once)`);
      this._save();
      return false;
    }
    const changed = !sameSet(r.domains, this.current.domains);
    const before = new Set(this.current.domains);
    const added = r.domains.filter((d) => !before.has(d)).length;
    const removed = this.current.domains.length - (r.domains.length - added);
    this.current = r;
    this.etag = res.etag;
    this._save();
    if (!changed) return false;   // a new date on the same sites: nothing to apply
    this.log('success', `Site list updated: ${r.domains.length} sites (${added} added, ${removed} removed)`);
    return true;
  }
}

module.exports = SiteList;
module.exports.validate = validate;
module.exports.isRegistry = isRegistry;
module.exports.fetchThrough = fetchThrough;
module.exports.LIST_URL = LIST_URL;
