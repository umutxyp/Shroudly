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
const { socksConnect } = require('./discord-relay');
const SystemProxy = require('./system-proxy');

const LIST_URL = 'https://raw.githubusercontent.com/umutxyp/Shroudly/site-list/sites.json';
const BUNDLED = path.join(__dirname, 'data', 'sites.json');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DOMAINS = 10000;
const DAY = 24 * 60 * 60 * 1000;

/* { generated, domains } from a published file, or an Error. */
function validate(obj, now = Date.now()) {
  if (!obj || obj.v !== 1 || !Array.isArray(obj.domains)) return new Error('not a site list');
  const t = Date.parse(obj.generated);
  if (!Number.isFinite(t) || t > now + 2 * DAY) return new Error('bad date');
  const domains = [...new Set(obj.domains.filter((d) => SystemProxy.isHostname(d)))];
  if (domains.length < 50 || domains.length > MAX_DOMAINS) return new Error(`unlikely size (${domains.length})`);
  // A list that is mostly not host names is not ours, whatever else it says.
  if (domains.length < obj.domains.length * 0.95) return new Error('too many invalid entries');
  return { generated: new Date(t).toISOString(), domains };
}

function readList(file) {
  try {
    const r = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
    return r instanceof Error ? null : r;
  } catch { return null; }
}

/* GET url through the engine (SOCKS on socksPort); resolves the body. */
function fetchThrough(socksPort, url, { ca, timeoutMs = 30000 } = {}) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);
    socksConnect(socksPort, u.hostname, port).then((raw) => {
      const sock = tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'], ...(ca ? { ca } : {}) });
      sock.on('error', fail);
      const req = http.request({
        createConnection: () => sock, method: 'GET', path: `${u.pathname}${u.search}`,
        headers: { host: u.host, 'user-agent': 'Shroudly', accept: 'application/json', 'accept-encoding': 'identity' },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode}`)); sock.destroy(); return; }
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { sock.destroy(); fail(new Error('too large')); } else chunks.push(c); });
        res.on('end', () => { clearTimeout(timer); if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } sock.destroy(); });
        res.on('error', fail);
      });
      req.on('error', fail);
      req.end();
    }, fail);
  });
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
    this.checkedAt = 0;
    const bundled = readList(opts.bundled || BUNDLED);
    const cached = opts.cacheFile ? readList(opts.cacheFile) : null;
    // Whichever is newer: a cache from before an app update can be older than
    // the list the update brought.
    this.current = [bundled, cached].filter(Boolean).sort((a, b) => b.generated.localeCompare(a.generated))[0]
      || { generated: new Date(0).toISOString(), domains: [] };
  }

  get domains() { return this.current.domains; }
  info() { return { count: this.current.domains.length, generated: this.current.generated, checkedAt: this.checkedAt }; }

  /* Fetch the published list. Resolves true if it replaced the current one. */
  async refresh() {
    const socksPort = this.getSocksPort();
    if (!socksPort) return false;
    let obj;
    try {
      obj = JSON.parse(await fetchThrough(socksPort, this.url, { ca: this.opts.ca }));
    } catch (e) {
      this.log('info', `Site list: could not check for a newer list (${e.message})`);
      return false;
    }
    this.checkedAt = Date.now();
    const r = validate(obj);
    if (r instanceof Error) { this.log('warning', `Site list: the downloaded list was refused (${r.message})`); return false; }
    if (r.generated <= this.current.generated) return false;
    if (this.opts.cacheFile) {
      try {
        fs.mkdirSync(path.dirname(this.opts.cacheFile), { recursive: true });
        const tmp = `${this.opts.cacheFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, generated: r.generated, count: r.domains.length, domains: r.domains }));
        fs.renameSync(tmp, this.opts.cacheFile);
      } catch {}
    }
    const before = new Set(this.current.domains);
    const added = r.domains.filter((d) => !before.has(d)).length;
    const removed = this.current.domains.length - (r.domains.length - added);
    this.current = r;
    this.log('success', `Site list updated: ${r.domains.length} sites (${added} added, ${removed} removed)`);
    return true;
  }
}

module.exports = SiteList;
module.exports.validate = validate;
module.exports.fetchThrough = fetchThrough;
module.exports.LIST_URL = LIST_URL;
