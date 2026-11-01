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
function domesticAnswers({ ms = 5000, lookup = lookup4, hs = handshake, sites = DOMESTIC } = {}) {
  const list = Object.entries(sites).flatMap(([country, hosts]) => hosts.map((host) => ({ country, host })));
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

module.exports = { domesticAnswers, DOMESTIC };
