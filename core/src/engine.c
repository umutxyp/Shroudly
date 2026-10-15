#include "engine.h"
#include "platform.h"
#include "proto.h"
#include "strategy.h"
#include "desync.h"
#include "doh.h"
#include "fake.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

#define RELAY_BUF   32768
#define FIRST_WAIT  4000   /* ms to gather the client's first payload */
#define QUIET_WAIT   400   /* ms to decide nobody is going to speak first */
#define MAX_CONNS   2048   /* hard cap on concurrent connections (loopback) */

/* ── attempt ladder ──────────────────────────────────────────────────────
 * A censored connection must never reach the browser as an error page. The
 * client's first payload is buffered, so when the filter kills an attempt we
 * can open a fresh connection and replay it with a different desync — the
 * browser only ever sees the attempt that worked. This is what removes the
 * "failed once, works when I reload" behaviour.
 *
 * The first attempt for an unknown host is deliberately PLAIN: a site that is
 * not blocked answers immediately and is then relayed untouched, so ordinary
 * browsing carries no desync, no risk and no added latency. Only when that
 * attempt is refused do we start trying desync strategies, and the one that
 * works is remembered per host, so the cost is paid once. */
#define ATT_PLAIN      (-2)    /* send the payload unmodified */
/* Room for every preset plus an untouched attempt at either end. It used to
 * be 12, which silently cut the last few presets off the ladder; the time
 * budget, not this count, is what bounds a connection. */
#define ATT_MAX         (STRATEGY_MAX_PRESETS + 2)
#define ATT_BUDGET_MS   15000
/* An attempt given less than this to be answered is not an attempt: it is not
 * started, and not counted. */
#define ATT_MIN_WAIT_MS  500
/* Less budget than this left after an attempt: no room for a re-dial and then
 * ATT_MIN_WAIT_MS of waiting, so the ladder ends there. */
#define ATT_MIN_LEFT_MS 1000
#define VERIFY_PLAIN_MS 5000
#define VERIFY_DESYNC_MS 3500
/* Once an attempt has gone unanswered and nothing has been refused, each
 * further one waits less: a technique that gets through is answered within a
 * round trip or two, and the shorter wait is what lets several of them fit in
 * the budget. The connection that went quiet first stays open meanwhile (see
 * "parked" in handle), so a server that was only slow is not lost by it. */
#define VERIFY_SILENT_MS 2500

/* Outcome of one attempt. */
#define ATT_OK      1   /* server answered */
#define ATT_REFUSED 0   /* reset or closed: the connection was refused */
#define ATT_SILENT  2   /* nothing came back at all: could be a slow server */
#define ATT_PARKED  3   /* the earlier, parked connection answered instead */
#define ATT_LOCAL  (-1) /* our own send failed */

static engine_config  g_cfg;
static engine_stats   g_stats;
static sock_t         g_listener = SOCK_INVALID;
static _Atomic int    g_running  = 0;

static int ip_literal(const char *h) {
  struct in_addr a4; struct in6_addr a6;
  return inet_pton(AF_INET, h, &a4) == 1 || inet_pton(AF_INET6, h, &a6) == 1;
}

/* ── one site, many names ────────────────────────────────────────────────
 * A site is reached under many names — www., api., cdn., gateway-us-east1-b.
 * — and a filter almost always treats them alike. So what one name teaches is
 * kept for its site as well, and a name with nothing of its own starts from
 * the site's, instead of paying the whole ladder again: a refusal for every
 * new name, or five seconds each on a network that drops silently. A name's
 * own entry always wins.
 *
 * The site is the registrable domain, by a deliberately small rule: the last
 * two labels, or three under a generic second level of a country domain
 * (example.co.uk, example.com.tr). Where unrelated people own the names under
 * one parent — shared hosting, CDN customer names — there is no site to share,
 * and neither is there for an address. Writes the site to out and returns 1,
 * or returns 0 when the host stands alone. */
static const char *const SHARED_SUFFIX[] = {
  "github.io", "githubusercontent.com", "pages.dev", "vercel.app", "netlify.app",
  "blogspot.com", "wordpress.com", "herokuapp.com", "appspot.com", "cloudfront.net",
  "azurewebsites.net", "amazonaws.com", "firebaseapp.com", "web.app", "workers.dev",
  "akamaized.net", "akamaihd.net", "fastly.net", "edgekey.net", "edgesuite.net",
  "googleusercontent.com", "storage.googleapis.com", NULL
};
static const char *const GENERIC_SLD[] = {
  "co", "com", "net", "org", "gov", "edu", "ac", "gen", "biz", "info", "or", "ne", "go", NULL
};

static int site_of(const char *h, char *out, size_t cap) {
  char low[256];
  size_t n = 0;
  out[0] = 0;
  for (; h[n] && n + 1 < sizeof(low); n++)
    low[n] = (h[n] >= 'A' && h[n] <= 'Z') ? (char)(h[n] + 32) : h[n];
  if (h[n]) return 0;                          /* longer than a name can be */
  if (n && low[n - 1] == '.') n--;             /* "example.com." */
  low[n] = 0;
  if (n == 0 || ip_literal(low)) return 0;
  for (int i = 0; SHARED_SUFFIX[i]; i++) {
    size_t m = strlen(SHARED_SUFFIX[i]);
    if (n >= m && strcmp(low + n - m, SHARED_SUFFIX[i]) == 0 && (n == m || low[n - m - 1] == '.'))
      return 0;
  }
  /* Where the last three labels start: dot[0] is the last dot, dot[1] the one
   * before it, dot[2] the one before that (-1 when there is none). */
  int dot[3] = { -1, -1, -1 }, nd = 0;
  for (int i = (int)n - 1; i >= 0 && nd < 3; i--) if (low[i] == '.') dot[nd++] = i;
  if (nd == 0) return 0;                       /* one label: "localhost" */
  int keep = 2;
  if (n - (size_t)dot[0] - 1 == 2) {           /* a two-letter country domain */
    int from = dot[1] + 1;                     /* the second-level label */
    size_t len = (size_t)(dot[0] - from);
    for (int i = 0; GENERIC_SLD[i]; i++)
      if (strlen(GENERIC_SLD[i]) == len && strncmp(low + from, GENERIC_SLD[i], len) == 0) keep = 3;
  }
  if (nd < keep - 1) return 0;                 /* "co.uk" itself is no one's site */
  int start = nd >= keep ? dot[keep - 1] + 1 : 0;
  if (n - (size_t)start + 1 > cap) return 0;
  memcpy(out, low + start, n - (size_t)start);
  out[n - (size_t)start] = 0;
  return 1;
}

/* The site to keep alongside h, if it is not h itself. */
static int site_key(const char *h, char *out, size_t cap) {
  return site_of(h, out, cap) && strcmp(out, h) != 0;
}

/* ── per-host learned strategy (auto-probe cache) ───────────────────────── */
typedef struct { char host[256]; int preset; uint64_t t; int used; } hoststrat;
#define HS_SIZE 512
static hoststrat g_hs[HS_SIZE];
static mutex_t   g_hs_mx;

/* Per host, the technique a silent ladder did not get to (see rs_get). Long
 * enough to live through a browser's retries; short enough that a lifted
 * block, or another network, gets its untouched attempt back soon. */
typedef struct { char host[256]; int next; uint64_t t; int used; } hostresume;
#define RS_SIZE   128
#define RS_TTL_MS (10 * 60 * 1000)
static hostresume g_rs[RS_SIZE];

/* Caller holds g_hs_mx. */
static int hs_find(const char *k) {
  for (int i = 0; i < HS_SIZE; i++)
    if (g_hs[i].used && strcmp(g_hs[i].host, k) == 0) return i;
  return -1;
}
static int rs_find(const char *k) {
  for (int i = 0; i < RS_SIZE; i++)
    if (g_rs[i].used && strcmp(g_rs[i].host, k) == 0) return i;
  return -1;
}

