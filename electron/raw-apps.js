'use strict';

/*
 * Apps whose connections are not TLS or HTTP (a messenger's own protocol, a
 * game's), and how Shroudly tells the user about one that cannot get through.
 *
 * The engine searches for a technique for such a connection by itself and
 * says what it found (core/src/engine.c, "streams that are not TLS or HTTP"):
 * a technique that opened it ("bypass", raw), every technique failing
 * ("blocked", raw), or the address not answering at all ("unreachable",
 * raw). The last two are what an app the user waits on cannot say for
 * itself, so they are told in one line, naming the app:
 *   - by the program holding the connection, where the system can say
 *     (desktop: procnet.owner, from the port the engine reports);
 *   - else by the service the address or name belongs to (SERVICES below:
 *     public facts about where a service's servers are, like the Discord and
 *     Roblox names the autopilot knows).
 * An address nothing can be said about is a line in the log, never a
 * notification: peer-to-peer and game clients try dead addresses all day.
 *
 * What the line says is what is true: an address that does not answer at
 * all is blocked by the network itself (or gone), which no technique on
 * this computer can change without a server elsewhere; the app's own proxy
 * setting or a VPN can.
 */

/* Where a service's servers are. Telegram: its published ranges
 * (https://core.telegram.org/resources/cidr.txt) and its names. */
const SERVICES = [
  {
    id: 'telegram',
    name: 'Telegram',
    cidrs: ['91.108.56.0/22', '91.108.4.0/22', '91.108.8.0/22', '91.108.16.0/22', '91.108.12.0/22',
      '149.154.160.0/20', '91.105.192.0/23', '91.108.20.0/22', '185.76.151.0/24',
      '2001:b28:f23d::/48', '2001:b28:f23f::/48', '2001:67c:4e8::/48', '2001:b28:f23c::/48', '2a0a:f280::/32'],
    domains: ['telegram.org', 'telegram.me', 't.me', 'telesco.pe', 'tdesktop.com', 'telegra.ph', 'tg.dev'],
    probe: 'telegram.org',
  },
  { id: 'whatsapp', name: 'WhatsApp', cidrs: [], domains: ['whatsapp.net', 'whatsapp.com'], probe: 'web.whatsapp.com' },
  { id: 'signal', name: 'Signal', cidrs: [], domains: ['signal.org', 'whispersystems.org'], probe: 'signal.org' },
];

function v4Bytes(a) {
  const p = String(a).split('.');
  if (p.length !== 4) return null;
  const b = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

function v6Bytes(a) {
  let s = String(a).replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!s.includes(':')) return null;
  let tail4 = null;
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { tail4 = v4Bytes(m[2]); if (!tail4) return null; s = `${m[1]}0:0`; }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const out = [];
  for (const g of groups) { const n = parseInt(g, 16); out.push(n >> 8, n & 255); }
  if (tail4) out.splice(12, 4, ...tail4);
  return out;
}

function inCidr(bytes, cidr) {
  const [base, bitsText] = cidr.split('/');
  const b = base.includes(':') ? v6Bytes(base) : v4Bytes(base);
  if (!b || !bytes || b.length !== bytes.length) return false;
  let bits = Number(bitsText);
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const m = bits >= 8 ? 255 : (0xff << (8 - bits)) & 255;
    if ((b[i] & m) !== (bytes[i] & m)) return false;
  }
  return true;
}

/* The service an address or name belongs to, or null. */
function serviceOf(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!h) return null;
  const bytes = v4Bytes(h) || v6Bytes(h);
  for (const s of SERVICES) {
    if (bytes ? s.cidrs.some((c) => inCidr(bytes, c)) : s.domains.some((d) => h === d || h.endsWith(`.${d}`))) return s;
  }
  return null;
}

