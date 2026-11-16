'use strict';

/*
 * "Only this country's network works": the connection to the rest of the
 * world cut while sites inside the country still open, as in Iran's
 * shutdowns (only the National Information Network left) and others like
 * them. No app gets past that, Shroudly included: nothing leaves the
 * country. Told as such, with where to read what can still help, instead
 * of "No internet", which reads as Shroudly having broken it.
 *
 * Asked only once the world's control addresses take no connection
 * (engine-manager.js, _checkOffline). Then a TLS handshake to large sites
 * hosted inside their own countries, all at once, straight from this
 * computer: one that completes, with its own valid certificate, says the
 * network inside the country is up. A sign-in page (a hotel's, a cafe's)
 * cannot show a site's certificate, so it is not taken for one. No country
 * needs to be guessed: while the world is out of reach, only the sites of
 * the country one is in can answer. A site listed here that is in fact
 * served from abroad only makes a shutdown read as "No internet", as before.
 */

const dns = require('dns');
const { handshake } = require('./blockcheck');

const DOMESTIC = {
  IR: ['www.digikala.com', 'www.aparat.com', 'divar.ir', 'www.zoomit.ir', 'www.shaparak.ir'],
  RU: ['ya.ru', 'vk.com', 'www.gosuslugi.ru'],
  BY: ['www.belta.by', 'onliner.by'],
  KZ: ['egov.kz', 'kaspi.kz'],
  UZ: ['my.gov.uz', 'kun.uz'],
  TM: ['turkmenportal.com'],
  AZ: ['www.azertag.az'],
  CN: ['www.baidu.com', 'www.qq.com'],
  TR: ['www.turkiye.gov.tr'],
  PK: ['www.ptcl.com.pk'],
  IQ: ['www.ina.iq'],
  ET: ['www.ethiotelecom.et'],
  MM: ['www.mpt.com.mm'],
};

/* The first IPv4 address the system's own DNS gives, or null. */
function lookup4(host, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    dns.lookup(host, { family: 4 }, (err, address) => { clearTimeout(timer); resolve(err ? null : address); });
  });
}

/* { country, host } of the first site of a country that answers, or null.
 * opts.lookup and opts.handshake stand in for the network in tests. */
function domesticAnswers({ ms = 5000, lookup = lookup4, hs = handshake, sites = DOMESTIC, tz = systemZone() } = {}) {
  // Only the countries it can be: a site of another country of the list
  // answering alone is that site abroad and reachable, not this network cut
  // off from the world (Iran's digikala.com answering a phone in Turkey for
  // a moment while the rest did not: SR-XM82).
  const list = Object.entries(sites).filter(([country]) => plausible(country, tz))
    .flatMap(([country, hosts]) => hosts.map((host) => ({ country, host })));
  return new Promise((resolve) => {
    let left = list.length;
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => finish(null), ms * 2 + 500);
    if (!left) { finish(null); return; }
    for (const s of list) {
      Promise.resolve(lookup(s.host, ms))
        .then((ip) => (ip ? hs({ ip, servername: s.host, ms }) : 'no address'))
        .catch(() => 'error')
        .then((r) => {
          if (r === 'ok') finish({ country: s.country, host: s.host });
          else if (--left === 0) finish(null);
        });
    }
  });
}

/* The system's time zones of the countries above. */
const ZONES = {
  IR: ['Asia/Tehran'],
  RU: ['Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara', 'Europe/Volgograd', 'Europe/Saratov', 'Europe/Ulyanovsk',
    'Europe/Astrakhan', 'Europe/Kirov', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Barnaul', 'Asia/Tomsk',
    'Asia/Novokuznetsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Chita', 'Asia/Yakutsk', 'Asia/Khandyga', 'Asia/Vladivostok',
    'Asia/Ust-Nera', 'Asia/Magadan', 'Asia/Sakhalin', 'Asia/Srednekolymsk', 'Asia/Kamchatka', 'Asia/Anadyr'],
  BY: ['Europe/Minsk'],
  KZ: ['Asia/Almaty', 'Asia/Qostanay', 'Asia/Aqtobe', 'Asia/Aqtau', 'Asia/Atyrau', 'Asia/Oral', 'Asia/Qyzylorda'],
  UZ: ['Asia/Tashkent', 'Asia/Samarkand'],
  TM: ['Asia/Ashgabat'],
  AZ: ['Asia/Baku'],
  CN: ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin'],
  TR: ['Europe/Istanbul', 'Asia/Istanbul'],
  PK: ['Asia/Karachi'],
  IQ: ['Asia/Baghdad'],
  ET: ['Africa/Addis_Ababa'],
  MM: ['Asia/Yangon', 'Asia/Rangoon'],
};

function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

/* The country the user is in, as well as it is known: the one the system's
 * time zone is in, else the one whose own network answered in a shutdown
 * (remembered), else null. The zone first: the user chose it, while a site
 * of another country answering in a bad moment once made a phone in Turkey
 * "Iranian" for good, its decoys Iranian names (SR-XM82). */
function zoneCountry(tz) {
  for (const [cc, zones] of Object.entries(ZONES)) if (zones.includes(tz)) return cc;
  return null;
}

/* A time zone that names no place (UTC, GMT, Etc/...): it says nothing of
 * the country. Any other zone does, even one of a country not on the list. */
function genericZone(tz) {
  return !tz || /^(UTC|GMT|UCT|Zulu|Universal|Greenwich|Etc\/.*)$/i.test(String(tz));
}

/* Whether cc's own sites answering alone can mean a national-only network
 * here: only when the time zone is cc's, or names no place. A zone of
 * another country, on the list or not, says it is only abroad (Iranian and
 * Russian sites answering a phone in Qatar for a moment, SR-F040). */
function plausible(cc, tz = systemZone()) {
  const z = zoneCountry(tz);
  return z === cc || (z === null && genericZone(tz));
}

function homeCountry({ remembered, tz = systemZone() } = {}) {
  const z = zoneCountry(tz);
  if (z) return z;
  // Remembered from a shutdown only where the zone names no place: a zone of
  // a country not on the list (Asia/Qatar) is that country, not a remembered
  // one (SR-F040: a phone in Qatar kept Iranian decoys).
  if (remembered && DOMESTIC[remembered] && genericZone(tz)) return remembered;
  return null;
}

/* The names a decoy carries in that country (core/src/proto.h, --decoy-name):
 * its large sites, the ones a network that lets only allowed sites through
 * keeps open. A real name, as zapret's and GoodbyeDPI's decoys carry, does as
 * well as a scrambled one against a filter that blocks a list. */
function decoyNames(country) {
  return country && DOMESTIC[country] ? DOMESTIC[country].slice(0, 8) : [];
}

/* Where Tor itself is blocked (components/helpNudge.js NOT_FROM, HelpNudge.kt,
 * HelpNudge.swift: the same list): helping others is not offered there and a
 * Snowflake proxy left on does not run; the user is among those who need it. */
const TOR_BLOCKED = ['BY', 'CN', 'IR', 'MM', 'RU', 'TM'];
const torBlocked = (country) => !!country && TOR_BLOCKED.includes(String(country).toUpperCase());

module.exports = { domesticAnswers, DOMESTIC, ZONES, homeCountry, plausible, decoyNames, TOR_BLOCKED, torBlocked };
