'use strict';

/* A plain-HTTP filter that answers a blocked Host with its own block page
 * instead of resetting it (core/src/engine.c, http_reply_blocked): a 302 to
 * a block-page address (TTNET's 195.175.254.2), a 302 to a private address,
 * or a 403 that frames Iran's 10.10.34.34. The engine's auto mode used to
 * take that for the site's answer, so its HTTP techniques were never tried;
 * now it goes on, and the site comes. A site's own redirect elsewhere, and
 * a site's own 403, are still passed on as they came. */

const net = require('net');
const H = require('./helpers');

const t = H.suite('engine-http-blockpage');

const PAGES = {
  'redirect to a block page': 'HTTP/1.1 302 Found\r\nLocation: http://195.175.254.2/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
  'redirect to a private address': 'HTTP/1.1 302 Moved Temporarily\r\nLocation: http://10.20.30.40/blocked.html?u=blocked.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
  "Iran's framed page": 'HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head></head><body><iframe src="http://10.10.34.34?type=Invalid Site&policy=MainPolicy " style="width: 100%; height: 100%"></iframe></body></html>',
};

/* What a filter sends for the blocked name whole in one segment; anything
 * else (the techniques split or scramble it) reaches the "site". */
function censor(page, siteReply) {
  return net.createServer((c) => {
    c.on('error', () => {});
    c.on('data', (d) => {
      const s = d.toString('latin1');
      if (s.includes('Host: blocked.example')) { c.end(page); return; }
      if (/\r\n\r\n/.test(s) || /host:/i.test(s)) c.end(siteReply);
    });
  }).listen(0, '127.0.0.1');
}

async function get(P, port) {
  const s = await H.socks(P, '127.0.0.1', port);
  return new Promise((res) => {
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => res(out.split('\r\n')[0] || '(nothing)'));
    s.on('error', () => {});
    s.write('GET / HTTP/1.1\r\nHost: blocked.example\r\nUser-Agent: x\r\nConnection: close\r\n\r\n');
    setTimeout(() => s.destroy(), 20000);
  });
}

(async () => {
  const OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
  for (const [kind, page] of Object.entries(PAGES)) {
    const c = censor(page, OK);
    await new Promise((r) => c.once('listening', r));
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--auto']);
    const first = await get(P, c.address().port);
    await H.sleep(300);
    const bypass = eng.out.split('\n').some((l) => /"type":"bypass"/.test(l) && /blocked\.example/.test(l));
    t.ok(first === 'HTTP/1.1 200 OK' && bypass, `${kind}: taken for the filter's, the HTTP techniques tried, the site opens (${first})`);
    eng.stop(); c.close();
  }
  // The site's own answers are not refusals: a redirect to a public name and
  // a 403 with no block-page address in it come through as they are.
  for (const [kind, reply] of Object.entries({
    "a site's own redirect": 'HTTP/1.1 301 Moved Permanently\r\nLocation: https://www.example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    "a site's own 403": 'HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\nforbidden',
  })) {
    const site = net.createServer((c) => { c.on('error', () => {}); c.on('data', () => c.end(reply)); }).listen(0, '127.0.0.1');
    await new Promise((r) => site.once('listening', r));
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--auto']);
    const first = await get(P, site.address().port);
    t.ok(first === reply.split('\r\n')[0], `${kind}: passed on as it came (${first})`);
    eng.stop(); site.close();
  }
  console.log(`engine-http-blockpage: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
