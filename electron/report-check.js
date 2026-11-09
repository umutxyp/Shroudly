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

/** The site or app named. */
function siteOk(v) {
  return [...String(v || '').trim()].length >= 2;
}

/** The first thing to put right, or null: 'what', 'site' or 'contact'. */
function problem(fields) {
  const f = fields || {};
  if (!whatOk(f.what)) return 'what';
  if (!siteOk(f.site)) return 'site';
  if (!contactOk(f.contact)) return 'contact';
  return null;
}

module.exports = { WHAT_MIN, WHAT_MAX, WHAT_WORDS, contactOk, whatOk, siteOk, problem };
