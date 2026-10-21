'use strict';

/*
 * Roblox's programs that go around Shroudly while this network blocks
 * Roblox, and what is done about them. main.js gives it what it needs (the
 * process list, the engine, the autopilot's verdict, how to start things);
 * everything here is decided by the rules below and a clock it is handed, so
 * the tests can run it, timings included.
 *
 * Roblox reads HTTPS_PROXY once, when it starts, from whoever started it. A
 * program of Roblox's goes around Shroudly when it started without it:
 *  - it was open before the mode came on (any system);
 *  - Windows: it started before the setting was in place (its own start
 *    time says so), or since then from something with an older environment
 *    (a browser that was open before, a script or a cafe's launcher started
 *    at login before Shroudly): no request from Roblox has reached Shroudly
 *    since it started, and it has run for QUIET_MS. Installers ask for
 *    Roblox's settings in their first second, players in their first
 *    seconds; one that goes through Shroudly has been seen asking long
 *    before then.
 * A program that sent a request since it started is never touched, however
 * long it then runs (a player in a game keeps its connections open), and
 * neither is one Shroudly started itself.
 *
 * Installers and the player are started again through Shroudly (nothing in
 * them is the user's, and they were not reaching Roblox anyway); Studio,
 * which may hold work that is not saved, is never closed: the user is told.
 * Each process is dealt with once; a player that still does not get through
 * after two restarts in ten minutes is left to Advanced mode. Acted on only
 * with protection on and where the autopilot found Roblox blocked.
 *
 * How often it looks: every FAST_MS while a program is being judged, and for
 * WARM_MS after the mode, protection or the verdict comes (a script that
 * starts the installer at login); every IDLE_MS on Windows while there is
 * something to act on (Roblox blocked, the mode on); else every SLOW_MS. One
 * process listing each time. Whatever makes acting possible looks at once.
 */

const { decide } = require('./roblox-app');

const QUIET_MS = { installer: 6000, player: 8000, studio: 8000 };
const FAST_MS = 2000;
const IDLE_MS = 5000;
const SLOW_MS = 20000;
const WARM_MS = 60000;
// Its start time, asked of PowerShell, is waited for at most this long
// (a cold PowerShell takes 20 s on a slow machine); it is judged without
// it after that.
const INFO_WAIT_MS = 10000;
// Its file (an installer is started again from it) is waited for this long
// before it is stopped anyway and the current installer downloaded instead.
const PATH_WAIT_MS = 60000;

/* One process: 'around', 'through' or 'waiting' (not known yet).
 *   p    { role: 'installer' | 'player' | 'studio', firstSeen, after (the
 *        look before the one that first saw it, null if none), startedAt
 *        (its own start time, null until read), probing (being read) }
 *   ctx  { lastRequestAt (Roblox's last request through Shroudly, 0: none),
 *        now, setAt (when the setting was put in place, 0: not known) }
 * The window it can have started in is the clock Shroudly reads: after
 * `after`, by `firstSeen`. Its own start time narrows that, held inside it
 * should the clock have been set in between. */
function startOf(p) {
  if (p.startedAt == null) return null;
  return Math.min(Math.max(p.startedAt, p.after == null ? -Infinity : p.after), p.firstSeen);
}

function judge(p, ctx) {
  const { lastRequestAt = 0, now, setAt = 0 } = ctx;
  const start = startOf(p);
  // Started before the setting was there: it cannot have it.
  if (start != null && setAt && start < setAt) return 'around';
  let since = start != null ? start : p.after;
  if (since == null) {
    // Seen on the first look: its start time is on its way. Not for long:
    // without it, any request from Roblox at all spares it.
    if (p.probing && now - p.firstSeen < INFO_WAIT_MS) return 'waiting';
    since = 0;
  }
  // A request from Roblox since it can have started: it, or another program
  // of Roblox's, uses Shroudly. Either way nothing is touched.
  if (lastRequestAt && lastRequestAt >= since) return 'through';
  const age = now - (start != null ? start : p.firstSeen);
  return age >= (QUIET_MS[p.role] || QUIET_MS.player) ? 'around' : 'waiting';
}

/* When a process still waiting would be judged around Shroudly if it stays
 * silent: the next look is made then, not up to a whole look later. */
function dueAt(p) {
  const start = startOf(p);
  return (start != null ? start : p.firstSeen) + (QUIET_MS[p.role] || QUIET_MS.player);
}

/* How long until the next look. `due`: ms until a waiting process falls due
 * (Infinity: none). */
function pollDelay({ on, watched, active, blocked, warm, pending, due = Infinity }) {
  if (!on) return SLOW_MS;
  if (watched && pending) return Math.max(50, Math.min(FAST_MS, due));
  if (watched && warm) return FAST_MS;
  if (watched && active && blocked) return IDLE_MS;
  return SLOW_MS;
}

