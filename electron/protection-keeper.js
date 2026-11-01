'use strict';

/*
 * Protection the user left on that is not running, put back by itself.
 *
 * A start at login that timed out on a busy PC (an antivirus scanning the
 * engine, a slow disk), a crash restart whose own start failed, an engine
 * given up on after crashing: each left protection off for the rest of the
 * session, with nothing trying again and nothing said, while the user took
 * it to be on. Now that state is looked at every half minute and a start is
 * tried after growing pauses (15 s, 1 min, 5 min, then every 15 min), and
 * at once after a wake or another network, when a start is likeliest to
 * work. The first time in a session it is told once (onFirst).
 *
 * due() says when it is that state: never while a start or a crash restart
 * is under way, after the user's Stop, while quitting or installing an
 * update, or once an antivirus blocked the engine (that needs the user, and
 * a start again would only make it act again). Apart from main.js so the
 * timing can be tested without Electron.
 */

const PAUSES = [15e3, 60e3, 5 * 60e3, 15 * 60e3];
const LOOK_MS = 30e3;

class ProtectionKeeper {
  constructor({ due, start, log = () => {}, onFirst = () => {}, pauses = PAUSES, lookMs = LOOK_MS, now = Date.now } = {}) {
    this.due = due;
    this.start = start;
    this.log = log;
    this.onFirst = onFirst;
    this.pauses = pauses;
    this.lookMs = lookMs;
    this.now = now;
    this.tries = 0;
    this._next = 0;
    this._busy = false;
    this._poked = false;
    this._told = false;
    this._timer = null;
  }

  begin() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.look().catch(() => {}); }, this.lookMs);
    if (this._timer.unref) this._timer.unref();
  }

  end() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /* A wake or another network: tried at once, and the pauses start over
   * (the first of them again: a network just back may need a moment). */
  poke() {
    if (this._busy || !this._wanted()) return Promise.resolve(false);
    this.tries = 0;
    this._next = this.now();
    this._poked = true;
    return this.look();
  }

  _wanted() {
    try { return !!this.due(); } catch { return false; }
  }

  /* One look: a start when it is due and its pause is over. True when a
   * start was tried. */
  async look() {
    if (this._busy) return false;
    if (!this._wanted()) { this.tries = 0; this._next = 0; return false; }
    const t = this.now();
    // Seen for the first time: the first pause before trying.
    if (!this._next) { this._next = t + this.pauses[0]; return false; }
    if (t < this._next) return false;
    this._busy = true;
    this.tries++;
    if (!this._told) { this._told = true; try { this.onFirst(); } catch {} }
    this.log('info', `Protection is meant to be on but is not running: starting it again (try ${this.tries})`);
    try { await this.start(); } catch {}
    this._busy = false;
    this._next = this.now() + this.pauses[this._poked ? 0 : Math.min(this.tries, this.pauses.length - 1)];
    this._poked = false;
    return true;
  }
}

module.exports = { ProtectionKeeper, PAUSES };
