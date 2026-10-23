#include "engine.h"
#include "platform.h"
#include "proto.h"
#include "strategy.h"
#include "desync.h"
#include "doh.h"
#include "fake.h"
#include "socksudp.h"
#include "adblock.h"
#include <ctype.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>

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
 * works is remembered per host, so the cost is paid once.
 *
 * What is remembered is only ever what the network showed: a technique is
 * learned when the untouched request was refused, or was still unanswered
 * while the technique got through on a connection of its own (see
 * ladder_won). A server that is slow, or down for a while, shows neither. */
#define ATT_PLAIN      (-2)    /* send the payload unmodified */
#define ATT_RAW_BASE   1000    /* raw technique i (see "streams that are not TLS or HTTP") */
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
/* Once an attempt has gone unanswered and nothing has been refused, the next
 * one starts sooner: a technique that gets through is usually answered within
 * a round trip or two, and the shorter wait is what lets several of them fit
 * in the budget. Starting the next one does not end the last: every attempt's
 * connection stays open and is listened to until one of them answers (see
 * "legs" below), so an answer that takes longer than this — a slow server, a
 * slow or lossy path — is still used, however many attempts went out since. */
#define VERIFY_SILENT_MS 2500
/* An untouched request raced against a technique (a ladder resuming a silent
 * search, or checking a technique learned long ago) has this long to itself
 * before the technique goes out beside it: two of the first connect's round
 * trips and some, which a server that is not filtered needs to answer it
 * first, held between these bounds. A silent network pays at most this. */
#define RACE_HEAD_MIN_MS 250
#define RACE_HEAD_MAX_MS 1000
/* A ladder keeps at most this many connections open. Past it, the oldest
 * technique's goes; the untouched request's never does (see legs_add). */
#define LEG_MAX 6
/* After the ladder is over with nothing answered, its connections are still
 * listened to for this long; then the oldest is simply relayed. */
#define RACE_MAX_MS 30000
/* How many re-dialled connections all ladders together may hold open at once.
 * A ladder's first connection is the client's own and is not counted. Many
 * computers behind one small router (an internet cafe, a school) share its
 * table of connections, and an endpoint that takes connections and never
 * answers — a dead server, a black-holed tracker its app retries all day —
 * would otherwise cost up to five more per connection made to it. A ladder
 * that finds no room listens to what it has open until there is (see
 * wait_room). Enough for a dozen silent ladders in full at once. */
#define EXTRA_LEGS_MAX 48
/* A host whose last ladder came to nothing (nothing answered) in this long
 * keeps at most LEG_COOL_MAX connections open on its next ladders: the
 * untouched request and the newest technique. The search goes on at the same
 * pace, so a site behind a silent filter still gets every technique its turn;
 * it just stops piling connections up on what is most likely a dead endpoint.
 * Anything answering for the host ends it. */
#define COOL_MS      60000
#define LEG_COOL_MAX 2

/* Outcome of one attempt. */
#define ATT_OK      1   /* server answered */
#define ATT_REFUSED 0   /* reset or closed: the connection was refused */
#define ATT_SILENT  2   /* nothing came back at all: could be a slow server */
#define ATT_LOCAL  (-1) /* our own send failed */
#define ATT_ALERT   3   /* (TLS) the far end answered with an alert: refused, but by a TLS speaker */

/* The running engine's settings. Each start gets a copy of its own and the
 * pointer moves to it; a copy is never freed, as connections of an earlier
 * start in the same process (embedded, see engine_main) may still be
 * reading theirs. Until the first start (and in the white-box tests) it is
 * g_cfg_first. */
static engine_config  g_cfg_first;
static _Atomic(engine_config *) g_cfg_ptr = &g_cfg_first;
typedef struct cfg_copy { engine_config cfg; struct cfg_copy *prev; } cfg_copy;
static cfg_copy *g_cfg_kept = NULL;
#define g_cfg (*atomic_load(&g_cfg_ptr))
static engine_stats   g_stats;
static sock_t         g_listener = SOCK_INVALID;
static _Atomic int    g_running  = 0;
/* Which start the accept loop running now belongs to: a loop left from an
 * earlier start in the same process (embedded) sees it changed and ends. */
static _Atomic unsigned g_generation = 0;

/* ── output ─────────────────────────────────────────────────────────────
 * Every JSON line goes through engine_printf. NULL is stdout. g_out_mx is
 * made once, before the first engine starts (engine_init_once); until then
 * (the tests, an error before the start) lines are written without it, as
 * nothing else can be writing yet. */
static FILE   *g_out = NULL;
static int     g_out_off = 0;
static mutex_t g_out_mx;
static int     g_out_mx_ready = 0;

void engine_set_output(FILE *out) {
  if (g_out_mx_ready) mutex_lock(&g_out_mx);
  g_out = out;
  g_out_off = 0;
  if (g_out_mx_ready) mutex_unlock(&g_out_mx);
}

void engine_output_off(void) {
  if (g_out_mx_ready) mutex_lock(&g_out_mx);
  g_out_off = 1;
  g_out = NULL;
  if (g_out_mx_ready) mutex_unlock(&g_out_mx);
}

void engine_printf(const char *fmt, ...) {
  int locked = g_out_mx_ready;
  if (locked) mutex_lock(&g_out_mx);
  FILE *f = g_out_off ? NULL : (g_out ? g_out : stdout);
  if (f) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fflush(f);
  }
  if (locked) mutex_unlock(&g_out_mx);
}

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
 * two labels, or three under a second level that is itself a public suffix
 * (example.co.uk, example.com.tr, ankara.bel.tr, example.uk.com). Where
 * unrelated people own the names under one parent — hosting and blog
 * platforms, shops, CDN customer names, dynamic DNS — there is no site to
 * share, and neither is there for an address. A list can never be complete,
 * so it leans one way: grouping strangers would give one of them another's
 * technique, while not grouping a real site only costs its names a ladder
 * each. When unsure, a name is left out of any group. Writes the site to out
 * and returns 1, or returns 0 when the host stands alone. */

/* Nothing under these is grouped. */
static const char *const SHARED_SUFFIX[] = {
  /* code, app and static-site hosting */
  "github.io", "githubusercontent.com", "gitlab.io", "bitbucket.io", "codeberg.page",
  "pages.dev", "vercel.app", "netlify.app", "surge.sh", "glitch.me", "neocities.org",
  "replit.app", "repl.co", "onrender.com", "fly.dev", "railway.app", "deno.dev",
  "herokuapp.com", "appspot.com", "run.app", "cloudfunctions.net", "firebaseapp.com",
  "web.app", "workers.dev", "r2.dev", "azurewebsites.net", "azureedge.net", "azurefd.net",
  "azurestaticapps.net", "cloudapp.net", "cloudapp.azure.com", "trafficmanager.net",
  "core.windows.net", "amazonaws.com", "elasticbeanstalk.com", "cloudfront.net",
  "googleusercontent.com", "storage.googleapis.com", "webflow.io",
  /* blogs, shops and personal pages */
  "blogspot.com", "wordpress.com", "tumblr.com", "wixsite.com", "weebly.com",
  "myshopify.com", "substack.com", "itch.io", "livejournal.com", "carrd.co",
  "ucoz.ru", "narod.ru",
  /* CDN customer names */
  "akamaized.net", "akamaihd.net", "akamaiedge.net", "edgekey.net", "edgesuite.net",
  "fastly.net", "fastlylb.net", "b-cdn.net", "kxcdn.com",
  /* dynamic DNS and tunnels */
  "duckdns.org", "ddns.net", "no-ip.org", "hopto.org", "zapto.org", "sytes.net",
  "dyndns.org", "ngrok.io", "ngrok.app", "ngrok-free.app", "trycloudflare.com",
  /* a public suffix a level deeper than the rule below sees: every name right
   * under it is a suffix of its own (a local education authority) */
  "sch.uk",
  NULL
};

/* Second levels under which people register their own names, under any
 * two-letter country domain (co.uk, com.tr, ac.ir, gob.mx, k12.tr). */
static const char *const GENERIC_SLD[] = {
  "co", "com", "net", "org", "gov", "edu", "ac", "gen", "biz", "info", "or", "ne", "go",
  "mil", "int", "nom", "ltd", "plc", "sch", "k12", "gob", "gouv", "govt", NULL
};

/* And these particular ones (the generic ones above, under one country only,
 * would split real sites such as web.de or ad.nl). */
static const char *const PUBLIC_2LD[] = {
  /* Turkey */
  "av.tr", "bbs.tr", "bel.tr", "dr.tr", "kep.tr", "name.tr", "nc.tr", "pol.tr",
  "tel.tr", "tsk.tr", "tv.tr", "web.tr",
  /* United Kingdom, Japan, Iran */
  "me.uk", "nhs.uk", "police.uk", "ad.jp", "ed.jp", "gr.jp", "lg.jp", "id.ir",
  /* Russia, Ukraine */
  "msk.ru", "spb.ru", "nov.ru", "msk.su", "spb.su", "kiev.ua", "kyiv.ua", "in.ua", "pp.ua",
  /* elsewhere */
  "id.au", "asn.au", "firm.in", "ind.in", "my.id", "web.id", "blog.br", "eti.br",
  "muni.il", "school.nz", "geek.nz", "kiwi.nz",
  /* second levels sold under generic domains (CentralNic and others) */
  "uk.com", "us.com", "eu.com", "gb.com", "de.com", "br.com", "cn.com", "jpn.com",
  "ru.com", "sa.com", "za.com", "kr.com", "hu.com", "no.com", "se.com", "qc.com",
  "uy.com", "gr.com", "ae.org", "us.org", "uk.net", "gb.net", "se.net", "hu.net",
  "in.net", "jp.net",
  NULL
};

/* h (n characters) is suf, or ends in "." + suf. */
static int under(const char *h, size_t n, const char *suf) {
  size_t m = strlen(suf);
  return n >= m && strcmp(h + n - m, suf) == 0 && (n == m || h[n - m - 1] == '.');
}

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
  for (int i = 0; SHARED_SUFFIX[i]; i++)
    if (under(low, n, SHARED_SUFFIX[i])) return 0;
  /* Where the last three labels start: dot[0] is the last dot, dot[1] the one
   * before it, dot[2] the one before that (-1 when there is none). */
  int dot[3] = { -1, -1, -1 }, nd = 0;
  for (int i = (int)n - 1; i >= 0 && nd < 3; i--) if (low[i] == '.') dot[nd++] = i;
  if (nd == 0) return 0;                       /* one label: "localhost" */
  int keep = 2;
  const char *sld = low + (dot[1] + 1);        /* the second-level label (dot[1] may be -1) */
  size_t sld_len = (size_t)(dot[0] - (dot[1] + 1));
  if (n - (size_t)dot[0] - 1 == 2) {           /* a two-letter country domain */
    for (int i = 0; GENERIC_SLD[i]; i++)
      if (strlen(GENERIC_SLD[i]) == sld_len && strncmp(sld, GENERIC_SLD[i], sld_len) == 0) keep = 3;
    /* Every two-letter name right under .us is a state, and the names under
     * a state are towns, schools and libraries: nobody's one site. */
    if (sld_len == 2 && strcmp(low + dot[0] + 1, "us") == 0) return 0;
  }
  for (int i = 0; PUBLIC_2LD[i]; i++)
    if (strcmp(sld, PUBLIC_2LD[i]) == 0) keep = 3;
  if (nd < keep - 1) return 0;                 /* "co.uk" itself is no one's site */
  int start = nd >= keep ? dot[keep - 1] + 1 : 0;
  /* example.blogspot.de, example.blogspot.com.tr: Blogger's country names */
  if (strncmp(low + start, "blogspot.", 9) == 0) return 0;
  if (n - (size_t)start + 1 > cap) return 0;
  memcpy(out, low + start, n - (size_t)start);
  out[n - (size_t)start] = 0;
  return 1;
}

/* The site to keep alongside h, if it is not h itself. */
static int site_key(const char *h, char *out, size_t cap) {
  return site_of(h, out, cap) && strcmp(out, h) != 0;
}

/* age_ms, used before its definition below. */
static uint64_t age_ms(uint64_t now, uint64_t t);

/* ── sites seen working ─────────────────────────────────────────────────
 * A connection to some name of a site that answered a request and was never
 * cut shows the site works through Shroudly. A ladder that gives up on
 * another of its names soon after is about that name alone (an API, a
 * tracker or a WebSocket that turns this client away): not the network
 * blocking the site, and the report says so, so the app does not raise an
 * alarm over a page that loads. Keyed by site, or by the name itself where it
 * has none (an address, a name under a shared suffix). */
#define OK_SLOTS     128
#define OK_RECENT_MS (10 * 60 * 1000)
static struct { char site[256]; uint64_t t; } g_ok[OK_SLOTS];
static mutex_t g_ok_mx;

static void ok_key(const char *h, char *out, size_t cap) {
  if (!site_of(h, out, cap)) { strncpy(out, h, cap - 1); out[cap - 1] = 0; }
}

static void ok_put(const char *h) {
  char k[256];
  ok_key(h, k, sizeof(k));
  if (!k[0]) return;
  uint64_t now = now_ms();
  mutex_lock(&g_ok_mx);
  int slot = 0;
  for (int i = 0; i < OK_SLOTS; i++) {
    if (g_ok[i].site[0] && strcmp(g_ok[i].site, k) == 0) { slot = i; break; }
    if (g_ok[i].t < g_ok[slot].t) slot = i;   /* else the oldest (or an empty one) */
  }
  memcpy(g_ok[slot].site, k, strlen(k) + 1);
  g_ok[slot].t = now;
  mutex_unlock(&g_ok_mx);
}

static int ok_recent(const char *h) {
  char k[256];
  ok_key(h, k, sizeof(k));
  if (!k[0]) return 0;
  int yes = 0;
  mutex_lock(&g_ok_mx);
  uint64_t now = now_ms();
  for (int i = 0; i < OK_SLOTS; i++)
    if (g_ok[i].site[0] && strcmp(g_ok[i].site, k) == 0) { yes = age_ms(now, g_ok[i].t) < OK_RECENT_MS; break; }
  mutex_unlock(&g_ok_mx);
  return yes;
}

/* ── hosts that came to nothing ──────────────────────────────────────────
 * The names whose last ladder ended with nothing answered, and when (see
 * COOL_MS). Keyed by the name itself: one dead endpoint says nothing about
 * the other names of its site. */
#define COOL_SLOTS 64
static struct { char host[256]; uint64_t t; } g_cool[COOL_SLOTS];
static mutex_t g_cool_mx;

static void cool_put(const char *h) {
  if (!h[0]) return;
  mutex_lock(&g_cool_mx);
  int slot = 0;
  for (int i = 0; i < COOL_SLOTS; i++) {
    if (g_cool[i].host[0] && strcmp(g_cool[i].host, h) == 0) { slot = i; break; }
    if (g_cool[i].t < g_cool[slot].t) slot = i;   /* else the oldest (or an empty one) */
  }
  snprintf(g_cool[slot].host, sizeof(g_cool[slot].host), "%s", h);
  g_cool[slot].t = now_ms();
  mutex_unlock(&g_cool_mx);
}

static int cool_is(const char *h) {
  int yes = 0;
  mutex_lock(&g_cool_mx);
  uint64_t now = now_ms();   /* under the lock: see age_ms */
  for (int i = 0; i < COOL_SLOTS; i++)
    if (g_cool[i].host[0] && strcmp(g_cool[i].host, h) == 0) { yes = age_ms(now, g_cool[i].t) < COOL_MS; break; }
  mutex_unlock(&g_cool_mx);
  return yes;
}

/* Something answered for the host. */
static void cool_drop(const char *h) {
  mutex_lock(&g_cool_mx);
  for (int i = 0; i < COOL_SLOTS; i++)
    if (g_cool[i].host[0] && strcmp(g_cool[i].host, h) == 0) { g_cool[i].host[0] = 0; g_cool[i].t = 0; break; }
  mutex_unlock(&g_cool_mx);
}

/* Room for one more re-dialled connection (see EXTRA_LEGS_MAX): 1 with it
 * taken, to be given back with room_give once that connection is closed or
 * becomes the one relayed. */
static _Atomic int g_extra_legs = 0;

static int room_take(void) {
  if (atomic_fetch_add(&g_extra_legs, 1) < EXTRA_LEGS_MAX) return 1;
  atomic_fetch_sub(&g_extra_legs, 1);
  return 0;
}
static void room_give(void) { atomic_fetch_sub(&g_extra_legs, 1); }

/* ── per-host learned strategy (auto-probe cache) ───────────────────────── */
typedef struct { char host[256]; int preset; uint64_t t; int used; } hoststrat;
#define HS_SIZE 512
/* A technique learned this long ago is checked again before it is relied on:
 * the next ladder races the untouched request against it (see handle). A
 * block that was lifted, or a technique learned from a fluke, is then let go,
 * and one still needed costs that check next to nothing. */
#define HS_VERIFY_MS (30 * 60 * 1000)
static hoststrat g_hs[HS_SIZE];
static mutex_t   g_hs_mx;

/* Per host, the technique a silent ladder did not get to (see below). Long
 * enough to live through a browser's retries; short enough that a lifted
 * block, or another network, gets its untouched attempt back soon. */
typedef struct { char host[256]; int next; uint64_t t; int used; } hostresume;
#define RS_SIZE   128
#define RS_TTL_MS (10 * 60 * 1000)
static hostresume g_rs[RS_SIZE];

/* How long ago t was. Another thread may have stored t after the caller read
 * the clock, which makes t the later of the two: that is no time at all, not
 * an unsigned wrap to half a billion years. */
static uint64_t age_ms(uint64_t now, uint64_t t) { return t > now ? 0 : now - t; }

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

/* Caller holds g_hs_mx. Only the technique: where a silent search left off is
 * not this function's business (see hs_put and hs_on_cut). */
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
}

/* Learned for the host, and for its site: the network showed this host needs
 * it (see ladder_won), which is what makes it worth sharing. */
