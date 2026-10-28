'use strict';

/*
 * Autopilot: what Shroudly turns on by itself.
 *
 * The people who use Shroudly do not open its settings or read its banners:
 * when something does not work, the app "is broken". So whenever Shroudly can
 * tell what stands in the way, it does what the user would otherwise have had
 * to do, and then says what it did, in one line (a notification and a line in
 * the window). The switches in Settings stay for whoever wants them; one the
 * user turns off by hand stays off for two weeks, after which the autopilot
 * may turn it on again if the same problem comes back.
 *
 * Services an app needs (Discord, Roblox): whether this network blocks one is
 * decided by a check of its own (blockcheck.js: the system's DNS and a direct
 * handshake fail where the same name works through Shroudly), made when
 * protection is on and the app is installed, so the mode is on before the app
 * is opened, and made again whenever the engine reports something about one
 * of the service's own names (a name that needed a technique, that no
 * technique opened, or that the engine believes is cut after it connects).
 * An engine event alone never decides it: one stalled connection on bad
 * Wi-Fi looks the same as a filter. What is learnt is looked at again after a
 * few hours and forgotten when the network changes. Then the service's mode
 * is turned on; what follows from it (restarting a program stuck around
 * Shroudly) is the caller's, which knows each program (main.js).
 *
 * Advanced mode: a site that no technique opens, or that connects and is then
 * cut, is the network Advanced mode is for. So is Discord, once this network
 * is known to block it, when its app is open and the engine cannot get its
 * page or its gateway through (the app then sits on its "Starting" screen),
 * or when a call is starting (the engine tells each connection under the
 * domain of Discord's voice servers, from the app or a browser, and a call
 * is one to a voice server's own name): the sound of a call
 * goes over UDP, which the default engine never touches, and only Advanced
 * mode can put its decoys ahead of it. So is a program that goes around
 * Shroudly (a bot, a command-line tool) and is stopped by this network
 * (around-watch.js finds it). It needs the system's permission, so
 * it is asked for at most once a session, not again by itself for two weeks
 * once the user declines, and never by itself while a game with an
 * anti-cheat is being played (antiCheatIn).
 */

const RESPECT_OFF_MS = 14 * 24 * 60 * 60 * 1000;
const CHECK_AGAIN_MS = 6 * 60 * 60 * 1000;
// How long a sign that a service needs Advanced mode waits for the check
// that says the service is blocked here.
const SIGN_MS = 10 * 60 * 1000;
const SOON_MS = 15 * 1000;
// Nothing learnt by a check (offline): how long before the next one.
const UNKNOWN_MS = 2 * 60 * 1000;
// Just after a wake the network is still coming back: a check then would
// see a direct connection fail for that alone, and call a service blocked.
const WAKE_QUIET_MS = 30 * 1000;

/* The services' own names: what the engine reports about them is worth a
 * check. Not the third parties they embed (GIFs, captchas, identity checks),
 * which say nothing about whether the service itself is blocked. */
const OWN = {
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordcdn.com',
    'discord.co', 'discord.app', 'discordstatus.com'],
  roblox: ['roblox.com', 'rbxcdn.com', 'rbxinfra.net', 'rbx.com', 'rblx.org', 'blox.com', 'rbxcdn.net', 'robloxcdn.com',
    'robloxlabs.com', 'rbxtrk.com'],
};

const under = (h, d) => h === d || h.endsWith(`.${d}`);
const norm = (host) => String(host || '').toLowerCase().replace(/\.$/, '');
function familyOf(host) {
  const h = norm(host);
  if (!h) return null;
  for (const [id, domains] of Object.entries(OWN)) if (domains.some((d) => under(h, d))) return id;
  return null;
}

/* What Advanced mode does for a service beyond any site: its voice servers,
 * and the names its app cannot start without (its own page and its
 * gateway). main.js asks the engine to tell each connection under `watch`;
 * of those, a call is one to a voice server (`call`): one server in one
 * region, handed to the client for that call, named after both
 * ("c-fra06-1a2b3c4d"; older ones "rotterdam1234", "us-east123"). Never the
 * names every open client fetches whether or not anyone calls:
 * latency.discord.media, which ranks the regions, or the domain itself. */