class RobloxWatch {
  /*
   * d.now()                    the clock
   * d.setTimeout(fn, ms) / d.clearTimeout(h)
   * d.watched                  programs can go around Shroudly here (Windows)
   * d.on()                     the mode is on and its proxy runs
   * d.active()                 protection is on
   * d.blocked()                the autopilot found Roblox blocked here
   * d.stillBlocked()           ... and still so right now (Promise)
   * d.checkSoon()              ask the autopilot to find out, if it does not know
   * d.lastRequestAt()          Roblox's last request through Shroudly
   * d.list()                   { players, studios, installers: { player, studio } } or null
   * d.info(pids)               Map pid -> { startedAt, path } (Windows), optional
   * d.prepare()                get what d.info and d.signed need ready (Windows), optional
   * d.signed(path, kind)       its content's hash if Roblox's signed installer, else null
   * d.same(path, hash)         still that content
   * d.kill(pids), d.startInstaller(path) -> pid, d.install(kind) -> { success, pid },
   * d.restart(pids) -> pid     what is done
   * d.log(level, msg), d.tell(id), d.needAdvanced(), d.studioReopen(at)
   */
  constructor(d) {
    this.d = d;
    this.procs = new Map();     // pid -> what is known of it (judge)
    this.listedAt = null;       // the last look
    this.before = new Set();    // open when the mode came on
    this.setAt = 0;             // when the setting was put in place
    this.handled = new Set();   // restarted or told about
    this.claimed = new Set();   // being seen to right now
    this.jobs = new Set();      // what is being done (never waited for by a look)
    this.ours = new Set();      // started by Shroudly, with the setting
    this.studioTold = new Map();// Studio pid -> when the user was asked to reopen it
    this.restarts = [];         // when the player was restarted
    this.warmUntil = 0;
    this.gen = 0;               // the mode came on or went off: a look under way is stale
    this.busy = false;
    this.again = false;
    this.timer = null;
    this.running = false;
  }

  // ── what main.js tells it ──────────────────────────────────────────────

  /* The setting was just put in place, at `at`; `list` is what was open
   * then (null if it could not be read). */
  modeOn(list, at) {
    this.gen++;
    this.setAt = at;
    this.before = new Set(list ? [...list.players, ...list.studios, ...list.installers.player, ...list.installers.studio] : []);
    if (list) this.observe(list, this.d.now());
    this.warm();
  }

  /* The mode went off: nothing from before counts any more. */
  modeOff() {
    this.gen++;
    this._reset();
    this.before.clear();
    this.setAt = 0;
  }

  /* Programs may be about to start, or acting just became possible: look
   * often for a while, starting now. */
  warm() {
    this.warmUntil = Math.max(this.warmUntil, this.d.now() + WARM_MS);
    if (this.d.watched && this.d.prepare && this.d.on()) { try { this.d.prepare(); } catch {} }
    this.poke();
  }

  /* Everything under way done (tests). */
  async idle() { while (this.jobs.size) await Promise.all([...this.jobs]); }

  /* Look now (or right after the look under way). */
  poke() {
    if (!this.running) return;
    if (this.busy) { this.again = true; return; }
    this._schedule(0);
  }

  start() { this.running = true; this._schedule(SLOW_MS); }
  stop() { this.running = false; if (this.timer) this.d.clearTimeout(this.timer); this.timer = null; }

  // ── one look ───────────────────────────────────────────────────────────