static void hs_put(const char *h, int preset) {
  char site[256], other[256];
  int in_site = site_of(h, site, sizeof(site));       /* its site, perhaps h itself */
  mutex_lock(&g_hs_mx);
  hs_store(h, preset);
  if (in_site && strcmp(site, h) != 0) hs_store(site, preset);
  /* Something works here now, so where a silent search left off no longer
   * matters: not for this name, and not for any name of its site, which take
   * this instead. */
  for (int i = 0; i < RS_SIZE; i++)
    if (g_rs[i].used && (strcmp(g_rs[i].host, h) == 0 ||
        (in_site && site_of(g_rs[i].host, other, sizeof(other)) && strcmp(other, site) == 0)))
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
 * next connection carries on from there and wraps around the list. Browsers
 * retry a page that failed, so a few connections give every technique its
 * turn; once one works the learned strategy above takes over and this entry
 * goes.
 *
 * A server that is down looks exactly the same, so this is a place to search
 * from, never evidence: the resumed ladder still sends the untouched request
 * first, races the technique beside it, and learns only if the untouched one
 * is still unanswered when the technique gets through. And it is kept for the
 * one name only: an outage of api. says nothing about www. Under the same lock
 * as the learned strategies. */

/* Caller holds g_hs_mx. The live resume entry for k, or -1; an expired one
 * is let go. */
static int rs_live(const char *k, uint64_t now) {
  int i = rs_find(k);
  if (i < 0) return -1;
  if (age_ms(now, g_rs[i].t) < RS_TTL_MS) return i;
  g_rs[i].used = 0;
  return -1;
}

/* Where a host's ladder starts: *from >= 0 to carry on its own silent search
 * from there, else *learned >= 0 to open with a known technique (*inherited
 * when it is the site's; *stale when it was learned so long ago that it is to
 * be checked again, see HS_VERIFY_MS), else neither. A resume point comes
 * before a learned technique: it means the last ladder, that technique
 * included, came to nothing. resume: 0 to ignore resume points (only TLS
 * ladders keep going through silence). With nothing of its own and nothing
 * learned for its site, a name carries on where its site's last name left
 * off (*site_from): a site of many names, a video CDN's (googlevideo.com,
 * issue #37), then has every technique tried across its names rather than
 * the same first few on each, which the budget of one ladder allows. */
static void ladder_start(const char *h, int resume, int *from, int *learned, int *inherited,
                         int *stale, int *site_from) {
  char site[256];
  int has_site = site_key(h, site, sizeof(site));
  *from = -1; *learned = -1; *inherited = 0; *stale = 0; *site_from = 0;
  mutex_lock(&g_hs_mx);
  uint64_t now = now_ms();   /* under the lock, so no entry is newer than it */
  int r = resume ? rs_live(h, now) : -1, l = hs_find(h);
  if (r >= 0) *from = g_rs[r].next;
  else {
    if (l < 0 && has_site && (l = hs_find(site)) >= 0) *inherited = 1;
    if (l >= 0) {
      *learned = g_hs[l].preset;
      *stale = age_ms(now, g_hs[l].t) >= HS_VERIFY_MS;
    } else if (resume && has_site && (r = rs_live(site, now)) >= 0) {
      *from = g_rs[r].next;
      *site_from = 1;
    }
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
  mutex_lock(&g_hs_mx);
  rs_store(h, next);
  mutex_unlock(&g_hs_mx);
}

/* Something got through for this host: its search is over. */
static void rs_drop(const char *h) {
  mutex_lock(&g_hs_mx);
  int i = rs_find(h);
  if (i >= 0) g_rs[i].used = 0;
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
     * rather than something learned, and not enough to move the whole site.
     * Nor to end a silent search: a resume point stays where it is. */
    mutex_lock(&g_hs_mx);
    hs_store(h, next);
    mutex_unlock(&g_hs_mx);
    return;
  }
}

const engine_stats *engine_get_stats(void) { return &g_stats; }
int engine_is_running(void) { return atomic_load(&g_running); }

void engine_emit_stats(void) {
  engine_printf("{\"type\":\"stats\",\"conns_total\":%llu,\"conns_active\":%llu,"
         "\"bytes_up\":%llu,\"bytes_down\":%llu,\"desync\":%llu,"
         "\"tls\":%llu,\"http\":%llu,\"probe_ok\":%llu,\"probe_fail\":%llu,\"blocked\":%llu}\n",
         (unsigned long long)atomic_load(&g_stats.conns_total),
         (unsigned long long)atomic_load(&g_stats.conns_active),
         (unsigned long long)atomic_load(&g_stats.bytes_up),
         (unsigned long long)atomic_load(&g_stats.bytes_down),
         (unsigned long long)atomic_load(&g_stats.desync_applied),
         (unsigned long long)atomic_load(&g_stats.tls_seen),
         (unsigned long long)atomic_load(&g_stats.http_seen),
         (unsigned long long)atomic_load(&g_stats.probe_success),
         (unsigned long long)atomic_load(&g_stats.probe_fail),
         (unsigned long long)adblock_total());
}

/* ── SOCKS handshake (client side) ──────────────────────────────────────── */
/* Reads the greeting and the CONNECT (or SOCKS5 UDP ASSOCIATE) request, fills
 * in what the client asked for.
 * Does NOT send the final reply — the caller dials upstream first and then
 * calls socks_reply(), per RFC 1928, so the client learns the true connect
 * result.
 *
 * SOCKS4 and SOCKS4a are accepted as well as SOCKS5 (unless --auth-file asks
 * for a password, which they cannot give). Plenty of clients fall back to
 * them: Firefox's system "SOCKS" setting, WinINet's "socks=" (what a Windows
 * program reading the system proxy gets), a PAC file's "SOCKS". */
typedef struct {
  char     host[256];
  uint16_t port;
  int      ver;        /* 4 or 5, or 1 for HTTP CONNECT: decides the reply format */
  /* 0x01 CONNECT, or (SOCKS5 only) 0x03 UDP ASSOCIATE: host and port are
   * then where the client says it will send its datagrams from; see
   * udp_associate() for when that is used. */
  int      cmd;
  uint8_t  atyp;       /* SOCKS5: 1 IPv4, 3 name, 4 IPv6 */
  uint8_t  addr[16];   /* SOCKS5 ATYP 1 (first 4 bytes) or 4: the address as sent */
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

static int send_str(sock_t c, const char *s) { return sock_send_all(c, (const uint8_t *)s, strlen(s), 0); }

/* Tell the client whether its connection is up, in its own protocol. */
static int socks_reply(sock_t c, const socks_req *rq, int ok) {
  if (rq->ver == 1) {
    static const char yes[] = "HTTP/1.1 200 Connection established\r\n\r\n";
    static const char no[]  = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    return ok ? send_str(c, yes) : send_str(c, no);
  }
  if (rq->ver == 4) return socks4_reply(c, ok ? 0x5A : 0x5B);
  return socks5_reply(c, ok ? 0x00 : 0x04);
}

/* SOCKS4: VN CD DSTPORT DSTIP USERID\0, and for SOCKS4a (DSTIP 0.0.0.x, x
 * not 0) the host name\0 after that. VN and CD are already read. */
static int socks4_accept(sock_t c, int cmd, socks_req *rq) {
  uint8_t h[6];
  if (recv_exact(c, h, 6) != 0) return -1;
  rq->ver = 4;
  rq->cmd = cmd;
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

/* ── authentication (optional) ───────────────────────────────────────────
 * With --auth-file the port is not open to everything on this machine: a
 * SOCKS5 client must offer username/password (method 0x02, RFC 1929) and
 * give the ones in the file; SOCKS4, which has no password, is refused.
 * Without it nothing changes. */
int engine_load_auth(engine_config *cfg, const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return -1;
  char line[600];
  size_t n = fread(line, 1, sizeof(line) - 1, f);
  fclose(f);
  line[n] = 0;
  if (strlen(line) != n) return -1;                   /* a NUL byte inside */
  while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
  if (strpbrk(line, "\r\n")) return -1;               /* more than one line */
  char *colon = strchr(line, ':');
  if (!colon) return -1;
  size_t ul = (size_t)(colon - line), pl = n - ul - 1;
  if (ul < 1 || ul > 255 || pl < 1 || pl > 255) return -1;
  memcpy(cfg->auth_user, line, ul); cfg->auth_user[ul] = 0;
  memcpy(cfg->auth_pass, colon + 1, pl); cfg->auth_pass[pl] = 0;
  memset(line, 0, sizeof(line));
  return 0;
}

/* ── stand-in addresses (--fake-net) ─────────────────────────────────────
 * A tunnel that answers names with made-up addresses from a pool of its own
 * (Android's: 198.18.0.0/15) maps them back to names before they get here.
 * One that does arrive outlived its mapping and leads nowhere, so it is
 * refused at once rather than dialled until the connect times out. */
int engine_add_fake_net(engine_config *cfg, const char *spec) {
  char buf[512];
  if (!spec || strlen(spec) >= sizeof(buf)) return -1;
  strcpy(buf, spec);
  int any = 0;
  for (char *next = buf; next; ) {
    char *tok = next, *comma = strchr(tok, ',');
    if (comma) { *comma = 0; next = comma + 1; } else next = NULL;
    while (*tok == ' ') tok++;
    for (char *e = tok + strlen(tok); e > tok && e[-1] == ' '; ) *--e = 0;
    if (!*tok) continue;
    if (cfg->fake_net_n >= ENGINE_FAKE_NET_MAX) return -1;
    char *slash = strchr(tok, '/');
    long bits = -1;
    if (slash) {
      char *end = NULL;
      *slash = 0;
      if (!slash[1]) return -1;
      bits = strtol(slash + 1, &end, 10);
      if (!end || *end) return -1;
    }
    struct in_addr a4; struct in6_addr a6;
    int fam, max;
    uint8_t addr[16] = { 0 };
    if (inet_pton(AF_INET, tok, &a4) == 1) { fam = AF_INET; max = 32; memcpy(addr, &a4, 4); }
    else if (inet_pton(AF_INET6, tok, &a6) == 1) { fam = AF_INET6; max = 128; memcpy(addr, &a6, 16); }
    else return -1;
    if (bits < 0) bits = max;
    if (bits > max) return -1;
    int k = cfg->fake_net_n++;
    cfg->fake_net[k].fam = fam;
    cfg->fake_net[k].bits = (int)bits;
    memcpy(cfg->fake_net[k].addr, addr, 16);
    any = 1;
  }
  return any ? 0 : -1;
}

/* ── names the app watches (--watch) ─────────────────────────────────────
 * See engine.h. A small table of the names told lately, so a page or a call
 * that opens many connections to one name is one event every
 * ENGINE_WATCH_EVERY_MS, not one per connection. A full table reuses its
 * oldest slot. */
#define WATCH_SLOTS 64
static struct { char host[256]; uint64_t t; } g_seen[WATCH_SLOTS];
static mutex_t g_seen_mx;

int engine_add_watch(engine_config *cfg, const char *domain) {
  if (!cfg || !domain || cfg->watch_n >= ENGINE_WATCH_MAX) return -1;
  size_t n = strlen(domain);
  if (n && domain[n - 1] == '.') n--;
  if (n < 3 || n >= sizeof(cfg->watch[0]) || domain[0] == '.' || !memchr(domain, '.', n)) return -1;
  char *d = cfg->watch[cfg->watch_n];
  for (size_t i = 0; i < n; i++) {
    char c = (char)tolower((unsigned char)domain[i]);
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) return -1;
    d[i] = c;
  }
  d[n] = 0;
  cfg->watch_n++;
  return 0;
}

/* a and b are the same name, whatever the case of their letters. */
static int name_eq(const char *a, const char *b) {
  for (; *a && *b; a++, b++)
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
  return *a == *b;
}

/* host is one of the watched domains or a name under one. */
static int watched(const char *host) {
  size_t hl = strlen(host);
  for (int i = 0; i < g_cfg.watch_n; i++) {
    const char *d = g_cfg.watch[i];
    size_t dl = strlen(d);
    if (hl == dl && name_eq(host, d)) return 1;
    if (hl > dl && host[hl - dl - 1] == '.' && name_eq(host + hl - dl, d)) return 1;
  }
  return 0;
}

/* Whether a connection to host is news to tell now; noted as told. */
static int watch_due(const char *host, uint64_t now) {
  if (!g_cfg.watch_n || !host || !host[0] || strlen(host) >= sizeof(g_seen[0].host) || !watched(host)) return 0;
  int due = 1, slot = 0;
  mutex_lock(&g_seen_mx);
  for (int i = 0; i < WATCH_SLOTS; i++) {
    if (g_seen[i].host[0] && name_eq(g_seen[i].host, host)) {
      slot = i;
      due = age_ms(now, g_seen[i].t) >= ENGINE_WATCH_EVERY_MS;
      break;
    }
    if (!g_seen[i].host[0] || g_seen[i].t < g_seen[slot].t) slot = i;
  }
  if (due) { snprintf(g_seen[slot].host, sizeof(g_seen[slot].host), "%s", host); g_seen[slot].t = now; }
  mutex_unlock(&g_seen_mx);
  return due;
}

static void json_host(char *out, size_t cap, const char *in);

static void watch_note(const char *host) {
  if (!watch_due(host, now_ms())) return;
  char h[256];
  json_host(h, sizeof(h), host);
  printf("{\"type\":\"seen\",\"host\":\"%s\"}\n", h);
  fflush(stdout);
}

/* The first bits of a and b (byte strings) are the same. */
static int prefix_eq(const uint8_t *a, const uint8_t *b, int bits) {
  int whole = bits / 8, rest = bits % 8;
  if (memcmp(a, b, (size_t)whole) != 0) return 0;
  if (!rest) return 1;
  uint8_t m = (uint8_t)(0xff << (8 - rest));
  return (a[whole] & m) == (b[whole] & m);
}

/* Is this address (raw bytes of family fam; an IPv4-mapped IPv6 one counts
 * as IPv4) inside one of the --fake-net ranges? */
static int in_fake_net(int fam, const uint8_t *addr) {
  static const uint8_t mapped[12] = { 0,0,0,0, 0,0,0,0, 0,0,0xff,0xff };
  if (fam == AF_INET6 && memcmp(addr, mapped, 12) == 0) { fam = AF_INET; addr += 12; }
  for (int i = 0; i < g_cfg.fake_net_n; i++)
    if (g_cfg.fake_net[i].fam == fam && prefix_eq(addr, g_cfg.fake_net[i].addr, g_cfg.fake_net[i].bits))
      return 1;
  return 0;
}

static int sa_in_fake_net(const struct sockaddr_storage *ss) {
  if (ss->ss_family == AF_INET)
    return in_fake_net(AF_INET, (const uint8_t *)&((const struct sockaddr_in *)ss)->sin_addr);
  if (ss->ss_family == AF_INET6)
    return in_fake_net(AF_INET6, (const uint8_t *)&((const struct sockaddr_in6 *)ss)->sin6_addr);
  return 0;
}

/* A literal address (as a SOCKS request carries it) inside a --fake-net range. */
static int host_in_fake_net(const char *h) {
  struct in_addr a4; struct in6_addr a6;
  if (!g_cfg.fake_net_n) return 0;
  if (inet_pton(AF_INET, h, &a4) == 1) return in_fake_net(AF_INET, (const uint8_t *)&a4);
  if (inet_pton(AF_INET6, h, &a6) == 1) return in_fake_net(AF_INET6, (const uint8_t *)&a6);
  return 0;
}

/* Equal, in a time that does not depend on where they differ. Both are at
 * most 255 bytes; the whole field is always compared. */
static int same_secret(const uint8_t *a, size_t al, const char *b) {
  size_t bl = strlen(b);
  unsigned diff = (unsigned)(al ^ bl);
  for (size_t i = 0; i < 255; i++) {
    uint8_t x = i < al ? a[i] : 0, y = i < bl ? (uint8_t)b[i] : 0;
    diff |= (unsigned)(x ^ y);
  }
  return diff == 0;
}

/* RFC 1929: VER(1) ULEN(1) UNAME PLEN(1) PASSWD, answered 01 00 or 01 01. */
static int socks5_auth(sock_t c) {
  uint8_t h[2], u[255], p[255], pl;
  if (recv_exact(c, h, 2) != 0 || h[0] != 0x01 || h[1] == 0) return -1;
  if (recv_exact(c, u, h[1]) != 0) return -1;
  if (recv_exact(c, &pl, 1) != 0 || pl == 0) return -1;
  if (recv_exact(c, p, pl) != 0) return -1;
  /* Both are checked whatever the first gives. */
  int ok = same_secret(u, h[1], g_cfg.auth_user) & same_secret(p, pl, g_cfg.auth_pass);
  uint8_t rep[2] = { 0x01, ok ? 0x00 : 0x01 };
  sock_send_all(c, rep, 2, 0);
  return ok ? 0 : -1;
}

/* HTTP CONNECT, for the programs that can be given only an HTTP proxy.
 * Windows' WinHTTP drops a PAC's SOCKS entries (it answers "no proxy"), so a
 * program that asks it for the system proxy (Qt programs such as Telegram
 * Desktop, .NET) would otherwise go around Shroudly; the PAC offers it this
 * port as a "PROXY" for https:// as well (system-proxy.js). Only a tunnel:
 * "CONNECT host:port HTTP/1.x", headers to the blank line (read to the byte,
 * so nothing of the tunnel is taken with them), then the same connection as
 * a SOCKS one. Never with --auth-file (Android), which no HTTP client here
 * would answer; and a web page cannot send CONNECT. The two bytes "CO" are
 * already read. */
static int http_connect_accept(sock_t c, socks_req *rq) {
  char h[2048];
  int n = 2;
  h[0] = 'C'; h[1] = 'O';
  while (n < (int)sizeof(h) - 1) {
    if (recv_exact(c, (uint8_t *)h + n, 1) != 0) return -1;
    n++;
    if (n >= 4 && memcmp(h + n - 4, "\r\n\r\n", 4) == 0) break;
  }
  h[n] = 0;
  static const char bad[] = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
  if (n < 4 || memcmp(h + n - 4, "\r\n\r\n", 4) != 0 || strncmp(h, "CONNECT ", 8) != 0) {
    send_str(c, bad); return -1;
  }
  const char *t = h + 8, *sp = strchr(t, ' ');
  if (!sp || strncmp(sp, " HTTP/1.", 8) != 0 || sp - t <= 0 || sp - t > 262) {
    send_str(c, bad); return -1;
  }
  char target[264];
  memcpy(target, t, (size_t)(sp - t)); target[sp - t] = 0;
  char *colon = strrchr(target, ':');
  long port = colon ? strtol(colon + 1, NULL, 10) : 0;
  if (!colon || port <= 0 || port > 65535) { send_str(c, bad); return -1; }
  *colon = 0;
  char *host = target;
  if (host[0] == '[') {
    size_t l = strlen(host);
    if (l < 3 || host[l - 1] != ']') { send_str(c, bad); return -1; }
    host[l - 1] = 0; host++;
    struct in6_addr a6;
    if (inet_pton(AF_INET6, host, &a6) != 1) { send_str(c, bad); return -1; }
  }
  if (!host[0] || strlen(host) > 253) { send_str(c, bad); return -1; }
  for (const char *q = host; *q; q++) {
    char ch = *q;
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == ':' || ch == '_')) {
      send_str(c, bad); return -1;
    }
  }
  rq->ver = 1;
  rq->cmd = 0x01;
  snprintf(rq->host, sizeof(rq->host), "%s", host);
  rq->port = (uint16_t)port;
  return 0;
}