const ADVANCED = {
  discord: {
    watch: ['discord.media'],
    call: (h) => /^(c-[a-z]+\d+-[0-9a-f]+|[a-z]+(-[a-z]+)*-?\d+)\.discord\.media$/.test(h),
    core: (h) => h === 'discord.com' || h === 'www.discord.com' || /^gateway(-[a-z0-9-]+)?\.discord\.gg$/.test(h),
  },
};
function voiceOf(host) {
  const h = norm(host);
  for (const [id, a] of Object.entries(ADVANCED)) if (a.call(h)) return id;
  return null;
}

/* Hand-made choices from before the autopilot (2.5.9 and older): a mode the
 * user turned off, or an offer they put off with "Not now", are respected as
 * if the switch had just been turned off by hand. Done once. */
const LEGACY = [['discordMode', 'discordOfferDeclinedAt'], ['appMode', 'appOfferDeclinedAt']];
function migrate(store, now) {
  if (store.get('autopilotSince')) return;
  for (const [mode, declinedKey] of LEGACY) {
    const declined = Number(store.get(declinedKey, 0)) || 0;
    if (store.get(`${mode}OffAt`) == null) {
      if (store.get(mode) === false) store.set(`${mode}OffAt`, now);
      else if (declined && now - declined < RESPECT_OFF_MS) store.set(`${mode}OffAt`, declined);
    }
    store.delete(declinedKey);
  }
  store.set('autopilotSince', now);
}

/* Which networks this computer is on, as a string that changes only when
 * they do (main.js compares it every half minute): each IPv4 address with
 * its mask, each IPv6 /64. Not the addresses themselves: IPv6 privacy
 * addresses change daily on the same network. */
/* An IPv6 address written out in its eight groups ("fd00::1" has two). */
function ipv6Groups(addr) {
  const [head, tail] = String(addr).split('%')[0].split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
  return [...a, ...fill, ...b].map((g) => (parseInt(g, 16) || 0).toString(16));
}
function networkFingerprint(ifaces) {
  const nets = new Set();
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (!a || a.internal || /^fe80:/i.test(a.address) || /^169\.254\./.test(a.address)) continue;
      if (a.family === 'IPv4' || a.family === 4) nets.add(`${name} ${a.address}/${a.netmask}`);
      else nets.add(`${name} ${ipv6Groups(a.address).slice(0, 4).join(':')}::/64`);
    }
  }
  return [...nets].sort().join(',');
}

class Autopilot {
  /*
   * opts.store             settings (electron-store: get, set, delete)
   * opts.log(level, msg)
   * opts.tell(id, params)  a notification and a line in the window
   * opts.protectionOn()    whether protection is on
   * opts.check(host)       blockcheck.check, through the engine
   * opts.services          [{ id, name, probe, mode, needsApp, present(), enable() -> { success } }]
   * opts.advanced          { available(), active(), start(since) -> { success, code },
   *                          antiCheat(), session() }: session() changes with each
   *                          Stop of protection, and start(since) answers
   *                          code 'protection_off' when one came first
   * opts.onBlocked(id)     a service was just found blocked (after its mode was considered)
   * opts.now()             the clock (tests)
   * opts.later(fn, ms)     a timer (tests)
   */
  constructor(opts) {
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.tell = opts.tell || (() => {});
    this.protectionOn = opts.protectionOn || (() => false);
    this.check = opts.check || (async () => null);
    this.services = opts.services || [];
    this.advanced = opts.advanced || null;
    this.onBlocked = opts.onBlocked || (() => {});
    this.now = opts.now || Date.now;
    this.later = opts.later || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    this.blocked = new Map();      // service id -> { how, host, at }
    this.clear = new Map();        // service id -> when it was last found not blocked
    this.unknownAt = new Map();    // service id -> when a check last learnt nothing (offline)
    this.checking = new Map();     // service id -> the check under way
    this.gen = 0;                  // network generation: a check from an older one is dropped
    this.failed = new Set();       // services whose mode could not be turned on this session
    this.busy = new Set();
    this.toldOff = new Set();
    this.signs = new Map();        // service id -> { host, voice, at }: it may need Advanced mode
    this.advancedAsked = false;
    this._asking = null;
    this.retries = new Map();      // service id -> a check waiting for its time (_retry)
    this.toldNotAsked = new Set(); // reasons Advanced mode is not asked for, told this session
    this.quietUntil = 0;           // no checks before this (a wake: resumed())
    migrate(this.store, this.now());
  }