/* The host's own entry, else its site's; *inherited says which (may be NULL). */
static int hs_get(const char *h, int *inherited) {
  char site[256];
  int has_site = site_key(h, site, sizeof(site));
  mutex_lock(&g_hs_mx);
  int r = -1, inh = 0, i = hs_find(h);
  if (i >= 0) r = g_hs[i].preset;
  else if (has_site && (i = hs_find(site)) >= 0) { r = g_hs[i].preset; inh = 1; }
  mutex_unlock(&g_hs_mx);
  if (inherited) *inherited = inh;
  return r;
}

/* Caller holds g_hs_mx. */
static void hs_store(const char *k, int preset) {
  /* The key's own entry first: a host that is learned again must replace
   * what was known, not sit behind it where hs_get would never look. */
  int slot = hs_find(k);
  uint64_t old = (uint64_t)-1;
  if (slot < 0) {   /* else a free slot, else the least recently learned */
    for (int i = 0; i < HS_SIZE; i++) {
      if (!g_hs[i].used) { slot = i; break; }
      if (g_hs[i].t < old) { old = g_hs[i].t; slot = i; }
    }
  }
  if (slot < 0) slot = 0;
  memset(&g_hs[slot], 0, sizeof(g_hs[slot]));
  strncpy(g_hs[slot].host, k, sizeof(g_hs[slot].host) - 1);
  g_hs[slot].preset = preset; g_hs[slot].t = now_ms(); g_hs[slot].used = 1;
  /* Something works here now: where a silent ladder left off no longer
   * matters (see below). */
  int r = rs_find(k);
  if (r >= 0) g_rs[r].used = 0;
}

/* Learned for the host, and for its site. */
static void hs_put(const char *h, int preset) {
  char site[256], other[256];
  int in_site = site_of(h, site, sizeof(site));       /* its site, perhaps h itself */
  mutex_lock(&g_hs_mx);
  hs_store(h, preset);
  if (in_site && strcmp(site, h) != 0) hs_store(site, preset);
  /* Something works for the site now, so none of its names needs to go on
   * searching from where its own silent ladder left off: they take this. */
  for (int i = 0; in_site && i < RS_SIZE; i++)
    if (g_rs[i].used && site_of(g_rs[i].host, other, sizeof(other)) && strcmp(other, site) == 0)
      g_rs[i].used = 0;
  mutex_unlock(&g_hs_mx);
}

/* The technique a ladder started with failed, and the untouched request then
 * got through: forget it where it came from — the host's own entry, or the
 * site's, so a stale site entry does not go on costing every other name of the
 * site a failed attempt. */
static void hs_unlearn(const char *h, int inherited) {
  char site[256];
  if (inherited && !site_key(h, site, sizeof(site))) return;
  mutex_lock(&g_hs_mx);
  int i = hs_find(inherited ? site : h);
  if (i >= 0) g_hs[i].used = 0;
  mutex_unlock(&g_hs_mx);
}

/* ── where a silent ladder left off ──────────────────────────────────────
 * On a network that drops a blocked handshake without a word, every attempt
 * costs its whole wait, so one connection's budget covers the untouched
 * attempt and the first four techniques, no more. A site that only a later
 * one opens would never be reached: every connection would try the same few
 * and fail. So when a ladder runs out with nothing answered and nothing
 * refused, the first technique it did not get to is remembered, and the host's
 * next connection starts there — without the untouched attempt, which it has
 * just seen dropped — and wraps around the list. Browsers retry a page that
 * failed, so a few connections give every technique its turn; once one works
 * the learned strategy above takes over and this entry goes. Kept for the
 * site too, like a learned strategy, and under the same lock. */

/* Caller holds g_hs_mx. The live resume entry for k, or -1; an expired one
 * is let go. */
static int rs_live(const char *k, uint64_t now) {
  int i = rs_find(k);
  if (i < 0) return -1;
  if (now - g_rs[i].t < RS_TTL_MS) return i;
  g_rs[i].used = 0;
  return -1;
}

/* Where a host's ladder starts: *from >= 0 to carry on a silent search from
 * there, else *learned >= 0 to open with a known technique (*inherited when it
 * is the site's), else neither. The host's own entries come first, a resume
 * point before a learned technique — a resume point means the last ladder,
 * that technique included, came to nothing. Then the site's: whichever of the
 * two is newer, the latest word on how this site fares. resume: 0 to ignore
 * resume points (only TLS ladders keep going through silence). */
static void ladder_start(const char *h, int resume, int *from, int *learned, int *inherited) {
  char site[256];
  int has_site = site_key(h, site, sizeof(site));
  uint64_t now = now_ms();
  *from = -1; *learned = -1; *inherited = 0;
  mutex_lock(&g_hs_mx);
  int r = resume ? rs_live(h, now) : -1, l = hs_find(h);
  if (r >= 0) *from = g_rs[r].next;
  else if (l >= 0) *learned = g_hs[l].preset;
  else if (has_site) {
    r = resume ? rs_live(site, now) : -1;
    l = hs_find(site);
    if (r >= 0 && (l < 0 || g_rs[r].t >= g_hs[l].t)) *from = g_rs[r].next;
    else if (l >= 0) { *learned = g_hs[l].preset; *inherited = 1; }
  }
  mutex_unlock(&g_hs_mx);
}

/* Caller holds g_hs_mx. */
static void rs_store(const char *k, int next) {
  int slot = rs_find(k);
  uint64_t old = (uint64_t)-1;
  if (slot < 0) {   /* else a free slot, else the one left alone longest */
    for (int i = 0; i < RS_SIZE; i++) {
      if (!g_rs[i].used) { slot = i; break; }
      if (g_rs[i].t < old) { old = g_rs[i].t; slot = i; }
    }
  }
  if (slot < 0) slot = 0;
  memset(&g_rs[slot], 0, sizeof(g_rs[slot]));
  strncpy(g_rs[slot].host, k, sizeof(g_rs[slot].host) - 1);
  g_rs[slot].next = next; g_rs[slot].t = now_ms(); g_rs[slot].used = 1;
}

static void rs_put(const char *h, int next) {
  char site[256];
  int has_site = site_key(h, site, sizeof(site));
  mutex_lock(&g_hs_mx);
  rs_store(h, next);
  if (has_site) rs_store(site, next);
  mutex_unlock(&g_hs_mx);
}

/* Something got through for this host: its own resume entry goes, and the
 * site's, since the site is evidently not dropped wholesale. */
static void rs_drop(const char *h) {
  char site[256];
  int has_site = site_key(h, site, sizeof(site));
  mutex_lock(&g_hs_mx);
  int i = rs_find(h);
  if (i >= 0) g_rs[i].used = 0;
  if (has_site && (i = rs_find(site)) >= 0) g_rs[i].used = 0;
  mutex_unlock(&g_hs_mx);
}

/* A preset that can do nothing on this platform (a decoy where decoys are not
 * built, see fake.h) would only send the payload untouched under another
 * name: a wasted attempt, and a false "opened with" if it ever got through. */
static int preset_usable(const strategy *st) {
  for (int i = 0; i < st->n_ops; i++)
    if (st->ops[i].kind != OP_FAKE || fake_available()) return 1;
  return 0;
}

static int usable_presets(void) {
  int n = 0;
  for (int i = 0; i < strategy_preset_count(); i++) n += preset_usable(strategy_preset(i));
  return n;
}

/* The network let a connection to this host start and then cut it. Whatever
 * opened it is not enough here, so the next connection starts with the next
 * technique. Cycling is cheap — every technique still has to produce a real
 * handshake before it is used — and it settles on the first one that is not
 * cut. This is what keeps working when a filter changes what it looks at.
 * Only techniques that can do something here are cycled onto: one that cannot
 * would send the request untouched, and be remembered as what works. */
static void hs_on_cut(const char *h) {
  int np = strategy_preset_count();
  if (np <= 0 || !g_cfg.auto_probe) return;
  int cur = hs_get(h, NULL);
  for (int k = 1; k <= np; k++) {
    int next = (cur + k) % np;             /* cur is -1 when nothing is learned */
    if (!preset_usable(strategy_preset(next))) continue;
    /* For this name only: a cut is one connection's word, a guess to try next
     * rather than something learned, and not enough to move the whole site. */
    mutex_lock(&g_hs_mx);
    hs_store(h, next);
    mutex_unlock(&g_hs_mx);
    return;
  }
}

