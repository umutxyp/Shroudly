'use strict';

/*
 * What a report must carry, checked before it goes (the window, as the user
 * types, and electron/report.js again): what happened in real words, the site
 * or app, and an e-mail address that can receive an answer. The report server
 * (codeshare website/server/shroudly/report.ts) checks the same and also that
 * the address's domain takes mail; Report.kt and Report.swift say the same.
 *
 * Most reports from some countries were a word or a keyboard mash, with a
 * Telegram name or a made-up address, about what no app can change. Only an
 * e-mail address is taken, never a Telegram or other messenger name.
 */

const WHAT_MIN = 80;
const WHAT_MAX = 1000;
const WHAT_WORDS = 8;

// Throwaway mailboxes: an answer sent there reaches nobody.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'temp-mail.io', 'tempmailo.com', 'tempail.com', 'tmpmail.org', 'tmpmail.net', 'trashmail.com', 'trashmail.de',
  'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
  'emailondeck.com', 'mohmal.com', 'mailnesia.com', 'mytemp.email', 'tempinbox.com', 'spamgourmet.com', 'mailcatch.com',
  'moakt.com', 'emailfake.com', 'fakemail.net', 'burnermail.io', 'dropmail.me', 'tempr.email', 'discard.email',
  'mail.tm', 'mail.gw', '1secmail.com', '1secmail.org', '1secmail.net', 'inboxkitten.com', 'mailpoof.com', 'linshiyouxiang.net',
]);
// Names no one has a mailbox under.
const FAKE_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'test.org', 'domain.com', 'email.test',
  'localhost', 'abc.com', 'xyz.com', 'asd.com', 'aaa.com', 'qwe.com', 'asdf.com', 'mail.com.com', 'gmail.co', 'gmial.com', 'gamil.com']);
const FAKE_LOCAL = /^(test|testing|tester|example|admin|user|email|mail|fake|spam|none|no|null|nobody|asd+f*|qwe+r*t*y*|zxc+|abc+d*|x+|a+|1+2*3*4*5*6*)$/i;

/** An e-mail address, and not a made-up or throwaway one. */
function contactOk(v) {
  const s = String(v || '').trim();
  const m = /^([^\s@]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})$/.exec(s);
  if (!m || s.length > 200) return false;
  const local = m[1];
  const domain = m[2].toLowerCase();
  if (FAKE_LOCAL.test(local) || /^(.)\1+$/.test(local)) return false;
  if (DISPOSABLE.has(domain) || FAKE_DOMAINS.has(domain)) return false;
  // A run of Latin letters with no vowel at all: typed at random.
  if (/^[b-df-hj-np-tv-xz]{6,}$/i.test(local)) return false;
  return true;
}

/** What happened, said in words: WHAT_MIN characters and WHAT_WORDS words,
 *  not one letter over and over and not a keyboard mash, in any script. */
function whatOk(v) {
  const t = String(v || '').trim();
  const chars = [...t];
  if (chars.length < WHAT_MIN || chars.length > WHAT_MAX) return false;
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length < WHAT_WORDS) return false;
  if (new Set(words.map((w) => w.toLowerCase())).size < 5) return false;
  const letters = chars.filter((c) => /\p{L}/u.test(c));
  if (letters.length < chars.length * 0.5) return false;
  if (/(.)\1{5,}/u.test(t)) return false;
  const count = new Map();
  for (const c of letters) { const k = c.toLowerCase(); count.set(k, (count.get(k) || 0) + 1); }
  if (Math.max(...count.values()) > letters.length * 0.3) return false;
  const latin = words.filter((w) => /^[A-Za-z]{6,}$/.test(w));
  if (latin.length && latin.filter((w) => !/[aeiouy]/i.test(w)).length > latin.length * 0.4) return false;
  return true;
}

/* What names no site or app: "vpn", "internet", "everything" (a report
 * from Iran named "vpn"). The same list in Report.kt, Report.swift and the
 * report server. */
const SITE_EMPTY = new Set(['vpn', 'proxy', 'internet', 'net', 'wifi', 'wi-fi', 'all', 'everything', 'any', 'anything', 'app', 'apps', 'application', 'site', 'sites', 'website', 'websites', 'web', 'none', 'no', 'nothing', 'test', 'shroudly', 'all sites', 'all apps', 'every site', 'every app', 'همه', 'همه چیز', 'همه سایت ها', 'همه سایتها', 'اینترنت', 'فیلترشکن', 'وی پی ان', 'все', 'всё', 'все сайты', 'интернет', 'впн', 'hepsi', 'her şey', 'herşey', 'tümü', 'tüm siteler', 'uygulama', 'site', 'الكل', 'كل شيء', 'الانترنت', 'كل المواقع', 'انترنت', '全部', '所有', '互联网']);

/** The site or app named: two letters or digits at least, and not a word
 *  that names none (SITE_EMPTY). */
function siteOk(v) {
  const t = String(v || '').trim().toLowerCase().replace(/[\s.,;:!?'"()\[\]{}<>/\\|_*-]+/gu, ' ').trim();
  if ([...t.replace(/[^\p{L}\p{N}]/gu, '')].length < 2) return false;
  return !SITE_EMPTY.has(t);
}

/** The log shows Shroudly was started (the engine at least tried): a report
 *  about something never tried with protection on says nothing. */
function triedOk(log) {
  return /Starting engine/.test(String(log || ''));
}

/** The first thing to put right, or null: 'what', 'site' or 'contact'. */
function problem(fields) {
  const f = fields || {};
  if (!whatOk(f.what)) return 'what';
  if (!siteOk(f.site)) return 'site';
  if (!contactOk(f.contact)) return 'contact';
  return null;
}

/* Where "Something not working?" is offered: only once Shroudly itself went
 * wrong (could not start, the engine ended or stuck, browsers not going
 * through it), for a day, and gone again as soon as a report is sent; every
 * country (the owner, 2026-11-16: most reports were about what no app can
 * change, and they buried the rest). The same rule on Android (Report.kt)
 * and the Apple apps (Report.swift). */
const FAULT_SHOWS_MS = 24 * 60 * 60 * 1000;
function offered(faultAt, lastSentAt, now) {
  return faultAt > lastSentAt && now - faultAt >= 0 && now - faultAt < FAULT_SHOWS_MS;
}

/* A log line that is Shroudly's own going wrong: an error, but not what the
 * user's antivirus did (told on its own, with what to do). */
function faultLine(level, message) {
  return level === 'error' && !/^Security software/i.test(String(message || ''));
}

module.exports = { FAULT_SHOWS_MS, offered, faultLine, WHAT_MIN, WHAT_MAX, WHAT_WORDS, SITE_EMPTY, contactOk, whatOk, siteOk, triedOk, problem };