  isBlocked(id) { return this.blocked.has(id); }

  /* The user turned a switch on or off by hand. */
  userSet(mode, on) {
    if (on) this.store.delete(`${mode}OffAt`);
    else this.store.set(`${mode}OffAt`, this.now());
  }

  _offByHand(mode) { return this.now() - this._when(`${mode}OffAt`) < RESPECT_OFF_MS; }

  /* "Ask for permission by itself" (Settings, on by default): off, no
   * permission prompt is ever brought up by Shroudly on its own; the user is
   * told what needs which mode instead (issue #55). */
  mayAsk() { return this.store.get('askByItself', true) !== false; }

  /* A time kept in the settings; one "in the future" (the clock was set
   * back since) counts as now, so the two weeks are never stretched. */
  _when(key) {
    const at = Number(this.store.get(key, 0)) || 0;
    const now = this.now();
    if (at > now + 60000) { this.store.set(key, now); return now; }
    return at;
  }

  /* The computer woke up: the network may still be on its way back, so no
   * service is judged for a moment; what was waiting for a check gets it
   * once that has passed. */
  resumed() {
    this.quietUntil = this.now() + WAKE_QUIET_MS;
  }

  /* A different network: what was learnt about the last one does not hold,
   * and a check still under way belongs to the old one. */
  networkChanged() {
    this.gen++;
    // A call starting is the user's doing, not the network's: its sign stays
    // for the new network's verdict (the engine tells a voice server once in
    // ten minutes, so it would not come again). What failed on the old
    // network says nothing about this one.
    for (const [id, sign] of this.signs) if (!sign.voice) this.signs.delete(id);
    if (!this.blocked.size && !this.clear.size && !this.unknownAt.size) return;
    this.blocked.clear();
    this.clear.clear();
    this.unknownAt.clear();
    this.failed.clear();
    this.log('info', 'Autopilot: the network changed; services will be checked again');
  }

  /* Before acting on a program (restarting it): is the service still blocked
   * right now? A verdict older than `freshMs` is checked again first, so a
   * program is never restarted on a network the verdict no longer fits
   * (two networks can look alike from this computer). */
  async stillBlocked(id, freshMs = 10 * 60 * 1000) {
    const b = this.blocked.get(id);
    if (!b) return false;
    if (this.now() - b.at < freshMs) return true;
    // Nothing learnt (offline, just woken up): not known to be blocked
    // now, so nothing is restarted on the strength of the old verdict.
    const fresh = await this._confirm(id, b.host, null);
    return fresh === true && this.blocked.has(id);
  }

  /* An engine event about a host (engine-manager's onHostEvent, and the cut
   * the engine believes, from its advice). A host that only refuses this
   * client, one no technique got an answer from, or a single cut, says
   * nothing about the network. A call starting on a service's voice server
   * ('seen') is worth finding out whether the service is blocked here. */
  noteHost(kind, host, info) {
    info = info || {};
    this._sign(kind, host, info);
    const real = kind === 'bypass'
      || (kind === 'cut' && info.believed === true)
      || (kind === 'blocked' && !info.alert && !info.siteOk && info.note !== 'silent')
      || (kind === 'seen' && voiceOf(host) !== null);
    if (!real) return;
    const id = familyOf(host);
    if (!id || this.blocked.has(id)) return;
    if (this.now() - (this.clear.get(id) || -Infinity) < CHECK_AGAIN_MS) return;
    // A voice server says nothing by its own name: the service's own is
    // what is checked.
    const svc = kind === 'seen' ? this.services.find((x) => x.id === id) : null;
    const probe = svc ? svc.probe : String(host).toLowerCase();
    // Nothing could be learnt a moment ago (offline): soon again, not at
    // once; and then for sure, since the engine may not tell this again.
    const unknown = this.unknownAt.get(id);
    if (unknown != null && this.now() - unknown < UNKNOWN_MS) { this._retry(id, probe, kind, unknown + UNKNOWN_MS - this.now()); return; }
    this._confirm(id, probe, kind).catch(() => {});
  }