static int socks_accept(sock_t c, socks_req *rq) {
  uint8_t b[300];
  memset(rq, 0, sizeof(*rq));
  int auth = g_cfg.auth_user[0] != 0;
  if (sock_wait_readable(c, 5000) != 1) return -1;
  if (recv_exact(c, b, 2) != 0) return -1;
  if (b[0] == 'C' && b[1] == 'O') {
    if (auth) {
      static const char no[] = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      send_str(c, no);
      return -1;
    }
    return http_connect_accept(c, rq);
  }
  if (b[0] == 0x04) {
    if (auth) { socks4_reply(c, 0x5B); return -1; }
    return socks4_accept(c, b[1], rq);
  }
  if (b[0] != 0x05) return -1;
  rq->ver = 5;
  int nm = b[1];
  if (nm > 0) { if (recv_exact(c, b, nm) != 0) return -1; }
  uint8_t want = auth ? 0x02 : 0x00;
  int offered = !auth;   /* without authentication every client is taken, as always */
  for (int i = 0; i < nm; i++) if (b[i] == want) offered = 1;
  uint8_t rep[2] = { 0x05, offered ? want : 0xFF };
  if (sock_send_all(c, rep, 2, 0) != 0 || !offered) return -1;
  if (auth && socks5_auth(c) != 0) return -1;

  if (recv_exact(c, b, 4) != 0) return -1;
  if (b[0] != 0x05 || (b[1] != 0x01 && b[1] != 0x03)) {   /* CONNECT, UDP ASSOCIATE */
    uint8_t f[10] = { 0x05, 0x07, 0, 0x01, 0,0,0,0, 0,0 };
    sock_send_all(c, f, 10, 0); return -1;
  }
  rq->cmd = b[1];
  int atyp = b[3];
  rq->atyp = (uint8_t)atyp;
  if (atyp == 0x01) {
    uint8_t a[4]; if (recv_exact(c, a, 4) != 0) return -1;
    memcpy(rq->addr, a, 4);
    snprintf(rq->host, sizeof(rq->host), "%u.%u.%u.%u", a[0], a[1], a[2], a[3]);
  } else if (atyp == 0x03) {
    uint8_t l; if (recv_exact(c, &l, 1) != 0) return -1;
    if (l == 0) return -1;                      /* 255 at most: always fits */
    if (recv_exact(c, (uint8_t *)rq->host, l) != 0) return -1;
    rq->host[l] = 0;
  } else if (atyp == 0x04) {
    uint8_t a[16]; if (recv_exact(c, a, 16) != 0) return -1;
    memcpy(rq->addr, a, 16);
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

/* ── dialling ────────────────────────────────────────────────────────────
 * Connect to the first address that answers. A name often has both IPv4 and
 * IPv6 addresses while the network only routes one of them (AAAA records
 * handed out right after Wi-Fi comes up with no IPv6 route; a site's IPv4
 * addresses blocked by address while its IPv6 ones are not), so the families
 * take turns, the preferred one first (IPv4 unless --ipv6): its first
 * address, the other family's first, its second, and so on (RFC 8305). An
 * address that has not connected after DIAL_STAGGER_MS does not hold up the
 * next one: that starts beside it, and whichever connects first is used. On a
 * working path the first connect is done long before, so nothing changes
 * there; a dead address now costs a second rather than eight, and a dead
 * family can no longer use up the time the other one needed.
 *
 * With our own resolver the other family is looked up only once it may be
 * needed — the first try is slow, or has failed — and then on a thread of its
 * own: a lookup can take seconds when a resolver does not answer, and a
 * connect that completes meanwhile must not wait for it. An address that
 * failed is dropped from the resolver's cache, so the next connection does not
 * wait on it again; one that was merely overtaken is kept.
 *
 * Every dial has a time limit. budget_ms > 0 is what the attempt ladder has
 * left, counted from now. 0 is a connection's first dial, made before the
 * client has its SOCKS reply: it gets DIAL_FIRST_MS, so a name whose every
 * address is dead fails in about as long as the old two tries took, however
 * many addresses it has — not the half minute after which a browser gives up
 * on the proxy, and pays again on every new connection. */
#define DIAL_MAX_TRIES   6
#define DIAL_FIRST_MS    14000
#define DIAL_TRY_MS      8000   /* each address, from when it was started */
/* Longer than the 250 ms RFC 8305 suggests: a connect over satellite or a
 * congested mobile link can take most of a second, and racing it there would
 * only double the connections. */
#define DIAL_STAGGER_MS  1000
typedef struct {
  int resolved;   /* addresses the name has */
  int tried;      /* how many of them were tried */
  /* The time ran out before every address had its full try: a failure then
   * says nothing about the host, only that the budget was spent. */
  int cut;
  int rtt_ms;     /* how long the connect that won took: about one round trip */
  int local;      /* how many of those tried are on this computer or its network */
  int noroute;    /* how many of those failed for want of a route from here */
} dial_info;
static int udp_dst_forbidden(const struct sockaddr_storage *ss);
static int udp_dst_private(const struct sockaddr_storage *ss);
static int has_route(const struct sockaddr_storage *sa);

typedef struct { struct sockaddr_storage sa; socklen_t sl; } dial_addr;

/* The other family's addresses, looked up beside the connects. Shared by the
 * dial and the lookup thread; whichever is done with it last frees it. */
typedef struct {
  char host[256];
  uint16_t port;
  int want6;
  struct sockaddr_storage sa[DOH_MAX_ADDRS];
  socklen_t sl[DOH_MAX_ADDRS];
  _Atomic int n;      /* -1 while looking, then how many addresses */
  _Atomic int refs;
} other_lookup;

static void lookup_release(other_lookup *j) {
  if (atomic_fetch_sub(&j->refs, 1) == 1) free(j);
}

static void *lookup_thread(void *p) {
  other_lookup *j = (other_lookup *)p;
  int n = doh_resolve_all(j->host, j->port, j->want6, j->sa, j->sl, DOH_MAX_ADDRS);
  atomic_store(&j->n, n > 0 ? n : 0);
  lookup_release(j);
  return NULL;
}

/* The address that last won a dial for a name when it was not the first one
 * tried: the next dial tries it first, so a dead address ahead of it in the
 * answer costs nothing more — not on the next connection, and not on each
 * re-dial of a ladder, whose budget a second per dial would eat. Its family
 * goes first for that name too. Let go once it fails, or after a while. */
#define WINNER_SLOTS  128
#define WINNER_TTL_MS (10 * 60 * 1000)
static struct { char host[256]; struct sockaddr_storage sa; uint64_t t; int used; } g_win[WINNER_SLOTS];
static mutex_t g_win_mx;

static int same_addr(const struct sockaddr_storage *a, const struct sockaddr_storage *b) {
  if (a->ss_family != b->ss_family) return 0;
  if (a->ss_family == AF_INET)
    return memcmp(&((const struct sockaddr_in *)a)->sin_addr, &((const struct sockaddr_in *)b)->sin_addr, 4) == 0;
  if (a->ss_family == AF_INET6)
    return memcmp(&((const struct sockaddr_in6 *)a)->sin6_addr, &((const struct sockaddr_in6 *)b)->sin6_addr, 16) == 0;
  return 0;
}

/* Caller holds g_win_mx. */
static int winner_find(const char *host) {
  for (int i = 0; i < WINNER_SLOTS; i++)
    if (g_win[i].used && strcmp(g_win[i].host, host) == 0) return i;
  return -1;
}

static int winner_get(const char *host, struct sockaddr_storage *out) {
  mutex_lock(&g_win_mx);
  int i = winner_find(host);
  if (i >= 0 && age_ms(now_ms(), g_win[i].t) >= WINNER_TTL_MS) { g_win[i].used = 0; i = -1; }
  if (i >= 0) *out = g_win[i].sa;
  mutex_unlock(&g_win_mx);
  return i >= 0;
}

static void winner_put(const char *host, const struct sockaddr_storage *sa) {
  mutex_lock(&g_win_mx);
  int slot = winner_find(host);
  uint64_t old = (uint64_t)-1;
  for (int i = 0; slot < 0 && i < WINNER_SLOTS; i++) {   /* else free, else the oldest */
    if (!g_win[i].used) { slot = i; break; }
    if (g_win[i].t < old) { old = g_win[i].t; slot = i; }
  }
  if (slot < 0) slot = 0;
  snprintf(g_win[slot].host, sizeof(g_win[slot].host), "%s", host);
  g_win[slot].sa = *sa; g_win[slot].t = now_ms(); g_win[slot].used = 1;
  mutex_unlock(&g_win_mx);
}

/* sa failed: if it is the address remembered for host, it is no longer. */
static void winner_drop(const char *host, const struct sockaddr_storage *sa) {
  mutex_lock(&g_win_mx);
  int i = winner_find(host);
  if (i >= 0 && same_addr(&g_win[i].sa, sa)) g_win[i].used = 0;
  mutex_unlock(&g_win_mx);
}

/* Move the address equal to hint, if list has it, to the front. */
static void hint_first(dial_addr *list, int n, const struct sockaddr_storage *hint) {
  for (int i = 1; i < n; i++) {
    if (!same_addr(&list[i].sa, hint)) continue;
    dial_addr d = list[i];
    memmove(&list[1], &list[0], (size_t)i * sizeof(dial_addr));
    list[0] = d;
    return;
  }
}

/* Our own resolver's addresses of one family into list; how many. */
static int resolve_family(const char *host, uint16_t port, int want6, dial_addr *list) {
  struct sockaddr_storage sa[DOH_MAX_ADDRS]; socklen_t sl[DOH_MAX_ADDRS];
  int n = doh_resolve_all(host, port, want6, sa, sl, DOH_MAX_ADDRS);
  for (int i = 0; i < n; i++) { list[i].sa = sa[i]; list[i].sl = sl[i]; }
  return n > 0 ? n : 0;
}

static sock_t dial(const char *host, uint16_t port, int prefer6, int use_doh,
                   int budget_ms, int *out_family, dial_info *di) {
  dial_info local;
  if (!di) di = &local;
  memset(di, 0, sizeof(*di));
  uint64_t t0 = now_ms();
  uint64_t end = t0 + (uint64_t)(budget_ms > 0 ? budget_ms : DIAL_FIRST_MS);
  struct sockaddr_storage hint;
  int has_hint = winner_get(host, &hint);
  if (has_hint) prefer6 = hint.ss_family == AF_INET6;   /* the family that worked last */
  dial_addr ad[2][DOH_MAX_ADDRS];   /* [0] the preferred family, [1] the other */
  int cnt[2] = { 0, 0 }, nxt[2] = { 0, 0 };
  int other = 2;                    /* the other family: 0 not looked up, 1 being looked up, 2 known */
  other_lookup *job = NULL;

  if (use_doh) {
    cnt[0] = resolve_family(host, port, prefer6, ad[0]);
    other = ip_literal(host) ? 2 : 0;   /* an address literal is all there is */
  } else {
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_ADDRCONFIG; /* no AAAA answers on an IPv4-only machine */
    char ps[8]; snprintf(ps, sizeof(ps), "%u", port);
    if (getaddrinfo(host, ps, &hints, &res) != 0 || !res) { if (res) freeaddrinfo(res); return SOCK_INVALID; }
    for (struct addrinfo *p = res; p; p = p->ai_next) {
      if (p->ai_family != AF_INET && p->ai_family != AF_INET6) continue;
      if ((size_t)p->ai_addrlen > sizeof(struct sockaddr_storage)) continue;
      int k = (p->ai_family == AF_INET6) == !!prefer6 ? 0 : 1;
      if (cnt[k] >= DOH_MAX_ADDRS) continue;
      memset(&ad[k][cnt[k]].sa, 0, sizeof(ad[k][cnt[k]].sa));
      memcpy(&ad[k][cnt[k]].sa, p->ai_addr, p->ai_addrlen);
      ad[k][cnt[k]].sl = (socklen_t)p->ai_addrlen;
      cnt[k]++;
    }
    freeaddrinfo(res);
  }
  di->resolved = cnt[0] + cnt[1];
  if (has_hint) hint_first(ad[0], cnt[0], &hint);

  /* The connects under way, oldest first. */
  sock_t ps[DIAL_MAX_TRIES]; uint64_t pstart[DIAL_MAX_TRIES]; dial_addr *pa[DIAL_MAX_TRIES];
  int np = 0, tries = 0, turn = 0, failed = 0, won_fam = 0;
  sock_t won = SOCK_INVALID;
  dial_addr *first_try = NULL, *won_addr = NULL;
  uint64_t next_at = t0;
  for (;;) {
    uint64_t t = now_ms();
    if (other == 1 && atomic_load(&job->n) >= 0) {
      int n = atomic_load(&job->n);
      for (int i = 0; i < n; i++) { ad[1][i].sa = job->sa[i]; ad[1][i].sl = job->sl[i]; }
      cnt[1] = n; di->resolved += n;
      lookup_release(job); job = NULL;
      other = 2;
      /* The family that was missing goes next, without waiting its turn. */
      if (n > 0) { turn = 1; next_at = t; }
    }
    int can_more = tries < DIAL_MAX_TRIES;
    /* The other family may be needed: a try has failed or is slow, or the
     * preferred family has nothing at all left to try. */
    if (other == 0 && can_more &&
        (failed || t >= t0 + DIAL_STAGGER_MS || (np == 0 && nxt[0] >= cnt[0]))) {
      if (np == 0 && nxt[0] >= cnt[0]) {
        /* Nothing else to do meanwhile: look it up here. */
        cnt[1] = resolve_family(host, port, !prefer6, ad[1]);
        di->resolved += cnt[1];
        other = 2;
        continue;
      }
      job = (other_lookup *)calloc(1, sizeof(*job));
      if (job) {
        snprintf(job->host, sizeof(job->host), "%s", host);
        job->port = port; job->want6 = !prefer6;
        atomic_store(&job->n, -1); atomic_store(&job->refs, 2);
        if (thread_spawn(lookup_thread, job, 256 * 1024) == 0) { other = 1; continue; }
        free(job); job = NULL;
      }
      cnt[1] = resolve_family(host, port, !prefer6, ad[1]);   /* no thread: here, then */
      di->resolved += cnt[1];
      other = 2;
      continue;
    }

    int left_to_try = can_more && (nxt[0] < cnt[0] || nxt[1] < cnt[1]);
    int more_coming = can_more && other < 2;   /* the other family's lookup is still out */
    if (t >= end) {
      /* Out of time with addresses still connecting or untried: no verdict. */
      if (np > 0 || left_to_try || more_coming) di->cut = 1;
      break;
    }
    if (left_to_try && t >= next_at) {
      int k = nxt[turn] < cnt[turn] ? turn : !turn;
      dial_addr *d = &ad[k][nxt[k]++];
      turn = !k;
      tries++;
      if (udp_dst_forbidden(&d->sa) || udp_dst_private(&d->sa)) di->local++;
      if (!first_try) first_try = d;
      sock_t s = socket(d->sa.ss_family, SOCK_STREAM, IPPROTO_TCP);
      int r = s == SOCK_INVALID ? -1 : sock_connect_start(s, (struct sockaddr *)&d->sa, (int)d->sl);
      if (r == 0) { won = s; won_fam = d->sa.ss_family; won_addr = d; break; }
      if (r < 0) {
        /* Refused or unreachable before it started: the next one goes now. */
        sock_close(s);
        if (!has_route(&d->sa)) di->noroute++;
        if (use_doh) doh_forget(host, &d->sa);
        winner_drop(host, &d->sa);
        failed = 1;
        next_at = t;
        continue;
      }
      ps[np] = s; pstart[np] = t; pa[np] = d; np++;
      next_at = t + DIAL_STAGGER_MS;
      continue;
    }
    if (np == 0 && !left_to_try && !more_coming) break;   /* every address failed */

    /* Wait for a connect, for the next one to be due, for the lookup. */
    uint64_t until = end;
    for (int i = 0; i < np; i++) if (pstart[i] + DIAL_TRY_MS < until) until = pstart[i] + DIAL_TRY_MS;
    if (left_to_try && next_at < until) until = next_at;
    if (other == 0 && can_more && t < t0 + DIAL_STAGGER_MS && t0 + DIAL_STAGGER_MS < until)
      until = t0 + DIAL_STAGGER_MS;
    if (other == 1 && t + 20 < until) until = t + 20;   /* look in on the lookup */
    int ms = until > t ? (int)(until - t) : 0;
    if (np == 0) { sleep_ms(ms > 0 ? ms : 1); continue; }
    int done[DIAL_MAX_TRIES];
    if (sock_connect_wait(ps, np, ms, done) < 0) break;
    t = now_ms();
    int w = -1;
    for (int i = 0; i < np && w < 0; i++) if (done[i] == 1) w = i;   /* the oldest that made it */
    if (w >= 0) {
      won = ps[w]; won_fam = pa[w]->sa.ss_family; won_addr = pa[w];
      di->rtt_ms = (int)age_ms(t, pstart[w]);
      ps[w] = SOCK_INVALID;
      break;
    }
    for (int i = np - 1; i >= 0; i--) {
      /* Refused, unreachable, or silent for its whole try (not merely cut
       * short by the dial's own time): the address's own doing. */
      int timed_out = pstart[i] + DIAL_TRY_MS <= t && pstart[i] + DIAL_TRY_MS <= end;
      if (done[i] != -1 && !timed_out) continue;
      sock_close(ps[i]);
      if (!has_route(&pa[i]->sa)) di->noroute++;
      if (use_doh) doh_forget(host, &pa[i]->sa);
      winner_drop(host, &pa[i]->sa);
      failed = 1;
      next_at = t;
      memmove(&ps[i], &ps[i + 1], (size_t)(np - i - 1) * sizeof(ps[0]));
      memmove(&pstart[i], &pstart[i + 1], (size_t)(np - i - 1) * sizeof(pstart[0]));
      memmove(&pa[i], &pa[i + 1], (size_t)(np - i - 1) * sizeof(pa[0]));
      np--;
    }
  }
  for (int i = 0; i < np; i++) sock_close(ps[i]);   /* overtaken, or out of time */
  if (job) lookup_release(job);
  if (won != SOCK_INVALID) {
    sock_set_nodelay(won, 1);
    sock_set_keepalive(won);
    if (out_family) *out_family = won_fam;
    /* Something ahead of it failed or was overtaken, or it is the one
     * remembered: remember it (again). */
    if (won_addr != first_try || has_hint) winner_put(host, &won_addr->sa);
  }
  di->tried = tries;
  return won;
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
 * A filter acts on a connection's first request: it lets the handshake through
 * and stops what follows. Once the server has answered a request on the
 * connection (application data back after the client's own), the connection
 * is past that point, and what a long-lived one does later is its own
 * business: a WebSocket or a long-poll sends and waits as long as it likes,
 * and its server closes it when idle. From then on only a stall mid-record
 * counts (a filter that freezes a transfer after so many bytes).
 * Each connection reports at most once; the app decides from several. */
#define CUT_MAX_BYTES  (64 * 1024)
#define CUT_STALL_MS   8000
#define CUT_NOREPLY_MS 15000

typedef struct { int have; uint8_t hdr[5]; uint32_t left; int lost; uint32_t apps; } tls_track;

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
        if (t->hdr[0] == 23) t->apps++;          /* application data */
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
  /* The ladder gave up on this connection and relays it only in case it is
   * answered late. Until it is, nothing that happens to it is a cut: no byte
   * of an answer ever came, so there is nothing to have been cut, and a
   * filter that resets a connection it has been swallowing for a while would
   * otherwise be taken for one that cuts working ones. */
  int gave_up;
  tls_track tt;       /* the server's records */
  tls_track ct;       /* the client's records */
  int answered;       /* the server has answered a request after the handshake */
  int site_marked;    /* ok_put done for it */
  int ended;          /* who ended the relay: 1 the server (closed or reset), 2 the client */
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
    if (cw && cw->host && !reported && cw->down < CUT_MAX_BYTES && (cw->down > 0 || !cw->gave_up)) {
      if (tls_mid_record(&cw->tt) && t - last_down >= CUT_STALL_MS) {
        report("cut", cw->host, "stall", (int)(cw->down / 1024), cw->fam, ok_recent(cw->host) ? "site_ok" : NULL); reported = 1;
        hs_on_cut(cw->host);
      } else if (waiting_since && !cw->answered && t - waiting_since >= CUT_NOREPLY_MS) {
        report("cut", cw->host, "noreply", (int)(cw->down / 1024), cw->fam, ok_recent(cw->host) ? "site_ok" : NULL); reported = 1;
      }
    }
    if (w == 0) continue;
    if (w & 1) {
      int n = recv(a, (char *)buf, RELAY_BUF, 0);
      if (n <= 0) { if (cw) cw->ended = 2; break; }
      if (sock_send_all(b, buf, (size_t)n, 0) != 0) break;
      atomic_fetch_add(&g_stats.bytes_up, (uint64_t)n);
      if (!waiting_since) waiting_since = t;   /* oldest request still unanswered */
      if (cw) tls_follow(&cw->ct, buf, n);
    }
    if (w & 2) {
      int n = recv(b, (char *)buf, RELAY_BUF, 0);
      if (n <= 0) {
        /* A reset is a censor's cut only when it lands on business in flight:
         * a request still unanswered, a record arriving in pieces, or a
         * connection that never got a byte. A reset after a completed
         * exchange, with nothing outstanding, is an ordinary keep-alive
         * teardown (Microsoft, Instagram, Discord's gateway all do it), not a
         * cut, and must not be reported as one or learned from. */
        if (n < 0 && sock_errno() == SE_CONNRESET && cw && cw->host && !reported &&
            cw->down < CUT_MAX_BYTES && (cw->down > 0 || !cw->gave_up) &&
            ((waiting_since && !cw->answered) || tls_mid_record(&cw->tt) || cw->down == 0))
        { report("cut", cw->host, "reset", (int)(cw->down / 1024), cw->fam, ok_recent(cw->host) ? "site_ok" : NULL); hs_on_cut(cw->host); reported = 1; }
        if (cw) cw->ended = 1;
        break;
      }
      if (sock_send_all(a, buf, (size_t)n, 0) != 0) break;
      atomic_fetch_add(&g_stats.bytes_down, (uint64_t)n);
      last_down = t;
      waiting_since = 0;
      if (cw) {
        uint32_t apps = cw->tt.apps;
        cw->down += (uint64_t)n;
        tls_follow(&cw->tt, buf, n);
        if (cw->ct.apps > 0 && cw->tt.apps > apps) cw->answered = 1;
        /* Past the size a filter freezes a transfer at: this one got through. */
        if (cw->host && cw->answered && !reported && cw->down >= CUT_MAX_BYTES && !cw->site_marked) {
          ok_put(cw->host); cw->site_marked = 1;
        }
      }
    }
  }
  /* A connection that answered a request and was never cut: the site works. */
  if (cw && cw->host && cw->answered && !reported && !cw->site_marked) ok_put(cw->host);
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
    uint64_t t = now_ms();
    if (t >= deadline) break;
    int left = (int)(deadline - t);
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
  engine_printf("{\"type\":\"%s\",\"host\":\"%s\",\"strategy\":\"%s\","
                "\"attempts\":%d,\"family\":\"%s\"%s%s%s}\n",
                ev, h, strat ? strat : "", attempts, fam == AF_INET6 ? "ipv6" : "ipv4",
                note ? ",\"note\":\"" : "", note ? note : "", note ? "\"" : "");
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
  int slot = -1, oldest = 0;
  mutex_lock(&g_unreach_mx);
  uint64_t t = now_ms();   /* under the lock: see age_ms */
  for (int i = 0; i < UNREACH_SLOTS; i++) {
    if (g_unreach[i].host[0] && strcmp(g_unreach[i].host, h) == 0) { slot = i; break; }
    if (g_unreach[i].t < g_unreach[oldest].t) oldest = i;
  }
  if (slot >= 0 && age_ms(t, g_unreach[slot].t) < UNREACH_REPEAT_MS) { mutex_unlock(&g_unreach_mx); return; }
  if (slot < 0) { slot = oldest; snprintf(g_unreach[slot].host, sizeof(g_unreach[slot].host), "%s", h); }
  g_unreach[slot].t = t;
  mutex_unlock(&g_unreach_mx);
  engine_printf("{\"type\":\"unreachable\",\"host\":\"%s\",\"stage\":\"%s\",\"ips\":%d}\n",
                h, di && di->resolved > 0 ? "connect" : "dns", di ? di->tried : 0);
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
 * much of the client's payload it carries, when that went out, with which
 * technique, as which attempt (0: the ladder's first), and whether it holds
 * room among the re-dialled connections (see room_take). */
typedef struct { sock_t s; int fam; int sent; uint64_t at; int cand; int idx; int room; } leg;

/* Send the first payload using `preset` (or unmodified for ATT_PLAIN).
 * Returns 0; ATT_REFUSED when the connection was reset or closed under us
 * while the payload went out — a filter that resets a handshake after its
 * first piece makes a technique's later writes fail exactly so, and that is
 * the network refusing, not us failing; ATT_LOCAL for any other failure of
 * our own send. */
static int attempt_send(sock_t up, int fam, uint8_t *payload, int pcap, int len,
                        const proto_info *pi, int preset) {
  int rc;
  if (preset >= ATT_RAW_BASE) {
    /* A raw technique: cuts at fixed places, for a payload of any kind. */
    rc = desync_send_first(up, fam, payload, len, pcap, pi, strategy_raw(preset - ATT_RAW_BASE),
                           &g_stats.desync_applied);
  } else if (preset == ATT_PLAIN || pi->kind == PROTO_UNKNOWN) {
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
 * with them left in `rbuf` and their length in `*rlen`, or ATT_REFUSED —
 * ATT_ALERT when (TLS) what came back was a well-formed alert: a refusal all
 * the same, but one made by something that speaks TLS. */
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
    if (!tls_reply_ok(rbuf, n))
      return (n >= 7 && rbuf[0] == 0x15 && rbuf[1] == 0x03 && rbuf[3] == 0 && rbuf[4] == 2) ? ATT_ALERT : ATT_REFUSED;
  }
  *rlen = n;
  return ATT_OK;
}

/* ── legs ────────────────────────────────────────────────────────────────
 * Every connection a ladder opens stays open until one of them answers: an
 * attempt that went unanswered may only be slow, and moving on to the next
 * must not throw its answer away. So the ladder listens to all of them at
 * once and uses whichever answers first (the oldest, when several do at
 * once) — and which one that was, set against the untouched request, is what
 * it learns from. */
typedef struct { leg l[LEG_MAX]; int n; int max; /* at most this many open, <= LEG_MAX */ } legset;

static void legs_drop(legset *L, int i) {
  sock_close(L->l[i].s);
  if (L->l[i].room) room_give();
  memmove(&L->l[i], &L->l[i + 1], (size_t)(L->n - i - 1) * sizeof(leg));
  L->n--;
}

/* Take connection i out of the set, still open: the one to relay, no longer
 * one of the ladder's extra connections. */
static leg legs_take(legset *L, int i) {
  leg g = L->l[i];
  if (g.room) { room_give(); g.room = 0; }
  memmove(&L->l[i], &L->l[i + 1], (size_t)(L->n - i - 1) * sizeof(leg));
  L->n--;
  return g;
}

static void legs_close(legset *L) { while (L->n > 0) legs_drop(L, L->n - 1); }

/* Make room for one more connection, before it is dialled, so the set never
 * has more than L->max open even for a moment. With none left, the oldest
 * technique's connection goes: a later one is as likely to be answered, while
 * the untouched request is never let go — it is what tells a slow server from
 * a filter. */
static void legs_make_room(legset *L) {
  while (L->n > 0 && L->n >= L->max) {
    int k = 0;
    while (k < L->n - 1 && L->l[k].cand == ATT_PLAIN) k++;
    legs_drop(L, k);
  }
}

/* Add the attempt just made. */
static void legs_add(legset *L, leg g) {
  legs_make_room(L);
  L->l[L->n++] = g;
}

/* What a ladder started from, and what it has seen so far. */
typedef struct {
  const char *key;
  const proto_info *pi;
  int tls;
  int learned, inherited;  /* the technique known for the host (-1: none), and whether it is the site's */
  int opened_learned;      /* the ladder opened with that technique */
  int race;                /* the ladder raced the untouched request against a technique */
  int saw_refusal;         /* some attempt was refused */
  int plain_refused;       /* the untouched request was */
  int plain_alert;         /* ... with a TLS alert */
  int hard_refusals;       /* refusals that were not alerts: resets, closes, anything else */
  int first_failed;        /* the technique it opened with was refused, or (TLS) went unanswered */
  int made;                /* attempts that went out */
  int silent;              /* attempts whose wait ran out unanswered */
  legset L;
} ladder_st;

static void note_refused(ladder_st *st, const leg *g, int alert) {
  st->saw_refusal = 1;
  if (g->cand == ATT_PLAIN) { st->plain_refused = 1; if (alert) st->plain_alert = 1; }
  if (!alert) st->hard_refusals++;
  if (g->idx == 0 && st->opened_learned) st->first_failed = 1;
}

/* Read whatever is ready on the ladder's connections (ready[] from
 * sock_wait_any): ATT_OK with *win set at the first, oldest, that answered;
 * otherwise each that was refused is noted and closed, and *newest_gone says
 * whether the attempt made last was among them. */
static int read_legs(ladder_st *st, const int *ready, uint8_t *rbuf, int rcap, int *rlen,
                     int *win, int *newest_gone) {
  legset *L = &st->L;
  int n = L->n, newest = n > 0 ? L->l[n - 1].idx : -1, gone[LEG_MAX];
  *newest_gone = 0;
  for (int i = 0; i < n; i++) {
    gone[i] = 0;
    if (!ready[i]) continue;
    int r = read_reply(L->l[i].s, st->pi, rbuf, rcap, rlen);
    if (r == ATT_OK) { *win = i; return ATT_OK; }
    note_refused(st, &L->l[i], r == ATT_ALERT);
    gone[i] = 1;
  }
  for (int i = n - 1; i >= 0; i--) {
    if (!gone[i]) continue;
    if (L->l[i].idx == newest) *newest_gone = 1;
    legs_drop(L, i);
  }
  return ATT_REFUSED;
}

/* Wait up to wait_ms for an answer on any of the ladder's connections.
 * ATT_OK with *win set (its first bytes in rbuf); ATT_REFUSED when the newest
 * — the attempt just made — was refused, and is closed; ATT_SILENT when the
 * time ran out with it still unanswered. An older one refused meanwhile is
 * closed and noted, and the wait goes on. */
static int await_legs(ladder_st *st, int wait_ms, uint8_t *rbuf, int rcap, int *rlen, int *win) {
  legset *L = &st->L;
  uint64_t end = now_ms() + (uint64_t)(wait_ms > 0 ? wait_ms : 0);
  *rlen = 0;
  for (;;) {
    if (L->n == 0) return ATT_REFUSED;
    uint64_t t = now_ms();
    if (t >= end) return ATT_SILENT;
    sock_t s[LEG_MAX]; int ready[LEG_MAX], gone = 0;
    for (int i = 0; i < L->n; i++) s[i] = L->l[i].s;
    int w = sock_wait_any(s, L->n, (int)(end - t), ready);
    if (w < 0) { legs_drop(L, L->n - 1); return ATT_REFUSED; }
    if (w == 0) return ATT_SILENT;           /* blackholed, or merely slow */
    if (read_legs(st, ready, rbuf, rcap, rlen, win, &gone) == ATT_OK) return ATT_OK;
    if (gone) return ATT_REFUSED;
  }
}

/* Room for the next attempt's connection (see EXTRA_LEGS_MAX). While there is
 * none, the ladder's open connections are listened to, a little at a time,
 * so an answer on one of them is not kept waiting. 1 with room taken; 2 when
 * one of them answered meanwhile (*win set, as in await_legs); 0 when there
 * is no longer budget enough for another attempt. */
#define ROOM_POLL_MS 200
static int wait_room(ladder_st *st, uint64_t deadline, uint8_t *rbuf, int rcap, int *rlen, int *win) {
  legset *L = &st->L;
  for (;;) {
    if (room_take()) return 1;
    if (now_ms() + ATT_MIN_LEFT_MS > deadline) return 0;
    if (L->n == 0) { sleep_ms(ROOM_POLL_MS); continue; }
    sock_t s[LEG_MAX]; int ready[LEG_MAX], gone = 0;
    for (int i = 0; i < L->n; i++) s[i] = L->l[i].s;
    int w = sock_wait_any(s, L->n, ROOM_POLL_MS, ready);
    if (w < 0) sleep_ms(ROOM_POLL_MS);
    else if (w > 0 && read_legs(st, ready, rbuf, rcap, rlen, win, &gone) == ATT_OK) return 2;
  }
}

/* The ladder is over with nothing answered, but its connections are still
 * open and one may yet be: a server that is only slow, a path that takes
 * longer than the ladder waited. Go on listening to all of them, and to the
 * client, until one answers (1, *win set), all are gone or the client has
 * left (0), or (2) the oldest should simply be relayed: the client has sent
 * more than can be held meanwhile, or RACE_MAX_MS went by. */
static int race_legs(ladder_st *st, sock_t client, uint8_t *rbuf, int rcap, int *rlen, int *win,
                     uint8_t *first, int *flen) {
  legset *L = &st->L;
  uint64_t end = now_ms() + RACE_MAX_MS;
  *rlen = 0;
  for (;;) {
    if (L->n == 0) return 0;
    uint64_t t = now_ms();
    if (t >= end) return 2;
    sock_t s[LEG_MAX + 1]; int ready[LEG_MAX + 1], gone = 0, n = L->n;
    for (int i = 0; i < n; i++) s[i] = L->l[i].s;
    s[n] = client;
    int w = sock_wait_any(s, n + 1, (int)(end - t), ready);
    if (w < 0) return 2;
    if (w == 0) continue;
    if (read_legs(st, ready, rbuf, rcap, rlen, win, &gone) == ATT_OK) return 1;
    if (ready[n]) {
      if (*flen >= RELAY_BUF) return 2;
      int m = recv(client, (char *)first + *flen, RELAY_BUF - *flen, 0);
      if (m <= 0) return 0;
      *flen += m;
    }
  }
}

/* Connection w (still in the set) answered. What does that teach? Only what
 * the network showed. A technique is learned — for this name and its site —
 * when the untouched request was refused, or (TLS, where only a real
 * handshake counts as an answer) was still unanswered on its own connection
 * while the technique got through on another; or when the ladder opened with
 * a technique learned like that before, and this one replaced it after it
 * failed here. Anything else teaches nothing: the known technique answering
 * at once, or the untouched request answering, however late. */
static void ladder_won(ladder_st *st, const leg *w) {
  atomic_fetch_add(&g_stats.probe_success, 1);
  cool_drop(st->key);   /* it answers: whatever came to nothing before is over */
  if (w->cand == ATT_PLAIN) {
    /* The untouched request got through: whatever technique this ladder had
     * to go on — one that failed first, or one it was checking — is not
     * needed here, and a silent search is over. */
    if (st->learned >= 0) hs_unlearn(st->key, st->inherited);
    if (st->tls) rs_drop(st->key);
    return;
  }
  if (w->cand < 0) return;
  int plain_open = 0;
  for (int i = 0; i < st->L.n; i++) if (st->L.l[i].cand == ATT_PLAIN) plain_open = 1;
  int untouched_blocked = st->plain_refused || (st->tls && plain_open);
  int replaces = st->opened_learned && st->first_failed && w->idx != 0;
  if (untouched_blocked || replaces) {
    hs_put(st->key, w->cand);
    /* News only when it is new, not when a known technique is confirmed. And
     * "silent" when nothing was ever refused: a different kind of filter, and
     * worth telling apart when reading a report. */
    if (w->cand != st->learned)
      report("bypass", st->key, strategy_preset(w->cand)->name, st->made, w->fam,
             st->saw_refusal ? NULL : "silent");
  } else if (st->tls) {
    rs_drop(st->key);
  }
}

/* How long a raced untouched request has to itself (see RACE_HEAD_MIN_MS),
 * from how long the first connect took. */
static int race_head_ms(int rtt_ms) {
  int h = 2 * rtt_ms + RACE_HEAD_MIN_MS;
  return h > RACE_HEAD_MAX_MS ? RACE_HEAD_MAX_MS : h;
}

/* The ladder's last word when nothing got through: "blocked" — unless every
 * attempt made failed in our own send, which says nothing about the network,
 * and is reported as that instead. st->made: the attempts that actually went
 * out. Two things the app needs to judge it come with it:
 *   site_ok — another name of the same site answered requests through
 *             Shroudly in the last OK_RECENT_MS: the site itself is not
 *             blocked, this one name does not answer this client;
 *   alert   — the untouched request was answered with a TLS alert and nothing
 *             was ever reset or closed: the server turned the handshake down
 *             itself (a client it does not accept, a name it does not serve). */
static void report_gave_up(const ladder_st *st, int local_fails, int fam) {
  if (st->made > 0 && local_fails == st->made) { report("send_failed", st->key, "", st->made, fam, NULL); return; }
  char h[256];
  json_host(h, sizeof(h), st->key);
  int alert = st->plain_alert && st->hard_refusals == 0;
  engine_printf("{\"type\":\"blocked\",\"host\":\"%s\",\"strategy\":\"\",\"attempts\":%d,\"family\":\"%s\"%s%s%s}\n",
                h, st->made, fam == AF_INET6 ? "ipv6" : "ipv4",
                st->saw_refusal ? "" : ",\"note\":\"silent\"",
                ok_recent(st->key) ? ",\"site_ok\":true" : "",
                alert ? ",\"alert\":true" : "");
}

/* ── UDP ASSOCIATE (RFC 1928 section 7) ──────────────────────────────────
 * Games, voice calls and an app's own DNS go over UDP, which a CONNECT can
 * not carry: on Android every packet of the phone reaches us through a
 * tun2socks, and its UDP arrives here as associations. Each one is a plain
 * relay, no desync — a datagram has no handshake to hide and nothing to
 * replay — run on the connection's own thread like a CONNECT:
 *
 *   - the client's TCP control connection asks for it and gets a relay port,
 *     a UDP socket on 127.0.0.1 of its own, on an ephemeral port the system
 *     picks; the association lives exactly as long as that connection, or
 *     until UDP_IDLE_MS pass with no datagram either way, and everything it
 *     holds is closed with it;
 *   - only a loopback client may ask, and the association belongs to one
 *     client endpoint, address and port: the one the request names (when it
 *     gives a port, and as address 0.0.0.0 or the control connection's own),
 *     else the one the first well-formed datagram comes from. It is fixed
 *     from then on; a datagram from any other port is dropped, so another
 *     program on this machine can neither send through the association nor
 *     take its replies. A fragment (FRAG != 0) or a malformed header is
 *     dropped too. hev-socks5-tunnel (the Android app's tun2socks) asks with
 *     0.0.0.0:0, so there it is always the first well-formed datagram that
 *     pins it. That leaves a window, from our reply to the client's first
 *     datagram, in which another local program that found the new relay
 *     port could send first and take the association; the port is
 *     ephemeral, on loopback, and only told to the client that asked, and
 *     with --auth-file only a client that gave the password can create an
 *     association at all. That residual race is accepted;
 *   - each datagram goes out, without its header, from an outbound socket of
 *     the association's own (one per address family, opened when first
 *     needed) to the address or name in its header — a name through our own
 *     resolver, as CONNECT does. Never to a loopback or unspecified address:
 *     nothing a tunnelled app sends needs one, and it would let one relay
 *     feed another, or itself. Nor to a --fake-net address: dropped;
 *   - plain DNS (a query to port 53) goes to our encrypted-DNS forwarder
 *     instead, when the engine has one (--doh with --doh-port), so an app
 *     with a resolver of its own still gets answers nobody on the path can
 *     read or forge. Only a well-formed standard query (QR clear, opcode 0,
 *     one question), and not one for a resolver at a private or link-local
 *     address nor about a name only the LAN knows (doh_local_name): those go
 *     where they were sent, as does anything else on port 53. Each one
 *     carries an id of its own to the forwarder; the answer gets the app's
 *     id back and is headed with the address the app asked, as if that one
 *     had answered. One not answered within UDP_DNS_PLAIN_MS is also sent
 *     where it was headed, in plaintext, as before there was a forwarder,
 *     and that answer is relayed like any datagram. An answer longer than
 *     512 bytes to a query without EDNS comes back as the question with TC
 *     set, so the app asks again over TCP;
 *   - whatever comes back to an outbound socket goes to the client, headed
 *     with where it came from: nothing is sent anywhere that did not send
 *     first, so the relay cannot be used to amplify.
 * At most UDP_ASSOC_MAX associations at once; one more is refused. */
#define UDP_ASSOC_MAX    256
#define UDP_IDLE_MS      120000
#define UDP_MAX_PAYLOAD  65507   /* the most an IPv4 datagram can carry */
#define UDP_DRAIN        64      /* datagrams read from one socket per wake-up */
#define UDP_SOCK_BUF     (256 * 1024)
#define UDP_NAME_OK_MS   30000   /* how long a name's address is reused */
#define UDP_NAME_BAD_MS  5000    /* and how long a name that did not resolve is not asked again */
#define UDP_DNS_SLOTS    32      /* DNS queries waiting for the forwarder, per association */
#define UDP_DNS_WAIT_MS  10000   /* and how long one waits before its slot is let go */
#define UDP_DNS_PLAIN_MS 2500    /* unanswered by then: also sent where the app sent it */
#define UDP_DNS_Q_MAX    1232    /* the longest query redirected (a common EDNS size) */

static _Atomic int g_udp_assocs = 0;

static void sa_set_port(struct sockaddr_storage *ss, uint16_t port) {
  if (ss->ss_family == AF_INET) ((struct sockaddr_in *)ss)->sin_port = htons(port);
  else if (ss->ss_family == AF_INET6) ((struct sockaddr_in6 *)ss)->sin6_port = htons(port);
}

static int is_loopback4(const struct sockaddr_storage *ss) {
  return ss->ss_family == AF_INET &&
         (ntohl(((const struct sockaddr_in *)ss)->sin_addr.s_addr) >> 24) == 127;
}

/* An IPv4 address (host order) a datagram must not go to: 0.0.0.0/8 and
 * loopback. */
static int udp_v4_forbidden(uint32_t a) {
  return (a >> 24) == 0 || (a >> 24) == 127;
}

/* A destination the relay refuses: loopback or unspecified, in either family,
 * IPv4-mapped IPv6 included, and anything that is neither family. */
static int udp_dst_forbidden(const struct sockaddr_storage *ss) {
  if (ss->ss_family == AF_INET)
    return udp_v4_forbidden(ntohl(((const struct sockaddr_in *)ss)->sin_addr.s_addr));
  if (ss->ss_family != AF_INET6) return 1;
  const uint8_t *a = (const uint8_t *)&((const struct sockaddr_in6 *)ss)->sin6_addr;
  static const uint8_t zero[16] = { 0 };
  if (memcmp(a, zero, 15) == 0 && (a[15] == 0 || a[15] == 1)) return 1;   /* ::, ::1 */
  if (memcmp(a, zero, 10) == 0 && a[10] == 0xff && a[11] == 0xff)           /* ::ffff:a.b.c.d */
    return udp_v4_forbidden(((uint32_t)a[12] << 24) | ((uint32_t)a[13] << 16) |
                            ((uint32_t)a[14] << 8) | a[15]);
  return 0;
}

/* A non-blocking UDP socket of family fam, with room for a burst. */
static sock_t udp_socket(int fam) {
  sock_t s = socket(fam, SOCK_DGRAM, IPPROTO_UDP);
  if (s == SOCK_INVALID) return SOCK_INVALID;
  int v = UDP_SOCK_BUF;
  /* Besides the room: macOS will not send a datagram larger than the send
   * buffer, 9216 bytes by default. */
  setsockopt(s, SOL_SOCKET, SO_SNDBUF, (const char *)&v, sizeof(v));
  setsockopt(s, SOL_SOCKET, SO_RCVBUF, (const char *)&v, sizeof(v));
  if (fam == AF_INET6) {
    int one = 1;
    setsockopt(s, IPPROTO_IPV6, IPV6_V6ONLY, (const char *)&one, sizeof(one));
  }
  if (sock_set_nonblock(s, 1) != 0) { sock_close(s); return SOCK_INVALID; }
  return s;
}

/* A name's address for a datagram, the preferred family first: our own
 * resolver when the engine uses it (as a CONNECT would), else the system's.
 * 0 on success. */
static int udp_resolve(const char *host, uint16_t port, struct sockaddr_storage *out, socklen_t *ol) {
  int pref6 = g_cfg.prefer_ipv6;
  if (g_cfg.use_doh) {
    if (doh_resolve(host, port, pref6, out, ol) == 0) return 0;
    return doh_resolve(host, port, !pref6, out, ol);
  }
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_DGRAM;
  hints.ai_flags = AI_ADDRCONFIG;
  char ps[8]; snprintf(ps, sizeof(ps), "%u", port);
  if (getaddrinfo(host, ps, &hints, &res) != 0 || !res) { if (res) freeaddrinfo(res); return -1; }
  const struct addrinfo *pick = NULL;
  for (const struct addrinfo *p = res; p; p = p->ai_next) {
    if ((p->ai_family != AF_INET && p->ai_family != AF_INET6) ||
        (size_t)p->ai_addrlen > sizeof(struct sockaddr_storage)) continue;
    if (!pick) pick = p;
    if ((p->ai_family == AF_INET6) == !!pref6) { pick = p; break; }
  }
  if (pick) {
    memset(out, 0, sizeof(*out));
    memcpy(out, pick->ai_addr, pick->ai_addrlen);
    *ol = (socklen_t)pick->ai_addrlen;
  }
  freeaddrinfo(res);
  return pick ? 0 : -1;
}

/* SOCKS5 reply carrying an IPv4 BND.ADDR / BND.PORT (network order). */
static int socks5_reply_bnd(sock_t c, uint8_t rep, uint32_t addr_n, uint16_t port_n) {
  uint8_t r[10] = { 0x05, rep, 0, 0x01 };
  memcpy(r + 4, &addr_n, 4);
  memcpy(r + 8, &port_n, 2);
  return sock_send_all(c, r, 10, 0);
}

/* A DNS query sent on to the forwarder. It carries an id of its own there,
 * unique among the queries waiting, so two apps (or one app's two resolvers)
 * that picked the same id cannot get each other's answers; the app's id and
 * the header it gave (where it sent the query) head the answer on the way
 * back. The query itself is kept for the plaintext fallback. */
typedef struct {
  uint16_t fid;                          /* the id it carries to the forwarder */
  uint16_t aid;                          /* the app's own id */
  uint16_t hl;                           /* header length */
  uint16_t ql;                           /* query length */
  uint16_t qend;                         /* where its question ends */
  uint8_t  edns;                         /* it has an OPT record: answers over 512 bytes are fine */
  uint8_t  plain;                        /* also sent where it was headed */
  uint8_t  used;
  uint64_t t;
  uint8_t  hdr[SUDP_HDR_MAX];
  uint8_t  q[UDP_DNS_Q_MAX];             /* as the app sent it, its own id included */
} udp_dns_q;

/* The association's state: its sockets, the client's endpoint, and the last
 * name it sent to. Lives on the connection thread's stack; buf on the heap. */
typedef struct {
  sock_t relay, out4, out6;
  sock_t dns;                            /* to the encrypted-DNS forwarder, once used */
  struct sockaddr_in self;               /* the relay port's own address */
  struct sockaddr_storage peer;          /* the control connection's client */
  struct sockaddr_in client;             /* the one endpoint datagrams are taken from */
  int have_client;                       /* client is set, for good */
  struct { char host[256]; struct sockaddr_storage sa; socklen_t sl; int ok; uint64_t t; } name;
  udp_dns_q *dq;                         /* UDP_DNS_SLOTS of them, once used */
  uint32_t idseq;                        /* where the next forwarder id comes from */
  uint8_t *buf;
  uint64_t last;                         /* last datagram either way */
} udp_assoc;

/* Private and link-local ranges (a LAN's own resolver lives there): IPv4
 * 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10; IPv6 fc00::/7,
 * fe80::/10, and the IPv4 ones mapped. */
static int udp_v4_private(uint32_t a) {
  return (a >> 24) == 10 || (a >> 20) == 0xac1 || (a >> 16) == 0xc0a8 ||
         (a >> 16) == 0xa9fe || (a >> 22) == (0x64400000u >> 22);
}
static int udp_dst_private(const struct sockaddr_storage *ss) {
  if (ss->ss_family == AF_INET)
    return udp_v4_private(ntohl(((const struct sockaddr_in *)ss)->sin_addr.s_addr));
  if (ss->ss_family != AF_INET6) return 0;
  const uint8_t *a = (const uint8_t *)&((const struct sockaddr_in6 *)ss)->sin6_addr;
  static const uint8_t mapped[12] = { 0,0,0,0, 0,0,0,0, 0,0,0xff,0xff };
  if (memcmp(a, mapped, 12) == 0)
    return udp_v4_private(((uint32_t)a[12] << 24) | ((uint32_t)a[13] << 16) |
                          ((uint32_t)a[14] << 8) | a[15]);
  return (a[0] & 0xfe) == 0xfc || (a[0] == 0xfe && (a[1] & 0xc0) == 0x80);
}

/* Is q (n bytes) a well-formed standard query: QR clear, opcode 0 (QUERY),
 * exactly one question, and every record after it whole? Then 0, with the
 * question's name (dotted; "" for the root) in name, where the question ends
 * in *qend, and whether an OPT record (EDNS) is among the additional ones in
 * *edns. -1 for anything else. A name in the question is plain labels; a
 * label holding a NUL or a dot is refused, as it would read as another name. */
static int dns_query_parse(const uint8_t *q, size_t n, char *name, size_t cap,
                           size_t *qend, int *edns) {
  if (n < 12 + 5 || cap < 256) return -1;
  if ((q[2] & 0x80) || ((q[2] >> 3) & 0x0f) != 0) return -1;
  if (q[4] != 0 || q[5] != 1) return -1;
  unsigned an = (unsigned)((q[6] << 8) | q[7]), ns = (unsigned)((q[8] << 8) | q[9]),
           ar = (unsigned)((q[10] << 8) | q[11]);
  size_t p = 12, k = 0;
  for (;;) {
    if (p >= n) return -1;
    uint8_t l = q[p++];
    if (l == 0) break;
    if (l > 63 || p + l > n || k + l + 1 > 254) return -1;
    if (k) name[k++] = '.';
    for (uint8_t i = 0; i < l; i++) {
      uint8_t c = q[p + i];
      if (c == 0 || c == '.') return -1;
      name[k++] = (char)c;
    }
    p += l;
  }
  name[k] = 0;
  if (p + 4 > n) return -1;
  p += 4;
  *qend = p;
  *edns = 0;
  for (unsigned r = 0; r < an + ns + ar; r++) {
    /* The owner name: labels, ended by a zero or by a pointer. */
    for (;;) {
      if (p >= n) return -1;
      uint8_t l = q[p];
      if ((l & 0xc0) == 0xc0) { if (p + 2 > n) return -1; p += 2; break; }
      if (l & 0xc0) return -1;
      p += 1 + (size_t)l;
      if (l == 0) break;
    }
    if (p + 10 > n) return -1;
    uint16_t type = (uint16_t)((q[p] << 8) | q[p + 1]);
    size_t rdlen = (size_t)((q[p + 8] << 8) | q[p + 9]);
    p += 10;
    if (p + rdlen > n) return -1;
    p += rdlen;
    if (r >= an + ns && type == 41) *edns = 1;
  }
  return 0;
}

/* A datagram from the client, without its header, to where the header says:
 * a name through our resolver (the last one is remembered), never into this
 * machine nor to a stand-in address. 0 when it went. */
static int udp_send_out(udp_assoc *u, const sudp_dst *d, const uint8_t *payload, size_t plen) {
  struct sockaddr_storage to; socklen_t tl;
  if (sudp_dst_addr(d, &to, &tl) != 0) {
    uint64_t t = now_ms();
    if (!(u->name.host[0] && strcmp(u->name.host, d->host) == 0 &&
          age_ms(t, u->name.t) < (u->name.ok ? UDP_NAME_OK_MS : UDP_NAME_BAD_MS))) {
      snprintf(u->name.host, sizeof(u->name.host), "%s", d->host);
      u->name.ok = udp_resolve(d->host, d->port, &u->name.sa, &u->name.sl) == 0;
      u->name.t = now_ms();
    }
    if (!u->name.ok) return -1;
    to = u->name.sa; tl = u->name.sl;
    sa_set_port(&to, d->port);
  }
  /* Not into this machine: not into the relay port itself, nor into
   * another association's. */
  if (udp_dst_forbidden(&to) || sa_in_fake_net(&to)) return -1;
  sock_t *os = to.ss_family == AF_INET6 ? &u->out6 : &u->out4;
  if (*os == SOCK_INVALID) *os = udp_socket(to.ss_family);
  if (*os == SOCK_INVALID) return -1;
  /* A datagram the network cannot take now is dropped, as UDP would. */
  if (sendto(*os, (const char *)payload, (int)plen, 0, (struct sockaddr *)&to, tl) < 0) return -1;
  u->last = now_ms();
  atomic_fetch_add(&g_stats.bytes_up, (uint64_t)plen);
  return 0;
}

/* The next id towards the forwarder: not one a waiting query has. Only the
 * forwarder (on loopback, the socket is connected to it) can answer, so the
 * ids need to be distinct more than unguessable. */
static uint16_t udp_dns_fid(udp_assoc *u) {
  for (;;) {
    uint32_t x = u->idseq;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    u->idseq = x ? x : 0x9e3779b9u;
    uint16_t id = (uint16_t)(x ^ (x >> 16));
    int taken = 0;
    for (int i = 0; i < UDP_DNS_SLOTS && !taken; i++) taken = u->dq[i].used && u->dq[i].fid == id;
    if (!taken) return id;
  }
}

/* Plain DNS from the client, sent to the forwarder instead of where it was
 * headed. 1 when it went (it is done with), 0 when it should go out as any
 * other datagram: the engine has no forwarder, the datagram is not a
 * well-formed standard query, it is for a resolver on the LAN or about a name
 * only the LAN knows, it is too long to keep, or every slot is waiting on a
 * query that has not been answered at all yet. */
static int udp_dns_redirect(udp_assoc *u, const sudp_dst *d, const uint8_t *hdr,
                            const uint8_t *q, size_t ql) {
  if (!g_cfg.use_doh || ql > UDP_DNS_Q_MAX) return 0;
  struct sockaddr_in fwd;
  if (doh_local_addr(&fwd) != 0) return 0;
  char name[256]; size_t qend; int edns;
  if (dns_query_parse(q, ql, name, sizeof(name), &qend, &edns) != 0) return 0;
  if (doh_local_name(name)) return 0;
  struct sockaddr_storage to; socklen_t tl;
  if (sudp_dst_addr(d, &to, &tl) == 0) { if (udp_dst_private(&to)) return 0; }
  else if (doh_local_name(d->host)) return 0;
  if (!u->dq) {
    u->dq = (udp_dns_q *)calloc(UDP_DNS_SLOTS, sizeof(udp_dns_q));
    if (!u->dq) return 0;
    u->idseq = (uint32_t)now_ms() ^ (uint32_t)(uintptr_t)u ^ 0x5bd1e995u;
  }
  if (u->dns == SOCK_INVALID) {
    u->dns = udp_socket(AF_INET);
    if (u->dns == SOCK_INVALID) return 0;
    /* Bound to the forwarder: nothing else can answer on this socket. */
    if (connect(u->dns, (struct sockaddr *)&fwd, sizeof(fwd)) != 0) {
      sock_close(u->dns); u->dns = SOCK_INVALID; return 0;
    }
  }
  uint64_t t = now_ms();
  /* A free or expired slot, else the oldest one already sent in plaintext
   * too (it has had its answer, or soon will), else none. */
  int slot = -1, oldest = -1;
  for (int i = 0; i < UDP_DNS_SLOTS && slot < 0; i++) {
    udp_dns_q *e = &u->dq[i];
    if (!e->used || age_ms(t, e->t) >= UDP_DNS_WAIT_MS) slot = i;
    else if (e->plain && (oldest < 0 || e->t < u->dq[oldest].t)) oldest = i;
  }
  if (slot < 0) slot = oldest;
  if (slot < 0) return 0;
  udp_dns_q *e = &u->dq[slot];
  e->used = 0;
  e->fid = udp_dns_fid(u);
  e->aid = (uint16_t)((q[0] << 8) | q[1]);
  e->hl = (uint16_t)d->hdr_len; e->ql = (uint16_t)ql; e->qend = (uint16_t)qend;
  e->edns = (uint8_t)edns; e->plain = 0; e->t = t;
  memcpy(e->hdr, hdr, d->hdr_len);
  e->hdr[0] = e->hdr[1] = e->hdr[2] = 0;                 /* RSV, FRAG */
  memcpy(e->q, q, ql);
  uint8_t out[UDP_DNS_Q_MAX];
  memcpy(out, q, ql);
  out[0] = (uint8_t)(e->fid >> 8); out[1] = (uint8_t)e->fid;
  if (send(u->dns, (const char *)out, (int)ql, 0) < 0) return 0;
  e->used = 1;
  u->last = t;
  atomic_fetch_add(&g_stats.bytes_up, (uint64_t)ql);
  return 1;
}

/* Queries the forwarder has not answered within UDP_DNS_PLAIN_MS go where
 * the app sent them, in plaintext, as they would have without the
 * forwarder; the answer comes back like any other datagram's. A late answer
 * from the forwarder is still passed on: the app takes whichever is first.
 * Returns how long until the next one is due (ms), at most max. */
static int udp_dns_tick(udp_assoc *u, int max) {
  if (!u->dq) return max;
  uint64_t t = now_ms();
  int next = max;
  for (int i = 0; i < UDP_DNS_SLOTS; i++) {
    udp_dns_q *e = &u->dq[i];
    if (!e->used) continue;
    uint64_t age = age_ms(t, e->t);
    if (age >= UDP_DNS_WAIT_MS) { e->used = 0; continue; }
    if (e->plain) continue;
    if (age < UDP_DNS_PLAIN_MS) {
      int left = (int)(UDP_DNS_PLAIN_MS - age);
      if (left < next) next = left;
      continue;
    }
    e->plain = 1;
    sudp_dst d;
    if (sudp_parse(e->hdr, e->hl, &d) == SUDP_OK) udp_send_out(u, &d, e->q, e->ql);
  }
  return next;
}

/* Answers from the forwarder: to the client, with the app's id and headed
 * with the address its query was sent to. An app that did not say it takes
 * more than 512 bytes (no EDNS) and would get more gets the question with TC
 * set instead, and asks again over TCP, which the engine carries. */
static void udp_dns_answers(udp_assoc *u) {
  for (int i = 0; i < UDP_DRAIN; i++) {
    int n = (int)recv(u->dns, (char *)u->buf + SUDP_HDR_MAX, 65536 - SUDP_HDR_MAX, 0);
    if (n < 0) break;
    if (n < 12 || !u->have_client || !u->dq) continue;
    uint8_t *a = u->buf + SUDP_HDR_MAX;
    if (!(a[2] & 0x80)) continue;                         /* not an answer */
    uint16_t fid = (uint16_t)((a[0] << 8) | a[1]);
    uint64_t t = now_ms();
    udp_dns_q *e = NULL;
    for (int k = 0; k < UDP_DNS_SLOTS && !e; k++)
      if (u->dq[k].used && u->dq[k].fid == fid && age_ms(t, u->dq[k].t) < UDP_DNS_WAIT_MS) e = &u->dq[k];
    if (!e) continue;
    e->used = 0;
    a[0] = (uint8_t)(e->aid >> 8); a[1] = (uint8_t)e->aid;
    if (!e->edns && n > 512) {
      a[2] |= 0x02;                                       /* TC */
      a[4] = 0; a[5] = 1;
      memset(a + 6, 0, 6);
      memcpy(a + 12, e->q + 12, (size_t)e->qend - 12);
      n = e->qend;
    }
    uint8_t *start = a - e->hl;
    memcpy(start, e->hdr, e->hl);
    if (sendto(u->relay, (const char *)start, (int)e->hl + n, 0,
               (struct sockaddr *)&u->client, sizeof(u->client)) < 0) continue;
    u->last = t;
    atomic_fetch_add(&g_stats.bytes_down, (uint64_t)n);
  }
}

/* Plain DNS from the client asking for a name on the ad and tracker list:
 * answered here, as if the resolver it asked had answered, with 0.0.0.0 or
 * :: (adb_dns_answer). Not NXDOMAIN: "no such name" sends some resolvers on
 * to the next server or the LAN's search domain, and is cached the longer;
 * an address that leads nowhere ends the attempt on the spot, which is what
 * AdGuard and Pi-hole answer too. 1 when it was answered. */
static int udp_dns_blocked(udp_assoc *u, const sudp_dst *d, const uint8_t *hdr,
                           const uint8_t *q, size_t ql) {
  if (!adblock_on() || !u->have_client) return 0;
  char name[256]; size_t qend; int edns;
  if (dns_query_parse(q, ql, name, sizeof(name), &qend, &edns) != 0) return 0;
  if (!adblock_blocked(name)) return 0;
  uint8_t out[SUDP_HDR_MAX + 512];
  memcpy(out, hdr, d->hdr_len);
  out[0] = out[1] = out[2] = 0;                           /* RSV, FRAG */
  int n = adb_dns_answer(q, qend, out + d->hdr_len, sizeof(out) - d->hdr_len);
  if (n < 0) return 0;
  adblock_count();
  sendto(u->relay, (const char *)out, (int)d->hdr_len + n, 0,
         (struct sockaddr *)&u->client, sizeof(u->client));
  u->last = now_ms();
  return 1;
}

/* Datagrams from the client: each one, unwrapped, goes to its destination. */
static void udp_from_client(udp_assoc *u) {
  for (int i = 0; i < UDP_DRAIN; i++) {
    struct sockaddr_storage from; socklen_t fl = sizeof(from);
    int n = (int)recvfrom(u->relay, (char *)u->buf, 65536, 0, (struct sockaddr *)&from, &fl);
    if (n < 0) break;   /* nothing more (or an error report): back to waiting */
    /* Only the client: its address, over IPv4 loopback, and once known its
     * port. */
    const struct sockaddr_in *f4 = (const struct sockaddr_in *)&from;
    if (from.ss_family != AF_INET ||
        f4->sin_addr.s_addr != ((struct sockaddr_in *)&u->peer)->sin_addr.s_addr)
      continue;
    if (u->have_client && f4->sin_port != u->client.sin_port) continue;
    sudp_dst d;
    if (sudp_parse(u->buf, (size_t)n, &d) != SUDP_OK) continue;
    if (!u->have_client) {
      /* The first well-formed datagram names the client, for good: junk
       * cannot claim the association. */
      memcpy(&u->client, f4, sizeof(u->client));
      u->have_client = 1;
    }
    size_t plen = (size_t)n - d.hdr_len;
    if (plen > UDP_MAX_PAYLOAD) continue;
    const uint8_t *payload = u->buf + d.hdr_len;
    /* A stand-in address leads nowhere: dropped, DNS to it included. */
    struct sockaddr_storage to; socklen_t tl;
    if (sudp_dst_addr(&d, &to, &tl) == 0 && sa_in_fake_net(&to)) continue;
    /* To a name on the ad and tracker list: dropped (an app then tries TCP,
     * which ends the same way). A lookup of one is answered here. */
    if (d.atyp == 3 && adblock_blocked(d.host)) continue;
    if (d.port == 53 && udp_dns_blocked(u, &d, u->buf, payload, plen)) continue;
    /* Plain DNS: to the encrypted forwarder, when it is a query for it. */
    if (d.port == 53 && udp_dns_redirect(u, &d, u->buf, payload, plen)) continue;
    udp_send_out(u, &d, payload, plen);
  }
}

/* Datagrams back from the far side: headed with their source, to the client. */
static void udp_to_client(udp_assoc *u, sock_t s) {
  uint8_t *data = u->buf + SUDP_REPLY_HDR_MAX;
  for (int i = 0; i < UDP_DRAIN; i++) {
    struct sockaddr_storage from; socklen_t fl = sizeof(from);
    int n = (int)recvfrom(s, (char *)data, 65536, 0, (struct sockaddr *)&from, &fl);
    if (n < 0) break;
    if (!u->have_client || n > UDP_MAX_PAYLOAD) continue;
    uint8_t h[SUDP_REPLY_HDR_MAX];
    int hl = sudp_build((struct sockaddr *)&from, h, sizeof(h));
    if (hl < 0) continue;
    memcpy(data - hl, h, (size_t)hl);
    if (sendto(u->relay, (const char *)data - hl, hl + n, 0,
               (struct sockaddr *)&u->client, sizeof(u->client)) < 0) continue;
    u->last = now_ms();
    atomic_fetch_add(&g_stats.bytes_down, (uint64_t)n);
  }
}

/* The request names the client's endpoint when it gives a port and, as the
 * address, 0.0.0.0 (or ::) or the control connection's own address (plain
 * or IPv4-mapped). 1 and the endpoint in out when it does. */
static int udp_request_endpoint(const socks_req *rq, const struct sockaddr_storage *peer,
                                struct sockaddr_in *out) {
  if (rq->port == 0) return 0;
  uint32_t peer_n = ((const struct sockaddr_in *)peer)->sin_addr.s_addr, a_n;
  static const uint8_t mapped[12] = { 0,0,0,0, 0,0,0,0, 0,0,0xff,0xff };
  static const uint8_t zero[16] = { 0 };
  if (rq->atyp == 0x01) memcpy(&a_n, rq->addr, 4);
  else if (rq->atyp == 0x04 && memcmp(rq->addr, zero, 16) == 0) a_n = 0;
  else if (rq->atyp == 0x04 && memcmp(rq->addr, mapped, 12) == 0) memcpy(&a_n, rq->addr + 12, 4);
  else return 0;
  if (a_n != 0 && a_n != peer_n) return 0;
  memset(out, 0, sizeof(*out));
  out->sin_family = AF_INET;
  out->sin_addr.s_addr = peer_n;
  out->sin_port = htons(rq->port);
  return 1;
}

static void udp_associate(sock_t client, const socks_req *rq) {
  udp_assoc u;
  memset(&u, 0, sizeof(u));
  u.relay = u.out4 = u.out6 = u.dns = SOCK_INVALID;
  socklen_t pl = sizeof(u.peer);
  if (getpeername(client, (struct sockaddr *)&u.peer, &pl) != 0 || !is_loopback4(&u.peer)) {
    socks5_reply(client, 0x02);   /* not allowed: datagrams are for this machine only */
    return;
  }
  if (atomic_fetch_add(&g_udp_assocs, 1) >= UDP_ASSOC_MAX) {
    atomic_fetch_sub(&g_udp_assocs, 1);
    socks5_reply(client, 0x01);
    return;
  }
  u.have_client = udp_request_endpoint(rq, &u.peer, &u.client);
  u.buf = (uint8_t *)malloc(65536 + SUDP_HDR_MAX);
  u.relay = udp_socket(AF_INET);
  socklen_t sl = sizeof(u.self);
  u.self.sin_family = AF_INET;
  u.self.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  u.self.sin_port = 0;
  if (!u.buf || u.relay == SOCK_INVALID ||
      bind(u.relay, (struct sockaddr *)&u.self, sizeof(u.self)) != 0 ||
      getsockname(u.relay, (struct sockaddr *)&u.self, &sl) != 0) {
    socks5_reply(client, 0x01);
    goto out;
  }
  if (socks5_reply_bnd(client, 0x00, u.self.sin_addr.s_addr, u.self.sin_port) != 0) goto out;

  u.last = now_ms();
  while (atomic_load(&g_running)) {
    /* First: a plaintext fallback it sends may open an outbound socket,
     * which must be in the set waited on below. */
    int wait_ms = udp_dns_tick(&u, 1000);
    sock_t s[5]; int ready[5], n = 0, i4 = -1, i6 = -1, id = -1;
    s[n++] = client; s[n++] = u.relay;
    if (u.out4 != SOCK_INVALID) { i4 = n; s[n++] = u.out4; }
    if (u.out6 != SOCK_INVALID) { i6 = n; s[n++] = u.out6; }
    if (u.dns != SOCK_INVALID) { id = n; s[n++] = u.dns; }
    int r = sock_wait_any(s, n, wait_ms, ready);
    if (r < 0) break;
    if (r > 0 && ready[0]) {
      /* The control connection says nothing more after the request: anything
       * it sends is let go, and its end is the association's. */
      char tmp[512];
      int k = (int)recv(client, tmp, sizeof(tmp), 0);
      if (k == 0) break;
      if (k < 0 && sock_errno() != SE_INTR && sock_errno() != SE_WOULDBLOCK) break;
    }
    if (r > 0 && ready[1]) udp_from_client(&u);
    if (r > 0 && i4 >= 0 && ready[i4]) udp_to_client(&u, u.out4);
    if (r > 0 && i6 >= 0 && ready[i6]) udp_to_client(&u, u.out6);
    if (r > 0 && id >= 0 && ready[id]) udp_dns_answers(&u);
    if (age_ms(now_ms(), u.last) >= UDP_IDLE_MS) break;
  }

out:
  sock_close(u.relay); sock_close(u.out4); sock_close(u.out6); sock_close(u.dns);
  free(u.dq);
  free(u.buf);
  atomic_fetch_sub(&g_udp_assocs, 1);
}

/* ── streams that are not TLS or HTTP ────────────────────────────────────
 * Messengers (Telegram's MTProto), games, and anything else that opens with
 * bytes of its own rather than a ClientHello or a request line: there is no
 * name to cut around, and the first payload cannot be replayed on a second
 * connection, because nothing says doing it twice is harmless for a protocol
 * we do not know. So the search for a technique runs across the app's own
 * connections instead of inside one: a destination whose untouched
 * connection gets no answer (refused, or silent until the app gives up) has
 * its next connection cut with the first technique of the raw list, the one
 * after that with the next, and so on. Apps whose servers stop answering
 * reconnect by themselves within seconds, so the first technique that gets
 * an answer is found after a few of their retries, and it is learned for
 * that destination (and tried first for its neighbours: the rest of its /24,
 * or /48 in IPv6, where a service's servers sit together).
 *
 * Safe for any protocol: every raw technique only changes how the bytes are
 * cut into segments, never the bytes the server receives (see strategy.h).
 *
 * Bounded: once every technique has failed for a destination, that is said
 * once (a "blocked" line marked raw) and its connections go out untouched
 * for RAW_REST_MS before another round may start. Never a search forever.
 *
 * What it cannot change: a destination whose address itself is blocked (its
 * connection never opens). That is told too (an "unreachable" line marked
 * raw), since an app the user is waiting on cannot say it — but only when it
 * is the network's doing: never when this computer has no route there (no
 * IPv6, offline), never for a name that did not resolve, and never while
 * the same address or its neighbours (/24, /48) took a connection lately.
 *
 * Careful with what is not evidence:
 *  - one failed connection is not a block (a server restarting): the search
 *    starts at the second failure, RAW_SECOND_FAIL_MS or more after the
 *    first;
 *  - an app that leaves before RAW_SILENT_MS with nothing back (a protocol
 *    that only sends: syslog, metrics, printing) told nothing;
 *  - this computer, its network (LAN, loopback, link-local, unique-local)
 *    are never searched: no filter sits there, and a decoy could reach a
 *    device that does not honour RFC 2385;
 *  - a learned technique is set aside for one connection every
 *    RAW_RECHECK_MS, so one learned from a fluke, or no longer needed, goes. */
#define RAW_SLOTS      256
#define RAW_REST_MS    (10 * 60 * 1000)
/* With nothing back after this long, an attempt the app then closed was
 * not answered: a slow server answers well within it. */
#define RAW_SILENT_MS  4000
/* Each raw destination's unreachable line at most once a minute (an app
 * retrying one address all along says so again, which is what tells a
 * blocked address from one that failed once), and no more than
 * RAW_UNREACH_BURST of them a minute in all: peer-to-peer and game clients
 * try dead addresses all day. */
#define RAW_UNREACH_REPEAT_MS 60000
#define RAW_UNREACH_BURST     20
/* After a raw line about a connection whose app is still connected to us,
 * that connection stays open this long before it is answered, so the app
 * reading the line can still see which program holds it (desktop). */
#define RAW_HOLD_MS    1200
#define RAW_SECOND_FAIL_MS 1000
#define RAW_RECHECK_MS (30 * 60 * 1000)
/* An address (or its /24, /48) that took a connection this recently is not
 * told unreachable: the network reaches it. */
#define RAW_SEEN_MS    (10 * 60 * 1000)
#define RAW_SEEN_SLOTS 256

typedef struct {
  char key[256];
  int used;
  int learned;      /* raw technique that works here, or -1 */
  int next;         /* raw technique the next connection uses, or -1 */
  int start;        /* where this round of the search began */
  int round;        /* techniques failed in this round */
  int tries;        /* connections that failed before one got through */
  int refused;      /* any of them refused (else they all went unanswered) */
  int plain_fails;  /* untouched connections that failed, before a search */
  uint64_t first_fail;
  uint64_t checked; /* when the learned technique was last set aside for a check */
  int rechecking;   /* one untouched connection is out to check it */
  uint64_t rest_until;
  uint64_t t;
} raw_ent;

static raw_ent g_raw[RAW_SLOTS];
static mutex_t g_raw_mx;
static int g_raw_good = -1;      /* the raw technique that last opened something */
static struct { char host[256]; uint64_t t; } g_raw_unreach[UNREACH_SLOTS];
static uint64_t g_raw_unreach_win;   /* the minute the burst count is for */
static int g_raw_unreach_n;
/* Addresses that took a connection lately (any connection, any protocol). */
static struct { int fam; uint8_t a[16]; uint64_t t; } g_raw_seen[RAW_SEEN_SLOTS];
static int g_raw_seen_at;

/* A connection to `sa` opened: the network reaches it and its neighbours. */
static void raw_seen_put(const struct sockaddr_storage *sa) {
  mutex_lock(&g_raw_mx);
  int i = g_raw_seen_at++ % RAW_SEEN_SLOTS;
  g_raw_seen[i].fam = sa->ss_family;
  memset(g_raw_seen[i].a, 0, 16);
  if (sa->ss_family == AF_INET) memcpy(g_raw_seen[i].a, &((const struct sockaddr_in *)sa)->sin_addr, 4);
  else memcpy(g_raw_seen[i].a, &((const struct sockaddr_in6 *)sa)->sin6_addr, 16);
  g_raw_seen[i].t = now_ms();
  mutex_unlock(&g_raw_mx);
}

/* Caller holds g_raw_mx. Did the address literal h, or a neighbour, take a
 * connection lately? */
static int raw_seen_near(const char *h, uint64_t now) {
  uint8_t x[16]; int fam = 0, bits = 0;
  memset(x, 0, sizeof(x));
  if (inet_pton(AF_INET, h, x) == 1) { fam = AF_INET; bits = 24; }
  else if (inet_pton(AF_INET6, h, x) == 1) { fam = AF_INET6; bits = 48; }
  else return 0;
  for (int i = 0; i < RAW_SEEN_SLOTS; i++)
    if (g_raw_seen[i].t && g_raw_seen[i].fam == fam && age_ms(now, g_raw_seen[i].t) < RAW_SEEN_MS &&
        prefix_eq(x, g_raw_seen[i].a, bits)) return 1;
  return 0;
}

/* This computer has a route to sa (asked of the routing table with a UDP
 * connect, which sends nothing). No route — no IPv6 on this network, or no
 * network at all — is not a block. */
static int has_route(const struct sockaddr_storage *sa) {
  sock_t u = socket(sa->ss_family, SOCK_DGRAM, IPPROTO_UDP);
  if (u == SOCK_INVALID) return 1;   /* cannot tell: assume yes */
  socklen_t l = sa->ss_family == AF_INET6 ? (socklen_t)sizeof(struct sockaddr_in6) : (socklen_t)sizeof(struct sockaddr_in);
  int r = connect(u, (const struct sockaddr *)sa, l);
  sock_close(u);
  return r == 0;
}

/* The far end of a connection is this computer or its network. */
static int sock_peer_local(sock_t s) {
  struct sockaddr_storage ss;
  socklen_t l = sizeof(ss);
  if (getpeername(s, (struct sockaddr *)&ss, &l) != 0) return 0;
  return udp_dst_forbidden(&ss) || udp_dst_private(&ss);
}

static int raw_usable(int i) { return preset_usable(strategy_raw(i)); }

/* Caller holds g_raw_mx. */
static int raw_find(const char *k) {
  for (int i = 0; i < RAW_SLOTS; i++)
    if (g_raw[i].used && strcmp(g_raw[i].key, k) == 0) return i;
  return -1;
}

/* Caller holds g_raw_mx. The key's entry, made (in a free slot, else the
 * one left alone longest) when there is none. */
static int raw_add(const char *k) {
  int slot = raw_find(k);
  if (slot >= 0) return slot;
  uint64_t old = (uint64_t)-1;
  for (int i = 0; i < RAW_SLOTS; i++) {
    if (!g_raw[i].used) { slot = i; break; }
    if (g_raw[i].t < old) { old = g_raw[i].t; slot = i; }
  }
  if (slot < 0) slot = 0;
  memset(&g_raw[slot], 0, sizeof(g_raw[slot]));
  snprintf(g_raw[slot].key, sizeof(g_raw[slot].key), "%s", k);
  g_raw[slot].used = 1;
  g_raw[slot].learned = -1;
  g_raw[slot].next = -1;
  g_raw[slot].t = now_ms();
  return slot;
}

/* The usable raw technique after i (from the top when i < 0), wrapping. */
static int raw_after(int i) {
  int n = strategy_raw_count();
  for (int k = 1; k <= n; k++) {
    int j = ((i < 0 ? -1 : i) + k) % n;
    if (raw_usable(j)) return j;
  }
  return -1;
}

static int raw_usable_count(void) {
  int n = 0;
  for (int i = 0; i < strategy_raw_count(); i++) n += raw_usable(i);
  return n;
}

/* Two address literals in the same /24 (IPv4) or /48 (IPv6). */
static int raw_neighbours(const char *a, const char *b) {
  uint8_t x[16], y[16];
  if (inet_pton(AF_INET, a, x) == 1 && inet_pton(AF_INET, b, y) == 1) return prefix_eq(x, y, 24);
  if (inet_pton(AF_INET6, a, x) == 1 && inet_pton(AF_INET6, b, y) == 1) return prefix_eq(x, y, 48);
  return 0;
}

/* What this destination's next connection goes out with: ATT_PLAIN, or
 * ATT_RAW_BASE + a raw technique. *inherited when it is a neighbour's. */
static int raw_pick(const char *k, int *inherited) {
  *inherited = 0;
  int c = ATT_PLAIN;
  mutex_lock(&g_raw_mx);
  int i = raw_find(k);
  if (i >= 0) {
    uint64_t now = now_ms();
    if (g_raw[i].learned >= 0) {
      c = ATT_RAW_BASE + g_raw[i].learned;
      /* Now and then one connection goes untouched, to see whether the
       * technique is still needed (see raw_result). */
      if (!g_raw[i].rechecking && age_ms(now, g_raw[i].checked) >= RAW_RECHECK_MS) {
        g_raw[i].rechecking = 1;
        g_raw[i].checked = now;
        c = ATT_PLAIN;
      }
    }
    else if (g_raw[i].next >= 0) c = ATT_RAW_BASE + g_raw[i].next;
  } else if (ip_literal(k)) {
    for (int j = 0; j < RAW_SLOTS; j++)
      if (g_raw[j].used && g_raw[j].learned >= 0 && raw_neighbours(k, g_raw[j].key)) {
        c = ATT_RAW_BASE + g_raw[j].learned; *inherited = 1; break;
      }
  }
  mutex_unlock(&g_raw_mx);
  return c;
}

/* The client's own port on its connection to us: what a desktop app looks
 * up to name the program behind a line. 0 when it cannot be had. */
static int peer_port(sock_t c) {
  struct sockaddr_storage ss;
  socklen_t l = sizeof(ss);
  if (getpeername(c, (struct sockaddr *)&ss, &l) != 0) return 0;
  if (ss.ss_family == AF_INET) return ntohs(((struct sockaddr_in *)&ss)->sin_port);
  if (ss.ss_family == AF_INET6) return ntohs(((struct sockaddr_in6 *)&ss)->sin6_port);
  return 0;
}

#define RAW_FAIL_REFUSED 0
#define RAW_FAIL_SILENT  1

/* What one connection to a raw destination showed: ok (the server answered),
 * or a failure of kind how. Only the attempt the destination is currently
 * on counts: several connections are often open to one server at once, and
 * the late word of one that went out with an earlier technique must not move
 * the search twice. Returns 1 when it printed a line (the caller may hold
 * the client a moment, see RAW_HOLD_MS). */
static int raw_result(const char *k, uint16_t port, int cand, int inherited, int ok, int how,
                      int fam, int cport) {
  char h[256];
  int printed = 0, tech = cand >= ATT_RAW_BASE ? cand - ATT_RAW_BASE : -1;
  json_host(h, sizeof(h), k);
  mutex_lock(&g_raw_mx);
  uint64_t now = now_ms();
  int i = raw_find(k);
  if (ok) {
    if (tech < 0) {
      /* Untouched and answered: whatever this destination was searching for
       * is over (a block lifted, or a server that was only down), and a
       * learned technique that an untouched check got past is not needed. */
      if (i >= 0 && (g_raw[i].learned < 0 || g_raw[i].rechecking)) g_raw[i].used = 0;
    } else if (i < 0 ? inherited : (g_raw[i].learned != tech && g_raw[i].next == tech)) {
      if (i < 0) i = raw_add(k);
      int tries = g_raw[i].tries + 1;
      g_raw[i].learned = tech; g_raw[i].next = -1; g_raw[i].round = 0;
      g_raw[i].tries = 0; g_raw[i].refused = 0; g_raw[i].rest_until = 0; g_raw[i].t = now;
      g_raw[i].plain_fails = 0; g_raw[i].checked = now; g_raw[i].rechecking = 0;
      g_raw_good = tech;
      engine_printf("{\"type\":\"bypass\",\"host\":\"%s\",\"strategy\":\"%s\",\"attempts\":%d,"
                    "\"family\":\"%s\",\"raw\":true,\"port\":%u,\"cport\":%d%s}\n",
                    h, strategy_raw(tech)->name, tries, fam == AF_INET6 ? "ipv6" : "ipv4",
                    (unsigned)port, cport, inherited ? ",\"note\":\"neighbour\"" : "");
    } else if (i >= 0 && g_raw[i].learned == tech) {
      g_raw[i].t = now;
    }
    mutex_unlock(&g_raw_mx);
    return printed;
  }

  int from = -2;   /* where the search goes on from; -2: this result moves nothing */
  if (tech < 0) {
    if (i >= 0 && g_raw[i].learned >= 0) {
      /* The untouched check of a learned technique failed: still needed. */
      g_raw[i].rechecking = 0;
      mutex_unlock(&g_raw_mx);
      return 0;
    }
    /* Untouched, and not answered: start a search, unless one is under
     * way or the destination is resting — and only at the second such
     * failure, a moment after the first: one is a server restarting as
     * often as a filter, and connections that went out together and
     * failed together are one failure. */
    if (i < 0 || (g_raw[i].next < 0 && now >= g_raw[i].rest_until)) {
      if (i < 0 || g_raw[i].plain_fails == 0 || age_ms(now, g_raw[i].first_fail) >= RAW_REST_MS) {
        if (i < 0) i = raw_add(k);
        g_raw[i].plain_fails = 1; g_raw[i].first_fail = now; g_raw[i].t = now;
        if (how == RAW_FAIL_REFUSED) g_raw[i].refused = 1;
        g_raw[i].tries = 1;
        mutex_unlock(&g_raw_mx);
        return 0;
      }
      if (age_ms(now, g_raw[i].first_fail) < RAW_SECOND_FAIL_MS) { mutex_unlock(&g_raw_mx); return 0; }
      from = -1;
    }
  } else if (i < 0) {
    if (inherited) from = tech;                         /* a neighbour's technique: not this one's */
  } else if (g_raw[i].learned == tech) {
    from = tech;                                        /* what worked here does not any more */
  } else if (g_raw[i].learned < 0 && g_raw[i].next == tech) {
    from = tech;
  }
  if (from == -2) { mutex_unlock(&g_raw_mx); return 0; }
  if (i < 0) i = raw_add(k);
  raw_ent *e = &g_raw[i];
  e->t = now;
  e->tries++;
  e->plain_fails = 0;
  if (how == RAW_FAIL_REFUSED) e->refused = 1;
  if (tech < 0 || e->learned == tech || (inherited && e->next < 0)) {
    /* A new round: from the technique that last opened something here or
     * nearby, else from the top. */
    e->learned = -1;
    e->round = tech >= 0 ? 1 : 0;
    int s = tech >= 0 ? raw_after(tech) : (g_raw_good >= 0 && raw_usable(g_raw_good) ? g_raw_good : raw_after(-1));
    e->start = s; e->next = s;
  } else {
    e->round++;
    e->next = raw_after(tech);
  }
  if (e->next < 0 || e->round >= raw_usable_count()) {
    /* Every technique has had its turn: say so once, and leave the
     * destination untouched for a while. */
    engine_printf("{\"type\":\"blocked\",\"host\":\"%s\",\"strategy\":\"\",\"attempts\":%d,"
                  "\"family\":\"%s\",\"raw\":true,\"port\":%u,\"cport\":%d%s}\n",
                  h, e->tries, fam == AF_INET6 ? "ipv6" : "ipv4", (unsigned)port, cport,
                  e->refused ? "" : ",\"note\":\"silent\"");
    printed = 1;
    e->next = -1; e->round = 0; e->tries = 0; e->refused = 0;
    e->rest_until = now + RAW_REST_MS;
  }
  mutex_unlock(&g_raw_mx);
  return printed;
}

/* Not worth a line: this computer, its network, or a stand-in address. */
static int raw_local_dest(const char *h) {
  struct in_addr a4; struct in6_addr a6;
  if (inet_pton(AF_INET, h, &a4) == 1) {
    uint32_t a = ntohl(a4.s_addr);
    return (a >> 24) == 0 || (a >> 24) == 127 || udp_v4_private(a) || (a >> 28) >= 14 || host_in_fake_net(h);
  }
  if (inet_pton(AF_INET6, h, &a6) == 1) {
    struct sockaddr_storage ss;
    memset(&ss, 0, sizeof(ss));
    ss.ss_family = AF_INET6;
    memcpy(&((struct sockaddr_in6 *)&ss)->sin6_addr, &a6, 16);
    return udp_dst_forbidden(&ss) || udp_dst_private(&ss) || host_in_fake_net(h) || a6.s6_addr[0] == 0xff;
  }
  return 0;
}

/* A connection that could not be opened at all, to an address or to a name
 * on a port that is not the web's (those are report_unreachable's): the
 * address itself is blocked, or the server is gone. Returns 1 when it
 * printed a line. */
static int report_raw_unreachable(const char *host, uint16_t port, const dial_info *di, int cport) {
  if (!host || !host[0] || raw_local_dest(host)) return 0;
  if (!ip_literal(host) && (port == 80 || port == 443)) return 0;
  if (di && di->cut) return 0;   /* the dial's own time ran out, not the address's */
  if (di && di->tried > 0 && di->local == di->tried) return 0;   /* a name for a local address */
  if (!di || di->resolved <= 0) return 0;   /* the name did not resolve: DNS, not this address */
  if (di->noroute > 0) return 0;            /* no route from this computer: no IPv6, offline */
  char h[256];
  json_host(h, sizeof(h), host);
  int slot = -1, oldest = 0;
  mutex_lock(&g_raw_mx);
  uint64_t t = now_ms();
  for (int i = 0; i < UNREACH_SLOTS; i++) {
    if (g_raw_unreach[i].host[0] && strcmp(g_raw_unreach[i].host, h) == 0) { slot = i; break; }
    if (g_raw_unreach[i].t < g_raw_unreach[oldest].t) oldest = i;
  }
  if (slot >= 0 && age_ms(t, g_raw_unreach[slot].t) < RAW_UNREACH_REPEAT_MS) { mutex_unlock(&g_raw_mx); return 0; }
  if (raw_seen_near(host, t)) { mutex_unlock(&g_raw_mx); return 0; }   /* it, or its neighbours, answer */
  if (age_ms(t, g_raw_unreach_win) >= 60000) { g_raw_unreach_win = t; g_raw_unreach_n = 0; }
  if (g_raw_unreach_n >= RAW_UNREACH_BURST) { mutex_unlock(&g_raw_mx); return 0; }
  g_raw_unreach_n++;
  if (slot < 0) { slot = oldest; snprintf(g_raw_unreach[slot].host, sizeof(g_raw_unreach[slot].host), "%s", h); }
  g_raw_unreach[slot].t = t;
  mutex_unlock(&g_raw_mx);
  engine_printf("{\"type\":\"unreachable\",\"host\":\"%s\",\"stage\":\"%s\",\"ips\":%d,"
                "\"raw\":true,\"port\":%u,\"cport\":%d}\n",
                h, "connect", di->tried, (unsigned)port, cport);
  return 1;
}

/* A raw technique learned by an earlier run (see engine_restore). */
static int raw_restore(const char *k, const char *technique, uint64_t age) {
  int p = -1;
  for (int i = 0; i < strategy_raw_count(); i++) if (strcmp(strategy_raw(i)->name, technique) == 0) { p = i; break; }
  if (p < 0 || !raw_usable(p)) return -1;
  mutex_lock(&g_raw_mx);
  int i = raw_add(k);
  g_raw[i].learned = p; g_raw[i].next = -1; g_raw[i].round = 0; g_raw[i].tries = 0;
  uint64_t now = now_ms();
  g_raw[i].checked = now > age ? now - age : 0;   /* one learned long ago is checked soon */
  mutex_unlock(&g_raw_mx);
  return 0;
}

/* ── names only this computer's own DNS knows ───────────────────────────
 * A company's intranet, a VPN's split DNS, a hosts-file entry: the system's
 * resolver answers them with a private address, and public DNS does not know
 * them at all, so asking only our own resolver would fail the connection.
 * The connection is made with our own resolver (encrypted DNS, or the user's
 * own server) first; only a name it has no address for (it does not know it,
 * or knows it only by a private or loopback address) is asked of the system,
 * so the system's DNS, which is the network's and in plain text, is never
 * shown a public name (issue #34; it was asked about every name before).
 * Then, as the program proxy does (electron/app-proxy.js), a name the system
 * resolves to private addresses only, none of them a known block page, or to
 * loopback or 0.0.0.0 (a hosts file, an ad blocker), is connected to where
 * the system says. A hosts-file entry for a name public DNS knows is not
 * followed. Decided once a minute per name; the system is given
 * OSDNS_WAIT_MS to answer (it may be the one that is broken). */
#define OSDNS_SLOTS   128
#define OSDNS_TTL_MS  60000
#define OSDNS_WAIT_MS 1500
static struct { char host[256]; int follow; uint64_t t; } g_osdns[OSDNS_SLOTS];
static mutex_t g_osdns_mx;
/* The system's resolver did not answer in time: not asked again for a
 * while, so a broken one costs one wait, not one per name. */
static uint64_t g_osdns_slow_until;

typedef struct { char host[256]; _Atomic int state; /* 0 asking, 1 private, 2 loopback, 3 other */ _Atomic int refs; } osdns_job;

static void osdns_release(osdns_job *j) { if (atomic_fetch_sub(&j->refs, 1) == 1) free(j); }

/* 1: every address private (RFC 1918, CGNAT, link-local, unique-local) and
 * none a known block page; 2: every address private or loopback/unspecified,
 * at least one of the latter; 3: anything else (a public address, none). */
static int osdns_classify(const char *host) {
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) { if (res) freeaddrinfo(res); return 3; }
  int n = 0, priv = 0, loop = 0, other = 0;
  for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
    if ((size_t)ai->ai_addrlen > sizeof(struct sockaddr_storage)) continue;
    struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss));
    memcpy(&ss, ai->ai_addr, ai->ai_addrlen);
    n++;
    if (ss.ss_family == AF_INET) {
      uint32_t ip = ntohl(((struct sockaddr_in *)&ss)->sin_addr.s_addr);
      if (doh_ipv4_is_blockpage(ip)) other++;
      else if ((ip >> 24) == 0 || (ip >> 24) == 127) loop++;
      else if (udp_v4_private(ip)) priv++;
      else other++;
    } else if (ss.ss_family == AF_INET6) {
      if (udp_dst_forbidden(&ss)) loop++;
      else if (udp_dst_private(&ss)) priv++;
      else other++;
    }
  }
  freeaddrinfo(res);
  if (!n || other || !(priv || loop)) return 3;
  return loop ? 2 : 1;
}