const engine_stats *engine_get_stats(void) { return &g_stats; }
int engine_is_running(void) { return atomic_load(&g_running); }

void engine_emit_stats(void) {
  printf("{\"type\":\"stats\",\"conns_total\":%llu,\"conns_active\":%llu,"
         "\"bytes_up\":%llu,\"bytes_down\":%llu,\"desync\":%llu,"
         "\"tls\":%llu,\"http\":%llu,\"probe_ok\":%llu,\"probe_fail\":%llu}\n",
         (unsigned long long)atomic_load(&g_stats.conns_total),
         (unsigned long long)atomic_load(&g_stats.conns_active),
         (unsigned long long)atomic_load(&g_stats.bytes_up),
         (unsigned long long)atomic_load(&g_stats.bytes_down),
         (unsigned long long)atomic_load(&g_stats.desync_applied),
         (unsigned long long)atomic_load(&g_stats.tls_seen),
         (unsigned long long)atomic_load(&g_stats.http_seen),
         (unsigned long long)atomic_load(&g_stats.probe_success),
         (unsigned long long)atomic_load(&g_stats.probe_fail));
  fflush(stdout);
}

/* ── SOCKS handshake (client side) ──────────────────────────────────────── */
/* Reads the greeting and CONNECT request, fills in what the client asked for.
 * Does NOT send the final reply — the caller dials upstream first and then
 * calls socks_reply(), per RFC 1928, so the client learns the true connect
 * result.
 *
 * SOCKS4 and SOCKS4a are accepted as well as SOCKS5. Plenty of clients fall
 * back to them: Firefox's system "SOCKS" setting, WinINet's "socks=" (what a
 * Windows program reading the system proxy gets), a PAC file's "SOCKS". */
typedef struct {
  char     host[256];
  uint16_t port;
  int      ver;        /* 4 or 5: decides the reply format */
  /* A SOCKS4 client resolved the name itself, through the system's DNS, and
   * asks for a known block page: that DNS was poisoned. The real name is in
   * the first payload; see handle(). 0.0.0.0 and loopback do not count — a
   * hosts file, an ad blocker or the user's own filtering DNS answers with
   * those on purpose, and they are connected to as asked. */
  int      blockpage;
} socks_req;

static int recv_exact(sock_t c, uint8_t *b, int n) {
  int got = 0;
  while (got < n) {
    int r = recv(c, (char *)b + got, n - got, 0);
    if (r <= 0) return -1;
    got += r;
  }
  return 0;
}

/* A NUL-terminated SOCKS4 field (user id, SOCKS4a host name). out may be NULL
 * to skip it. Anything longer than a host name can be is refused. */
static int recv_cstr(sock_t c, char *out, size_t cap) {
  size_t n = 0;
  for (;;) {
    uint8_t ch;
    if (recv_exact(c, &ch, 1) != 0) return -1;
    if (ch == 0) break;
    if (++n > 255) return -1;
    if (out && n < cap) out[n - 1] = (char)ch;
  }
  if (out) out[n < cap ? n : cap - 1] = 0;
  return 0;
}

/* rep: 0x5A granted, 0x5B rejected or failed. */
static int socks4_reply(sock_t c, uint8_t rep) {
  uint8_t r[8] = { 0x00, rep, 0,0, 0,0,0,0 };
  return sock_send_all(c, r, 8, 0);
}

/* rep: 0x00 success, 0x05 refused, 0x04 host unreachable, 0x01 general. */
static int socks5_reply(sock_t c, uint8_t rep) {
  uint8_t r[10] = { 0x05, rep, 0, 0x01, 0,0,0,0, 0,0 };
  return sock_send_all(c, r, 10, 0);
}

/* Tell the client whether its connection is up, in its own protocol. */
static int socks_reply(sock_t c, const socks_req *rq, int ok) {
  if (rq->ver == 4) return socks4_reply(c, ok ? 0x5A : 0x5B);
  return socks5_reply(c, ok ? 0x00 : 0x04);
}

/* SOCKS4: VN CD DSTPORT DSTIP USERID\0, and for SOCKS4a (DSTIP 0.0.0.x, x
 * not 0) the host name\0 after that. VN and CD are already read. */
static int socks4_accept(sock_t c, int cmd, socks_req *rq) {
  uint8_t h[6];
  if (recv_exact(c, h, 6) != 0) return -1;
  rq->ver = 4;
  rq->port = (uint16_t)((h[0] << 8) | h[1]);
  if (recv_cstr(c, NULL, 0) != 0) return -1;            /* user id: unused */
  if (cmd != 0x01) { socks4_reply(c, 0x5B); return -1; } /* only CONNECT */
  if (h[2] == 0 && h[3] == 0 && h[4] == 0 && h[5] != 0) {
    /* SOCKS4a: the client left the name to us, so it goes through our own
     * resolver like any SOCKS5 name. */
    if (recv_cstr(c, rq->host, sizeof(rq->host)) != 0 || !rq->host[0]) {
      socks4_reply(c, 0x5B); return -1;
    }
    return 0;
  }
  snprintf(rq->host, sizeof(rq->host), "%u.%u.%u.%u", h[2], h[3], h[4], h[5]);
  uint32_t ip = ((uint32_t)h[2] << 24) | ((uint32_t)h[3] << 16) | ((uint32_t)h[4] << 8) | h[5];
  rq->blockpage = doh_ipv4_is_blockpage(ip);
  return 0;
}

static int socks_accept(sock_t c, socks_req *rq) {
  uint8_t b[300];
  memset(rq, 0, sizeof(*rq));
  if (sock_wait_readable(c, 5000) != 1) return -1;
  if (recv_exact(c, b, 2) != 0) return -1;
  if (b[0] == 0x04) return socks4_accept(c, b[1], rq);
  if (b[0] != 0x05) return -1;
  rq->ver = 5;
  int nm = b[1];
  if (nm > 0) { if (recv_exact(c, b, nm) != 0) return -1; }
  uint8_t rep[2] = { 0x05, 0x00 };
  if (sock_send_all(c, rep, 2, 0) != 0) return -1;

  if (recv_exact(c, b, 4) != 0) return -1;
  if (b[0] != 0x05 || b[1] != 0x01) {           /* only CONNECT */
    uint8_t f[10] = { 0x05, 0x07, 0, 0x01, 0,0,0,0, 0,0 };
    sock_send_all(c, f, 10, 0); return -1;
  }
  int atyp = b[3];
  if (atyp == 0x01) {
    uint8_t a[4]; if (recv_exact(c, a, 4) != 0) return -1;
    snprintf(rq->host, sizeof(rq->host), "%u.%u.%u.%u", a[0], a[1], a[2], a[3]);
  } else if (atyp == 0x03) {
    uint8_t l; if (recv_exact(c, &l, 1) != 0) return -1;
    if (l == 0) return -1;                      /* 255 at most: always fits */
    if (recv_exact(c, (uint8_t *)rq->host, l) != 0) return -1;
    rq->host[l] = 0;
  } else if (atyp == 0x04) {
    uint8_t a[16]; if (recv_exact(c, a, 16) != 0) return -1;
    char tmp[64]; inet_ntop(AF_INET6, a, tmp, sizeof(tmp));
    snprintf(rq->host, sizeof(rq->host), "%s", tmp);
  } else {
    uint8_t f[10] = { 0x05, 0x08, 0, 0x01, 0,0,0,0, 0,0 };
    sock_send_all(c, f, 10, 0); return -1;
  }
  uint8_t pb[2]; if (recv_exact(c, pb, 2) != 0) return -1;
  rq->port = (uint16_t)((pb[0] << 8) | pb[1]);
  return 0;
}

/* *timed_out: the connect failed because nothing came back within
 * timeout_ms, as opposed to being refused or having no route. */