/* The IPv4 ranges of every service, as [network, mask] for a PAC's isInNet. */
function pacRanges() {
  const out = [];
  for (const s of SERVICES) {
    for (const c of s.cidrs) {
      const [base, bits] = c.split('/');
      if (!v4Bytes(base)) continue;
      const n = Number(bits);
      const mask = [0, 1, 2, 3].map((i) => { const k = Math.max(0, Math.min(8, n - i * 8)); return k ? (0xff << (8 - k)) & 255 : 0; });
      out.push([base, mask.join('.')]);
    }
  }
  return out;
}

/* The IPv6 ranges of every service, as [eight 16-bit groups, prefix bits],
 * for the PAC's own string-only matcher (no DNS lookups there). */
function pacRanges6() {
  const out = [];
  for (const s of SERVICES) {
    for (const c of s.cidrs) {
      const [base, bits] = c.split('/');
      const b = v6Bytes(base);
      if (!b) continue;
      const groups = [];
      for (let i = 0; i < 16; i += 2) groups.push((b[i] << 8) | b[i + 1]);
      out.push([groups, Number(bits)]);
    }
  }
  return out;
}

/* A program's name as people know it: "Telegram.exe" -> "Telegram". */
function programName(name) {
  const n = String(name || '').trim().replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return n && n.length <= 64 ? n : null;
}

/* How much makes an app's servers unreachable rather than one that failed
 * once: for a known service, two of its addresses, or one address still
 * failing at least AGAIN_MS later (the engine says it again at most once a
 * minute while the app keeps trying); for a program, three addresses (it may
 * be a peer-to-peer client trying dead peers). All within WINDOW_MS.
 *
 * "No technique got through" is told only when it is confirmed to be the
 * network's doing, not the service having an outage (a server that takes
 * connections and drops them looks exactly like a filter from here): a
 * blockcheck of the service's own name (opts.confirm) says this network
 * filters it, or it held on more than one of the app's addresses, or on the
 * same address again after the engine's rest (BLOCKED_AGAIN_MS later). A
 * "blocked" line about connections that only went unanswered (note
 * "silent") is never told: an app that sends and waits looks the same.
 *
 * Nothing is told while nothing else comes back either (opts.networkWorks):
 * offline, or a network that is down, is not a block. */
const NOTICE_MIN_ADDRS = { service: 2, program: 3 };
const AGAIN_MS = 30 * 1000;
const WINDOW_MS = 5 * 60 * 1000;
const BLOCKED_AGAIN_MS = 9 * 60 * 1000;
const BLOCKED_WINDOW_MS = 30 * 60 * 1000;

