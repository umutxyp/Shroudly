'use strict';

/* The block-page list must never catch a real site: no shared cloud space, no
 * duplicates, and none of a few hundred popular sites' addresses (resolved
 * fresh over encrypted DNS) on it. */

const path = require('path');
const net = require('net');
const { ROOT, suite } = require('./helpers');

const fp = require(path.join(ROOT, 'electron', 'censor-fingerprints.js'));
const t = suite('fingerprints');

const DOMAINS = ('google.com youtube.com facebook.com instagram.com whatsapp.com x.com wikipedia.org amazon.com netflix.com microsoft.com apple.com '
  + 'linkedin.com reddit.com yahoo.com bing.com tiktok.com discord.com twitch.tv github.com stackoverflow.com cloudflare.com zoom.us office.com '
  + 'spotify.com telegram.org signal.org ' // global
  + 'yandex.ru vk.com mail.ru ozon.ru wildberries.ru avito.ru gosuslugi.ru rbc.ru ' // RU
  + 'detik.com kompas.com tokopedia.com shopee.co.id tribunnews.com telkomsel.com bca.co.id ' // ID
  + 'flipkart.com hotstar.com jio.com airtel.in ndtv.com sbi.co.in irctc.co.in ' // IN
  + 'baidu.com qq.com taobao.com jd.com weibo.com bilibili.com ' // CN
  + 'digikala.com aparat.com divar.ir ' // IR
  + 'trendyol.com hepsiburada.com sahibinden.com turkiye.gov.tr ' // TR
  + 'daraz.pk dawn.com lazada.co.th vnexpress.net globo.com bbc.co.uk spiegel.de').split(/\s+/).filter(Boolean);

function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const n = (x) => x.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (n(ip) & mask) === (n(base) & mask);
}

(async () => {
  t.ok(fp.ALL.length > 150 && fp.ALL.every((ip) => net.isIPv4(ip)), `${fp.ALL.length} block pages, all IPv4`);
  t.ok(new Set(fp.ALL).size === fp.ALL.length, 'no duplicates');
  const CLOUD = ['3.0.0.0/8', '13.248.0.0/16', '35.71.0.0/16', '52.0.0.0/8', '54.0.0.0/8', '75.2.0.0/16', '76.223.0.0/16', '99.83.0.0/16',
    '34.0.0.0/8', '104.16.0.0/12', '172.64.0.0/13', '167.172.0.0/16', '45.32.0.0/16', '45.77.0.0/16', '95.217.0.0/16'];
  t.ok(!fp.ALL.some((ip) => CLOUD.some((c) => inCidr(ip, c))), 'nothing in shared cloud space (AWS, Google Cloud, Cloudflare, DO, Vultr, Hetzner)');
  t.ok(fp.countryOf('10.10.34.36') === 'IR' && fp.countryOf('195.175.254.2') === 'TR' && fp.countryOf('1.1.1.1') === null, 'countries recognised');

  let ips = 0; const hits = []; let failed = 0;
  await Promise.all(DOMAINS.flatMap((d) => [d, `www.${d}`]).map(async (name) => {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=A`, { headers: { accept: 'application/dns-json' } });
      const j = await r.json();
      for (const a of j.Answer || []) if (a.type === 1) { ips++; if (fp.countryOf(a.data)) hits.push(`${name} -> ${a.data}`); }
    } catch { failed++; }
  }));
  t.ok(ips > 100, `${ips} addresses of ${DOMAINS.length * 2} popular names resolved (${failed} lookups failed)`);
  t.ok(hits.length === 0, hits.length ? `FALSE POSITIVES: ${hits.join(', ')}` : 'none of them is on the block-page list');
  console.log(`fingerprints: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
