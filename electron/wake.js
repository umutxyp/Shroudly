'use strict';

/*
 * Wake — the computer slept, or its clock jumped.
 *
 * Every "nothing for N seconds" in Shroudly (an engine that stopped
 * answering, a program that never made a request, a connection that went
 * quiet, a prompt nobody answered) means something only while the computer
 * is awake and its clock runs on. After a sleep (lid closed, hibernate,
 * Modern Standby, macOS DarkWake, a main process frozen by App Nap) or a
 * clock change, those windows are wrong in one direction or the other, and
 * acting on them hurts: a healthy engine killed, the system proxy taken down,
 * a call's connections reported as cut. So each of them starts afresh
 * instead.
 *
 * How it is known, on every system:
 *  - the system says so (Electron's powerMonitor 'resume', 'unlock-screen');
 *  - a timer ran late: between two looks, much more time went by than was
 *    asked for (Windows' monotonic clock counts the sleep, so a 1 s timer
 *    fires once at wake, minutes late);
 *  - the wall clock and the monotonic one disagree (macOS and Linux stop the
 *    monotonic clock while asleep, so the timer is on time but Date.now()
 *    jumped; and a clock set by hand or by NTP moves only Date.now()).
 * Whoever looks first (check()) notices it; `epoch` counts the wakes, so
 * each user tells "since I started waiting" from "a wake happened meanwhile".
 */

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

// More than this beyond what a look was asked for: the computer was not
// running in between, or the clock moved.
const GAP_MS = 5000;
const TICK_MS = 1000;

class Wake extends EventEmitter {
  /* opts.now, opts.mono: the wall and monotonic clocks (tests). */
  constructor(opts = {}) {
    super();
    this.now = opts.now || Date.now;
    this.mono = opts.mono || (() => performance.now());
    this.gapMs = opts.gapMs || GAP_MS;
    this.tickMs = opts.tickMs || TICK_MS;
    this.epoch = 0;
    this.at = -Infinity;            // monotonic time of the last wake
    this.why = null;
    this._wall = this.now();
    this._mono = this.mono();
    this._timer = null;
  }

  /* The look every tickMs: a late one, or one where the two clocks
   * disagree, is a wake. */
  start() {
    if (this._timer) return this;
    this.check();
    this._timer = setInterval(() => this.check(), this.tickMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  /* Looks now; true when it found a wake. */
  check() {
    const late = this.gap(this._wall, this._mono, this.tickMs);
    this._wall = this.now();
    this._mono = this.mono();
    if (late) { this.resumed(late); return true; }
    return false;
  }

  /* Since (wall, mono), meant to be `expected` ms: 'late' when much more
   * time went by, 'clock' when the two clocks disagree, else null. */
  gap(wall, mono, expected) {
    const dWall = this.now() - wall;
    const dMono = this.mono() - mono;
    if (dMono > expected + this.gapMs) return 'late';
    if (Math.abs(dWall - dMono) > this.gapMs) return 'clock';
    return null;
  }

  /* A wake, from the system or from a look. Every window measured until now
   * starts afresh. */
  resumed(why = 'system') {
    this.epoch++;
    this.why = why;
    this.at = this.mono();
    this._wall = this.now();
    this._mono = this.at;
    this.emit('resume', why);
  }

  /* A wake less than `ms` ago (monotonic). */
  recent(ms) { return this.mono() - this.at < ms; }

  /* setTimeout, except that a wake while it waits makes it wait the whole
   * `ms` again, from the wake: a time limit measured across a sleep is not
   * one. Returns { cancel() }. */
  timeout(fn, ms) {
    const h = { t: null, cancel() { clearTimeout(this.t); } };
    const arm = () => {
      const epoch = this.epoch;
      const wall = this.now();
      const mono = this.mono();
      h.t = setTimeout(() => {
        // Its own measure as well as the shared one: the look every second
        // may not have come round yet (timers due at once run in any order).
        if (this.gap(wall, mono, ms)) this.resumed('late');
        if (this.epoch !== epoch) { arm(); return; }
        fn();
      }, ms);
    };
    arm();
    return h;
  }
}

// The one the app uses; tests make their own.
const shared = new Wake();

module.exports = shared;
module.exports.Wake = Wake;
module.exports.GAP_MS = GAP_MS;
