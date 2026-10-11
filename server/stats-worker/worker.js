/*
 * Shroudly live user counter (Cloudflare Worker + Durable Object).
 * Deployed at https://shroudly.codeshare.me.
 *
 * Anonymous by design: each running app picks a random id when it starts
 * (not stored on the device) and pings every `interval` seconds. An id that
 * stops pinging expires; quitting removes it at once. Only the ids and their
 * last-seen times live here, in memory: no IPs, headers or anything else about
 * the user is read or stored.
 *
 *   POST /v1/ping   {"id": "<random>"}  -> {"online": n, "interval": s}
 *   POST /v1/leave  {"id": "<random>"}  -> {"online": n, "interval": s}
 *   GET  /v1/online                     -> {"online": n, "interval": s}
 *
 * The server sets the ping interval and widens it as the count grows, keeping
 * the request volume within Workers limits.
 */

const ID_RE = /^[A-Za-z0-9-]{16,64}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });
}

export class Presence {
  constructor() {
    this.seen = new Map(); // id -> last ping (ms)
  }

  interval() {
    const n = this.seen.size;
    return n < 500 ? 60 : n < 3000 ? 180 : 300;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (request.method === 'POST') {
      let id = '';
      try { id = String((await request.json()).id || ''); } catch {}
      if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
      if (url.pathname === '/v1/leave') this.seen.delete(id);
      else this.seen.set(id, now);
    }
    // Expire ids that missed more than two pings (interval as seen by clients).
    const ttl = this.interval() * 2.5 * 1000;
    for (const [id, t] of this.seen) if (now - t > ttl) this.seen.delete(id);
    return json({ online: this.seen.size, interval: this.interval() });
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    if (route === 'POST /v1/ping' || route === 'POST /v1/leave' || route === 'GET /v1/online') {
      const stub = env.PRESENCE.get(env.PRESENCE.idFromName('global'));
      return stub.fetch(request);
    }
    return json({ error: 'not found' }, 404);
  },
};