static void *osdns_thread(void *p) {
  osdns_job *j = (osdns_job *)p;
  atomic_store(&j->state, osdns_classify(j->host));
  osdns_release(j);
  return NULL;
}

/* Connect to host where the system's resolver says, rather than ask ours? */
static int osdns_follow(const char *host) {
  if (!g_cfg.use_doh || doh_strict() || !host[0] || ip_literal(host) || doh_local_name(host)) return 0;
  mutex_lock(&g_osdns_mx);
  uint64_t now = now_ms();
  int slot = -1, oldest = 0;
  for (int i = 0; i < OSDNS_SLOTS; i++) {
    if (g_osdns[i].host[0] && strcmp(g_osdns[i].host, host) == 0) { slot = i; break; }
    if (g_osdns[i].t < g_osdns[oldest].t) oldest = i;
  }
  if (slot >= 0 && age_ms(now, g_osdns[slot].t) < OSDNS_TTL_MS) { int f = g_osdns[slot].follow; mutex_unlock(&g_osdns_mx); return f; }
  if (now < g_osdns_slow_until) { mutex_unlock(&g_osdns_mx); return 0; }
  mutex_unlock(&g_osdns_mx);

  /* Asked only once our own resolver had no address for the name (the
   * caller), so a loopback or 0.0.0.0 answer is followed as well. */
  osdns_job *j = (osdns_job *)calloc(1, sizeof(*j));
  if (!j) return 0;
  snprintf(j->host, sizeof(j->host), "%s", host);
  atomic_store(&j->refs, 2);
  if (thread_spawn(osdns_thread, j, 256 * 1024) != 0) { free(j); return 0; }
  uint64_t end = now + OSDNS_WAIT_MS;
  int st;
  while ((st = atomic_load(&j->state)) == 0 && now_ms() < end) sleep_ms(5);
  osdns_release(j);
  int follow = st == 1 || st == 2;
  mutex_lock(&g_osdns_mx);
  if (st == 0) g_osdns_slow_until = now_ms() + OSDNS_TTL_MS;   /* decided: ours, for a while */
  if (slot < 0) slot = oldest;
  snprintf(g_osdns[slot].host, sizeof(g_osdns[slot].host), "%s", host);
  g_osdns[slot].follow = follow;
  g_osdns[slot].t = now_ms();
  mutex_unlock(&g_osdns_mx);
  return follow;
}