  /* A check due later (offline a moment ago, just woken up): one per
   * service, made then unless the verdict came meanwhile. */
  _retry(id, host, why, ms) {
    if (this.retries.has(id)) return;
    this.retries.set(id, this.later(() => {
      this.retries.delete(id);
      if (this.blocked.has(id) || !this.protectionOn()) return;
      this._confirm(id, host, why).catch(() => {});
    }, Math.max(1000, ms + 1000)));
  }

  /* Whether `host` of service `id` is blocked, by blockcheck. One check per
   * service at a time. */
  async _confirm(id, host, why) {
    // One check per service at a time, on the current network: one still
    // running for the last network is not waited for.
    const cur = this.checking.get(id);
    if (cur && cur.gen === this.gen) return cur.run;
    // Just woken up: the network may not be back yet. Checked once it is.
    if (this.now() < this.quietUntil) { this._retry(id, host, why, this.quietUntil - this.now()); return false; }
    const gen = this.gen;
    const run = (async () => {
      let r = null;
      try { r = await this.check(host); } catch {}
      // No answer, or the network changed while it ran: nothing learnt.
      if (!r || gen !== this.gen) return false;
      if (r.unknown) {
        this.unknownAt.set(id, this.now());
        this.log('info', `Autopilot: ${host} could not be checked (${r.detail}); tried again later`);
        return false;
      }
      this.unknownAt.delete(id);
      if (r.blocked) {
        this.blocked.set(id, { how: r.how, host, at: this.now() });
        this.clear.delete(id);
        this.log('info', `Autopilot: ${id} is blocked on this network (${host}: ${r.how}, ${r.detail}${why ? `; after ${why}` : ''})`);
        await this.consider(id);
        // Not waited for: it may be a permission prompt the user takes a
        // while over, and stillBlocked() waits for this.
        this._advancedFor(id).catch(() => {});
        try { this.onBlocked(id); } catch {}
        return true;
      }
      this.blocked.delete(id);
      this.clear.set(id, this.now());
      this.log('info', `Autopilot: ${host} works without Shroudly on this network (${r.detail})`);
      return false;
    })();
    const entry = { gen, run };
    this.checking.set(id, entry);
    try { return await run; } finally { if (this.checking.get(id) === entry) this.checking.delete(id); }
  }

  /* Turn a blocked service's mode on, unless it is on already, its app is not
   * here, the user turned it off by hand not long ago, or it could not be
   * turned on earlier this session (a permission the user did not give, a
   * proxy of their own in the way): the window shows that, and the user
   * decides. */
  async consider(id) {
    const s = this.services.find((x) => x.id === id);
    if (!s || !this.blocked.has(id) || !this.protectionOn()) return false;
    if (this.store.get(s.mode) === true) return false;
    if (s.needsApp && !s.present()) return false;
    if (this._offByHand(s.mode)) {
      if (!this.toldOff.has(id)) {
        this.toldOff.add(id);
        const date = day(this._when(`${s.mode}OffAt`));
        this.log('info', `Autopilot: ${s.name} is blocked on this network, but its mode was turned off by hand on ${date}; turn it on in Settings to use its app`);
        if (s.toldOff) this.tell(s.toldOff, { date });
      }
      return false;
    }
    if (this.failed.has(id) || this.busy.has(id)) return false;
    this.busy.add(id);
    try {
      let r = null;
      try { r = await s.enable(); } catch (e) { r = { success: false, code: e.message }; }
      if (r && r.success) {
        this.log('success', s.logOn);
        this.tell(s.told, {});
        return true;
      }
      this.failed.add(id);
      // Said once, with what to do: the switch in Settings tries again (and
      // the window shows what stood in the way, where it knows).
      this.log('info', `Autopilot: ${s.name} is blocked on this network, but its mode could not be turned on (${(r && r.code) || 'failed'}); turn it on in Settings to try again`);
      if (s.toldFailed) this.tell(s.toldFailed, {});
      return false;
    } finally { this.busy.delete(id); }
  }

