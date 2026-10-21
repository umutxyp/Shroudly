'use strict';

/* --watch: the engine tells the app when a program connects to a watched
 * domain (the desktop app watches Discord's voice servers: a call starting,
 * whose sound goes over UDP), once per name in a while, and changes nothing
 * about the connection. */

const tls = require('tls');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-watch');

/* One TLS request through the engine to the local server, with `name` as the
 * server name (the test certificate is trusted; its name is not the one
 * asked for). Resolves the answer. */
async function fetchAs(socksPort, port, name) {
  const raw = await socks(socksPort, '127.0.0.1', port);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: raw, servername: name, ca: testServerOptions().cert, checkServerIdentity: () => undefined }, () => s.write('ping'));
    let got = '';
    s.on('data', (d) => { got += d; if (got.includes('pong')) { s.end(); resolve(got); } });
    s.on('error', reject);
    setTimeout(() => reject(new Error('no answer')), 5000);
  });
}

(async () => {
  const srv = tls.createServer(testServerOptions(), (c) => { c.on('data', () => c.write('pong')); c.on('error', () => {}); });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const P = await freePort();
  const eng = await startEngine(P, ['--watch', 'Discord.Media', '--watch', 'not a domain']);
  const seen = () => eng.out.split('\n').filter((l) => l.includes('"type":"seen"')).map((l) => JSON.parse(l).host);
  try {
    t.ok(await fetchAs(P, port, 'c-ist01-1a2b.discord.media') === 'pong', 'a connection to a watched name works as ever');
    await fetchAs(P, port, 'c-ist01-1a2b.discord.media');
    await fetchAs(P, port, 'gateway.discord.gg');
    await fetchAs(P, port, 'notdiscord.media');
    await sleep(200);
    t.ok(JSON.stringify(seen()) === '["c-ist01-1a2b.discord.media"]',
      `told once for the watched name, never for others (${JSON.stringify(seen())})`);
    await fetchAs(P, port, 'latency.discord.media');
    await sleep(200);
    t.ok(seen().length === 2 && seen()[1] === 'latency.discord.media', 'another name under the watched domain is its own news');
    t.ok(eng.exited === null, 'a domain that is not one is left out, and the engine runs');
  } finally {
    eng.stop();
    srv.close();
  }
  console.log(`engine-watch: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