  async tick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do { this.again = false; await this._tick(); } while (this.again);
    } finally { this.busy = false; }
  }

  delay() {
    const d = this.d;
    const now = d.now();
    const due = this.due(now);
    return pollDelay({
      on: d.on(), watched: d.watched, active: d.active(), blocked: d.blocked(),
      warm: now < this.warmUntil, pending: due !== null, due: due === null ? Infinity : due - now,
    });
  }

  /* When the first program still being judged falls due (null: none is). */
  due(now = this.d.now()) {
    if (!this.d.watched) return null;
    const ctx = this._ctx(now);
    let first = null;
    for (const p of this.procs.values()) {
      if (this.handled.has(p.pid) || this.ours.has(p.pid) || this.before.has(p.pid) || this.claimed.has(p.pid)) continue;
      if (judge(p, ctx) !== 'waiting') continue;
      const at = p.probing && p.after == null && now - p.firstSeen < INFO_WAIT_MS
        ? Math.min(now + FAST_MS, p.firstSeen + INFO_WAIT_MS) : dueAt(p);
      if (first === null || at < first) first = at;
    }
    return first;
  }

  /* A program still being judged. */
  pending(now = this.d.now()) { return this.due(now) !== null; }

  /* The ones found going around Shroudly by the rules above (Windows). */
  quiet(now = this.d.now()) {
    if (!this.d.watched) return [];
    const ctx = this._ctx(now);
    return [...this.procs.values()]
      .filter((p) => !this.ours.has(p.pid) && judge(p, ctx) === 'around')
      .map((p) => p.pid);
  }

  _ctx(now) { return { lastRequestAt: this.d.lastRequestAt() || 0, now, setAt: this.setAt }; }

  _schedule(ms) {
    if (this.timer) this.d.clearTimeout(this.timer);
    this.timer = this.d.setTimeout(() => this._run(), ms);
  }

  async _run() {
    this.timer = null;
    try { await this.tick(); } catch {}
    if (this.running && !this.timer) this._schedule(this.delay());
  }

  _reset() {
    this.procs.clear();
    this.listedAt = null;
    this.handled.clear();
    this.ours.clear();
    this.studioTold.clear();
    this.d.studioReopen(0);
  }

  /* Who is there now: the ones that ended are forgotten, new ones noted
   * with the look before (the earliest they can have started). */
  observe(list, now) {
    const roles = [
      ...list.players.map((pid) => [pid, 'player', 'player']),
      ...list.studios.map((pid) => [pid, 'studio', 'studio']),
      ...list.installers.player.map((pid) => [pid, 'installer', 'player']),
      ...list.installers.studio.map((pid) => [pid, 'installer', 'studio']),
    ];
    const live = new Set(roles.map((r) => r[0]));
    for (const pid of [...this.procs.keys()]) if (!live.has(pid)) this.procs.delete(pid);
    for (const set of [this.handled, this.before, this.ours]) for (const pid of [...set]) if (!live.has(pid)) set.delete(pid);
    for (const [pid, role, kind] of roles) {
      if (!this.procs.has(pid)) this.procs.set(pid, { pid, role, kind, firstSeen: now, after: this.listedAt, startedAt: null, probing: false, probed: false, path: null, file: null });
    }
    this.listedAt = now;
  }

  /* Windows: each new program's start time and file, read once, at once;
   * for an installer, whether its file is Roblox's signed one is asked as
   * soon as the file is known, so the answer is in by the time it is judged. */
  _probe() {
    const d = this.d;
    if (!d.info) return;
    const want = [...this.procs.values()].filter((p) => !p.probing && !p.probed && !this.handled.has(p.pid) && !this.ours.has(p.pid));
    if (!want.length) return;
    for (const p of want) p.probing = true;
    const done = (m) => {
      for (const p of want) {
        const i = m && m.get(p.pid);
        p.probing = false;
        p.probed = true;
        if (i) { p.startedAt = i.startedAt == null ? null : i.startedAt; p.path = i.path || null; }
        if (p.role === 'installer' && (this.before.has(p.pid) || judge(p, this._ctx(d.now())) !== 'through')) this._check(p);
      }
      // Its start time may decide it: no need to wait for the next look.
      this.poke();
    };
    const asked = Promise.resolve().then(() => d.info(want.map((p) => p.pid))).then(done, () => done(null));
    for (const p of want) p.info = asked;
  }

  /* `promise`, or undefined once `ms` have passed. */
  _within(promise, ms) {
    return new Promise((resolve) => {
      const h = this.d.setTimeout(() => resolve(undefined), ms);
      Promise.resolve(promise).then((v) => { this.d.clearTimeout(h); resolve(v); }, () => { this.d.clearTimeout(h); resolve(undefined); });
    });
  }

  _job(promise) {
    const p = Promise.resolve(promise).catch(() => {});
    this.jobs.add(p);
    p.then(() => this.jobs.delete(p));
    return p;
  }

  _check(p) {
    if (p.file || !p.path) return;
    p.file = Promise.resolve().then(() => this.d.signed(p.path, p.kind)).catch(() => null);
  }

  async _tick() {
    const d = this.d;
    if (!d.on()) { this._reset(); return; }
    const gen = this.gen;
    const list = await d.list();
    // The list could not be read: nothing is taken for gone.
    if (!list || gen !== this.gen) return;
    const now = d.now();
    this.observe(list, now);
    // The line about Studio stays while a Studio the user was asked about
    // still runs (the window shows it while protection is on).
    for (const pid of [...this.studioTold.keys()]) if (!list.studios.includes(pid)) this.studioTold.delete(pid);
    d.studioReopen(this.studioTold.size ? Math.max(...this.studioTold.values()) : 0);
    if (!d.active()) return;
    if (d.watched) this._probe();
    const dec = decide({
      players: list.players, studios: list.studios, installers: list.installers,
      quiet: this.quiet(now), before: [...this.before],
      handled: [...this.handled, ...this.ours, ...this.claimed], restarts: this.restarts, now,
    });
    const something = dec.installers.player.length || dec.installers.studio.length || dec.restartPlayers.length || dec.stuckPlayers.length || dec.tellStudios.length;
    if (!something) return;
    // Only where Roblox is blocked: not known yet, it is found out now (the
    // verdict, when it comes, looks again at once).
    if (!d.blocked()) { d.checkSoon(); return; }
    // Seen to apart from the looks, which go on meanwhile: a signature check
    // that takes 20 s, or a file still being asked for, holds up nothing else.
    const mine = [...dec.installers.player, ...dec.installers.studio, ...dec.restartPlayers, ...dec.stuckPlayers, ...dec.tellStudios];
    mine.forEach((pid) => this.claimed.add(pid));
    this._job(this._act(dec, gen)).then(() => mine.forEach((pid) => this.claimed.delete(pid)));
  }

  async _act(dec, gen) {
    const d = this.d;
    // Before touching a program: still blocked right now (checked again if
    // the verdict is not fresh)?
    if (!(await d.stillBlocked()) || gen !== this.gen) return;
    const jobs = ['player', 'studio'].filter((kind) => dec.installers[kind].length).map((kind) => this._replace(kind, dec.installers[kind], gen));

    if (dec.restartPlayers.length) {
      dec.restartPlayers.forEach((pid) => this.handled.add(pid));
      jobs.push((async () => {
        const pid = await d.restart(dec.restartPlayers);
        if (!pid) return;
        if (Number.isInteger(pid)) this.ours.add(pid);
        this.restarts.push(d.now());
        d.log('success', 'Autopilot: Roblox did not get through Shroudly; restarted it');
        d.tell('autoRobloxRestarted');
      })());
    }
    if (dec.stuckPlayers.length) {
      dec.stuckPlayers.forEach((pid) => this.handled.add(pid));
      d.log('warning', 'Autopilot: Roblox still does not get through after being restarted through Shroudly');
      d.needAdvanced();
    }

    if (dec.tellStudios.length) {
      const at = d.now();
      dec.tellStudios.forEach((pid) => { this.handled.add(pid); this.studioTold.set(pid, at); });
      d.log('warning', 'Autopilot: Roblox Studio was opened before Shroudly could take it through; the user was asked to reopen it');
      d.tell('autoStudioReopen');
      d.studioReopen(at);
    }
    await Promise.all(jobs);
  }

  /* An installer around Shroudly, stopped and started again through it:
   * from its own file when that is Roblox's, signed by Roblox (known as soon
   * as the check that began when it was first seen ends), else the current
   * one fetched through the engine. Never an unsigned file. */
  async _replace(kind, ids, gen) {
    const d = this.d;
    // Asked again right before: a pid seen a while ago may have ended and
    // been given to another program since.
    const fresh = await d.list();
    const still = fresh ? ids.filter((pid) => fresh.installers[kind].includes(pid)) : [];
    ids.forEach((pid) => this.handled.add(pid));
    if (!still.length || gen !== this.gen) return;
    const p = this.procs.get(still[0]) || { pid: still[0], kind, role: 'installer', path: null, file: null };
    // Its file goes with the process: waited for while it runs (PowerShell
    // may still be starting), asked once more if the first answer had none.
    if (!p.path && d.info) {
      if (p.probing && p.info) await this._within(p.info, PATH_WAIT_MS);
      if (!p.path) {
        const m = await this._within(Promise.resolve().then(() => d.info([p.pid])), PATH_WAIT_MS);
        const i = m && m.get && m.get(p.pid);
        if (i && i.path) p.path = i.path;
      }
    }
    if (gen !== this.gen) return;
    this._check(p);
    // Stopped while its file is still being checked; started again the
    // moment the check ends.
    const [, hash] = await Promise.all([d.kill(still), p.file || null]);
    if (gen !== this.gen) return;
    let pid = false;
    if (hash && await d.same(p.path, hash)) pid = d.startInstaller(p.path);
    else {
      // Not Roblox's own signed installer (or its file could not be read):
      // the current one, fetched through the engine.
      const r = await d.install(kind);
      pid = r && r.success ? (r.pid || true) : false;
    }
    if (!pid) return;
    if (Number.isInteger(pid)) this.ours.add(pid);
    d.log('success', 'Autopilot: a Roblox installer went around Shroudly; started it again through Shroudly');
    d.tell('autoInstallerRestarted');
  }
}

module.exports = { RobloxWatch, judge, dueAt, pollDelay, QUIET_MS, FAST_MS, IDLE_MS, SLOW_MS, WARM_MS, INFO_WAIT_MS, PATH_WAIT_MS };