  /* The network forges DNS answers (the check at the start finds it):
   * programs that do not use the system proxy (command-line tools, bots,
   * some games) resolve through it and land on a block page, while
   * everything that uses the proxy works. Games and apps mode points them at
   * Shroudly (HTTPS_PROXY, and NODE_USE_ENV_PROXY for Node.js): turned on by
   * itself, as a blocked service's mode is, once a run; a mode turned off by
   * hand is respected and said once. hosts: the names found forged. */
  async forgedDns(hosts) {
    const s = this.services.find((x) => x.mode === 'appMode');
    if (!s || this._forgedDone || !this.protectionOn() || this.store.get('appMode') === true) return false;
    this._forgedDone = true;
    const names = (hosts || []).slice(0, 3).join(', ');
    if (this._offByHand('appMode')) {
      const date = day(this._when('appModeOffAt'));
      this.log('info', `Autopilot: this network forges DNS answers (${names}), so programs that do not use the system proxy go around Shroudly; Games and apps mode was turned off by hand on ${date}; turn it on in Settings for them`);
      this.tell('autoForgedDnsOffByHand', { date });
      return false;
    }
    let r = null;
    try { r = await s.enable(); } catch (e) { r = { success: false, code: e.message }; }
    if (r && r.success) {
      this.log('success', `Autopilot: this network forges DNS answers (${names}); Games and apps mode turned on, so programs that do not use the system proxy go through Shroudly too`);
      this.tell('autoForgedDnsOn', {});
      return true;
    }
    // Not on this system (Linux: no one place every program reads it from).
    if (r && r.code === 'unsupported') return false;
    this.log('info', `Autopilot: this network forges DNS answers (${names}), but Games and apps mode could not be turned on (${(r && r.code) || 'failed'}); turn it on in Settings to try again`);
    return false;
  }

  /* When protection comes on, and every so often after: for each service
   * whose app is here, find out whether this network blocks it; a service
   * found blocked hours ago is looked at again. The services are checked side
   * by side: one whose check waits out a silent network (or whose mode takes
   * a while to come on) never holds up another's verdict. */
  async survey() {
    await Promise.all(this.services.map((s) => this._surveyOne(s)));
  }

  async _surveyOne(s) {
    if (!this.protectionOn()) return;
    const b = this.blocked.get(s.id);
    if (b) {
      if (this.now() - b.at >= CHECK_AGAIN_MS) await this._confirm(s.id, b.host, null);
      else await this.consider(s.id);
      return;
    }
    if (!s.present()) return;
    if (this.now() - (this.clear.get(s.id) || -Infinity) < CHECK_AGAIN_MS) return;
    if (this.now() - (this.unknownAt.get(s.id) || -Infinity) < UNKNOWN_MS) return;
    await this._confirm(s.id, s.probe, null);
  }

  /* A program of the service is waiting on the verdict (a Roblox installer
   * that goes around Shroudly): the check now, unless the verdict is known,
   * one is under way, or nothing could be learnt less than SOON_MS ago
   * (offline at login): soon again then, not in ten minutes. Resolves
   * whether it is blocked. */
  async checkSoon(id) {
    const s = this.services.find((x) => x.id === id);
    if (!s || !this.protectionOn()) return false;
    if (this.blocked.has(id)) return true;
    const cur = this.checking.get(id);
    if (cur && cur.gen === this.gen) return cur.run;
    if (this.now() - (this.clear.get(id) || -Infinity) < CHECK_AGAIN_MS) return false;
    if (this.now() - (this.unknownAt.get(id) || -Infinity) < SOON_MS) return false;
    return this._confirm(id, s.probe, null);
  }

  /* A sign, in what the engine said, that a service needs Advanced mode
   * here (see the top of this file):
   *  - a connection to one of its voice servers: a call starting;
   *  - no technique getting its own page or gateway open (a silent failure,
   *    or one while its other names answer, included; never the server's own
   *    refusal), another of its names that no technique opens, or a cut the
   *    engine believes.
   * Kept a while, and acted on once the service is known blocked here. */
  _sign(kind, host, info) {
    const h = norm(host);
    const id = familyOf(h);
    const a = id && ADVANCED[id];
    if (!a || !this.services.some((x) => x.id === id)) return;
    const voice = voiceOf(h) === id;
    const failed = (kind === 'cut' && info.believed === true)
      || (kind === 'blocked' && !info.alert && (a.core(h) || (!info.siteOk && info.note !== 'silent')));
    if (!voice && !failed) return;
    this.signs.set(id, { host: h, voice, at: this.now() });
    if (this.blocked.has(id)) this._advancedFor(id).catch(() => {});
  }

