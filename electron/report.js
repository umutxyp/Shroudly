'use strict';

/*
 * "Something not working?" (components/ReportDialog.js): what the user
 * wrote, a few facts about this computer and the log, sent to
 * codeshare.me (POST /api/shroudly/report, on Codeshare's own server), which
 * mails it to the developer and keeps nothing. Only when the user presses
 * Send, after reading what goes.
 *
 * On this computer: the references of the reports sent, with when, for
 * HISTORY_MS (then they go by themselves), so the user can quote one; and
 * the times, so no more than one goes an hour and three a day (the server
 * holds its own limits too). Nothing else is kept.
 *
 * The request goes like the app's other requests (presence.js): through the
 * system proxy, so with protection on, through Shroudly's engine.
 */

const zlib = require('zlib');
const crypto = require('crypto');

const URL_REPORT = 'https://codeshare.me/api/shroudly/report';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const HISTORY_MS = 60 * DAY;
const PER_HOUR = 1;
const PER_DAY = 3;
const LOG_MAX_CHARS = 2 * 1024 * 1024;
const REF_RE = /^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
// What each field may hold, as the server takes it (longer is cut there).
const FIELD_MAX = { what: 1000, site: 300, isp: 120, country: 80, contact: 200 };
// What went wrong, in characters (not UTF-16 units: the server counts the
// same way).
const WHAT_MIN = 50;
const WHAT_MAX = 1000;
const POW_BITS = 18;
const POW_PREFIX = 'shroudly-report-v1';
const chars = (s) => [...String(s || '').trim()].length;

/* The references kept, newest first, without those older than HISTORY_MS
 * or not looking like one. */
function history(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r.ref === 'string' && REF_RE.test(r.ref) && Number.isFinite(r.at) && r.at <= now + 60000 && now - r.at < HISTORY_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, 50);
}

/* 0 when one may go now; else how long to wait (ms), and which limit. */
function wait(list, now = Date.now()) {
  const h = history(list, now);
  const hour = h.filter((r) => now - r.at < HOUR);
  const day = h.filter((r) => now - r.at < DAY);
  if (day.length >= PER_DAY) return { ms: day[PER_DAY - 1].at + DAY - now, limit: 'day' };
  if (hour.length >= PER_HOUR) return { ms: hour[PER_HOUR - 1].at + HOUR - now, limit: 'hour' };
  return { ms: 0, limit: null };
}

function text(v, max) {
  return typeof v === 'string' ? [...v.trim()].slice(0, max).join('') : '';
}

function zeroBits(b) {
  let n = 0;
  for (const byte of b) {
    if (byte === 0) { n += 8; continue; }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

/* The proof of work the server asks of every report (codeshare.me,
 * server/shroudly/report.ts powOk): "<unix seconds>.<nonce>" such that
 * SHA-256 of "shroudly-report-v1\n<seconds>\n<SHA-256 of the body, hex>\n
 * <nonce>" starts with POW_BITS zero bits. A fraction of a second, worked
 * in slices so the app never stalls. */
async function proofOfWork(body, { bits = POW_BITS, now = Date.now() } = {}) {
  const at = Math.floor(now / 1000);
  const bh = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  for (let n = 0; ; n++) {
    const nonce = n.toString(16);
    const h = crypto.createHash('sha256').update(`${POW_PREFIX}\n${at}\n${bh}\n${nonce}`, 'utf8').digest();
    if (zeroBits(h) >= bits) return `${at}.${nonce}`;
    if (n % 4096 === 4095) await new Promise((r) => setImmediate(r));
  }
}

/* The request's body. `log` is the log's text (cut from the start when too
 * long: the end is what matters). */
function payload({ fields = {}, version, platform, os, device, lang, log = '' }) {
  let l = String(log || '');
  if (l.length > LOG_MAX_CHARS) l = `[… the start was cut]\n${l.slice(-LOG_MAX_CHARS)}`;
  return {
    v: 1,
    app: { platform, version, os: text(os, 100), device: text(device, 100) },
    lang: text(lang, 20),
    what: text(fields.what, FIELD_MAX.what),
    site: text(fields.site, FIELD_MAX.site),
    isp: text(fields.isp, FIELD_MAX.isp),
    country: text(fields.country, FIELD_MAX.country),
    contact: text(fields.contact, FIELD_MAX.contact),
    log: zlib.gzipSync(Buffer.from(l, 'utf8'), { level: 9 }).toString('base64'),
  };
}

/* POST it with `request` (electron's net.request, or a stand-in in tests):
 * {ok, ref} or {ok: false, error: 'rate'|'bad'|'off'|'mail'|'network', retryAfter}. */
async function send(request, body, { url = URL_REPORT, timeoutMs = 45000, bits = POW_BITS } = {}) {
  const json = JSON.stringify(body);
  const proof = await proofOfWork(json, { bits });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let req;
    try {
      req = request({ method: 'POST', url });
      req.setHeader('content-type', 'application/json');
      req.setHeader('x-shroudly-app', `${body.app.platform}/${body.app.version}`);
      req.setHeader('x-shroudly-pow', proof);
    } catch { finish({ ok: false, error: 'network' }); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch {} finish({ ok: false, error: 'network' }); }, timeoutMs);
    let data = '';
    req.on('response', (res) => {
      res.on('data', (d) => { if (data.length < 4096) data += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(data); } catch {}
        if (res.statusCode === 200 && j && j.ok && typeof j.ref === 'string' && REF_RE.test(j.ref)) { finish({ ok: true, ref: j.ref }); return; }
        const error = j && typeof j.error === 'string' && ['rate', 'bad', 'off', 'mail'].includes(j.error) ? j.error : 'network';
        finish({ ok: false, error, retryAfter: j && Number.isFinite(j.retryAfter) ? j.retryAfter : undefined });
      });
      res.on('error', () => finish({ ok: false, error: 'network' }));
    });
    req.on('error', () => finish({ ok: false, error: 'network' }));
    req.end(json);
  });
}