/* ── the network's own DNS, for a site encrypted DNS's addresses fail ────
 * In some countries a site's servers get through only at the addresses the
 * network's own DNS gives: a CDN's cache inside the country (Google's caches,
 * which serve YouTube's videos in Iran, issue #37), while the addresses
 * encrypted DNS gives are abroad, blocked by address or filtered past every
 * technique. ByeByeDPI with the country's DNS plays the videos; with a
 * foreign one it does not.
 * So once every technique failed on a name of a site, or none of its
 * addresses answered, the site's next names are also asked of the system's
 * resolver (the network's DNS, in plain text: it learns only of a site that
 * is failing anyway) and connected to where it says, when that is a public
 * address our own resolver did not give: never a private, loopback or
 * block-page address, which is what a censor answers with. Kept for the site
 * while it works (NETDNS_TTL_MS from its last success); left alone for as
 * long when that address does not get through either. Not with "Only this
 * server" (doh_strict): the user wants that server's answers and no other. */
#define NETDNS_SLOTS   64
#define NETDNS_TTL_MS  (30 * 60 * 1000)
#define NETDNS_WAIT_MS 1500
enum { ND_NONE = 0, ND_TRY, ND_GOOD, ND_BAD };
static struct { char site[256]; int state; uint64_t t; } g_nd[NETDNS_SLOTS];
static mutex_t g_nd_mx;