  /* Ask for Advanced mode for a service with a fresh sign, known blocked on
   * this network: for a call starting, at once; for a name its app cannot
   * reach, while its app is open (a browser has the window's own offer for
   * a site no technique opens). Resolves whether it is on now. */
  async _advancedFor(id) {
    const sign = this.signs.get(id);
    if (!sign || this.now() - sign.at > SIGN_MS || !this.blocked.has(id) || !this.protectionOn()) return false;
    const s = this.services.find((x) => x.id === id);
    const a = this.advanced;
    if (!s || !a || !a.available() || a.active()) return false;
    const since = this._session();
    if (!sign.voice) {
      let open = false;
      try { open = !!(s.running && await s.running()); } catch {}
      if (!open) return false;
    }
    if (this.signs.get(id) !== sign) return false;   // a newer sign took over
    this.signs.delete(id);
    const why = sign.voice ? `a ${s.name} call is starting; its sound goes over UDP` : `${s.name} is open and cannot reach it`;
    // Not asked (declined, turned off by hand, failed earlier): said once,
    // with what to do. Asked: an ask under way for something else answers
    // this too, and if that one ends without Advanced mode, that is said
    // as well (an ask of its own has said so already).
    if (!this.willAskAdvanced() && !this._asking) { this._notAsked(s.name, why); return false; }
    const on = await this.needAdvanced(sign.host, { why, label: s.name, since });
    const own = this._lastAsk && this._lastAsk.host === sign.host;
    if (!on && !own && this._stillOn(since) && !a.active() && !this.willAskAdvanced()) this._notAsked(s.name, why);
    return on;
  }

  /* Why Advanced mode would not be asked for now, when it is the user's to
   * change: { reason: 'off' | 'declined' | 'noask' | 'failed', at } or null. */
  _notAskedReason() {
    const a = this.advanced;
    if (!a || !a.available() || a.active() || !this.protectionOn() || this._asking) return null;
    if (this._offByHand('advancedMode')) return { reason: 'off', at: this._when('advancedModeOffAt') };
    const declined = this._when('advancedDeclinedAt');
    if (this.now() - declined < RESPECT_OFF_MS) return { reason: 'declined', at: declined };
    if (!this.mayAsk()) return { reason: 'noask', at: this.now() };
    if (this.advancedAsked) return { reason: 'failed', at: this.now() };
    return null;
  }

  /* `what` needs Advanced mode and it is not asked for: one line, and a
   * line in the window, once a session per reason, saying what to do. */
  _notAsked(what, why = null) {
    const r = this._notAskedReason();
    if (!r || this.toldNotAsked.has(r.reason)) return false;
    this.toldNotAsked.add(r.reason);
    const date = day(r.at);
    const because = {
      off: `it was turned off by hand on ${date}, so it is not turned on by itself`,
      declined: `it was not allowed on ${date}, so it is not asked for by itself`,
      noask: 'Shroudly does not ask for permission by itself (a setting)',
      failed: 'it could not be started earlier in this session',
    }[r.reason];
    this.log('info', `Autopilot: ${what} needs Advanced mode on this network${why ? ` (${why})` : ''}; ${because}; turn it on in Settings`);
    this.tell({ off: 'autoAdvancedOffBefore', declined: 'autoAdvancedDeclinedBefore', noask: 'autoAdvancedNoAsk', failed: 'autoAdvancedFailedBefore' }[r.reason], { host: what, date });
    return true;
  }

  /* Protection's session (advanced.session(): one per Stop), and whether an
   * ask begun in `since` still belongs to protection as it is now. */
  _session() { return this.advanced && this.advanced.session ? this.advanced.session() : null; }
  _stillOn(since) { return this.protectionOn() && this._session() === since; }

  /* The user declined Advanced mode's permission prompt (also one they
   * started themselves): not asked again by itself for two weeks. */
  recordDecline() { this.store.set('advancedDeclinedAt', this.now()); }

  /* Whether something that needs Advanced mode is still worth looking for:
   * it would be asked for now, or why it is not has yet to be said this
   * session (around-watch.js looks only then). */
  advancedPending() {
    if (this.willAskAdvanced() || this._asking) return true;
    const r = this._notAskedReason();
    return !!r && !this.toldNotAsked.has(r.reason);
  }

  /* The services found blocked at the handshake (not only by DNS): a
   * program that reaches their real addresses directly, around Shroudly,
   * is stopped too (around-watch.js). */
  blockedAtHandshake() {
    return [...this.blocked].filter(([, b]) => b.how === 'tls').map(([id]) => id);
  }

