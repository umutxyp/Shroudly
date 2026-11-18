'use strict';

/*
 * Remote settings: what Shroudly can be told without a new version, on every
 * system (this file: the desktop; android/.../RemoteConfig.kt; apple/Shared/
 * RemoteConfig.swift). Data, never code: remote.json in the repository, with
 * remote.json.sig, an ECDSA P-256 / SHA-256 signature of its exact bytes
 * (scripts/sign-remote.js; the private key never leaves the owner's
 * computer). A file whose signature does not check, that is older (a lower
 * serial) than the one in use, that has expired or that is not understood
 * is never used; the last good one is kept. Only the keys below are read,
 * each checked for its shape, and engineArgs only from an allow-list that
 * tunes techniques: nothing that could send traffic anywhere else (no
 * server, no file, no port, no address).
 *
 * remote.json:
 *   { "v": 1, "serial": 3, "issued": "2026-11-16T20:00:00Z", "expires": "...",
 *     "set": { key: value, ... },
 *     "rules": [ { "when": { "platform": ["android"], "country": ["IR"],
 *                            "appMin": "2.6.81", "appMax": "2.6.90" },
 *                  "set": { key: value } } ] }
 * Rules apply in order over "set"; a "when" left out matches everything.
 *
 * Keys (each a default the user's own choice still overrides):
 *   engineArgs   [string]  extra engine arguments (ENGINE_ALLOWED)
 *   quicOff      bool      the phones' default for "Turn off QUIC"
 *   torAllowed   bool      false: the last way out is not started at all
 *   torBridges   { transport: [bridge line] }  tried before the bundled ones
 *   decoyNames   { CC: [host] }   decoy names for a country
 *   reportOffer  "fault" | "always" | "never"   "Something not working?"
 */

const crypto = require('crypto');

const PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERbLcXjFix6KWe3RTG+f7yhiqxBJ5mmNwu9jl2ZK5c7yDpxnC+wcU/YuC1vR3HnQCXfeylIYc7opckWkmTd/4HQ==';
const SOURCES = [
  'https://raw.githubusercontent.com/umutxyp/Shroudly/main/',
  'https://cdn.jsdelivr.net/gh/umutxyp/Shroudly@main/',
];
const FILE = 'remote.json';
const SIG = 'remote.json.sig';
const MAX_BYTES = 256 * 1024;

/* The engine arguments a remote file may add: technique tuning only. */
const ENGINE_ALLOWED = {
  '--strategy': /^[a-z0-9_(),=.:+\-]{1,200}$/i,
  '--decoy-name': /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i,
  '--fake-repeats': /^([1-9]|1[0-6])$/,
  '--tlsrec': /^[01]$/,
  '--ipv4-only': null,
  '--drop-quic': null,
  '--no-quic-block': null,
  '--no-udp-fake': null,
};

function verify(data, sigB64, publicKey = PUBLIC_KEY) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.from(data), key, Buffer.from(String(sigB64).trim(), 'base64'));
  } catch { return false; }
}

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/* The file, understood, or null. */
function parse(text, now = Date.now()) {
  let c;
  try { c = JSON.parse(String(text)); } catch { return null; }
  if (!isObj(c) || c.v !== 1 || !Number.isInteger(c.serial) || c.serial < 1) return null;
  if (c.expires !== undefined) { const e = Date.parse(c.expires); if (!(e > now)) return null; }
  if (c.set !== undefined && !isObj(c.set)) return null;
  if (c.rules !== undefined && !Array.isArray(c.rules)) return null;
  return c;
}

/* "2.6.81" against "2.6.9": by numbers, part by part. */
function cmpVersion(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

function matches(when, ctx) {
  if (when === undefined) return true;
  if (!isObj(when)) return false;
  const inList = (list, v) => Array.isArray(list) && list.map((s) => String(s).toLowerCase()).includes(String(v || '').toLowerCase());
  if (when.platform !== undefined && !inList(when.platform, ctx.platform)) return false;
  if (when.country !== undefined && !inList(when.country, ctx.country)) return false;
  if (when.appMin !== undefined && cmpVersion(ctx.app, when.appMin) < 0) return false;
  if (when.appMax !== undefined && cmpVersion(ctx.app, when.appMax) > 0) return false;
  return true;
}

/* The settings for this copy: "set", then every rule that matches, in order. */
function effective(c, ctx) {
  const out = {};
  if (!c) return out;
  Object.assign(out, isObj(c.set) ? c.set : {});
  for (const r of c.rules || []) if (isObj(r) && matches(r.when, ctx) && isObj(r.set)) Object.assign(out, r.set);
  return out;
}

/* engineArgs from a remote file, only what ENGINE_ALLOWED takes. */
function engineArgs(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (!Object.prototype.hasOwnProperty.call(ENGINE_ALLOWED, a)) continue;
    const shape = ENGINE_ALLOWED[a];
    if (shape === null) { out.push(a); continue; }
    const v = list[i + 1];
    if (typeof v === 'string' && shape.test(v)) { out.push(a, v); i++; }
  }
  return out;
}