static sock_t connect_addr(const struct sockaddr *sa, socklen_t sl, int timeout_ms, int *timed_out) {
  *timed_out = 0;
  sock_t s = socket(sa->sa_family, SOCK_STREAM, IPPROTO_TCP);
  if (s == SOCK_INVALID) return SOCK_INVALID;
  int r = sock_connect_timeout(s, sa, (int)sl, timeout_ms);
  if (r != 0) { *timed_out = r == -2; sock_close(s); return SOCK_INVALID; }
  sock_set_nodelay(s, 1);
  sock_set_keepalive(s);
  return s;
}

/* Connect to the first address that answers. A name often has both IPv4 and
 * IPv6 addresses while the network only routes one of them (e.g. AAAA records
 * handed out right after Wi-Fi comes up, with no IPv6 route): so try the
 * preferred family first (IPv4 unless --ipv6), then the other, and move on to
 * the next address when one fails instead of failing the whole connection.
 * That holds for our own resolver too: it hands back every address of the
 * name, and one that fails is dropped from its cache, so the next connection
 * does not wait out the same dead address.
 *
 * Every dial has a time limit. budget_ms > 0 is what the attempt ladder has
 * left, counted from now. 0 is a connection's first dial, made before the
 * client has its SOCKS reply: its connects get DIAL_FIRST_MS between them,
 * counted from the first one (a slow lookup is not the addresses' fault), so
 * a name whose every address is dead fails in about as long as the old two
 * tries took, however many addresses it has — not the half minute after which
 * a browser gives up on the proxy, and pays again on every new connection. */
#define DIAL_MAX_TRIES 6
#define DIAL_FIRST_MS 14000
#define DIAL_TRY_MS    8000   /* the first address */
#define DIAL_NEXT_MS   4000   /* each address after it */
typedef struct {
  int resolved;   /* addresses the name has */
  int tried;      /* how many of them were tried */
  /* The time ran out before an address had its full try: a failure then says
   * nothing about the host, only that the budget was spent. */
  int cut;
} dial_info;

/* One address of a dial. Returns the socket, or SOCK_INVALID with di->cut set
 * when the dial's time ran out (before the try, or during one that it had to
 * shorten), else with *dead set: refused, unreachable, or silent for its full
 * time — the address's own doing, so it is worth forgetting. */
static sock_t dial_addr(const struct sockaddr *sa, socklen_t sl, int *tries, uint64_t *end,
                        dial_info *di, int *dead) {
  *dead = 0;
  uint64_t n = now_ms();
  if (!*end) *end = n + DIAL_FIRST_MS;
  if (n >= *end) { di->cut = 1; return SOCK_INVALID; }
  int wait = *tries == 0 ? DIAL_TRY_MS : DIAL_NEXT_MS, clamped = 0, timed_out = 0;
  if (*end - n < (uint64_t)wait) { wait = (int)(*end - n); clamped = 1; }
  (*tries)++;
  sock_t s = connect_addr(sa, sl, wait, &timed_out);
  if (s == SOCK_INVALID) {
    if (clamped && timed_out) di->cut = 1;   /* we cut it short: no verdict */
    else *dead = 1;
  }
  return s;
}

static sock_t dial(const char *host, uint16_t port, int prefer6, int use_doh,
                   int budget_ms, int *out_family, dial_info *di) {
  sock_t s = SOCK_INVALID;
  int tries = 0, dead = 0;
  uint64_t end = budget_ms > 0 ? now_ms() + (uint64_t)budget_ms : 0;
  dial_info local;
  if (!di) di = &local;
  memset(di, 0, sizeof(*di));
  if (use_doh) {
    for (int pass = 0; pass < 2 && s == SOCK_INVALID && !di->cut; pass++) {
      struct sockaddr_storage sa[DOH_MAX_ADDRS]; socklen_t sl[DOH_MAX_ADDRS];
      int n = doh_resolve_all(host, port, pass == 0 ? prefer6 : !prefer6, sa, sl, DOH_MAX_ADDRS);
      if (n <= 0) continue;
      di->resolved += n;
      for (int i = 0; i < n && s == SOCK_INVALID && !di->cut && tries < DIAL_MAX_TRIES; i++) {
        s = dial_addr((struct sockaddr *)&sa[i], sl[i], &tries, &end, di, &dead);
        if (s != SOCK_INVALID) { if (out_family) *out_family = sa[i].ss_family; }
        else if (dead) doh_forget(host, &sa[i]);
      }
    }
    di->tried = tries;
    return s;
  }
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_ADDRCONFIG; /* no AAAA answers on an IPv4-only machine */
  char ps[8]; snprintf(ps, sizeof(ps), "%u", port);
  if (getaddrinfo(host, ps, &hints, &res) != 0 || !res) { if (res) freeaddrinfo(res); return SOCK_INVALID; }
  for (struct addrinfo *p = res; p; p = p->ai_next)
    if (p->ai_family == AF_INET || p->ai_family == AF_INET6) di->resolved++;
  for (int pass = 0; pass < 2 && s == SOCK_INVALID && !di->cut; pass++) {
    int fam = (pass == 0) == !!prefer6 ? AF_INET6 : AF_INET;
    for (struct addrinfo *p = res; p && s == SOCK_INVALID && !di->cut && tries < DIAL_MAX_TRIES; p = p->ai_next) {
      if (p->ai_family != fam) continue;
      s = dial_addr(p->ai_addr, (socklen_t)p->ai_addrlen, &tries, &end, di, &dead);
      if (s != SOCK_INVALID && out_family) *out_family = fam;
    }
  }
  freeaddrinfo(res);
  di->tried = tries;
  return s;
}

/* ── cut detection ───────────────────────────────────────────────────────
 * Some filters let a connection start and then stop it: the handshake goes
 * through, the page never arrives (Iran's stateful filtering, Russia's 16 KB
 * freeze). From the browser that looks like a blank page, and from the
 * handshake check like success. Three signs, watched on TLS connections only,
 * while fewer than CUT_MAX_BYTES have come back:
 *   stall   — the server goes silent halfway through a TLS record. A real
 *             server does not pause mid-record for seconds; a filter that
 *             drops the rest of the flow does exactly that.
 *   reset   — "the server" resets the connection.
 *   noreply — the browser sent a request and nothing at all came back.
 *             Weakest of the three (a long-poll looks the same); the app
 *             needs more of these before it believes them.
 * Each connection reports at most once; the app decides from several. */
#define CUT_MAX_BYTES  (64 * 1024)
#define CUT_STALL_MS   8000
#define CUT_NOREPLY_MS 15000

typedef struct { int have; uint8_t hdr[5]; uint32_t left; int lost; } tls_track;

/* Follow the server's TLS record boundaries. */
static void tls_follow(tls_track *t, const uint8_t *p, int n) {
  while (n > 0 && !t->lost) {
    if (t->left == 0) {
      int take = 5 - t->have; if (take > n) take = n;
      memcpy(t->hdr + t->have, p, (size_t)take);
      t->have += take; p += take; n -= take;
      if (t->have == 5) {
        t->have = 0;
        if (t->hdr[0] < 20 || t->hdr[0] > 24 || t->hdr[1] != 3) { t->lost = 1; return; }
        t->left = ((uint32_t)t->hdr[3] << 8) | t->hdr[4];
      }
    } else {
      uint32_t take = t->left < (uint32_t)n ? t->left : (uint32_t)n;
      t->left -= take; p += take; n -= (int)take;
    }
  }
}
static int tls_mid_record(const tls_track *t) { return !t->lost && (t->left > 0 || t->have > 0); }

typedef struct {
  const char *host;   /* for the report; NULL = not watched */
  int fam;
  uint64_t down;      /* bytes from the server so far, handshake included */
  /* When the request that is still unanswered went out. The relay sets it for
   * what it forwards; the first payload went out before the relay started, so
   * the caller sets it when that one is still waiting for its answer —
   * otherwise a ClientHello nobody ever answers is never reported. */
  uint64_t waiting;
  tls_track tt;
} cut_watch;

static void report(const char *ev, const char *host, const char *strat, int attempts, int fam,
                   const char *note);

