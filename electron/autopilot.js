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
 * cut, is the network Advanced mode is for. It needs the system's permission,
 * so it is asked for at most once a session, and not again by itself for two
 * weeks once the user declines.
 */

const RESPECT_OFF_MS = 14 * 24 * 60 * 60 * 1000;
const CHECK_AGAIN_MS = 6 * 60 * 60 * 1000;

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
function familyOf(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  for (const [id, domains] of Object.entries(OWN)) if (domains.some((d) => under(h, d))) return id;
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
   * opts.advanced          { available(), active(), start() -> { success, code } }
   * opts.now()             the clock (tests)
   */
  constructor(opts) {
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.tell = opts.tell || (() => {});
    this.protectionOn = opts.protectionOn || (() => false);
    this.check = opts.check || (async () => null);
    this.services = opts.services || [];
    this.advanced = opts.advanced || null;
    this.now = opts.now || Date.now;
    this.blocked = new Map();      // service id -> { how, host, at }
    this.clear = new Map();        // service id -> when it was last found not blocked
    this.unknownAt = new Map();    // service id -> when a check last learnt nothing (offline)
    this.checking = new Map();     // service id -> the check under way
    this.gen = 0;                  // network generation: a check from an older one is dropped
    this.failed = new Set();       // services whose mode could not be turned on this session
    this.busy = new Set();
    this.toldOff = new Set();
    this.advancedAsked = false;
    migrate(this.store, this.now());
  }

  isBlocked(id) { return this.blocked.has(id); }

  /* The user turned a switch on or off by hand. */
  userSet(mode, on) {
    if (on) this.store.delete(`${mode}OffAt`);
    else this.store.set(`${mode}OffAt`, this.now());
  }

  _offByHand(mode) {
    const at = Number(this.store.get(`${mode}OffAt`, 0)) || 0;
    return this.now() - at < RESPECT_OFF_MS;
  }

  /* A different network: what was learnt about the last one does not hold,
   * and a check still under way belongs to the old one. */
  networkChanged() {
    this.gen++;
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
    await this._confirm(id, b.host, null);
    return this.blocked.has(id);
  }

  /* An engine event about a host (engine-manager's onHostEvent, and the cut
   * the engine believes, from its advice). A host that only refuses this
   * client, one no technique got an answer from, or a single cut, says
   * nothing about the network. */
  noteHost(kind, host, info = {}) {
    const real = kind === 'bypass'
      || (kind === 'cut' && info.believed === true)
      || (kind === 'blocked' && !info.alert && !info.siteOk && info.note !== 'silent');
    if (!real) return;
    const id = familyOf(host);
    if (!id || this.blocked.has(id)) return;
    if (this.now() - (this.clear.get(id) || -Infinity) < CHECK_AGAIN_MS) return;
    // Nothing could be learnt a moment ago (offline): soon again, not at once.
    if (this.now() - (this.unknownAt.get(id) || -Infinity) < 2 * 60 * 1000) return;
    this._confirm(id, String(host).toLowerCase(), kind).catch(() => {});
  }

  /* Whether `host` of service `id` is blocked, by blockcheck. One check per
   * service at a time. */
  async _confirm(id, host, why) {
    // One check per service at a time, on the current network: one still
    // running for the last network is not waited for.
    const cur = this.checking.get(id);
    if (cur && cur.gen === this.gen) return cur.run;
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
        this.log('info', `Autopilot: ${s.name} is blocked here, but its switch was turned off by hand; left off`);
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
      this.log('info', `Autopilot: ${s.name} mode could not be turned on (${(r && r.code) || 'failed'}); not tried again by itself this session`);
      return false;
    } finally { this.busy.delete(id); }
  }

  /* When protection comes on, and every so often after: for each service
   * whose app is here, find out whether this network blocks it; a service
   * found blocked hours ago is looked at again. */
  async survey() {
    for (const s of this.services) {
      if (!this.protectionOn()) return;
      const b = this.blocked.get(s.id);
      if (b) {
        if (this.now() - b.at >= CHECK_AGAIN_MS) await this._confirm(s.id, b.host, null);
        else await this.consider(s.id);
        continue;
      }
      if (!s.present()) continue;
      if (this.now() - (this.clear.get(s.id) || -Infinity) < CHECK_AGAIN_MS) continue;
      if (this.now() - (this.unknownAt.get(s.id) || -Infinity) < 2 * 60 * 1000) continue;
      await this._confirm(s.id, s.probe, null);
    }
  }

  /* The user declined Advanced mode's permission prompt (also one they
   * started themselves): not asked again by itself for two weeks. */
  recordDecline() { this.store.set('advancedDeclinedAt', this.now()); }

  /* Whether needAdvanced would ask now (the window shows its own offer
   * otherwise). */
  willAskAdvanced() {
    const a = this.advanced;
    if (!a || !a.available() || a.active() || !this.protectionOn() || this.advancedAsked) return false;
    if (this._offByHand('advancedMode')) return false;
    return this.now() - (Number(this.store.get('advancedDeclinedAt', 0)) || 0) >= RESPECT_OFF_MS;
  }

  /* A site no technique opened, or one cut after it connected: Advanced mode
   * is what is left. Resolves whether it is on now. */
  async needAdvanced(host) {
    if (!this.willAskAdvanced()) return false;
    const a = this.advanced;
    // A game's anti-cheat running: a packet driver is never loaded beside it
    // by itself (it may refuse the game, or flag it). The user still can.
    let ac = null;
    try { ac = a.antiCheat ? await a.antiCheat() : null; } catch {}
    if (ac) {
      if (!this.antiCheatLogged) this.log('info', `Autopilot: ${host} needs Advanced mode, but a game's anti-cheat is running (${ac}); not started by itself`);
      this.antiCheatLogged = true;
      return false;
    }
    this.advancedAsked = true;
    this.log('info', `Autopilot: ${host} needs Advanced mode; asking for permission`);
    this.tell('autoAdvancedAsk', { host });
    let r = null;
    try { r = await a.start(); } catch (e) { r = { success: false, code: e.code }; }
    if (r && r.success) {
      this.tell('autoAdvancedOn', { host });
      return true;
    }
    if (r && r.code === 'declined') {
      this.recordDecline();
      this.log('info', 'Advanced mode was not allowed; Shroudly will not ask by itself again for two weeks');
      this.tell('autoAdvancedDeclined', { host });
    } else {
      this.tell('autoAdvancedFailed', { host });
    }
    return false;
  }
}