/* host's state: its site's, or its own where it has none. */
static int nd_state(const char *host) {
  char k[256];
  ok_key(host, k, sizeof(k));
  int st = ND_NONE;
  mutex_lock(&g_nd_mx);
  uint64_t t = now_ms();
  for (int i = 0; i < NETDNS_SLOTS; i++)
    if (g_nd[i].site[0] && strcmp(g_nd[i].site, k) == 0) { if (age_ms(t, g_nd[i].t) < NETDNS_TTL_MS) st = g_nd[i].state; break; }
  mutex_unlock(&g_nd_mx);
  return st;
}

static void nd_put(const char *host, int st) {
  char k[256];
  ok_key(host, k, sizeof(k));
  mutex_lock(&g_nd_mx);
  uint64_t t = now_ms();
  int slot = -1, oldest = 0;
  for (int i = 0; i < NETDNS_SLOTS; i++) {
    if (g_nd[i].site[0] && strcmp(g_nd[i].site, k) == 0) { slot = i; break; }
    if (g_nd[i].t < g_nd[oldest].t) oldest = i;
  }
  if (slot < 0) { slot = oldest; snprintf(g_nd[slot].site, sizeof(g_nd[slot].site), "%s", k); }
  g_nd[slot].state = st;
  g_nd[slot].t = t;
  mutex_unlock(&g_nd_mx);
}

