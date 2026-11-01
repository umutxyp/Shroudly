'use strict';

/*
 * The Mac copy from GitHub (the disk image) suggesting the Mac App Store
 * one, once that is published, as the Android APK suggests Google Play.
 *
 * Only where it is really there: stores.json on main (fetched at most every
 * 12 hours) says whether the Mac App Store copy is live, where (countries,
 * "*" for all, less exclude: a country where it was taken down, a law
 * there) and at which address. This Mac's country is its region setting;
 * one not known, a store not live, an address not given or a file that
 * could not be read: nothing is suggested. Never forced: shown at most
 * twice, 30 days apart; "Open the App Store" ends it, as a second "Not now"
 * does. Not in a copy the App Store installed (process.mas). Apart from
 * main.js so the rule can be tested without Electron.
 */

const STORES_URL = 'https://raw.githubusercontent.com/umutxyp/Shroudly/main/stores.json';
const FETCH_EVERY_MS = 12 * 60 * 60 * 1000;
const GAP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SHOWN = 2;
const KEY = 'macStoreSuggest';

/* Is the store live in this country? `entry`: stores.json's macAppStore. */
function availableIn(entry, country) {
  if (!entry || entry.live !== true || typeof entry.url !== 'string' || !/^https:\/\/apps\.apple\.com\//.test(entry.url)) return false;
  const cc = String(country || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return false;
  const up = (l) => (Array.isArray(l) ? l.map((c) => String(c).toUpperCase()) : []);
  const countries = entry.countries === undefined ? ['*'] : up(entry.countries);
  if (!countries.includes('*') && !countries.includes(cc)) return false;
  return !up(entry.exclude).includes(cc);
}

/* Whether to show it now, by what was shown before ({ shown, at, done }). */
function due(state, now) {
  const s = state && typeof state === 'object' ? state : {};
  if (s.done || (s.shown | 0) >= MAX_SHOWN) return false;
  if (!s.shown) return true;
  // A clock set back: counted from now, not shown early.
  if (!(s.at > 0) || s.at > now) return false;
  return now - s.at >= GAP_MS;
}

class StoreSuggest {
  /* opts: store (electron-store), fetchJson(url) → object, country() → "TR",
   * platform, mas (process.mas), packaged, now(). */
  constructor(opts) {
    this.store = opts.store;
    this.fetchJson = opts.fetchJson;
    this.country = opts.country;
    this.platform = opts.platform || process.platform;
    this.mas = !!opts.mas;
    this.packaged = opts.packaged !== false;
    this.now = opts.now || Date.now;
    this.cached = null;     // { at, entry }
  }

  async _entry() {
    const t = this.now();
    if (this.cached && t - this.cached.at < FETCH_EVERY_MS && t >= this.cached.at) return this.cached.entry;
    let entry = null;
    try {
      const json = await this.fetchJson(STORES_URL);
      entry = json && typeof json === 'object' ? json.macAppStore || null : null;
    } catch { entry = null; }
    // Unknown is "not live", and not kept: the next look asks again.
    this.cached = entry ? { at: t, entry } : null;
    return entry;
  }

  /* The suggestion to show now, or null: { url }. */
  async pending() {
    if (this.platform !== 'darwin' || this.mas || !this.packaged) return null;
    let state = null;
    try { state = this.store.get(KEY); } catch {}
    if (!due(state, this.now())) return null;
    const entry = await this._entry();
    let cc = '';
    try { cc = this.country(); } catch {}
    return availableIn(entry, cc) ? { url: entry.url } : null;
  }

  /* It was shown (the window has it on screen). */
  shown() {
    const s = { ...(this.store.get(KEY) || {}) };
    s.shown = (s.shown | 0) + 1;
    s.at = this.now();
    try { this.store.set(KEY, s); } catch {}
  }

  /* "Open the App Store": done for good. "Not now": the next is 30 days
   * on, and the second "Not now" is the last. */
  answered(opened) {
    const s = { ...(this.store.get(KEY) || {}) };
    if (opened || (s.shown | 0) >= MAX_SHOWN) s.done = true;
    s.at = this.now();
    try { this.store.set(KEY, s); } catch {}
  }
}

module.exports = { StoreSuggest, availableIn, due, STORES_URL, GAP_MS, MAX_SHOWN, KEY };