const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const hostList = (l) => (Array.isArray(l) ? l.filter((h) => typeof h === 'string' && ENGINE_ALLOWED['--decoy-name'].test(h)).slice(0, 8) : []);
function decoyNames(eff, cc) {
  const d = isObj(eff.decoyNames) ? eff.decoyNames[String(cc || '').toUpperCase()] : undefined;
  return d === undefined ? null : hostList(d);
}
function torBridges(eff) {
  const out = {};
  if (!isObj(eff.torBridges)) return out;
  for (const [k, v] of Object.entries(eff.torBridges)) {
    if (!/^[a-z0-9_]{1,20}$/i.test(k) || !Array.isArray(v)) continue;
    const lines = v.filter((l) => typeof l === 'string' && l.length < 2000 && !/[\r\n]/.test(l) && l.split(' ')[0] === k).slice(0, 40);
    if (lines.length) out[k] = lines;
  }
  return out;
}
/* What of the settings the engine and Tor start with: a new file restarts
 * them only when this changes (a first file that changes nothing, or one
 * that changes only the report rule, must not cut every open connection). */
function engineKey(eff) {
  const e = isObj(eff) ? eff : {};
  return JSON.stringify([engineArgs(e.engineArgs), isObj(e.decoyNames) ? e.decoyNames : null, e.torAllowed === false, torBridges(e), e.quicOff === undefined ? null : !!e.quicOff]);
}
function reportOffer(eff) { return ['fault', 'always', 'never'].includes(eff.reportOffer) ? eff.reportOffer : 'fault'; }

/*
 * The desktop's keeper: the last good file in the settings store, checked
 * again at every start, a new one asked for every six hours (through
 * Shroudly when protection is on: fetchText decides), from each source in
 * turn.
 */
const EVERY_MS = 6 * 60 * 60 * 1000;
// Asked again this soon when a source answered but none gave a usable file.
const RETRY_MS = 60 * 60 * 1000;
class RemoteConfig {
  constructor({ store, fetchText, ctx, log = () => {}, now = () => Date.now(), publicKey = PUBLIC_KEY }) {
    this.store = store; this.fetchText = fetchText; this.ctx = ctx; this.log = log; this.now = now; this.publicKey = publicKey;
    this.current = null;
    const kept = store.get('remoteConfig');
    if (isObj(kept) && verify(kept.text, kept.sig, publicKey)) this.current = parse(kept.text, now());
  }

  settings() { return effective(this.current, this.ctx()); }
  serial() { return this.current ? this.current.serial : 0; }

  /* A file and its signature as fetched: what it is worth.
   *   'new'   it checks and is newer: taken (kept, and in use from now on);
   *   'same'  it checks and is the one in use: the check is done, nothing
   *           changes (no engine restart);
   *   null    unusable: missing, too large, a signature that does not check
   *           (a mirror out of step, a captive portal's page), unreadable or
   *           expired, or older than the one in use. The next source is
   *           asked then: an HTTP 200 alone used to end the check, and an
   *           unusable answer from the first source kept the mirror from
   *           ever being asked until the next check, six hours on. */
  take(text, sig) {
    if (!text || !sig || Buffer.byteLength(text) > MAX_BYTES) return null;
    if (!verify(text, sig, this.publicKey)) { this.log('warning', 'Remote settings: a file whose signature does not check was refused'); return null; }
    const c = parse(text, this.now());
    if (!c || c.serial < this.serial()) return null;
    if (c.serial === this.serial()) return 'same';
    this.current = c;
    this.store.set('remoteConfig', { text, sig });
    this.log('info', `Remote settings: number ${c.serial} in use`);
    return 'new';
  }

  /* True when it was taken (take: 'new'). */
  offer(text, sig) { return this.take(text, sig) === 'new'; }

  due() { return this.now() - (Number(this.store.get('remoteConfigAt')) || 0) >= EVERY_MS; }

  /* Each source in turn, until one gives a usable file (take). None did,
   * though one answered: the last good file stays in use, and it is asked
   * again in an hour (RETRY_MS) rather than in six. None answered at all
   * (offline): asked again at the next look, as before. */
  async refresh({ force = false } = {}) {
    if (!force && !this.due()) return false;
    let answered = false;
    for (const base of SOURCES) {
      let text, sig;
      try {
        [text, sig] = await Promise.all([this.fetchText(base + FILE), this.fetchText(base + SIG)]);
      } catch { continue; }
      answered = true;
      const got = this.take(text, sig);
      if (got === null) continue;
      this.store.set('remoteConfigAt', this.now());
      return got === 'new';
    }
    if (answered) this.store.set('remoteConfigAt', this.now() - EVERY_MS + RETRY_MS);
    return false;
  }
}

module.exports = { PUBLIC_KEY, SOURCES, ENGINE_ALLOWED, verify, parse, cmpVersion, matches, effective, engineArgs, engineKey, decoyNames, torBridges, reportOffer, bool, RemoteConfig };
