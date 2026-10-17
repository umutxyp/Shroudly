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
 * Services an app needs (Discord, Roblox): the autopilot learns that this
 * network blocks one from the engine's own events for its names (a site that
 * needed a technique, one cut after it connected, one no technique opened),
 * or from a check of its own (blockcheck.js) when protection is on and the
 * app is installed, so the mode is on before the app is opened. Then it turns
 * that service's mode on. What follows from it (restarting a program that is
 * stuck around Shroudly) is the caller's, which knows each program (main.js).
 *
 * Advanced mode: a site that no technique opens, or that connects and is then
 * cut, is the network Advanced mode is for. It needs the system's permission,
 * so it is asked for at most once a session, and not again by itself for two
 * weeks once the user declines.
 */

const { FAMILIES } = require('./families');

const RESPECT_OFF_MS = 14 * 24 * 60 * 60 * 1000;
const CHECK_AGAIN_MS = 6 * 60 * 60 * 1000;

const under = (h, d) => h === d || h.endsWith(`.${d}`);
function familyOf(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  for (const [id, domains] of Object.entries(FAMILIES)) if (domains.some((d) => under(h, d))) return id;
  return null;
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
    this.checkedAt = new Map();    // service id -> when blockcheck last ran
    this.busy = new Set();
    this.toldOff = new Set();
    this.advancedAsked = false;
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

  /* An engine event about a host (engine-manager's onHostEvent). A host that
   * only refuses this client, or one no technique got an answer from, says
   * nothing about the network. */
  noteHost(kind, host, info = {}) {
    const real = kind === 'bypass' || kind === 'cut'
      || (kind === 'blocked' && !info.alert && !info.siteOk && info.note !== 'silent');
    if (!real) return;
    const id = familyOf(host);
    if (id) this._evidence(id, kind === 'bypass' ? 'technique' : kind, host);
  }

  _evidence(id, how, host) {
    if (this.blocked.has(id)) return;
    this.blocked.set(id, { how, host, at: this.now() });
    this.log('info', `Autopilot: ${id} is blocked on this network (${how}, ${host})`);
    this.consider(id).catch(() => {});
  }

  /* Turn a blocked service's mode on, unless it is on already, its app is not
   * here, or the user turned it off by hand not long ago. */
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
    if (this.busy.has(id)) return false;
    this.busy.add(id);
    try {
      let r = null;
      try { r = await s.enable(); } catch (e) { r = { success: false, code: e.message }; }
      if (r && r.success) {
        this.log('success', s.logOn);
        this.tell(s.told, {});
        return true;
      }
      return false;
    } finally { this.busy.delete(id); }
  }

  /* When protection comes on, and every so often after: for each service
   * whose app is here, find out whether this network blocks it. Asked with
   * the mode already on too (left on by an earlier session): what follows the
   * mode (main.js restarting a program stuck around Shroudly) is only done
   * where the service is known to be blocked. */
  async survey() {
    for (const s of this.services) {
      if (!this.protectionOn()) return;
      if (this.blocked.has(s.id)) { await this.consider(s.id); continue; }
      if (!s.present()) continue;
      if (this.now() - (this.checkedAt.get(s.id) || 0) < CHECK_AGAIN_MS) continue;
      this.checkedAt.set(s.id, this.now());
      let r = null;
      try { r = await this.check(s.probe); } catch {}
      if (r && r.blocked) this._evidence(s.id, r.how, s.probe);
      else if (r) this.log('info', `Autopilot: ${s.probe} works without Shroudly on this network (${r.detail})`);
    }
  }

  /* A site no technique opened, or one cut after it connected: Advanced mode
   * is what is left. Resolves whether it is on now. */
  async needAdvanced(host) {
    const a = this.advanced;
    if (!a || !a.available() || a.active() || !this.protectionOn() || this.advancedAsked) return false;
    if (this._offByHand('advancedMode')) return false;
    if (this.now() - (Number(this.store.get('advancedDeclinedAt', 0)) || 0) < RESPECT_OFF_MS) return false;
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
      this.store.set('advancedDeclinedAt', this.now());
      this.log('info', 'Advanced mode was not allowed; Shroudly will not ask by itself again for two weeks');
      this.tell('autoAdvancedDeclined', { host });
    }
    return false;
  }
}

module.exports = Autopilot;
module.exports.familyOf = familyOf;
module.exports.RESPECT_OFF_MS = RESPECT_OFF_MS;
module.exports.CHECK_AGAIN_MS = CHECK_AGAIN_MS;