/* Our own resolver's addresses for host got nowhere: its site's next names
 * try the network's DNS too, unless that was found no better lately. */
static void nd_failed(const char *host) {
  if (!g_cfg.use_doh || doh_strict() || !host[0] || ip_literal(host) || doh_local_name(host)) return;
  int st = nd_state(host);
  if (st == ND_NONE) nd_put(host, ND_TRY);
}

static void nd_tell(const char *host, const char *addr, const char *stage) {
  char h[256], k[256], a[80];
  ok_key(host, k, sizeof(k));
  json_host(h, sizeof(h), k);
  json_host(a, sizeof(a), addr);
  engine_printf("{\"type\":\"netdns\",\"host\":\"%s\",\"addr\":\"%s\",\"stage\":\"%s\"}\n", h, a, stage);
}

/* An address the network's DNS may send a connection to: public, and not a
 * known block page (loopback too under --raw-local, for the tests). */
static int nd_usable(const struct sockaddr_storage *ss) {
  if (ss->ss_family == AF_INET) {
    uint32_t ip = ntohl(((const struct sockaddr_in *)ss)->sin_addr.s_addr);
    if ((ip >> 24) == 127) return g_cfg.raw_local;
    if (doh_ipv4_is_blockpage(ip) || (ip >> 24) == 0 || (ip >> 24) >= 224 || udp_v4_private(ip)) return 0;
    return 1;
  }
  if (ss->ss_family == AF_INET6) return !udp_dst_forbidden(ss) && !udp_dst_private(ss);
  return 0;
}

typedef struct { char host[256]; char addr[64]; _Atomic int done; _Atomic int refs; } nd_job;
static void nd_release(nd_job *j) { if (atomic_fetch_sub(&j->refs, 1) == 1) free(j); }

/* The first usable address the system's resolver gives for the job's host
 * that our own resolver did not (IPv4 first), as text; "" when none. */
static void *nd_thread(void *p) {
  nd_job *j = (nd_job *)p;
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(j->host, NULL, &hints, &res) == 0 && res) {
    struct sockaddr_storage ours[DOH_MAX_ADDRS * 2]; socklen_t ol[DOH_MAX_ADDRS * 2];
    int no = 0, k = doh_resolve_all(j->host, 443, 0, ours, ol, DOH_MAX_ADDRS);
    if (k > 0) no += k;
    k = doh_resolve_all(j->host, 443, 1, ours + no, ol + no, DOH_MAX_ADDRS);
    if (k > 0) no += k;
    for (int pass = 0; pass < 2 && !j->addr[0]; pass++) {
      for (struct addrinfo *ai = res; ai && !j->addr[0]; ai = ai->ai_next) {
        if ((ai->ai_family == AF_INET) != (pass == 0) || (ai->ai_family != AF_INET && ai->ai_family != AF_INET6)) continue;
        if ((size_t)ai->ai_addrlen > sizeof(struct sockaddr_storage)) continue;
        struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss));
        memcpy(&ss, ai->ai_addr, ai->ai_addrlen);
        if (!nd_usable(&ss)) continue;
        int known = 0;
        for (int i = 0; i < no && !known; i++) known = same_addr(&ours[i], &ss);
        if (known) continue;
        const void *src = ss.ss_family == AF_INET ? (const void *)&((struct sockaddr_in *)&ss)->sin_addr
                                                  : (const void *)&((struct sockaddr_in6 *)&ss)->sin6_addr;
        if (!inet_ntop(ss.ss_family, src, j->addr, sizeof(j->addr))) j->addr[0] = 0;
      }
    }
  }
  if (res) freeaddrinfo(res);
  atomic_store(&j->done, 1);
  nd_release(j);
  return NULL;
}

/* The network's DNS's other address for host into out ("" when there is
 * none, or it did not answer within NETDNS_WAIT_MS). */
static void nd_lookup(const char *host, char *out, size_t cap) {
  out[0] = 0;
  nd_job *j = (nd_job *)calloc(1, sizeof(*j));
  if (!j) return;
  snprintf(j->host, sizeof(j->host), "%s", host);
  atomic_store(&j->refs, 2);
  if (thread_spawn(nd_thread, j, 256 * 1024) != 0) { free(j); return; }
  uint64_t end = now_ms() + NETDNS_WAIT_MS;
  while (!atomic_load(&j->done) && now_ms() < end) sleep_ms(5);
  if (atomic_load(&j->done)) snprintf(out, cap, "%s", j->addr);
  nd_release(j);
}

/* ── names on the ad and tracker list (adblock.h) ────────────────────────
 * A connection to a listed name is accepted and then ended inside it, never
 * refused at the proxy step. A browser takes a refusal there for a broken
 * proxy: Chromium falls over to the next entry of the PAC (the plain "SOCKS"
 * one, for which it looks names up through the system's DNS) and avoids this
 * one for five minutes, and on a desktop whose PAC ends in DIRECT it goes
 * around Shroudly altogether. So the proxy step succeeds, and then a TLS
 * client gets a fatal unrecognized_name alert (Chromium shows
 * ERR_SSL_UNRECOGNIZED_NAME_ALERT, not a proxy failure), an HTTP one
 * "403 Forbidden", anything else the end of the connection. Nothing goes to
 * the network for it: no lookup, no connection. buf holds the client's first
 * payload (flen bytes), or flen < 0 when the proxy step is still to be
 * answered and nothing has been read. */