/* Anti-cheat programs in a Windows process list (tasklist /FO CSV): the
 * first one found, or null. */
const ANTI_CHEAT = ['vgc.exe', 'vgtray.exe', 'EasyAntiCheat.exe', 'EasyAntiCheat_EOS.exe', 'BEService.exe', 'BEService_x64.exe',
  'FACEIT.exe', 'faceitservice.exe', 'EAAntiCheat.GameService.exe', 'GameGuard.des', 'nProtect.exe', 'xigncode.exe', 'PnkBstrA.exe'];
function antiCheatIn(out) {
  const names = new Set([...String(out || '').matchAll(/^"([^"]+)"/gm)].map((m) => m[1].toLowerCase()));
  return ANTI_CHEAT.find((n) => names.has(n.toLowerCase())) || null;
}

function antiCheatRunning(platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => require('child_process').execFile('tasklist', ['/NH', '/FO', 'CSV'],
    { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? null : antiCheatIn(out))));
}

module.exports = Autopilot;
module.exports.antiCheatIn = antiCheatIn;
module.exports.antiCheatRunning = antiCheatRunning;
module.exports.familyOf = familyOf;
module.exports.networkFingerprint = networkFingerprint;
module.exports.ipv6Groups = ipv6Groups;
module.exports.OWN = OWN;
module.exports.RESPECT_OFF_MS = RESPECT_OFF_MS;
module.exports.CHECK_AGAIN_MS = CHECK_AGAIN_MS;