class RawWatch {
  /*
   * opts.log(level, msg)
   * opts.tell(id, params)        a notification and a line in the window
   * opts.owner(cport) -> Promise<string|null>   the program holding the app's
   *                              end of a connection to the engine (desktop);
   *                              absent where the system cannot say
   * opts.networkWorks() -> bool|Promise<bool>   other traffic is coming back
   *                              (default: assumed)
   * opts.confirm(service) -> Promise<'blocked'|'open'|'unknown'>   a
   *                              blockcheck of the service's own name
   * opts.now()
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.tell = opts.tell || (() => {});
    this.owner = opts.owner || null;
    this.networkWorks = opts.networkWorks || (() => true);
    this.confirm = opts.confirm || null;
    this.now = opts.now || Date.now;
    this.recent = new Map();     // app -> { kind -> [{ addr, at }] }
    this.told = new Set();       // `${kind} ${app}` told on this network
    this.logged = new Map();     // addr line -> at
    this.hostApp = new Map();    // host -> app name learnt from a program
  }

  networkChanged() { this.recent.clear(); this.told.clear(); this.logged.clear(); }

  async _who(msg) {
    let program = null;
    if (this.owner && msg.cport > 0) {
      try { program = programName(await this.owner(msg.cport)); } catch {}
    }
    if (program) {
      if (this.hostApp.size > 500) this.hostApp.clear();
      this.hostApp.set(msg.host, program);
      return { app: program, by: 'program', service: serviceOf(msg.host) };
    }
    const s = serviceOf(msg.host);
    if (s) return { app: s.name, by: 'service', service: s };
    const known = this.hostApp.get(msg.host);
    if (known) return { app: known, by: 'program', service: null };
    return { app: null, by: null, service: null };
  }

  _logRarely(k, line, now) {
    if (now - (this.logged.get(k) || -Infinity) < 30 * 60 * 1000) return 'quiet';
    if (this.logged.size > 500) this.logged.clear();
    this.logged.set(k, now);
    this.log('info', line);
    return 'logged';
  }

  /* An engine line marked raw: kind 'unreachable' or 'blocked' ('bypass' is
   * the engine-manager's ordinary success line). Resolves what was done. */
  async onEvent(kind, msg) {
    if (!msg || !msg.host || (kind !== 'unreachable' && kind !== 'blocked')) return null;
    // A name that did not resolve is DNS, not a blocked address.
    if (kind === 'unreachable' && msg.stage === 'dns') return 'ignored';
    const addr = String(msg.host).includes(':') ? `[${msg.host}]:${msg.port}` : `${msg.host}:${msg.port}`;
    const now = this.now();
    const unreachLine = `${addr}: could not be reached (not a web connection)`;
    const blockedLine = `${addr}: still blocked after ${msg.attempts || 0} techniques (not a web connection)`;
    // Only unanswered, never refused: a protocol that sends and waits looks
    // the same. A line, never a notification.
    if (kind === 'blocked' && msg.note === 'silent') return this._logRarely(`silent ${addr}`, blockedLine, now) === 'logged' ? 'silent' : 'quiet';
    const { app, by, service } = await this._who(msg);
    if (!app) return this._logRarely(`${kind} ${addr}`, kind === 'unreachable' ? unreachLine : blockedLine, now);
    let per = this.recent.get(app);
    if (!per) { per = { unreachable: [], blocked: [] }; this.recent.set(app, per); }
    const seen = per[kind].filter((e) => now - e.at <= (kind === 'blocked' ? BLOCKED_WINDOW_MS : WINDOW_MS));
    seen.push({ addr, at: now });
    per[kind] = seen;
    const addrs = new Set(seen.map((e) => e.addr));
    let enough;
    if (kind === 'unreachable') {
      const again = by === 'service' && seen.some((e) => e.addr === addr && now - e.at >= AGAIN_MS);
      enough = addrs.size >= NOTICE_MIN_ADDRS[by] || again;
    } else {
      enough = addrs.size >= 2 || seen.some((e) => e.addr === addr && now - e.at >= BLOCKED_AGAIN_MS);
      if (!enough && service && this.confirm) {
        let r = 'unknown';
        try { r = await this.confirm(service); } catch {}
        enough = r === 'blocked';
      }
    }
    if (!enough) return 'counting';
    const key = `${kind} ${app}`;
    if (this.told.has(key)) return 'told';
    let works = true;
    try { works = !!(await this.networkWorks()); } catch {}
    if (!works) return 'offline';
    if (this.told.has(key)) return 'told';
    this.told.add(key);
    const list = [...addrs].slice(0, 3).join(', ');
    if (kind === 'unreachable') {
      this.log('warning', `${app} cannot reach its servers (${list}): the network blocks those addresses themselves; only the app's own proxy setting or a VPN gets around that`);
      this.tell('autoRawUnreachable', { app });
    } else {
      this.log('warning', `${app}: the network stops its connections (${list}) and no technique got through; only the app's own proxy setting or a VPN gets around that`);
      this.tell('autoRawBlocked', { app });
    }
    return 'notified';
  }
}

module.exports = { SERVICES, serviceOf, pacRanges, pacRanges6, programName, inCidr, v4Bytes, v6Bytes, RawWatch, NOTICE_MIN_ADDRS, AGAIN_MS, WINDOW_MS, BLOCKED_AGAIN_MS };