  /* Whether needAdvanced would ask now (the window shows its own offer
   * otherwise). */
  willAskAdvanced() {
    const a = this.advanced;
    if (!a || !a.available() || a.active() || !this.protectionOn() || this.advancedAsked) return false;
    if (this._offByHand('advancedMode') || !this.mayAsk()) return false;
    return this.now() - this._when('advancedDeclinedAt') >= RESPECT_OFF_MS;
  }

  /* A site no technique opened, or one cut after it connected: Advanced mode
   * is what is left. Resolves whether it is on now. opts.why goes in the log
   * line, opts.label is what the user is told needs it (the host by
   * default). One ask at a time: another reason arriving meanwhile gets the
   * same answer, not a second prompt. opts.since: protection's session the
   * ask began in (advanced.session(); now by default), which a Stop ends.
   * opts.told: { ask, on, params }, the lines said when it is asked for and
   * when it is on, in place of the ones about a site. */
  needAdvanced(host, opts = {}) {
    if (this._asking) return this._asking;
    const run = this._needAdvanced(host, opts);
    this._asking = run;
    run.then(() => { if (this._asking === run) this._asking = null; }, () => { if (this._asking === run) this._asking = null; });
    return run;
  }

  async _needAdvanced(host, { why = null, label = null, since = this._session(), told: lines = null } = {}) {
    if (!this.willAskAdvanced()) { this._notAsked(label || host, why); return false; }
    const a = this.advanced;
    // A game's anti-cheat running: a packet driver is never loaded beside it
    // by itself (it may refuse the game, or flag it). The user still can.
    let ac = null;
    try { ac = a.antiCheat ? await a.antiCheat() : null; } catch {}
    // Protection stopped meanwhile (and maybe started again): the Stop wins,
    // and nothing is asked.
    if (!this._stillOn(since)) return false;
    if (ac) {
      if (!this.antiCheatLogged) {
        this.log('info', `Autopilot: ${host} needs Advanced mode, but a game's anti-cheat is running (${ac}); not started by itself`);
        this.tell('autoAdvancedAntiCheat', { host: label || host, program: ac });
      }
      this.antiCheatLogged = true;
      return false;
    }
    this.advancedAsked = true;
    this._lastAsk = { host };
    this.log('info', `Autopilot: ${host} needs Advanced mode${why ? ` (${why})` : ''}; asking for permission`);
    const told = { host: label || host };
    this.tell((lines && lines.ask) || 'autoAdvancedAsk', (lines && lines.params) || told);
    let r = null;
    try { r = await a.start(since); } catch (e) { r = { success: false, code: e.code }; }
    if (r && r.success) {
      this.tell((lines && lines.on) || 'autoAdvancedOn', (lines && lines.params) || told);
      return true;
    }
    // Protection was stopped before it came up: it went with it (main.js
    // brings it back with the next Start), nothing failed, and nothing was
    // decided: a later session may ask.
    if (r && r.code === 'protection_off') { this.advancedAsked = false; return false; }
    if (r && r.code === 'declined') {
      this.recordDecline();
      this.log('info', 'Advanced mode was not allowed; Shroudly will not ask by itself again for two weeks');
      this.tell('autoAdvancedDeclined', told);
    } else {
      this.tell('autoAdvancedFailed', told);
    }
    return false;
  }
}

