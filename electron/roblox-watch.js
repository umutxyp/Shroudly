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
 *    Roblox's settings in their first second; players can take a while to
 *    load on a slow PC, so they get longer. Silence from before this
 *    Shroudly could see requests (it was restarted) is not counted.
 * A program that sent a request since it started is never touched, however
 * long it then runs (a player in a game keeps its connections open), and
 * neither is one Shroudly started itself.
 *
 * Installers and the player are started again through Shroudly (nothing in
 * them is the user's, and they were not reaching Roblox anyway); Studio,
 * which may hold work that is not saved, is never closed: the user is told.
 * A program is only ever stopped when Shroudly can make sure, right before,
 * that it is the very program that was judged (its start time and file, read
 * from Windows), and when what replaces it is in hand: the installer's own
 * file signed by Roblox, or the current one downloaded and found signed;
 * Roblox to open again. Otherwise (PowerShell missing, blocked or restricted,
 * a program of another user's or an administrator's, no replacement, a stop
 * that did not work) it is left running and the user is asked to start it
 * again. Each process is dealt with once; a player that still does not get
 * through after two restarts in ten minutes is left to Advanced mode. Acted on
 * only with protection on and where the autopilot found Roblox blocked;
 * stopping protection, or quitting, stops what is under way.
 *
 * How often it looks: every FAST_MS while a program is being judged, and for
 * WARM_MS after the mode, protection or the verdict comes (a script that
 * starts the installer at login); every IDLE_MS on Windows while there is
 * something to act on (Roblox blocked, the mode on); else every SLOW_MS. One
 * process listing each time. Whatever makes acting possible looks at once.
 */

const { decide } = require('./roblox-app');

const QUIET_MS = { installer: 6000, player: 25000, studio: 25000 };
const FAST_MS = 2000;
const IDLE_MS = 5000;
const SLOW_MS = 20000;
const WARM_MS = 60000;
// Its start time, asked of PowerShell, is waited for at most this long
// (a cold PowerShell takes 20 s on a slow machine); it is judged without
// it after that.
const INFO_WAIT_MS = 10000;
// Before anything is done about it, its start time and file are waited for
// this long (asked once more if the first answer had none).
const PATH_WAIT_MS = 60000;
// A start time read for a process id is only taken as that process's when
// it fits the window it was seen to start in (this much slack for clocks).
const START_SLACK_MS = 2000;
// The same line to the user at most this often.
const TELL_EVERY_MS = 2 * 60 * 1000;

/* One process: 'around', 'through' or 'waiting' (not known yet).
 *   p    { role: 'installer' | 'player' | 'studio', firstSeen, after (when
 *        the look before the one that first saw it was asked, null if none),
 *        startedAt (its own start time, null until read), probing (being
 *        read) }
 *   ctx  { lastRequestAt (Roblox's last request through Shroudly, 0: none),
 *        now, setAt (when the setting was put in place, 0: not used), from
 *        (since when this Shroudly sees requests, null: not known) }
 * The window it can have started in is the clock Shroudly reads: after
 * `after`, by `firstSeen`. Its own start time narrows that, held inside it
 * should the clock have been set in between. */
function startOf(p) {
  if (p.startedAt == null) return null;
  return Math.min(Math.max(p.startedAt, p.after == null ? -Infinity : p.after), p.firstSeen);
}

/* From when its silence counts: since it started, but not from before this
 * Shroudly could see requests (a Shroudly restarted after a crash knows
 * nothing of the requests made before). */
function originOf(p, from) {
  const start = startOf(p);
  const o = start != null ? start : p.firstSeen;
  return from != null ? Math.max(o, from) : o;
}

function judge(p, ctx) {
  const { lastRequestAt = 0, now, setAt = 0, from = null } = ctx;
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
  const age = now - originOf(p, from);
  return age >= (QUIET_MS[p.role] || QUIET_MS.player) ? 'around' : 'waiting';
}

/* When a process still waiting would be judged around Shroudly if it stays
 * silent: the next look is made then, not up to a whole look later. */
function dueAt(p, from = null) {
  return originOf(p, from) + (QUIET_MS[p.role] || QUIET_MS.player);
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
   * d.info(pids)               Map pid -> { startedAt, path } (Windows), optional;
   *                            its `answered` is false when PowerShell gave no answer,
   *                            its `restricted` names a PowerShell that may not be
   *                            relied on here (ConstrainedLanguage)
   * d.prepare()                get what d.info and d.signed need ready (Windows), optional
   * d.signed(path, kind)       its content's hash if Roblox's signed installer, else null
   * d.same(path, hash)         still that content
   * d.fetch(kind)              the current installer, downloaded through the engine and
   *                            found signed by Roblox, not started: { success, file, hash, code }
   * d.kill(pids) -> stopped    d.startInstaller(path) -> pid, d.startFetched(r) -> pid
   * d.restart(pids)            quit these players and open Roblox again:
   *                            { success, pid } or { success: false, code }
   * d.log(level, msg), d.tell(id), d.needAdvanced(), d.studioReopen(at)
   */
  constructor(d) {
    this.d = d;
    this.procs = new Map();     // pid -> what is known of it (judge)
    this.listedAt = null;       // when the last look was asked for
    this.from = null;           // since when requests are seen (the first look with the mode on)
    this.before = new Set();    // open when the mode came on
    this.setAt = 0;             // when the setting was put in place (only used if what was open then is not known)
    this.handled = new Set();   // restarted or told about
    this.claimed = new Set();   // being seen to right now
    this.jobs = new Set();      // what is being done (never waited for by a look)
    this.ours = new Set();      // started by Shroudly, with the setting
    this.studioTold = new Map();// Studio pid -> when the user was asked to reopen it
    this.toldAt = new Map();    // line -> when the user was last told it
    this.restarts = [];         // when the player was restarted
    this.warmUntil = 0;
    this.gen = 0;               // the mode, or protection, went off: what is under way is stale
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
    // Every program that started before the setting and still runs is in
    // `list`, so `before` covers it; the start time against the setting is
    // only needed when the list could not be read (and is never trusted
    // across a clock set back: observe).
    this.setAt = list ? 0 : at;
    if (this.from == null) this.from = at;
    this.before = new Set(list ? [...list.players, ...list.studios, ...list.installers.player, ...list.installers.studio] : []);
    if (list) this.observe(list, this.d.now(), at);
    this.warm();
  }

  /* The mode went off: nothing from before counts any more. */
  modeOff() {
    this.gen++;
    this._reset();
    this.before.clear();
    this.setAt = 0;
  }

  /* Protection stopped, or Shroudly quits: nothing under way is stopped or
   * started any more (what was not dealt with is judged again once
   * protection is back). */
  halt() { this.gen++; }

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
        ? Math.min(now + FAST_MS, p.firstSeen + INFO_WAIT_MS) : dueAt(p, this.from);
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

  _ctx(now) { return { lastRequestAt: this.d.lastRequestAt() || 0, now, setAt: this.setAt, from: this.from }; }

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
    this.from = null;
    this.handled.clear();
    this.ours.clear();
    this.studioTold.clear();
    this.d.studioReopen(0);
  }

  /* Who is there now (`list`, read between `asked` and `now`): the ones that
   * ended are forgotten, new ones noted with when the look before was asked
   * for (the earliest they can have started: a listing is taken somewhere
   * between being asked for and returning). */
  observe(list, now, asked = now) {
    // The clock was set back: the setting's time, and when the look before
    // was asked, say nothing any more.
    const back = this.listedAt != null && asked < this.listedAt;
    if (this.setAt && (now < this.setAt || back)) this.setAt = 0;
    const after = back ? null : this.listedAt;
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
      if (!this.procs.has(pid)) this.procs.set(pid, { pid, role, kind, firstSeen: now, after, startedAt: null, probing: false, probed: false, path: null, file: null, why: null, gone: false });
    }
    this.listedAt = asked;
  }

  /* What Windows says of a process, taken only if it is the process that
   * was listed: one that started after it was first seen is another that got
   * its id since. */
  _take(p, m) {
    // An administrator restricted PowerShell here (AppLocker, Device Guard):
    // nothing it says is acted on.
    if (m && m.restricted) { p.why = `PowerShell is restricted here (${m.restricted})`; return; }
    const i = m && m.get && m.get(p.pid);
    if (!i) { if (!p.why) p.why = m && m.get && m.answered !== false ? 'Windows did not say when it started' : 'PowerShell did not answer'; return; }
    if (i.startedAt == null) { p.why = 'it runs as another user or as administrator'; return; }
    // Started after it was first seen: it ended, and its process id went to
    // another program, which has nothing to do with it.
    if (i.startedAt > p.firstSeen + START_SLACK_MS) { p.gone = true; return; }
    p.startedAt = i.startedAt;
    p.path = i.path || null;
    p.why = null;
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
        p.probing = false;
        p.probed = true;
        this._take(p, m);
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

  /* Still allowed to touch anything: the same mode, protection on. */
  _may(gen) { const d = this.d; return gen === this.gen && !!d.on() && !!d.active(); }

  async _tick() {
    const d = this.d;
    if (!d.on()) { this._reset(); return; }
    const gen = this.gen;
    const asked = d.now();
    const list = await d.list();
    // The list could not be read: nothing is taken for gone.
    if (!list || gen !== this.gen) return;
    const now = d.now();
    // Requests are seen from now on (a Shroudly restarted after a crash).
    if (this.from == null) this.from = asked;
    this.observe(list, now, asked);
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
    if (!(await d.stillBlocked()) || !this._may(gen)) return;
    const jobs = ['player', 'studio'].filter((kind) => dec.installers[kind].length).map((kind) => this._replace(kind, dec.installers[kind], gen));
    if (dec.restartPlayers.length) jobs.push(this._restartPlayers(dec.restartPlayers, gen));
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

  _proc(pid, role, kind) {
    return this.procs.get(pid) || { pid, role, kind, firstSeen: this.d.now(), after: null, startedAt: null, path: null, file: null, why: 'it ended' };
  }

  /* Windows: its start time and file, waited for while PowerShell answers
   * (it may still be starting), asked once more if the first answer had
   * none. Without them it could not be told apart from a program that got
   * its process id later, so it is never stopped. */
  async _known(p) {
    const d = this.d;
    if (!d.info || p.startedAt != null || p.gone) return;
    if (p.probing && p.info) await this._within(p.info, PATH_WAIT_MS);
    if (p.startedAt != null || p.gone || /restricted/.test(p.why || '')) return;
    const m = await this._within(Promise.resolve().then(() => d.info([p.pid])), PATH_WAIT_MS);
    this._take(p, m);
  }

  /* Which of these are, right now, the very programs that were judged: still
   * listed under the same name, and where Windows is asked (d.info), with
   * the same start time and file. One that ended meanwhile may have left
   * its process id to another program, which is never touched. null when
   * that could not be found out. */
  async _verify(ps) {
    const d = this.d;
    const fresh = await d.list();
    if (!fresh) return null;
    const listed = (p) => (p.role === 'player' ? fresh.players : p.role === 'studio' ? fresh.studios : fresh.installers[p.kind]).includes(p.pid);
    const live = ps.filter(listed);
    if (!live.length || !d.info) return live;
    const m = await this._within(Promise.resolve().then(() => d.info(live.map((p) => p.pid))), PATH_WAIT_MS);
    if (!m || !m.get || m.restricted || m.answered === false) return null;
    return live.filter((p) => {
      const i = m.get(p.pid);
      return !!i && p.startedAt != null && i.startedAt === p.startedAt && (i.path || null) === (p.path || null);
    });
  }

  /* It goes around Shroudly, and Shroudly cannot make sure that stopping it
   * is safe and that it can be started again: it is left running, and the
   * user is asked to close it and start it again. */
  _leave(ps, role, why) {
    if (!ps.length) return;
    const d = this.d;
    ps.forEach((p) => this.handled.add(p.pid));
    if (role === 'installer') d.log('warning', `Autopilot: a Roblox installer went around Shroudly; it was left running (${why}) and the user was asked to start it again`);
    else d.log('warning', `Autopilot: Roblox went around Shroudly; it was left running (${why}) and the user was asked to open it again`);
    const id = role === 'installer' ? 'autoInstallerAround' : 'autoRobloxAround';
    const now = d.now();
    if (now - (this.toldAt.has(id) ? this.toldAt.get(id) : -Infinity) < TELL_EVERY_MS) return;
    this.toldAt.set(id, now);
    d.tell(id);
  }

  /* Installers around Shroudly, stopped and started again through it:
   * from their own file when that is Roblox's, signed by Roblox (known as
   * soon as the check that began when it was first seen ends), else the
   * current one fetched through the engine. The replacement is in hand
   * before anything is stopped. Never an unsigned file. */
  async _replace(kind, ids, gen) {
    const d = this.d;
    const ps = ids.map((pid) => this._proc(pid, 'installer', kind));
    await Promise.all(ps.map((p) => this._known(p)));
    if (!this._may(gen)) return;
    ps.filter((p) => p.gone).forEach((p) => this.handled.add(p.pid));
    const known = d.info ? ps.filter((p) => p.startedAt != null && !p.gone) : ps;
    this._leave(ps.filter((p) => !known.includes(p) && !p.gone), 'installer', ps.map((p) => p.why).find(Boolean) || 'its start time is not known');
    if (!known.length) return;

    // What starts in its place: its own file, when that is Roblox's signed
    // installer and still the content that was checked ...
    let own = null;
    for (const p of known) {
      this._check(p);
      const hash = await (p.file || null);
      if (hash && await d.same(p.path, hash)) { own = { file: p.path, hash }; break; }
    }
    if (!this._may(gen)) return;
    // ... else the current one, downloaded through the engine and found
    // signed by Roblox (not started yet).
    let fetched = null;
    if (!own) {
      fetched = await Promise.resolve().then(() => d.fetch(kind)).catch((e) => ({ success: false, code: e.message }));
      if (!this._may(gen)) return;
      if (!fetched || !fetched.success) { this._leave(known, 'installer', `no installer to start in its place: ${(fetched && (fetched.detail || fetched.code)) || 'failed'}`); return; }
    }

    const live = await this._verify(known);
    if (!this._may(gen)) return;
    if (!live) { this._leave(known, 'installer', 'it could not be checked again right before'); return; }
    known.forEach((p) => this.handled.add(p.pid));
    // Ended by itself meanwhile: there is nothing to start again.
    if (!live.length) return;
    if (!(await d.kill(live.map((p) => p.pid)))) { this._leave(live, 'installer', 'it could not be stopped'); return; }
    let pid = false;
    if (own && await d.same(own.file, own.hash)) pid = await d.startInstaller(own.file);
    else if (own && this._may(gen)) {
      // Changed after it was stopped: the current one instead.
      fetched = await Promise.resolve().then(() => d.fetch(kind)).catch(() => null);
    }
    if (!pid && fetched && fetched.success) pid = await d.startFetched(fetched);
    if (!pid) { d.log('error', 'Autopilot: a Roblox installer went around Shroudly and was stopped, but the one to start in its place could not be started'); return; }
    if (Number.isInteger(pid)) this.ours.add(pid);
    d.log('success', 'Autopilot: a Roblox installer went around Shroudly; started it again through Shroudly');
    d.tell('autoInstallerRestarted');
  }

  /* Players around Shroudly, quit and opened again through it, the ones
   * still found around it right before (a first request that came late
   * spares it). */
  async _restartPlayers(ids, gen) {
    const d = this.d;
    const ps = ids.map((pid) => this._proc(pid, 'player', 'player'));
    await Promise.all(ps.map((p) => this._known(p)));
    if (!this._may(gen)) return;
    const ctx = this._ctx(d.now());
    ps.filter((p) => p.gone).forEach((p) => this.handled.add(p.pid));
    const still = ps.filter((p) => !p.gone && (this.before.has(p.pid) || judge(p, ctx) === 'around'));
    const known = d.info ? still.filter((p) => p.startedAt != null) : still;
    this._leave(still.filter((p) => !known.includes(p)), 'player', still.map((p) => p.why).find(Boolean) || 'its start time is not known');
    if (!known.length) return;
    const live = await this._verify(known);
    if (!this._may(gen)) return;
    if (!live) { this._leave(known, 'player', 'it could not be checked again right before'); return; }
    known.forEach((p) => this.handled.add(p.pid));
    if (!live.length) return;
    const r = await d.restart(live.map((p) => p.pid));
    if (!r || !r.success) {
      if (r && r.code === 'notstopped') this._leave(live, 'player', 'it could not be stopped');
      else if (r && r.code === 'nolauncher') this._leave(live, 'player', 'Roblox was not found to open again');
      return;
    }
    if (Number.isInteger(r.pid)) this.ours.add(r.pid);
    this.restarts.push(d.now());
    d.log('success', 'Autopilot: Roblox did not get through Shroudly; restarted it');
    d.tell('autoRobloxRestarted');
  }
}

module.exports = { RobloxWatch, judge, dueAt, pollDelay, QUIET_MS, FAST_MS, IDLE_MS, SLOW_MS, WARM_MS, INFO_WAIT_MS, PATH_WAIT_MS, TELL_EVERY_MS };
