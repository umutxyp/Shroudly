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

/* Cloudflare evicts an idle Durable Object from memory between requests, so
 * the id list is also kept in its storage and loaded back when the object
 * wakes up. Joins and leaves (one per app launch / quit) are saved at once;
 * routine pings only refresh timestamps and are saved in one batched write at
 * most every SAVE_EVERY_MS, so writes stay low however many users ping. */
const SAVE_EVERY_MS = 30000;

export class Presence {
  constructor(state) {
    this.state = state;
    this.seen = new Map(); // id -> last ping (ms)
    this.dirty = false;
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('seen');
      if (saved) this.seen = new Map(Object.entries(saved));
    });
  }

  interval() {
    const n = this.seen.size;
    return n < 500 ? 60 : n < 3000 ? 180 : 300;
  }

  prune(now) {
    // Expire ids that missed more than two pings (interval as seen by clients).
    const ttl = this.interval() * 2.5 * 1000;
    for (const [id, t] of this.seen) if (now - t > ttl) { this.seen.delete(id); this.dirty = true; }
  }

  async saveNow() {
    this.dirty = false;
    await this.state.storage.put('seen', Object.fromEntries(this.seen));
  }

  async scheduleSave() {
    this.dirty = true;
    if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(Date.now() + SAVE_EVERY_MS);
  }

  async alarm() {
    this.prune(Date.now());
    if (this.dirty) await this.saveNow();
    // Keep saving while anyone is online, so expiries are persisted too.
    if (this.seen.size) await this.state.storage.setAlarm(Date.now() + SAVE_EVERY_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (request.method === 'POST') {
      let id = '';
      try { id = String((await request.json()).id || ''); } catch {}
      if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
      const joined = !this.seen.has(id);
      if (url.pathname === '/v1/leave') { if (!joined) { this.seen.delete(id); await this.saveNow(); } }
      else {
        this.seen.set(id, now);
        if (joined) await this.saveNow(); else await this.scheduleSave();
      }
    }
    this.prune(now);
    return json({ online: this.seen.size, interval: this.interval() });
  }
}

/* ── always-latest download redirects ─────────────────────────────────────
 * /dl                -> the latest release page
 * /dl/<key>          -> 302 to that platform's installer in the latest release
 *
 * NO GITHUB API. This used to read api.github.com/.../releases/latest, which
 * is limited to 60 unauthenticated requests an hour per IP — and a Worker
 * shares its egress IPs with everyone else's Workers, so the limit was often
 * spent before we asked. The 10-minute cache did not help much: caches.default
 * is per data centre, so most visitors landed on a cold one. Every refused
 * lookup sent the visitor to the release page instead of the file.
 *
 * Now the version comes from the redirect github.com itself serves for
 * /releases/latest (-> /releases/tag/vX.Y.Z), which is not an API call and
 * has no such limit, and the filename is built from the fixed shape
 * electron-builder gives every release. Each built URL is checked once with a
 * HEAD before it is handed out, so a release whose assets are still uploading
 * falls back to the release page rather than to a 404.
 *
 * Both lookups are cached per data centre for 5 minutes; a failed one is not
 * cached, so the next request simply tries again. */
const DL_FILES = {
  'windows-x64':     (v) => `Shroudly-${v}-Windows-x64-Setup.exe`,
  'windows-arm64':   (v) => `Shroudly-${v}-Windows-arm64-Setup.exe`,
  'macos-arm64':     (v) => `Shroudly-${v}-macOS-arm64.dmg`,
  'macos-x64':       (v) => `Shroudly-${v}-macOS-x64.dmg`,
  'macos-arm64-zip': (v) => `Shroudly-${v}-macOS-arm64.zip`,
  'macos-x64-zip':   (v) => `Shroudly-${v}-macOS-x64.zip`,
  'linux-x64':       (v) => `Shroudly-${v}-Linux-x86_64.AppImage`,
  'linux-arm64':     (v) => `Shroudly-${v}-Linux-arm64.AppImage`,
  'linux-deb':       (v) => `Shroudly-${v}-Linux-amd64.deb`,
  // electron-builder names these two differently from each other: x64 for the
  // Arch package, x86_64 for the RPM. Copied from what it actually produces.
  'linux-pacman':    (v) => `Shroudly-${v}-Linux-x64.pacman`,
  'linux-rpm':       (v) => `Shroudly-${v}-Linux-x86_64.rpm`,
};
const REPO = 'https://github.com/umutxyp/Shroudly';
const RELEASES_LATEST = `${REPO}/releases/latest`;
const CACHE_SECONDS = 300;
const TAG_RE = /\/releases\/tag\/(v?(\d+\.\d+\.\d+[^/?#]*))$/;

/* A tiny string cache on caches.default, keyed by a URL we never serve. */
async function cached(name, ctx, produce) {
  const key = new Request(`https://shroudly.codeshare.me/__cache/${encodeURIComponent(name)}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.text();
  const value = await produce();
  if (value) {
    const res = new Response(value, { headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}` } });
    ctx.waitUntil(caches.default.put(key, res));
  }
  return value;
}

/* "v2.3.0" -> { tag: "v2.3.0", version: "2.3.0" }, or null. */
async function latestTag(ctx) {
  const tag = await cached('latest-tag', ctx, async () => {
    const res = await fetch(RELEASES_LATEST, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'user-agent': 'shroudly-dl' },
    });
    const m = (res.headers.get('location') || '').match(TAG_RE);
    return m ? m[1] : null;
  });
  if (!tag) return null;
  return { tag, version: tag.replace(/^v/, '') };
}

async function assetExists(url, ctx) {
  const ok = await cached(`asset:${url}`, ctx, async () => {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'shroudly-dl' } });
    // github.com answers an existing asset with a redirect to its storage.
    return res.status === 302 || res.status === 200 ? '1' : null;
  });
  return ok === '1';
}

async function handleDownload(pathname, ctx) {
  const key = pathname.replace(/^\/dl\/?/, '');
  if (!key) return Response.redirect(RELEASES_LATEST, 302);
  const file = DL_FILES[key];
  if (!file) return new Response('unknown download key', { status: 404 });
  try {
    const latest = await latestTag(ctx);
    if (latest) {
      const url = `${REPO}/releases/download/${latest.tag}/${file(latest.version)}`;
      if (await assetExists(url, ctx)) return Response.redirect(url, 302);
    }
  } catch {
    /* github.com unreachable: the release page is still the right answer */
  }
  return Response.redirect(RELEASES_LATEST, 302);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && (pathname === '/dl' || pathname.startsWith('/dl/'))) {
      return handleDownload(pathname, ctx);
    }
    const route = `${request.method} ${pathname}`;
    if (route === 'POST /v1/ping' || route === 'POST /v1/leave' || route === 'GET /v1/online') {
      const stub = env.PRESENCE.get(env.PRESENCE.idFromName('global'));
      return stub.fetch(request);
    }
    return json({ error: 'not found' }, 404);
  },
};