static void adblock_refuse(sock_t client, const socks_req *rq, uint8_t *buf, int flen) {
  adblock_count();
  if (flen < 0) {
    if (socks_reply(client, rq, 1) != 0) return;
    flen = read_first(client, SOCK_INVALID, buf, RELAY_BUF);
  }
  if (flen <= 0) return;
  if (buf[0] == 0x16) {
    static const uint8_t alert[] = { 0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x70 };
    sock_send_all(client, alert, sizeof(alert), 0);
  } else if (http_is_request(buf, (size_t)flen)) {
    send_str(client, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  }
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
  int nd = 0;   /* connected where the network's own DNS says (see netdns) */
  dial_info di;
  uint64_t waiting = 0;   /* the first payload went out and is still unanswered */

  sock_set_timeouts(client, 30000);
  sock_set_nodelay(client, 1);

  if (socks_accept(client, &rq) != 0) goto done;
  if (rq.cmd == 0x03) { udp_associate(client, &rq); goto done; }
  /* A stand-in address that outlived its mapping: "not allowed", at once. */
  if (host_in_fake_net(rq.host)) {
    if (rq.ver == 4) socks4_reply(client, 0x5B); else if (rq.ver == 1) socks_reply(client, &rq, 0); else socks5_reply(client, 0x02);
    goto done;
  }
  snprintf(dial_host, sizeof(dial_host), "%s", rq.host);

  first = (uint8_t *)malloc(RELAY_BUF);
  work  = (uint8_t *)malloc(RELAY_BUF);
  rbuf  = (uint8_t *)malloc(RELAY_BUF);
  if (!first || !work || !rbuf) { socks_reply(client, &rq, 0); goto done; }

  /* A name on the ad and tracker list: not looked up, not connected to. */
  if (!ip_literal(rq.host) && adblock_blocked(rq.host)) { adblock_refuse(client, &rq, first, -1); goto done; }

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
    if (pi0.host[0] && adblock_blocked(pi0.host)) { adblock_refuse(client, &rq, first, flen); goto done; }
    if (pi0.host[0] && !doh_local_name(pi0.host)) {
      up = dial(pi0.host, rq.port, g_cfg.prefer_ipv6, 1, 0, &fam, &di);
      if (up != SOCK_INVALID) { snprintf(dial_host, sizeof(dial_host), "%s", pi0.host); dial_doh = 1; }
      else report_unreachable(pi0.host, rq.port, &di);   /* the site meant, not the block page */
    }
    /* No name, or it does not resolve: go where the client asked, which is
     * exactly what would have happened without us. */
    if (up == SOCK_INVALID) up = dial(rq.host, rq.port, g_cfg.prefer_ipv6, g_cfg.use_doh, 0, &fam, &di);
    if (up == SOCK_INVALID) goto done;
  } else {
    /* A site whose addresses from our own resolver got nowhere lately: where
     * the network's own DNS says, when that is another public address (see
     * "the network's own DNS"). */
    if (dial_doh && !ip_literal(rq.host) && !doh_strict() && !doh_local_name(rq.host)) {
      int st = nd_state(rq.host);
      if (st == ND_TRY || st == ND_GOOD) {
        char alt[64];
        nd_lookup(rq.host, alt, sizeof(alt));
        if (alt[0]) up = dial(alt, rq.port, g_cfg.prefer_ipv6, 0, 0, &fam, &di);
        if (up != SOCK_INVALID) {
          nd = 1; dial_doh = 0;
          snprintf(dial_host, sizeof(dial_host), "%s", alt);
          if (st == ND_TRY) nd_tell(rq.host, alt, "try");
        } else {
          /* No other address, or it does not answer either: our own again. */
          nd_put(rq.host, ND_BAD);
          if (st == ND_TRY && alt[0]) nd_tell(rq.host, alt, "bad");
        }
      }
    }
    if (!nd) up = dial(rq.host, rq.port, g_cfg.prefer_ipv6, dial_doh, 0, &fam, &di);
    /* A name our resolver has no address for, which only this computer's DNS
     * knows (an intranet, a VPN's split DNS, a hosts file): where the system
     * says (see osdns_follow). A public name never gets here, so the
     * network's DNS is not shown it. */
    if (up == SOCK_INVALID && dial_doh && di.resolved == 0 && osdns_follow(rq.host)) {
      dial_doh = 0;
      snprintf(dial_host, sizeof(dial_host), "%s", rq.host);
      up = dial(rq.host, rq.port, g_cfg.prefer_ipv6, 0, 0, &fam, &di);
    }
    if (up == SOCK_INVALID) {
      /* Told while the app is still connected to us (see RAW_HOLD_MS); not
       * where nobody could look (--auth-file: the tunnel on Android). */
      if (report_raw_unreachable(rq.host, rq.port, &di, peer_port(client)) && !g_cfg.auth_user[0]) sleep_ms(RAW_HOLD_MS);
      /* Addresses, and none of them answered: the network's DNS may know
       * others (see "the network's own DNS"). */
      if (dial_doh && di.resolved > 0) nd_failed(rq.host);
      socks_reply(client, &rq, 0); report_unreachable(rq.host, rq.port, &di); goto done;
    }
    {
      /* The network reaches this address (see raw_seen_near). */
      struct sockaddr_storage pa; socklen_t pl = sizeof(pa);
      if (getpeername(up, (struct sockaddr *)&pa, &pl) == 0 && !udp_dst_forbidden(&pa) && !udp_dst_private(&pa))
        raw_seen_put(&pa);
    }
    if (socks_reply(client, &rq, 1) != 0) goto done;
    flen = read_first(client, up, first, RELAY_BUF);
  }

  int watch_tls = 0;
  char cut_key[256]; cut_key[0] = 0;
  /* A stream that is neither TLS nor HTTP: the technique it went out with
   * (raw_cand), and when, for raw_result once its fate is known. */
  int raw_cand = 0, raw_inh = 0, raw_done = 1;
  uint64_t raw_at = 0;
  int told = 0;      /* the connection's fate is already in the log */
  int gave_up = 0;   /* the ladder ended with nothing answered: blocked, or unreachable */
  int race_head = race_head_ms(di.rtt_ms);

  if (flen > 0) {
    proto_info pi;
    proto_inspect(first, (size_t)flen, &pi);
    /* Asked for by address (the app looked the name up itself): the name it
     * means is in the payload, and a listed one ends here. */
    if (ip_literal(rq.host) && pi.host[0] && adblock_blocked(pi.host)) {
      adblock_refuse(client, &rq, first, flen);
      goto done;
    }
    if (pi.kind == PROTO_TLS)  atomic_fetch_add(&g_stats.tls_seen, 1);
    if (pi.kind == PROTO_HTTP) atomic_fetch_add(&g_stats.http_seen, 1);

    const char *key = pi.host[0] ? pi.host : rq.host;
    watch_note(key);
    watch_tls = pi.kind == PROTO_TLS;
    strncpy(cut_key, key, sizeof(cut_key) - 1); cut_key[sizeof(cut_key) - 1] = 0;

    int ladder = g_cfg.auto_probe && pi.kind != PROTO_UNKNOWN &&
                 retry_safe(&pi, first, flen);
    if (!ladder) {
      /* One attempt, as asked (the configured strategy, or untouched), and
       * the relay takes it from there. A stream that is not TLS or HTTP goes
       * out with what its destination's search is on (see raw_pick). */
      /* Never on this computer or its network (see "streams that are not
       * TLS or HTTP"); --raw-local lets the tests use loopback. */
      int raw = g_cfg.auto_probe && pi.kind == PROTO_UNKNOWN &&
                (g_cfg.raw_local || (!raw_local_dest(key) && !sock_peer_local(up)));
      int hold_ok = !g_cfg.auth_user[0];
      int c = raw ? raw_pick(key, &raw_inh) : g_cfg.auto_probe ? ATT_PLAIN : -1;   /* -1 = configured */
      uint64_t at = now_ms();
      memcpy(work, first, (size_t)flen);   /* strategies may rewrite in place */
      int sr = attempt_send(up, fam, work, RELAY_BUF, flen, &pi, c);
      if (sr != 0) {
        report("send_failed", key, "", 1, fam, NULL); told = 1;
        if (raw && sr == ATT_REFUSED &&
            raw_result(key, rq.port, c, raw_inh, 0, RAW_FAIL_REFUSED, fam, peer_port(client)) && hold_ok)
          sleep_ms(RAW_HOLD_MS);
      } else {
        /* The answer, or the client: one that sends more, or leaves, before
         * the server says anything is the relay's from here — its next bytes
         * are not held back, and one that left early is no evidence. */
        int w = sock_wait_either(client, up, VERIFY_PLAIN_MS);
        if (w > 0 && (w & 2)) {
          int rr = read_reply(up, &pi, rbuf, RELAY_BUF, &rlen);
          if (rr == ATT_OK) atomic_fetch_add(&g_stats.probe_success, 1);
          if (raw && raw_result(key, rq.port, c, raw_inh, rr == ATT_OK, RAW_FAIL_REFUSED, fam, peer_port(client)) && hold_ok)
            sleep_ms(RAW_HOLD_MS);
        } else if (raw) {
          /* Not answered yet: the relay finds out. */
          raw_cand = c; raw_at = at; raw_done = 0;
        }
      }
      if (rlen == 0 && !told) waiting = at;
    } else {
      /* Build the ladder. */
      int cand[ATT_MAX]; int ncand = 0;
      int np = strategy_preset_count();
      int from = -1, learned = -1, inherited = 0, stale = 0, site_from = 0;
      ladder_start(key, watch_tls, &from, &learned, &inherited, &stale, &site_from);
      if (learned >= np) learned = -1;
      int resumed = from >= 0 && from < np;
      ladder_st st;
      memset(&st, 0, sizeof(st));
      st.key = key; st.pi = &pi; st.tls = watch_tls;
      st.learned = learned; st.inherited = inherited;
      st.L.max = cool_is(key) ? LEG_COOL_MAX : LEG_MAX;
      if (resumed || (learned >= 0 && stale && watch_tls)) {
        /* A race: the untouched request goes first and has a moment to itself
         * (race_head), then the technique goes out beside it on a connection
         * of its own, and the first to answer is used. Whatever it is the
         * ladder goes on — where a silent search left off, or a technique
         * learned long ago — it is only a place to start, not evidence, and
         * the race is what turns it into evidence or lets it go: if the
         * untouched request answers, nothing is learned and that is dropped;
         * if the technique answers while it is still unanswered, it is
         * learned (again). On a network that drops silently this costs the
         * head start at most; on one that refuses, a round trip. */
        st.race = 1;
        cand[ncand++] = ATT_PLAIN;
        if (resumed) {
          for (int k = 0; k < np && ncand < ATT_MAX; k++) {
            int i = (from + k) % np;
            if (preset_usable(strategy_preset(i))) cand[ncand++] = i;
          }
        } else {
          cand[ncand++] = learned;
          for (int i = 0; i < np && ncand < ATT_MAX; i++)
            if (i != learned && preset_usable(strategy_preset(i))) cand[ncand++] = i;
        }
        /* The last connection was dropped from start to end: the techniques
         * get the shorter wait from the start (not known for another name). */
        st.silent = resumed && !site_from;
      } else {
        st.opened_learned = learned >= 0;
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
      int last_preset = -1;     /* the last technique that actually went out */
      int local_fails = 0;      /* attempts our own send failed for a reason of ours */
      int win = -1, rep_fam = fam;
      for (int a = 0; a < ncand && win < 0; a++) {
        int c = cand[a];
        int head = st.race && a == 0;
        int wait_ms = c == ATT_PLAIN ? (head ? race_head : VERIFY_PLAIN_MS)
                    : (st.silent && !st.saw_refusal) ? VERIFY_SILENT_MS : VERIFY_DESYNC_MS;
        leg cur = { SOCK_INVALID, fam, 0, 0, c, a, 0 };
        if (a == 0) {
          cur.s = up; up = SOCK_INVALID;   /* owned by the ladder from here on */
        } else {
          /* Anything the client sent meanwhile belongs in the replay. */
          while (flen < RELAY_BUF && sock_wait_readable(client, 0) == 1) {
            int n = recv(client, (char *)first + flen, RELAY_BUF - flen, 0);
            if (n <= 0) break;
            flen += n;
          }
          /* The re-dial may spend what is left of the budget except the least
           * an attempt needs to be answered in. */
          uint64_t t = now_ms();
          int left = t < deadline ? (int)(deadline - t) : 0;
          int spent = left <= ATT_MIN_WAIT_MS;
          if (!spent) {
            /* Room for one more connection, in this ladder's set and among
             * all ladders' (waited for if need be). */
            legs_make_room(&st.L);
            int room = wait_room(&st, deadline, rbuf, RELAY_BUF, &rlen, &win);
            if (room == 2) break;                     /* one already open answered */
            t = now_ms();
            left = t < deadline ? (int)(deadline - t) : 0;
            spent = !room || left <= ATT_MIN_WAIT_MS;
            if (room && spent) room_give();
          }
          if (!spent) {
            cur.room = 1;
            cur.s = dial(dial_host, rq.port, g_cfg.prefer_ipv6, dial_doh, left - ATT_MIN_WAIT_MS,
                         &cur.fam, &di);
            if (cur.s == SOCK_INVALID) { room_give(); cur.room = 0; }
            if (cur.s == SOCK_INVALID && !di.cut) {
              /* Refused at every address, or silent there for a full try. */
              report_unreachable(dial_host, rq.port, &di);
              told = 1; gave_up = 1;
              break;
            }
            t = now_ms();
            left = t < deadline ? (int)(deadline - t) : 0;
            if (cur.s != SOCK_INVALID && left < ATT_MIN_WAIT_MS) {
              sock_close(cur.s); cur.s = SOCK_INVALID;
              room_give(); cur.room = 0;
            }
            spent = cur.s == SOCK_INVALID;
          }
          if (spent) {
            /* The budget ran out before this attempt could be made. The host
             * took a connection earlier in this same ladder, so it is not
             * unreachable: the ladder is simply over, the site is blocked, and
             * the attempt that never went out is not counted. */
            report_gave_up(&st, local_fails, rep_fam);
            told = 1; gave_up = 1;
            break;
          }
          /* The budget bounds the whole ladder, so the last wait gets what is left. */
          if (wait_ms > left) wait_ms = left;
        }
        rep_fam = cur.fam;
        memcpy(work, first, (size_t)flen);   /* strategies may rewrite in place */
        cur.sent = flen; cur.at = now_ms();
        if (c >= 0) last_preset = c;
        int r = attempt_send(cur.s, cur.fam, work, RELAY_BUF, flen, &pi, c);
        st.made++;
        if (r != 0) {
          /* A send that failed is one more failed attempt, never the end of
           * the ladder. Reset in the middle of going out is the network
           * refusing, like a reset in reply; any other failure is ours and
           * says nothing about the network either way. */
          if (r == ATT_REFUSED) note_refused(&st, &cur, 0);
          else local_fails++;
          sock_close(cur.s);
          if (cur.room) room_give();
        } else {
          legs_add(&st.L, cur);
          r = await_legs(&st, wait_ms, rbuf, RELAY_BUF, &rlen, &win);
          if (r == ATT_OK) break;
          if (r == ATT_SILENT && !head) {
            if (a == 0 && st.opened_learned && watch_tls) st.first_failed = 1;
            if (++st.silent >= 2 && !st.saw_refusal && !watch_tls) {
              /* Twice now the far end simply said nothing to a plain HTTP
               * request, and nothing has ever been refused. That is a slow or
               * unreachable server far more often than a censored one, and
               * working through ten more techniques would only make an already
               * slow page slower. Wait on what is open. (A TLS handshake keeps
               * going: a silent drop is how some filters work, Turkcell
               * Superonline's for one.) */
              break;
            }
          }
        }
        if (!head || r != ATT_SILENT) atomic_fetch_add(&g_stats.probe_fail, 1);
        if (a + 1 >= ncand || now_ms() + ATT_MIN_LEFT_MS > deadline) {
          /* Nothing got through. This line is what a support log needs: the
           * host, how many techniques were tried, which address family was
           * used, and whether the network refused them or dropped them. */
          report_gave_up(&st, local_fails, rep_fam);
          told = 1; gave_up = 1;
          break;
        }
      }

      /* Where this host's next ladder starts (see ladder_start). TLS only: the other
       * ladders stop at the second silence instead of walking the list. One
       * that met a refusal walks it quickly enough, and starts from the top. */
      if (win < 0 && watch_tls) {
        if (gave_up && !st.saw_refusal && st.silent > 0 && last_preset >= 0)
          rs_put(key, (last_preset + 1) % np);
        else if (gave_up) rs_drop(key);
        /* The site's next name carries on after the last technique tried here
         * (see ladder_start), refused or dropped alike: the point is to reach
         * the techniques this ladder had no time for. */
        char site[256];
        if (gave_up && last_preset >= 0 && site_key(key, site, sizeof(site))) rs_put(site, (last_preset + 1) % np);
      }
      /* Nothing answered: for a while, its next ladders keep fewer connections
       * open (see COOL_MS). One that answers late, in the race below, ends
       * that again. */
      if (win < 0 && gave_up) cool_put(key);

      int pick = win;   /* the connection to relay */
      if (win < 0 && st.L.n > 0) {
        int rr = race_legs(&st, client, rbuf, RELAY_BUF, &rlen, &win, first, &flen);
        if (rr == 1) pick = win;
        else if (rr == 2) pick = 0;   /* the oldest: on a fresh ladder, the untouched request */
      }
      if (win >= 0) ladder_won(&st, &st.L.l[win]);
      /* The network's own DNS (see there): its address got through, or did
       * not; or every technique failed at our own resolver's addresses. */
      if (watch_tls && nd) {
        if (win >= 0) { if (nd_state(rq.host) != ND_GOOD) nd_tell(rq.host, dial_host, "ok"); nd_put(rq.host, ND_GOOD); }
        else if (gave_up) {
          /* Found no better: left alone for a while. One that worked before
           * (a node of a CDN gone, say) starts over instead. */
          int was = nd_state(rq.host);
          nd_put(rq.host, was == ND_GOOD ? ND_NONE : ND_BAD);
          if (was != ND_GOOD) nd_tell(rq.host, dial_host, "bad");
        }
      } else if (watch_tls && gave_up && win < 0 && dial_doh) {
        nd_failed(rq.host);
      }
      leg cur = { SOCK_INVALID, fam, 0, 0, ATT_PLAIN, 0, 0 };
      if (pick >= 0) cur = legs_take(&st.L, pick);
      legs_close(&st.L);
      /* A connection that went out before the client sent more has not been
       * given those bytes yet. */
      if (cur.s != SOCK_INVALID && flen > cur.sent) {
        if (sock_send_all(cur.s, first + cur.sent, (size_t)(flen - cur.sent), 0) == 0)
          atomic_fetch_add(&g_stats.bytes_up, (uint64_t)(flen - cur.sent));
      }
      up = cur.s; fam = cur.fam;
      /* Still unanswered, and nothing has been said about it yet: let the relay
       * report it if it stays that way. */
      if (rlen == 0 && !told) waiting = cur.at;
    }
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
    cw.gave_up = gave_up;
    if (rlen > 0) tls_follow(&cw.tt, rbuf, rlen);
    relay(client, up, &cw);
    if (!raw_done) {
      /* Any answer at all: it got through. Nothing, and the server ended it:
       * refused. Nothing, and the app gave up after a while: unanswered. An
       * app that left sooner than that says nothing either way. */
      if (cw.down > 0)
        raw_result(cut_key, rq.port, raw_cand, raw_inh, 1, 0, fam, 0);
      else if (cw.ended == 1) {
        /* The app is still connected: held a moment if this was told. */
        if (raw_result(cut_key, rq.port, raw_cand, raw_inh, 0, RAW_FAIL_REFUSED, fam, peer_port(client)) &&
            !g_cfg.auth_user[0])
          sleep_ms(RAW_HOLD_MS);
      } else if (cw.ended == 2 && age_ms(now_ms(), raw_at) >= RAW_SILENT_MS)
        raw_result(cut_key, rq.port, raw_cand, raw_inh, 0, RAW_FAIL_SILENT, fam, 0);
    }
  }

done:
  if (up != SOCK_INVALID) sock_close(up);
  free(first); free(work); free(rbuf);
  atomic_fetch_sub(&g_stats.conns_active, 1);
  sock_close_graceful(client);
}

/* The connection's socket travels as the thread's argument itself: nothing
 * to allocate, nothing to free. */
static void *conn_thread(void *p) {
  sock_t c = (sock_t)(uintptr_t)p;
  handle(c);
  return NULL;
}

/* What one accept loop serves: its listening socket, and the start it
 * belongs to (g_generation). */
typedef struct { sock_t l; unsigned gen; } accept_arg;

static int accept_current(unsigned gen) {
  return atomic_load(&g_running) && atomic_load(&g_generation) == gen;
}

static void *accept_loop(void *p) {
  accept_arg a = *(accept_arg *)p;
  free(p);
  while (accept_current(a.gen)) {
    struct sockaddr_storage ca; socklen_t cl = sizeof(ca);
    sock_t c = accept(a.l, (struct sockaddr *)&ca, &cl);
    if (c == SOCK_INVALID) {
      if (!accept_current(a.gen)) break;
      sleep_ms(5);
      continue;
    }
    /* Stopped while it waited: the connection is for no engine. */
    if (!accept_current(a.gen)) { sock_close(c); break; }
    /* Cap concurrency so a flood of localhost connections cannot exhaust
     * threads/memory. conns_active is decremented when each handler returns. */
    if (atomic_load(&g_stats.conns_active) >= MAX_CONNS) {
      sock_close(c);
      continue;
    }
    if (thread_spawn(conn_thread, (void *)(uintptr_t)c, 256 * 1024) != 0) sock_close(c);
  }
#if defined(__linux__)
  /* engine_stop only shut it down (see there): the loop closes it. */
  sock_close(a.l);
#endif
  return NULL;
}

/* The tables' locks and the output's, made once per process: a start after a
 * stop in the same process (embedded) must not make a lock anew while a
 * connection of the earlier engine may hold it. */
static void engine_init_once(void) {
  static int done = 0;
  if (done) return;
  done = 1;
  mutex_init(&g_hs_mx);
  mutex_init(&g_unreach_mx);
  mutex_init(&g_ok_mx);
  mutex_init(&g_win_mx);
  mutex_init(&g_cool_mx);
  mutex_init(&g_seen_mx);
  mutex_init(&g_raw_mx);
  mutex_init(&g_osdns_mx);
  mutex_init(&g_nd_mx);
  strategy_raw_count();   /* the raw list built before any thread reads it */
  mutex_init(&g_out_mx);
  g_out_mx_ready = 1;
}

/* Everything an engine has learned about hosts and resolvers: a start is a
 * fresh engine, as a new process was (the app sends back what it keeps
 * itself, see LEARN). In a process that has just started it is all empty
 * already. */
static void engine_forget(void) {
  mutex_lock(&g_hs_mx);
  memset(g_hs, 0, sizeof(g_hs));
  memset(g_rs, 0, sizeof(g_rs));
  mutex_unlock(&g_hs_mx);
  mutex_lock(&g_ok_mx);
  memset(g_ok, 0, sizeof(g_ok));
  mutex_unlock(&g_ok_mx);
  mutex_lock(&g_cool_mx);
  memset(g_cool, 0, sizeof(g_cool));
  mutex_unlock(&g_cool_mx);
  mutex_lock(&g_win_mx);
  memset(g_win, 0, sizeof(g_win));
  mutex_unlock(&g_win_mx);
  mutex_lock(&g_unreach_mx);
  memset(g_unreach, 0, sizeof(g_unreach));
  mutex_unlock(&g_unreach_mx);
  mutex_lock(&g_seen_mx);
  memset(g_seen, 0, sizeof(g_seen));
  mutex_unlock(&g_seen_mx);
  mutex_lock(&g_raw_mx);
  memset(g_raw, 0, sizeof(g_raw));
  memset(g_raw_unreach, 0, sizeof(g_raw_unreach));
  g_raw_unreach_win = 0; g_raw_unreach_n = 0; g_raw_good = -1;
  memset(g_raw_seen, 0, sizeof(g_raw_seen)); g_raw_seen_at = 0;
  mutex_unlock(&g_raw_mx);
  mutex_lock(&g_osdns_mx);
  memset(g_osdns, 0, sizeof(g_osdns));
  g_osdns_slow_until = 0;
  mutex_unlock(&g_osdns_mx);
  mutex_lock(&g_nd_mx);
  memset(g_nd, 0, sizeof(g_nd));
  mutex_unlock(&g_nd_mx);
  doh_clear_cache();   /* the answers, and which resolvers were found dead */
}

int engine_start(const engine_config *cfg) {
  engine_init_once();
  /* Each copy stays linked from the last (g_cfg_kept), so none is ever
   * unreachable, for a leak checker as much as for the connections. */
  cfg_copy *own = (cfg_copy *)malloc(sizeof(*own));
  if (!own) return -1;
  own->cfg = *cfg;
  own->prev = g_cfg_kept;
  g_cfg_kept = own;
  atomic_store(&g_cfg_ptr, &own->cfg);
  /* The counters start over. conns_active is what is open right now: in a
   * process that has run an engine before (embedded), connections of that
   * one may still be finishing, and they count themselves out when they do. */
  atomic_store(&g_stats.conns_total, 0);
  atomic_store(&g_stats.bytes_up, 0);
  atomic_store(&g_stats.bytes_down, 0);
  atomic_store(&g_stats.desync_applied, 0);
  atomic_store(&g_stats.tls_seen, 0);
  atomic_store(&g_stats.http_seen, 0);
  atomic_store(&g_stats.probe_success, 0);
  atomic_store(&g_stats.probe_fail, 0);
  doh_init(cfg->doh_host, cfg->doh_ip);
  engine_forget();

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)cfg->listen_port);
  if (inet_pton(AF_INET, cfg->listen_addr[0] ? cfg->listen_addr : "127.0.0.1",
                &addr.sin_addr) != 1) {
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  }

  sock_t l = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (l == SOCK_INVALID) return -1;
  int yes = 1;
#ifdef _WIN32
  /* SO_REUSEADDR does not mean on Windows what it means elsewhere: it lets a
   * second process bind the same address and port and take over the
   * connections, which for a proxy the whole system is pointed at would hand
   * every request to whoever asked second. SO_EXCLUSIVEADDRUSE is the option
   * that reserves the port. */
  setsockopt(l, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&yes, sizeof(yes));
#else
  setsockopt(l, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
#endif
  if (bind(l, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    sock_close(l); return -2;
  }
  if (listen(l, 128) != 0) {
    sock_close(l); return -3;
  }
  accept_arg *aa = (accept_arg *)malloc(sizeof(*aa));
  if (!aa) { sock_close(l); return -1; }
  aa->l = l;
  aa->gen = atomic_fetch_add(&g_generation, 1) + 1;

  g_listener = l;
  atomic_store(&g_running, 1);
  /* With --auto the ladder decides, not --strategy; say how many techniques it
   * has here so the app can describe what is actually running. */
  /* pid: which process the engine is (a supervisor that did not start it
   * through a handle it keeps can tell it by that). */
#ifdef _WIN32
  long pid = (long)GetCurrentProcessId();
#else
  long pid = (long)getpid();
#endif
  engine_printf("{\"type\":\"ready\",\"port\":%d,\"techniques\":%d,\"pid\":%ld}\n", cfg->listen_port,
                usable_presets(), pid);
  if (thread_spawn(accept_loop, aa, 256 * 1024) != 0) {
    free(aa);
    atomic_store(&g_running, 0);
    g_listener = SOCK_INVALID;
    sock_close(l);
    return -1;
  }
  return 0;
}

void engine_stop(void) {
  atomic_store(&g_running, 0);
  if (g_listener != SOCK_INVALID) {
    sock_t l = g_listener; g_listener = SOCK_INVALID;
#if defined(__linux__)
    /* On Linux close() does not wake an accept() blocked on the socket in
     * another thread; shutdown() does, and stops new connections the same.
     * The accept loop then closes it, so the descriptor is never closed under
     * the loop and handed to something else in the process meanwhile (an
     * engine run inside another program, see engine_main). */
    shutdown(l, SHUT_RDWR);
#else
    sock_close(l);
#endif
  }
}

/* Called by the probe subsystem to record a working strategy for a host. */
void engine_learn(const char *host, int preset) { hs_put(host, preset); }

/* What an earlier run learned (the app keeps it across restarts): a host, the
 * technique by name, and how long ago it was learned. It is stored as that
 * old, so one learned more than HS_VERIFY_MS ago is checked against the
 * untouched request before it is relied on again, and one that no longer
 * works is replaced by the ladder like any other. 0, or -1 for a name that
 * is not a host, a technique this build does not have, or one that cannot
 * do anything here. */
int engine_restore(const char *host, const char *technique, uint64_t age) {
  size_t n = strlen(host);
  if (n == 0 || n > 253) return -1;
  /* A raw technique (a stream that is not TLS or HTTP), learned for an
   * address or a name alike. */
  if (strncmp(technique, "raw-", 4) == 0) {
    for (size_t i = 0; i < n; i++) {
      char c = host[i];
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == ':')) return -1;
    }
    return raw_restore(host, technique, age);
  }
  if (ip_literal(host)) return -1;
  for (size_t i = 0; i < n; i++) {
    char c = host[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-')) return -1;
  }
  int p = -1, np = strategy_preset_count();
  for (int i = 0; i < np; i++) if (strcmp(strategy_preset(i)->name, technique) == 0) { p = i; break; }
  if (p < 0 || !preset_usable(strategy_preset(p))) return -1;
  hs_put(host, p);
  uint64_t now = now_ms(), t = now > age ? now - age : 0;
  char site[256];
  mutex_lock(&g_hs_mx);
  int i = hs_find(host);
  if (i >= 0) g_hs[i].t = t;
  if (site_key(host, site, sizeof(site)) && (i = hs_find(site)) >= 0) g_hs[i].t = t;
  mutex_unlock(&g_hs_mx);
  return 0;
}
