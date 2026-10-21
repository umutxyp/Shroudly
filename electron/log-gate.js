'use strict';

/*
 * The same line about the same host, kept from filling the log.
 *
 * A program retries a host it cannot reach over and over: Roblox asked for
 * silver.roblox.com and pulsar.roblox.com every minute for half an hour in
 * issue #29, and every try put "could not be reached" in the log again,
 * from the engine and from Games and apps both. Such a line is said the
 * first time at once, then at most once every half hour for that host and
 * that kind of line. One gate is shared by the engine's lines, Games and
 * apps (app-proxy.js) and the Discord relay (main.js hands it to each), so
 * the rule is the same wherever the line comes from; each kind still has
 * its own half hour, as each says something different.
 *
 * A clock set back (or a wake that moved it) never silences a host for
 * longer: a time before the last line counts as a new one. A host that gets
 * through is forgotten (its next failure is said at once), and each engine
 * start begins afresh for the unreachable lines. "Shroudly is restarting"
 * is one line per restart, whichever hosts were waiting: its kind is keyed
 * with no host, and forgotten when the engine is up again.
 */

const REPEAT_MS = 30 * 60 * 1000;
const MAX_KEYS = 2000;

class LogGate {
  constructor({ repeatMs = REPEAT_MS, now = Date.now } = {}) {
    this.repeatMs = repeatMs;
    this.now = now;
    this.said = new Map(); // `${kind}\n${host}` -> when it was last said
  }

  /* True when the line of this kind about this host is to be said now (and
   * remembers that it was). */
  allow(kind, host) {
    const key = `${kind}\n${String(host || '').toLowerCase()}`;
    const t = this.now();
    const last = this.said.get(key);
    if (last !== undefined && t >= last && t - last < this.repeatMs) return false;
    if (!this.said.has(key) && this.said.size >= MAX_KEYS) this._prune(t);
    this.said.delete(key);
    this.said.set(key, t);
    return true;
  }

  /* What is past its half hour goes; if every one is still within it, the
   * oldest half (the map keeps the order they were said in). */
  _prune(t) {
    for (const [k, at] of this.said) if (t < at || t - at >= this.repeatMs) this.said.delete(k);
    if (this.said.size < MAX_KEYS) return;
    let drop = Math.ceil(this.said.size / 2);
    for (const k of this.said.keys()) { if (drop-- <= 0) break; this.said.delete(k); }
  }

  /* The host got through: its next failure is news again, said at once. */
  forget(kind, host) { this.said.delete(`${kind}\n${String(host || '').toLowerCase()}`); }

  /* Every line of the kinds `match` picks ((kind) => boolean) is news
   * again: an engine start begins afresh (EngineManager). */
  forgetKinds(match) {
    for (const k of [...this.said.keys()]) if (match(k.slice(0, k.indexOf('\n')))) this.said.delete(k);
  }

  clear() { this.said.clear(); }
}

module.exports = LogGate;
module.exports.REPEAT_MS = REPEAT_MS;
module.exports.MAX_KEYS = MAX_KEYS;