/* Bidirectional relay until either side closes. a = client, b = server. */
static void relay(sock_t a, sock_t b, cut_watch *cw) {
  uint8_t *buf = (uint8_t *)malloc(RELAY_BUF);
  if (!buf) return;
  int reported = 0;
  uint64_t t = now_ms(), last_down = t;
  uint64_t waiting_since = cw ? cw->waiting : 0;   /* client sent something the server has not answered */
  for (;;) {
    int w = sock_wait_either(a, b, 1000);
    if (w < 0) break;
    t = now_ms();
    if (cw && cw->host && !reported && cw->down < CUT_MAX_BYTES) {
      if (tls_mid_record(&cw->tt) && t - last_down >= CUT_STALL_MS) {
        report("cut", cw->host, "stall", (int)(cw->down / 1024), cw->fam, NULL); reported = 1;
        hs_on_cut(cw->host);
      } else if (waiting_since && t - waiting_since >= CUT_NOREPLY_MS) {
        report("cut", cw->host, "noreply", (int)(cw->down / 1024), cw->fam, NULL); reported = 1;
      }
    }
    if (w == 0) continue;
    if (w & 1) {
      int n = recv(a, (char *)buf, RELAY_BUF, 0);
      if (n <= 0) break;
      if (sock_send_all(b, buf, (size_t)n, 0) != 0) break;
      atomic_fetch_add(&g_stats.bytes_up, (uint64_t)n);
      if (!waiting_since) waiting_since = t;   /* oldest request still unanswered */
    }
    if (w & 2) {
      int n = recv(b, (char *)buf, RELAY_BUF, 0);
      if (n <= 0) {
        if (n < 0 && sock_errno() == SE_CONNRESET && cw && cw->host && !reported &&
            cw->down < CUT_MAX_BYTES)
        { report("cut", cw->host, "reset", (int)(cw->down / 1024), cw->fam, NULL); hs_on_cut(cw->host); }
        break;
      }
      if (sock_send_all(a, buf, (size_t)n, 0) != 0) break;
      atomic_fetch_add(&g_stats.bytes_down, (uint64_t)n);
      last_down = t;
      waiting_since = 0;
      if (cw) { cw->down += (uint64_t)n; tls_follow(&cw->tt, buf, n); }
    }
  }
  free(buf);
}

/* Read the first client payload (ClientHello / HTTP request). For TLS we wait
 * until the whole first record has arrived so multi-segment ClientHellos are
 * handled correctly. Returns bytes read, or -1. */
static int read_first(sock_t c, sock_t up, uint8_t *buf, int cap) {
  int total = 0;
  uint64_t deadline = now_ms() + FIRST_WAIT;
  int want = 0;
  while (total < cap) {
    int left = (int)(deadline - now_ms());
    if (left <= 0) break;
    int w;
    if (total == 0) {
      /* Nothing from the client yet. In plenty of protocols the server speaks
       * first — SMTP, IMAP, SSH, game clients — and a browser also opens
       * connections it never sends anything on. Waiting out the whole window
       * for a payload that is never coming stalls those connections for four
       * seconds each and pins a thread while it happens, so watch both sides
       * and stop as soon as it is clear the client is not the one talking. */
      int quiet = left < QUIET_WAIT ? left : QUIET_WAIT;
      /* No upstream yet (a SOCKS4 block page, see handle): only the client. */
      w = up == SOCK_INVALID ? sock_wait_readable(c, quiet) : sock_wait_either(c, up, quiet);
      if (w <= 0) break;            /* neither spoke: hand over to the relay */
      if (!(w & 1)) break;          /* the server spoke first */
    } else {
      w = sock_wait_readable(c, left);
      if (w <= 0) break;
    }
    int n = recv(c, (char *)buf + total, cap - total, 0);
    if (n <= 0) break;
    total += n;
    /* tls_expected_len answers 5 while it has only part of the header, so keep
     * asking until it knows the real record length — otherwise a ClientHello
     * that arrives in pieces is cut off after five bytes. */
    if (want == 0 || want == 5) {
      want = tls_expected_len(buf, (size_t)total);
      if (want == 0) break;          /* not TLS: first recv is the HTTP request */
    }
    if (want > 5 && total >= want) break;
  }
  return total > 0 ? total : -1;
}

typedef struct { sock_t client; } conn_arg;

/* Replaying a payload must be harmless. A TLS ClientHello always is; for HTTP
 * only idempotent methods qualify, so a POST is never sent twice. */
static int retry_safe(const proto_info *pi, const uint8_t *b, int len) {
  if (pi->kind == PROTO_TLS) return 1;
  if (pi->kind == PROTO_HTTP && len >= 5)
    return memcmp(b, "GET ", 4) == 0 || memcmp(b, "HEAD ", 5) == 0;
  return 0;
}

/* One line of JSON per interesting event, read by the app and written to the
 * log the user can send us. Hosts are reported because the user asked for the
 * site, but nothing is sent anywhere: it only reaches the local log file. */
/* The host comes from whatever asked us to connect, so it cannot be pasted
 * into JSON as-is: one quote would corrupt this line and every line after it,
 * and the app parses these. Keep it to characters a host name may contain. */
static void json_host(char *out, size_t cap, const char *in) {
  size_t j = 0;
  for (size_t i = 0; in && in[i] && j + 1 < cap; i++) {
    unsigned char c = (unsigned char)in[i];
    int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
             (c >= '0' && c <= '9') || c == '.' || c == '-' || c == ':' || c == '_';
    out[j++] = ok ? (char)c : '?';
  }
  out[j] = 0;
}

/* note: NULL, or "silent" when the network dropped the attempts without a
 * word rather than refusing them — worth knowing when reading a report, since
 * it is a different kind of filter. */
static void report(const char *ev, const char *host, const char *strat,
                   int attempts, int fam, const char *note) {
  char h[256];
  json_host(h, sizeof(h), host);
  printf("{\"type\":\"%s\",\"host\":\"%s\",\"strategy\":\"%s\","
         "\"attempts\":%d,\"family\":\"%s\"%s%s%s}\n",
         ev, h, strat ? strat : "", attempts, fam == AF_INET6 ? "ipv6" : "ipv4",
         note ? ",\"note\":\"" : "", note ? note : "", note ? "\"" : "");
  fflush(stdout);
}

/* A host we could not connect to at all: its name did not resolve, or none of
 * its addresses answered. Without this the browser just shows its own error
 * and the log has nothing to say about why. A dead host is retried by the
 * browser over and over, so each one is told at most once a minute.
 *
 * Only a site name on the web ports is told. Peer-to-peer and game clients
 * that follow the system proxy try dead addresses on every sort of port all
 * day, and a bare address says nothing a reader of the log could act on;
 * reporting those would bury the lines that matter. */
#define UNREACH_SLOTS     64
#define UNREACH_REPEAT_MS 60000
static struct { char host[256]; uint64_t t; } g_unreach[UNREACH_SLOTS];
static mutex_t g_unreach_mx;

static void report_unreachable(const char *host, uint16_t port, const dial_info *di) {
  if (!host || !host[0] || ip_literal(host) || (port != 80 && port != 443)) return;
  char h[256];
  json_host(h, sizeof(h), host);
  uint64_t t = now_ms();
  int slot = -1, oldest = 0;
  mutex_lock(&g_unreach_mx);
  for (int i = 0; i < UNREACH_SLOTS; i++) {
    if (g_unreach[i].host[0] && strcmp(g_unreach[i].host, h) == 0) { slot = i; break; }
    if (g_unreach[i].t < g_unreach[oldest].t) oldest = i;
  }
  if (slot >= 0 && t - g_unreach[slot].t < UNREACH_REPEAT_MS) { mutex_unlock(&g_unreach_mx); return; }
  if (slot < 0) { slot = oldest; snprintf(g_unreach[slot].host, sizeof(g_unreach[slot].host), "%s", h); }
  g_unreach[slot].t = t;
  mutex_unlock(&g_unreach_mx);
  printf("{\"type\":\"unreachable\",\"host\":\"%s\",\"stage\":\"%s\",\"ips\":%d}\n",
         h, di && di->resolved > 0 ? "connect" : "dns", di ? di->tried : 0);
  fflush(stdout);
}

