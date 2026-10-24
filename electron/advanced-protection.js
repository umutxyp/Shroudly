'use strict';

/*
 * Advanced mode as part of protection (main.js).
 *
 * Protection's Stop takes Advanced mode down with it: WinDivert / NFQUEUE
 * would otherwise keep putting decoys into every outbound connection with
 * protection off. After the user's own Stop it comes back at their next
 * Start in this run (one permission prompt, as when it was first turned on).
 * Without that, a Stop and Start left it off for the rest of the session,
 * since the autopilot asks only once a session, and whatever only it opened
 * (Discord's gateway on some networks) stayed shut. Turned off by hand
 * meanwhile: not.
 *
 * A start on protection's behalf (that return, the autopilot's ask) takes a
 * while: a look for a game's anti-cheat, then a permission prompt the user
 * may take minutes over. A Stop meanwhile wins: nothing is asked after it,
 * and a backend that comes up after it is stopped again at once and comes
 * back with the next Start. Each Stop begins a new session (session()), so a
 * Stop followed by a quick Start counts too. One such start at a time, so a
 * Start waits for the answer to one from before its Stop.
 *
 * A start from the Settings panel is the user's own, works with protection
 * off, and does not go through here.
 *
 * A game with an anti-cheat that starts while Advanced mode runs (BattlEye,
 * Easy Anti-Cheat, Vanguard, FACEIT): the anti-cheat refuses the game, or
 * drops it from its servers, beside a packet driver ("Rockstar Games:
 * connection error"). So Advanced mode steps aside (guard(), every few
 * seconds while it runs): it is stopped, the user is told in one line, and
 * once the game has closed it comes back (one permission prompt). Started
 * while the game already runs, it is the user's own choice and left alone.
 * A Stop, or Advanced mode turned off by hand, ends the wait.
 */

class AdvancedProtection {
  /*
   * opts.active()          whether the Advanced backend is running
   * opts.start()           start it -> { success, code, alreadyActive }
   * opts.ready()           optional: waited for before asking (another permission prompt on screen)
   * opts.stop()            stop it, and tell the window
   * opts.protectionOn()    whether protection is on (or on its way back)
   * opts.antiCheat()       a game's anti-cheat running (its name), or null
   * opts.declined()        the user declined the permission prompt
   * opts.tell(id, params)  a notification and a line in the window
   * opts.log(level, msg)
   */
  constructor(opts) {
    this.active = opts.active;
    this.startBackend = opts.start;
    this.ready = opts.ready || (async () => {});
    this.stopBackend = opts.stop;
    this.protectionOn = opts.protectionOn;
    this.antiCheat = opts.antiCheat || (async () => null);
    this.declined = opts.declined || (() => {});
    this.tell = opts.tell || (() => {});
    this.log = opts.log || (() => {});
    this.paused = null;              // { game }: stepped aside for a game's anti-cheat
    this.lastGame = undefined;       // the anti-cheat game seen at the last look (undefined: no look yet)
    this.guarding = false;
    this.stops = 0;                  // protection's Stops in this run
    this.resume = false;             // Advanced mode comes back at the next Start
    this.tail = Promise.resolve();   // the last start on protection's behalf
  }

  /* The session a start on protection's behalf belongs to (see start). */
  session() { return this.stops; }

  /* Still session `since`, with protection on. */
  current(since) { return since === this.stops && !!this.protectionOn(); }

  /* Protection is being stopped (before the engine). user: the user's own
   * Stop, after which Advanced mode comes back with their next Start. */
  async stopped({ user = false } = {}) {
    this.stops++;
    // Stepped aside for a game: the Stop ends the wait; after the user's
    // own, the next Start brings it back (once the game has closed).
    if (this.paused) { this.paused = null; this.resume = !!user; return; }
    if (!this.active()) return;
    this.resume = !!user;
    try { await this.stopBackend(); } catch {}
  }

  /* Turned off by hand: it does not come back by itself. */
  offByHand() { this.resume = false; this.paused = null; }

  /* One look for a game's anti-cheat (see the top of this file). */
  async guard() {
    if (this.guarding) return;
    this.guarding = true;
    try {
      let game = null;
      try { game = await this.antiCheat(); } catch { return; }
      const before = this.lastGame;
      this.lastGame = game;
      if (this.paused) {
        // Started again meanwhile (by the user), or protection is off: the
        // wait is over.
        if (this.active() || !this.protectionOn()) { this.paused = null; return; }
        if (game) return;
        const was = this.paused.game;
        this.paused = null;
        this.log('info', `${was} has closed; Advanced mode comes back`);
        this.tell('autoAdvancedBackAfterGame', { program: was });
        const r = await this.start(this.stops);
        if (r && r.code === 'declined') this.declined();
        return;
      }
      // A game that has just started (not one that was already running when
      // Advanced mode was started, nor at the first look).
      if (!game || before === undefined || before || !this.active() || !this.protectionOn()) return;
      this.paused = { game };
      try { await this.stopBackend(); } catch {}
      this.log('info', `Advanced mode paused: ${game} is running, and its anti-cheat does not allow the packet driver Advanced mode uses; it comes back when the game closes`);
      this.tell('autoAdvancedPausedForGame', { program: game });
    } finally { this.guarding = false; }
  }

  /* The user started protection: Advanced mode comes back if it was running
   * when they stopped it. */
  started() { return this.queue(() => this.comeBack()); }

  async comeBack() {
    if (!this.resume || this.active() || !this.protectionOn()) return;
    const since = this.stops;
    this.resume = false;
    // As for the autopilot: never loaded by itself beside a game's anti-cheat.
    let ac = null;
    try { ac = await this.antiCheat(); } catch {}
    // Stopped again meanwhile: nothing is asked; the next Start tries again.
    if (!this.current(since)) { this.resume = true; return; }
    if (ac) { this.log('info', `Advanced mode was on when protection was stopped, but a game's anti-cheat is running (${ac}); not started by itself`); return; }
    this.log('info', 'Advanced mode was on when protection was stopped; turning it back on');
    const r = await this.run(since);
    if (r && r.code === 'declined') this.declined();
  }

  /* Start Advanced mode on protection's behalf, for session `since`. Resolves
   * as opts.start does, or { success: false, code: 'protection_off' } when
   * protection was stopped before it came up. */
  start(since) { return this.queue(() => this.run(since)); }

  async run(since) {
    if (!this.current(since)) return { success: false, code: 'protection_off' };
    // Never two permission prompts at once; a Stop while waiting still wins.
    await this.ready();
    if (!this.current(since)) return { success: false, code: 'protection_off' };
    const r = await this.startBackend();
    // Already running: the user's own start from Settings, left alone.
    if (r && r.success && !r.alreadyActive && !this.current(since)) {
      this.log('info', 'Protection was stopped while Advanced mode was starting; Advanced mode is off again and comes back when protection is started');
      try { await this.stopBackend(); } catch {}
      this.resume = true;
      return { success: false, code: 'protection_off' };
    }
    return r;
  }

  queue(fn) {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

module.exports = AdvancedProtection;
