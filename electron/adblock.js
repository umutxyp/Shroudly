'use strict';

/* The ad and tracker list, for "Block ads and trackers" (off by default).
 *
 * The blocking itself is the engine's (core/src/adblock.c): it answers a
 * lookup of a listed name with 0.0.0.0 / :: and ends a connection to one
 * before anything reaches the network. Here is only the list: Shroudly's
 * own, combined every week from AdGuard DNS filter, HaGeZi's Multi PRO,
 * EasyList, EasyPrivacy and StevenBlack/hosts (scripts/adblock-list/build.js;
 * published on the repository's site-list branch), fetched through the
 * engine itself so it arrives on a network that filters GitHub, checked by
 * the engine (ADBLOCK-CHECK: big enough, lists what every ad list lists,
 * spares the sites no list may take) before it replaces the one in use, kept
 * in the user's data folder and fetched again once a week. A download that
 * fails or brings something else changes nothing: the list in use stays.
 * A list from another source (the hosts list alone, before 2.6.19) is
 * replaced at once, not after its week. */

const fs = require('fs');
const path = require('path');
const tls = require('tls');

const SOURCE = { host: 'raw.githubusercontent.com', path: '/umutxyp/Shroudly/site-list/adblock.txt' };
const MAX_BYTES = 16 * 1024 * 1024;            // as the engine's ADB_MAX_FILE
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 90 * 1000;

/* The user's exceptions, as written in Settings: one domain each, any case,
 * "www."/"*." and a path or port left out; what is not a domain is dropped. */
function cleanAllow(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let d = String(raw || '').trim().toLowerCase();
    d = d.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '');
    const cut = d.search(/[/:?#]/);
    if (cut !== -1) d = d.slice(0, cut);
    d = d.replace(/\.$/, '');
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(d) || d.length > 253) continue;
    if (!out.includes(d)) out.push(d);
  }
  return out.slice(0, 512);                    // ADBLOCK_ALLOW_MAX
}

/* An HTTP/1.1 body, chunked or not, from the bytes after the headers. */
function dechunk(buf) {
  const parts = [];
  let i = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', i);
    if (eol === -1) throw new Error('cut off');
    const size = parseInt(buf.slice(i, eol).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size)) throw new Error('bad chunk');
    if (size === 0) return Buffer.concat(parts);
    const start = eol + 2;
    if (start + size > buf.length) throw new Error('cut off');
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2;
  }
}

class AdblockList {
  /* opts.dir         where the list is kept (the user's data folder)
   * opts.connect     (socksPort, host, port) -> socket through the engine
   * opts.now()       the clock (tests)
   * opts.source       { host, path } of the list (tests: a local server)
   * opts.tls         extra TLS options (tests: the local server's certificate) */
  constructor(opts) {
    this.dir = opts.dir;
    this.connect = opts.connect;
    this.now = opts.now || Date.now;
    this.source = opts.source || SOURCE;
    this.tls = opts.tls || {};
    this.lastTry = -Infinity;
    this.busy = null;
  }

  get file() { return path.join(this.dir, 'adblock-list.txt'); }
  /* Where the list in use came from (written when it is adopted). */
  get sourceFile() { return path.join(this.dir, 'adblock-list.source'); }
  _sourceKey() { return `${this.source.host}${this.source.path}`; }

  /* A list is here to use. */
  has() {
    try { return fs.statSync(this.file).size > 0; } catch { return false; }
  }

  /* Time to fetch it (again): none yet, or a week old; not twice in half an
   * hour after a failure. */
  due() {
    if (this.now() - this.lastTry < RETRY_MS) return false;
    let from = '';
    try { from = fs.readFileSync(this.sourceFile, 'utf8').trim(); } catch {}
    if (from !== this._sourceKey()) return true;
    try { return this.now() - fs.statSync(this.file).mtimeMs >= REFRESH_MS; } catch { return true; }
  }

  /* Fetch the list through the engine at socksPort into a file beside the
   * one in use. Resolves its path; the caller has the engine check it and
   * then calls adopt(). */
  fetch(socksPort) {
    if (this.busy) return this.busy;
    this.lastTry = this.now();
    this.busy = this._fetch(socksPort).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _fetch(socksPort) {
    fs.mkdirSync(this.dir, { recursive: true });
    const raw = await this.connect(socksPort, this.source.host, 443);
    const body = await new Promise((resolve, reject) => {
      const s = tls.connect({ ...this.tls, socket: raw, servername: this.source.host, ALPNProtocols: ['http/1.1'] });
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => { s.destroy(); reject(new Error('timed out')); }, TIMEOUT_MS);
      s.on('secureConnect', () => {
        s.write(`GET ${this.source.path} HTTP/1.1\r\nHost: ${this.source.host}\r\n`
          + 'User-Agent: Shroudly\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n');
      });
      s.on('data', (d) => {
        size += d.length;
        if (size > MAX_BYTES + 65536) { s.destroy(); clearTimeout(timer); reject(new Error('too large')); return; }
        chunks.push(d);
      });
      s.on('error', (e) => { clearTimeout(timer); reject(e); });
      s.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    });
    const head = body.indexOf('\r\n\r\n');
    if (head === -1) throw new Error('no answer');
    const headers = body.subarray(0, head).toString('latin1');
    const status = (/^HTTP\/1\.[01] (\d{3})/.exec(headers) || [])[1];
    if (status !== '200') throw new Error(`HTTP ${status || '?'}`);
    let content = body.subarray(head + 4);
    if (/^transfer-encoding:\s*chunked/im.test(headers)) content = dechunk(content);
    else {
      const len = Number((/^content-length:\s*(\d+)/im.exec(headers) || [])[1]);
      if (Number.isFinite(len) && content.length < len) throw new Error('cut off');
    }
    if (content.length === 0 || content.length > MAX_BYTES) throw new Error('not a list');
    const tmp = path.join(this.dir, 'adblock-list.new');
    fs.writeFileSync(tmp, content);
    return tmp;
  }

  /* The fetched file, checked by the engine, becomes the list in use. */
  adopt(tmp) {
    fs.renameSync(tmp, this.file);
    fs.writeFileSync(this.sourceFile, `${this._sourceKey()}\n`);
  }

  /* A fetched file the engine turned down. */
  discard(tmp) {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { AdblockList, cleanAllow, dechunk, SOURCE, REFRESH_MS, RETRY_MS };