/* The filter can answer *instead* of the server: an injected block page, a
 * forged handshake, or a plaintext redirect. So bytes arriving is not proof
 * that an attempt worked — when we sent a ClientHello the reply has to be a
 * real TLS handshake record, and a ServerHello if it is a handshake at all.
 * Without this check a block page counts as success and gets cached. */
static int tls_reply_ok(const uint8_t *b, int n) {
  if (n < 3) return 0;
  /* Only a handshake counts. An alert (0x15) is the server saying the
   * handshake failed — which is exactly what a technique that corrupts the
   * request produces, so accepting it would cache the corruption and keep
   * using it for that site. */
  if (b[0] != 0x16) return 0;
  if (b[1] != 0x03) return 0;                    /* legacy record version */
  if (n >= 6 && b[5] != 0x02) return 0;          /* a handshake, but not ServerHello */
  return 1;
}

/* One upstream connection of the ladder: the socket, its address family, how
 * much of the client's payload it carries, when that went out, and with which
 * technique. */
typedef struct { sock_t s; int fam; int sent; uint64_t at; int cand; } leg;

/* Send the first payload using `preset` (or unmodified for ATT_PLAIN).
 * Returns 0; ATT_REFUSED when the connection was reset or closed under us
 * while the payload went out — a filter that resets a handshake after its
 * first piece makes a technique's later writes fail exactly so, and that is
 * the network refusing, not us failing; ATT_LOCAL for any other failure of
 * our own send. */
static int attempt_send(sock_t up, int fam, uint8_t *payload, int pcap, int len,
                        const proto_info *pi, int preset) {
  int rc;
  if (preset == ATT_PLAIN || pi->kind == PROTO_UNKNOWN) {
    rc = sock_send_all(up, payload, (size_t)len, 0);
  } else {
    const strategy *st = (preset >= 0) ? strategy_preset(preset) : &g_cfg.strat;
    rc = desync_send_first(up, fam, payload, len, pcap, pi, st, &g_stats.desync_applied);
  }
  /* Read straight away: the failing call is the last socket call made. */
  if (rc != 0) return sock_err_peer_gone(sock_errno()) ? ATT_REFUSED : ATT_LOCAL;
  atomic_fetch_add(&g_stats.bytes_up, (uint64_t)len);
  return 0;
}

/* Read the server's first bytes from a socket that has become readable: ATT_OK
 * with them left in `rbuf` and their length in `*rlen`, or ATT_REFUSED. */
static int read_reply(sock_t up, const proto_info *pi, uint8_t *rbuf, int rcap, int *rlen) {
  *rlen = 0;
  int n = recv(up, (char *)rbuf, rcap, 0);
  if (n <= 0) return ATT_REFUSED;        /* RST or FIN injected by the filter */

  if (pi->kind == PROTO_TLS) {
    /* Top up to the first six bytes so the record header can be judged. */
    while (n < 6 && n < rcap && sock_wait_readable(up, 400) == 1) {
      int m = recv(up, (char *)rbuf + n, rcap - n, 0);
      if (m <= 0) break;
      n += m;
    }
    if (!tls_reply_ok(rbuf, n)) return ATT_REFUSED;
  }
  *rlen = n;
  return ATT_OK;
}

/* Wait up to wait_ms for the server to answer on `cur`. A parked connection —
 * an earlier attempt nobody answered — is listened to as well. Moving on from
 * a silent attempt used to mean closing it, which threw away the answer of a
 * server that was only slow; now, if the parked one answers first, the two
 * swap places, the newer one is closed, and ATT_PARKED says so. A parked
 * connection that is refused is simply closed. */
static int await_reply(leg *cur, leg *parked, const proto_info *pi, int wait_ms,
                       uint8_t *rbuf, int rcap, int *rlen) {
  uint64_t end = now_ms() + (uint64_t)(wait_ms > 0 ? wait_ms : 0);
  *rlen = 0;
  for (;;) {
    uint64_t t = now_ms();
    if (t >= end) return ATT_SILENT;
    int left = (int)(end - t);
    int w = parked->s != SOCK_INVALID ? sock_wait_either(cur->s, parked->s, left)
                                      : sock_wait_readable(cur->s, left);
    if (w < 0) return ATT_REFUSED;
    if (w == 0) return ATT_SILENT;          /* blackholed, or merely slow */
    if (parked->s != SOCK_INVALID && (w & 2)) {
      if (read_reply(parked->s, pi, rbuf, rcap, rlen) == ATT_OK) {
        leg newer = *cur;
        *cur = *parked;
        sock_close(newer.s);
        parked->s = SOCK_INVALID;
        return ATT_PARKED;
      }
      sock_close(parked->s);
      parked->s = SOCK_INVALID;
    }
    if (w & 1) return read_reply(cur->s, pi, rbuf, rcap, rlen);
  }
}

/* The ladder's last word when nothing got through: "blocked" — unless every
 * attempt made failed in our own send, which says nothing about the network,
 * and is reported as that instead. made: the attempts that actually went out. */
static void report_gave_up(const char *key, int made, int local_fails, int saw_refusal, int fam) {
  if (made > 0 && local_fails == made) report("send_failed", key, "", made, fam, NULL);
  else report("blocked", key, "", made, fam, saw_refusal ? NULL : "silent");
}

/* Names that never resolve on the public internet (RFC 6761, 6762, 8375 and
 * their usual relatives). A SOCKS4 request for a block page that names one of
 * these is a local connection, not a poisoned lookup, and asking the public
 * resolvers about it would only leak the name and add a delay. */
static int local_name(const char *h) {
  static const char *const SUFFIX[] = {
    ".localhost", ".local", ".test", ".invalid", ".internal", ".lan", ".home.arpa", NULL
  };
  if (!strchr(h, '.')) return 1;           /* "localhost", "router", ... */
  size_t n = strlen(h);
  for (int i = 0; SUFFIX[i]; i++) {
    size_t m = strlen(SUFFIX[i]);
    if (n >= m && strcmp(h + n - m, SUFFIX[i]) == 0) return 1;
  }
  return 0;
}