/* A day as the log and the window give it: 2026-10-21. */
function day(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return Number.isNaN(d.getTime()) ? '?' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* A game with an anti-cheat, running now, in a Windows process list
 * (tasklist /FO CSV): its name, or null.
 *
 * Only a game that is being played counts. Many anti-cheats leave a part of
 * themselves running whenever the PC is on, from the boot or the login on,
 * with no game open at all: Riot Vanguard's service and tray icon (vgc,
 * vgtray) on every PC with VALORANT or League installed, FACEIT's client and
 * service, PunkBuster's service, the Easy Anti-Cheat, BattlEye and EA
 * services a game started once and that stay. Counting those kept Advanced
 * mode off for good on such a PC, where it was never anywhere near a game.
 * They count only next to a game known to be protected by one, or an
 * Unreal or BattlEye game (its "-Win64-Shipping" or "_BE" program) while one
 * of them runs. The parts an anti-cheat runs only inside a game (GameGuard,
 * XIGNCODE, PunkBuster's game-side program) count by themselves. */
const RESIDENT_ANTI_CHEAT = ['vgc.exe', 'vgtray.exe', 'EasyAntiCheat.exe', 'EasyAntiCheat_EOS.exe', 'BEService.exe', 'BEService_x64.exe',
  'FACEIT.exe', 'faceitservice.exe', 'FACEITClient.exe', 'EAAntiCheat.GameService.exe', 'EAAntiCheat.GameServiceLauncher.exe', 'PnkBstrA.exe',
  'ACE-Tray.exe', 'SGuardSvc64.exe'];
const IN_GAME_ANTI_CHEAT = ['GameMon.des', 'GameMon64.des', 'GameGuard.des', 'xcoronahost.xem', 'x3.xem', 'xigncode.exe', 'PnkBstrB.exe',
  'EasyAntiCheat_launcher.exe', 'start_protected_game.exe', 'SGuard64.exe'];
// Games whose anti-cheat runs beside them (Vanguard, Easy Anti-Cheat,
// BattlEye, EA, FACEIT, ACE): a few of the most played, by program name.
// Riot's clients count too: the sign-in and Vanguard's check happen in the
// Riot Client (and League's), before the game's own program starts, and a
// packet driver loaded then keeps VALORANT and League from starting (#56).
const PROTECTED_GAMES = ['VALORANT-Win64-Shipping.exe', 'VALORANT.exe', 'League of Legends.exe', 'Riot Client.exe', 'RiotClientServices.exe',
  'RiotClientUx.exe', 'LeagueClient.exe', 'LeagueClientUx.exe', 'FortniteClient-Win64-Shipping.exe', 'r5apex.exe', 'r5apex_dx12.exe',
  'RustClient.exe', 'TslGame.exe', 'RainbowSix.exe', 'RainbowSix_Vulkan.exe', 'DayZ_x64.exe', 'EscapeFromTarkov.exe', 'destiny2.exe', 'GTA5.exe',
  'GTA5_Enhanced.exe', 'eldenring.exe', 'DeadByDaylight-Win64-Shipping.exe', 'FallGuys_client_game.exe', 'SoTGame.exe', 'HuntGame.exe',
  'LOSTARK.exe', 'Discovery.exe', 'bf2042.exe', 'bf6.exe', 'FC25.exe', 'FC26.exe', 'cs2.exe', 'cod.exe', 'ArmA3_x64.exe',
  'Overwatch.exe', 'NewWorld.exe', 'SquadGame.exe', 'NarakaBladepoint.exe'];
function antiCheatIn(out) {
  const seen = [...String(out || '').matchAll(/^"([^"]+)"/gm)].map((m) => m[1]);
  const has = (list) => { const set = new Set(list.map((n) => n.toLowerCase())); return seen.find((n) => set.has(n.toLowerCase())) || null; };
  const inGame = has(IN_GAME_ANTI_CHEAT);
  if (inGame) return inGame;
  const resident = has(RESIDENT_ANTI_CHEAT);
  if (!resident) return null;
  return has(PROTECTED_GAMES) || seen.find((n) => /-Win64-Shipping\.exe$|_BE\.exe$/i.test(n)) || null;
}

function antiCheatRunning(platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => require('child_process').execFile('tasklist', ['/NH', '/FO', 'CSV'],
    { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? null : antiCheatIn(out))));
}

module.exports = Autopilot;
module.exports.antiCheatIn = antiCheatIn;
module.exports.RESIDENT_ANTI_CHEAT = RESIDENT_ANTI_CHEAT;
module.exports.day = day;
module.exports.antiCheatRunning = antiCheatRunning;
module.exports.familyOf = familyOf;
module.exports.voiceOf = voiceOf;
// The domains the engine is asked to tell each connection to (--watch).
module.exports.WATCH = Object.values(ADVANCED).flatMap((a) => a.watch);
module.exports.SIGN_MS = SIGN_MS;
module.exports.networkFingerprint = networkFingerprint;
module.exports.ipv6Groups = ipv6Groups;
module.exports.OWN = OWN;
module.exports.RESPECT_OFF_MS = RESPECT_OFF_MS;
module.exports.CHECK_AGAIN_MS = CHECK_AGAIN_MS;
module.exports.SOON_MS = SOON_MS;