/* The Connections list (the engine's CONNS) as lines of the report: the
 * names Shroudly did something to (a technique, Tor, the user's own server),
 * and those of the apps it looks after (`apps(host)`: Discord, Roblox,
 * Riot's games) however they went, so a report says whether Shroudly touched
 * a sign-in or a game at all. Other names that went through untouched are
 * left out: they would be the user's browsing, which a report does not
 * carry. Those it did something to first, then the busiest; at most `max`. */
/* The apps whose names a report keeps however they went: the engine's own
 * families (core/src/engine.c SITE_FAMILY), the same list on every
 * platform (Report.kt, Report.swift). */
const APP_DOMAINS = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordcdn.com', 'discord.co', 'youtube.com',
  'youtu.be', 'ytimg.com', 'googlevideo.com', 'ggpht.com', 'youtube-nocookie.com', 'x.com', 'twitter.com', 'twimg.com',
  't.co', 'instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'fb.com', 'fbsbx.com', 'messenger.com',
  'whatsapp.com', 'whatsapp.net', 'telegram.org', 't.me', 'telegram.me', 'telesco.pe', 'tdesktop.com', 'telegra.ph',
  'roblox.com', 'rbxcdn.com', 'rbx.com', 'rbxinfra.net', 'riotgames.com', 'leagueoflegends.com', 'pvp.net', 'riotcdn.net',
  'playvalorant.com', 'lolstatic.com', 'rgpub.io', 'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'spotify.com', 'scdn.co',
  'spotifycdn.com', 'reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com', 'tiktok.com', 'tiktokcdn.com', 'tiktokv.com',
  'signal.org', 'whispersystems.org',
];
function isApp(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return APP_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
const ROUTE_ORDER = { tor: 0, server: 1, technique: 2, direct: 3 };
/* What a row says beyond its count, as the engine keeps it (core/src/
 * conns.c): how many are open now, what went each way, and how long ago the
 * name was last used. A connection that got nothing back ("down 0 B"), or
 * one that sits open and silent, is what a report most often needs to see
 * (a Discord stuck on "Starting" with one connection to each name). */
function bytes(n) {
  const v = Number(n) || 0;
  return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : v >= 1024 ? `${Math.round(v / 1024)} KB` : `${v} B`;
}
function connDetail(r) {
  const parts = [];
  if (Number(r.active) > 0) parts.push(`${Number(r.active)} open`);
  if (r.up != null || r.down != null) parts.push(`up ${bytes(r.up)}, down ${bytes(r.down)}`);
  if (r.ago != null && Number.isFinite(Number(r.ago))) parts.push(`last ${Math.round(Number(r.ago) / 1000)} s ago`);
  return parts.length ? `  ${parts.join(', ')}` : '';
}

function connsText(rows, max = 60, apps = isApp) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.host === 'string' && r.host
    && ((r.route && r.route !== 'direct') || apps(r.host)));
  if (!list.length) return '(none)';
  list.sort((a, b) => ((ROUTE_ORDER[a.route] ?? 3) - (ROUTE_ORDER[b.route] ?? 3)) || ((b.conns || 0) - (a.conns || 0)) || a.host.localeCompare(b.host));
  const lines = list.slice(0, max).map((r) => {
    const extra = [r.blocked ? 'blocked by the user' : '', r.refused ? `${r.refused} refused` : ''].filter(Boolean).join(', ');
    return `${r.host.slice(0, 120)}  ${r.route || 'direct'}  ${r.conns || 0} conns${connDetail(r)}${extra ? `  (${extra})` : ''}`;
  });
  if (list.length > max) lines.push(`(+${list.length - max} more)`);
  return lines.join('\n');
}

/* The section: this session's list, or, protection off, the one of the
 * session that ended last (kept in memory until the next start). */
function connsSection(on, rows, last) {
  if (on) return `== Connections this session ==\n${connsText(rows)}`;
  if (last && Array.isArray(last.rows)) return `== Connections last session (ended ${new Date(last.at).toISOString()}) ==\n${connsText(last.rows)}`;
  return '== Connections ==\n(protection is off, and has not run since Shroudly started)';
}

/* The engine's last events about sites (engine-manager.js siteEvents), one
 * line each, newest last: when, what, the name, and what the engine said of
 * it (technique, tries, the note). */
function siteEventsSection(events, max = 80) {
  const list = (Array.isArray(events) ? events : []).slice(-max);
  if (!list.length) return '== Recent site events ==\n(none)';
  const lines = list.map((e) => {
    const t = new Date(e.at).toISOString().slice(11, 19);
    const rest = Object.entries(e).filter(([k]) => !['at', 'type', 'host'].includes(k))
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' ');
    return `${t} ${e.type} ${String(e.host || '').slice(0, 120)}${rest ? ` ${rest}` : ''}`;
  });
  return `== Recent site events ==\n${lines.join('\n')}`;
}

module.exports = { siteEventsSection, connDetail, URL_REPORT, HISTORY_MS, PER_HOUR, PER_DAY, FIELD_MAX, WHAT_MIN, WHAT_MAX, POW_BITS, REF_RE, chars, history, wait, payload, proofOfWork, send, connsText, connsSection, isApp, APP_DOMAINS };