static void handle(sock_t client) {
  atomic_fetch_add(&g_stats.conns_total, 1);
  atomic_fetch_add(&g_stats.conns_active, 1);

  socks_req rq;
  uint8_t *first = NULL, *work = NULL, *rbuf = NULL;
  sock_t up = SOCK_INVALID;
  int fam = 0, flen = -1, rlen = 0;
  /* What every attempt dials, and whether through our own resolver. */
  char dial_host[256];
  int dial_doh = g_cfg.use_doh;
  dial_info di;
  uint64_t waiting = 0;   /* the first payload went out and is still unanswered */

  sock_set_timeouts(client, 30000);
  sock_set_nodelay(client, 1);

  if (socks_accept(client, &rq) != 0) goto done;
  snprintf(dial_host, sizeof(dial_host), "%s", rq.host);

  first = (uint8_t *)malloc(RELAY_BUF);
  work  = (uint8_t *)malloc(RELAY_BUF);
  rbuf  = (uint8_t *)malloc(RELAY_BUF);
  if (!first || !work || !rbuf) { socks_reply(client, &rq, 0); goto done; }

  if (rq.blockpage) {
    /* The client looked the name up itself and the system's DNS answered with
     * a known block page, so connecting where it asks only shows the block
     * page. The name it meant is in its first payload (the TLS server name, or
     * the HTTP Host), so accept now, read that, and look the name up with our
     * own resolver — always ours, since the system's is the one that lied. */
    if (socks_reply(client, &rq, 1) != 0) goto done;
    flen = read_first(client, SOCK_INVALID, first, RELAY_BUF);
    proto_info pi0;
    memset(&pi0, 0, sizeof(pi0));
    if (flen > 0) proto_inspect(first, (size_t)flen, &pi0);
    if (pi0.host[0] && !local_name(pi0.host)) {
      up = dial(pi0.host, rq.port, g_cfg.prefer_ipv6, 1, 0, &fam, &di);
      if (up != SOCK_INVALID) { snprintf(dial_host, sizeof(dial_host), "%s", pi0.host); dial_doh = 1; }
      else report_unreachable(pi0.host, rq.port, &di);   /* the site meant, not the block page */
    }
    /* No name, or it does not resolve: go where the client asked, which is
     * exactly what would have happened without us. */
    if (up == SOCK_INVALID) up = dial(rq.host, rq.port, g_cfg.prefer_ipv6, g_cfg.use_doh, 0, &fam, &di);
    if (up == SOCK_INVALID) goto done;
  } else {
    up = dial(rq.host, rq.port, g_cfg.prefer_ipv6, g_cfg.use_doh, 0, &fam, &di);
    if (up == SOCK_INVALID) { socks_reply(client, &rq, 0); report_unreachable(rq.host, rq.port, &di); goto done; }
    if (socks_reply(client, &rq, 1) != 0) goto done;
    flen = read_first(client, up, first, RELAY_BUF);
  }

  int watch_tls = 0;
  char cut_key[256]; cut_key[0] = 0;
  /* This ladder gave up and left a place to resume from, and the connection
   * kept for the relay carries the untouched request: see after relay(). */
  int resume_set = 0, kept_plain = 0;

  if (flen > 0) {
    proto_info pi;
    proto_inspect(first, (size_t)flen, &pi);
    if (pi.kind == PROTO_TLS)  atomic_fetch_add(&g_stats.tls_seen, 1);
    if (pi.kind == PROTO_HTTP) atomic_fetch_add(&g_stats.http_seen, 1);

    const char *key = pi.host[0] ? pi.host : rq.host;
    watch_tls = pi.kind == PROTO_TLS;
    strncpy(cut_key, key, sizeof(cut_key) - 1); cut_key[sizeof(cut_key) - 1] = 0;

    /* Build the ladder. */
    int cand[ATT_MAX]; int ncand = 0;
    int ladder = g_cfg.auto_probe && pi.kind != PROTO_UNKNOWN &&
                 retry_safe(&pi, first, flen);
    int np = strategy_preset_count();
    int from = -1, learned = -1, inherited = 0;
    if (ladder) ladder_start(key, pi.kind == PROTO_TLS, &from, &learned, &inherited);
    int resumed = from >= 0 && from < np;
    if (!ladder) {
      cand[ncand++] = g_cfg.auto_probe ? ATT_PLAIN : -1;   /* -1 = configured */
    } else if (resumed) {
      /* The last ladder for this host was dropped without a word from start to
       * end and ran out of time partway down the list: carry on where it
       * stopped, round the list, with the untouched attempt it has just seen
       * dropped left for last. */
      for (int k = 0; k < np && ncand < ATT_MAX; k++) {
        int i = (from + k) % np;
        if (preset_usable(strategy_preset(i))) cand[ncand++] = i;
      }
      if (ncand < ATT_MAX) cand[ncand++] = ATT_PLAIN;
    } else {
      if (learned >= np) learned = -1;
      if (learned >= 0) cand[ncand++] = learned;           /* known to work */
      else              cand[ncand++] = ATT_PLAIN;         /* untouched first */
      for (int i = 0; i < np && ncand < ATT_MAX; i++) {
        if (i == learned || !preset_usable(strategy_preset(i))) continue;
        cand[ncand++] = i;
      }
      /* If a strategy was learned, still allow an untouched attempt last: the
       * block may have been lifted, or the host may have changed. */
      if (learned >= 0 && ncand < ATT_MAX) cand[ncand++] = ATT_PLAIN;
    }

    uint64_t deadline = now_ms() + ATT_BUDGET_MS;
    /* A resumed ladder starts as if its untouched attempt had just gone
     * unanswered again, which is what the last connection saw: its attempts
     * get the shorter wait, and the first that gets through is learned. */
    int saw_refusal = 0, silent = resumed, told = 0, last = ATT_OK;
    int gave_up = 0;          /* ended with nothing answered: blocked, or unreachable */
    int last_preset = -1;     /* the last technique that actually went out */
    int local_fails = 0;      /* attempts our own send failed for a reason of ours */
    leg cur = { up, fam, 0, 0, ATT_PLAIN };
    leg parked = { SOCK_INVALID, 0, 0, 0, ATT_PLAIN };
    up = SOCK_INVALID;                     /* owned by cur from here on */
    for (int a = 0; a < ncand; a++) {
      int wait_ms = (cand[a] == ATT_PLAIN) ? VERIFY_PLAIN_MS
                  : (silent && !saw_refusal) ? VERIFY_SILENT_MS : VERIFY_DESYNC_MS;
      if (a > 0) {
        /* Anything the client sent meanwhile belongs in the replay. */
        while (flen < RELAY_BUF && sock_wait_readable(client, 0) == 1) {
          int n = recv(client, (char *)first + flen, RELAY_BUF - flen, 0);
          if (n <= 0) break;
          flen += n;
        }
        /* The first connection nobody answered stays open while the next one
         * is tried (see await_reply); any other is done with. */
        if (last == ATT_SILENT && parked.s == SOCK_INVALID) parked = cur;
        else sock_close(cur.s);
        cur.s = SOCK_INVALID;
        /* The re-dial may spend what is left of the budget except the least an
         * attempt needs to be answered in. */
        uint64_t t = now_ms();
        int left = t < deadline ? (int)(deadline - t) : 0;
        int spent = left <= ATT_MIN_WAIT_MS;
        if (!spent) {
          cur.s = dial(dial_host, rq.port, g_cfg.prefer_ipv6, dial_doh, left - ATT_MIN_WAIT_MS,
                       &cur.fam, &di);
          if (cur.s == SOCK_INVALID && !di.cut) {
            /* Refused at every address, or silent there for a full try. */
            report_unreachable(dial_host, rq.port, &di);
            told = 1; gave_up = 1;
            break;
          }
          t = now_ms();
          left = t < deadline ? (int)(deadline - t) : 0;
          if (cur.s != SOCK_INVALID && left < ATT_MIN_WAIT_MS) { sock_close(cur.s); cur.s = SOCK_INVALID; }
          spent = cur.s == SOCK_INVALID;
        }
        if (spent) {
          /* The budget ran out before this attempt could be made. The host took
           * a connection earlier in this same ladder, so it is not unreachable:
           * the ladder is simply over, the site is blocked, and the attempt that
           * never went out is not counted. */
          report_gave_up(key, a, local_fails, saw_refusal, cur.fam);
          told = 1; gave_up = 1;
          break;
        }
        /* The budget bounds the whole ladder, so the last wait gets what is left. */
        if (wait_ms > left) wait_ms = left;
      }
      memcpy(work, first, (size_t)flen);   /* strategies may rewrite in place */
      cur.sent = flen; cur.at = now_ms(); cur.cand = cand[a];
      if (cand[a] >= 0) last_preset = cand[a];
      int r = attempt_send(cur.s, cur.fam, work, RELAY_BUF, flen, &pi, cand[a]);
      int send_err = r != 0;
      if (r == 0) r = await_reply(&cur, &parked, &pi, wait_ms, rbuf, RELAY_BUF, &rlen);
      last = r;
      if (r == ATT_PARKED) {
        /* The connection that went quiet earlier answered after all: the
         * server was slow, not censored. Nothing to learn, nothing to report. */
        atomic_fetch_add(&g_stats.probe_success, 1);
        break;
      }
      if (r == ATT_OK) {
        /* Remember the technique only when the network showed it interferes:
         * it refused an attempt, or — on a TLS handshake, where a silent drop
         * is how some filters work (Turkcell Superonline's, for one) — let an
         * untouched one go unanswered while this one got through at once. A
         * server that was merely slow must not leave this host permanently
         * desynced; the parked connection is what tells the two apart, since
         * a slow server answers there first. */
        int silent_drop = !saw_refusal && silent > 0 && pi.kind == PROTO_TLS;
        int learn = ladder && cand[a] >= 0 && (saw_refusal || silent_drop);
        if (learn) hs_put(key, cand[a]);
        atomic_fetch_add(&g_stats.probe_success, 1);
        /* Only worth reporting when something had to be done about it: a site
         * that opened untouched is not news, one that needed a technique is.
         * And only call it a bypass if the network actually got in the way: a
         * server that was just slow is not a censored one, and saying so in
         * the log would send the user chasing a block that never happened. */
        if ((a > 0 || resumed) && learn)
          report("bypass", key, strategy_preset(cand[a])->name, a + 1, cur.fam,
                 saw_refusal ? NULL : "silent");
        /* The technique this ladder started with failed, and the untouched
         * request then got through: whatever it was learned for is over, here
         * at least. Forget it rather than keep paying a failed attempt for it. */
        if (ladder && cand[a] == ATT_PLAIN && a > 0 && learned >= 0)
          hs_unlearn(key, inherited);
        break;
      }
      if (!ladder) {
        /* Nothing to fall back on: a send that failed gets its line, as ever. */
        if (send_err) { report("send_failed", key, "", a + 1, cur.fam, NULL); told = 1; }
        break;
      }
      /* With a ladder, a send that failed is one more failed attempt, never the
       * end of it. Reset in the middle of going out is the network refusing,
       * like a reset in reply; any other failure is ours and says nothing about
       * the network either way. Both go on to the next technique on a fresh
       * connection. */
      if (r == ATT_REFUSED) saw_refusal = 1;
      else if (r == ATT_LOCAL) local_fails++;
      else if (++silent >= 2 && !saw_refusal && pi.kind != PROTO_TLS) {
        /* Twice now the far end simply said nothing to a plain HTTP request,
         * and nothing has ever been refused. That is a slow or unreachable
         * server far more often than a censored one, and working through ten
         * more techniques would only make an already slow page slower. Let the
         * relay wait it out. (A TLS handshake keeps going: see above.) */
        break;
      }
      atomic_fetch_add(&g_stats.probe_fail, 1);
      if (a + 1 >= ncand || now_ms() + ATT_MIN_LEFT_MS > deadline) {
        /* Nothing got through. This line is what a support log needs: the host,
         * how many techniques were tried, which address family was used, and
         * whether the network refused them or silently dropped them. */
        report_gave_up(key, a + 1, local_fails, saw_refusal, cur.fam);
        told = 1; gave_up = 1;
        break;
      }
    }

    /* Where this host's next ladder starts (see rs_get). TLS only: the other
     * ladders stop at the second silence instead of walking the list. One that
     * met a refusal walks it quickly enough, and starts from the top again. */
    if (ladder && pi.kind == PROTO_TLS) {
      if (rlen > 0) rs_drop(key);
      else if (gave_up && !saw_refusal && silent > 0 && last_preset >= 0) {
        rs_put(key, (last_preset + 1) % np);
        resume_set = 1;
      } else if (gave_up) rs_drop(key);
    }

    if (rlen == 0 && parked.s != SOCK_INVALID) {
      /* Nothing answered. Of the connections still open, keep the one that
       * has waited longest: on a fresh ladder, the untouched request. */
      if (cur.s != SOCK_INVALID) sock_close(cur.s);
      cur = parked;
      parked.s = SOCK_INVALID;
    }
    if (parked.s != SOCK_INVALID) sock_close(parked.s);
    /* A connection that went out before the client sent more has not been
     * given those bytes yet. */
    if (cur.s != SOCK_INVALID && flen > cur.sent) {
      if (sock_send_all(cur.s, first + cur.sent, (size_t)(flen - cur.sent), 0) == 0)
        atomic_fetch_add(&g_stats.bytes_up, (uint64_t)(flen - cur.sent));
    }
    up = cur.s; fam = cur.fam;
    kept_plain = cur.cand == ATT_PLAIN;
    /* Still unanswered, and nothing has been said about it yet: let the relay
     * report it if it stays that way. */
    if (rlen == 0 && !told) waiting = cur.at;
  }

  if (up == SOCK_INVALID) goto done;
  if (rlen > 0) {
    if (sock_send_all(client, rbuf, (size_t)rlen, 0) != 0) goto done;
    atomic_fetch_add(&g_stats.bytes_down, (uint64_t)rlen);
  }
  {
    cut_watch cw;
    memset(&cw, 0, sizeof(cw));
    cw.host = (watch_tls && cut_key[0]) ? cut_key : NULL;
    cw.fam = fam;
    cw.down = (uint64_t)rlen;
    cw.waiting = waiting;
    if (rlen > 0) tls_follow(&cw.tt, rbuf, rlen);
    relay(client, up, &cw);
    /* The ladder gave up, yet the untouched request was answered after all —
     * later than the ladder waited. A slow server, not a filter: its next
     * connection starts untouched again. */
    if (resume_set && kept_plain && cw.down > 0 && !cw.tt.lost) rs_drop(cut_key);
  }

done:
  if (up != SOCK_INVALID) sock_close(up);
  free(first); free(work); free(rbuf);
  atomic_fetch_sub(&g_stats.conns_active, 1);
  sock_close(client);
}

static void *conn_thread(void *p) {
  conn_arg *a = (conn_arg *)p;
  sock_t c = a->client;
  free(a);
  handle(c);
  return NULL;
}

static void *accept_loop(void *unused) {
  (void)unused;
  while (atomic_load(&g_running)) {
    struct sockaddr_storage ca; socklen_t cl = sizeof(ca);
    sock_t c = accept(g_listener, (struct sockaddr *)&ca, &cl);
    if (c == SOCK_INVALID) {
      if (!atomic_load(&g_running)) break;
      sleep_ms(5);
      continue;
    }
    /* Cap concurrency so a flood of localhost connections cannot exhaust
     * threads/memory. conns_active is decremented when each handler returns. */
    if (atomic_load(&g_stats.conns_active) >= MAX_CONNS) {
      sock_close(c);
      continue;
    }
    conn_arg *arg = (conn_arg *)malloc(sizeof(*arg));
    if (!arg) { sock_close(c); continue; }
    arg->client = c;
    if (thread_spawn(conn_thread, arg, 256 * 1024) != 0) {
      sock_close(c); free(arg);
    }
  }
  return NULL;
}

int engine_start(const engine_config *cfg) {
  g_cfg = *cfg;
  memset(&g_stats, 0, sizeof(g_stats));
  mutex_init(&g_hs_mx);
  mutex_init(&g_unreach_mx);
  doh_init(cfg->doh_host, cfg->doh_ip);

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)cfg->listen_port);
  if (inet_pton(AF_INET, cfg->listen_addr[0] ? cfg->listen_addr : "127.0.0.1",
                &addr.sin_addr) != 1) {
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  }

  g_listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (g_listener == SOCK_INVALID) return -1;
  int yes = 1;
#ifdef _WIN32
  /* SO_REUSEADDR does not mean on Windows what it means elsewhere: it lets a
   * second process bind the same address and port and take over the
   * connections, which for a proxy the whole system is pointed at would hand
   * every request to whoever asked second. SO_EXCLUSIVEADDRUSE is the option
   * that reserves the port. */
  setsockopt(g_listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&yes, sizeof(yes));
#else
  setsockopt(g_listener, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
#endif
  if (bind(g_listener, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    sock_close(g_listener); g_listener = SOCK_INVALID; return -2;
  }
  if (listen(g_listener, 128) != 0) {
    sock_close(g_listener); g_listener = SOCK_INVALID; return -3;
  }

  atomic_store(&g_running, 1);
  /* With --auto the ladder decides, not --strategy; say how many techniques it
   * has here so the app can describe what is actually running. */
  printf("{\"type\":\"ready\",\"port\":%d,\"techniques\":%d}\n", cfg->listen_port,
         usable_presets());
  fflush(stdout);
  return thread_spawn(accept_loop, NULL, 256 * 1024);
}

void engine_stop(void) {
  atomic_store(&g_running, 0);
  if (g_listener != SOCK_INVALID) {
    sock_t l = g_listener; g_listener = SOCK_INVALID;
    sock_close(l);
  }
}

/* Called by the probe subsystem to record a working strategy for a host. */
void engine_learn(const char *host, int preset) { hs_put(host, preset); }
