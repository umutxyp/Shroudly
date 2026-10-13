#include "engine.h"
#include "platform.h"
#include "proto.h"
#include "strategy.h"
#include "desync.h"
#include "doh.h"
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
#define ATT_MAX         12
#define ATT_BUDGET_MS   15000
#define VERIFY_PLAIN_MS 5000
#define VERIFY_DESYNC_MS 3500

/* Outcome of one attempt. */
#define ATT_OK      1   /* server answered */
#define ATT_REFUSED 0   /* reset or closed: the connection was refused */
#define ATT_SILENT  2   /* nothing came back at all: could be a slow server */
#define ATT_LOCAL  (-1) /* our own send failed */

static engine_config  g_cfg;
static engine_stats   g_stats;
static sock_t         g_listener = SOCK_INVALID;
static _Atomic int    g_running  = 0;

/* ── per-host learned strategy (auto-probe cache) ───────────────────────── */
typedef struct { char host[256]; int preset; uint64_t t; int used; } hoststrat;
#define HS_SIZE 512
static hoststrat g_hs[HS_SIZE];
static mutex_t   g_hs_mx;

static int hs_get(const char *h) {
  mutex_lock(&g_hs_mx);
  int r = -1;
  for (int i = 0; i < HS_SIZE; i++)
    if (g_hs[i].used && strcmp(g_hs[i].host, h) == 0) { r = g_hs[i].preset; break; }
  mutex_unlock(&g_hs_mx);
  return r;
}
static void hs_put(const char *h, int preset) {
  mutex_lock(&g_hs_mx);
  int slot = -1; uint64_t old = (uint64_t)-1;
  /* The host's own entry first: a host that is learned again must replace
   * what was known, not sit behind it where hs_get would never look. */
  for (int i = 0; i < HS_SIZE; i++)
    if (g_hs[i].used && strcmp(g_hs[i].host, h) == 0) { slot = i; break; }
  if (slot < 0) {   /* else a free slot, else the least recently learned */
    for (int i = 0; i < HS_SIZE; i++) {
      if (!g_hs[i].used) { slot = i; break; }
      if (g_hs[i].t < old) { old = g_hs[i].t; slot = i; }
    }
  }
  if (slot < 0) slot = 0;
  memset(&g_hs[slot], 0, sizeof(g_hs[slot]));
  strncpy(g_hs[slot].host, h, sizeof(g_hs[slot].host) - 1);
  g_hs[slot].preset = preset; g_hs[slot].t = now_ms(); g_hs[slot].used = 1;
  mutex_unlock(&g_hs_mx);
}

/* The network let a connection to this host start and then cut it. Whatever
 * opened it is not enough here, so the next connection starts with the next
 * technique. Cycling is cheap — every technique still has to produce a real
 * handshake before it is used — and it settles on the first one that is not
 * cut. This is what keeps working when a filter changes what it looks at. */
static void hs_on_cut(const char *h) {
  int np = strategy_preset_count();
  if (np <= 0 || !g_cfg.auto_probe) return;
  int cur = hs_get(h);
  hs_put(h, cur < 0 ? 0 : (cur + 1) % np);
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

/* ── SOCKS5 handshake (client side) ─────────────────────────────────────── */
/* Reads greeting + CONNECT request, fills host/port. Does NOT send the final
 * reply — the caller dials upstream first and then calls socks5_reply(), per
 * RFC 1928, so the client learns the true connect result. */
static int recv_exact(sock_t c, uint8_t *b, int n) {
  int got = 0;
  while (got < n) {
    int r = recv(c, (char *)b + got, n - got, 0);
    if (r <= 0) return -1;
    got += r;
  }
  return 0;
}

static int socks5_accept(sock_t c, char *host, size_t hostsz, uint16_t *port, int *is_ip6) {
  uint8_t b[300];
  if (sock_wait_readable(c, 5000) != 1) return -1;
  if (recv_exact(c, b, 2) != 0 || b[0] != 0x05) return -1;
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
  *is_ip6 = 0;
  if (atyp == 0x01) {
    uint8_t a[4]; if (recv_exact(c, a, 4) != 0) return -1;
    snprintf(host, hostsz, "%u.%u.%u.%u", a[0], a[1], a[2], a[3]);
  } else if (atyp == 0x03) {
    uint8_t l; if (recv_exact(c, &l, 1) != 0) return -1;
    if (l == 0 || l >= hostsz) return -1;
    if (recv_exact(c, (uint8_t *)host, l) != 0) return -1;
    host[l] = 0;
  } else if (atyp == 0x04) {
    uint8_t a[16]; if (recv_exact(c, a, 16) != 0) return -1;
    char tmp[64]; inet_ntop(AF_INET6, a, tmp, sizeof(tmp));
    snprintf(host, hostsz, "%s", tmp); *is_ip6 = 1;
  } else {
    uint8_t f[10] = { 0x05, 0x08, 0, 0x01, 0,0,0,0, 0,0 };
    sock_send_all(c, f, 10, 0); return -1;
  }
  uint8_t pb[2]; if (recv_exact(c, pb, 2) != 0) return -1;
  *port = (uint16_t)((pb[0] << 8) | pb[1]);
  return 0;
}

/* rep: 0x00 success, 0x05 refused, 0x04 host unreachable, 0x01 general. */
static int socks5_reply(sock_t c, uint8_t rep) {
  uint8_t r[10] = { 0x05, rep, 0, 0x01, 0,0,0,0, 0,0 };
  return sock_send_all(c, r, 10, 0);
}

static sock_t connect_addr(const struct sockaddr *sa, socklen_t sl, int timeout_ms) {
  sock_t s = socket(sa->sa_family, SOCK_STREAM, IPPROTO_TCP);
  if (s == SOCK_INVALID) return SOCK_INVALID;
  if (sock_connect_timeout(s, sa, (int)sl, timeout_ms) != 0) { sock_close(s); return SOCK_INVALID; }
  sock_set_nodelay(s, 1);
  sock_set_keepalive(s);
  return s;
}

/* Connect to the first address that answers. A name often has both IPv4 and
 * IPv6 addresses while the network only routes one of them (e.g. AAAA records
 * handed out right after Wi-Fi comes up, with no IPv6 route): so try the
 * preferred family first (IPv4 unless --ipv6), then the other, and move on to
 * the next address when one fails instead of failing the whole connection. */
#define DIAL_MAX_TRIES 6
static sock_t dial(const char *host, uint16_t port, int prefer6, int *out_family) {
  sock_t s = SOCK_INVALID;
  int tries = 0;
  if (g_cfg.use_doh) {
    for (int pass = 0; pass < 2 && s == SOCK_INVALID; pass++) {
      struct sockaddr_storage sa; socklen_t sl = 0;
      if (doh_resolve(host, port, pass == 0 ? prefer6 : !prefer6, &sa, &sl) != 0) continue;
      s = connect_addr((struct sockaddr *)&sa, sl, tries++ == 0 ? 8000 : 4000);
      if (s != SOCK_INVALID && out_family) *out_family = sa.ss_family;
    }
    return s;
  }
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_ADDRCONFIG; /* no AAAA answers on an IPv4-only machine */
  char ps[8]; snprintf(ps, sizeof(ps), "%u", port);
  if (getaddrinfo(host, ps, &hints, &res) != 0 || !res) return SOCK_INVALID;
  for (int pass = 0; pass < 2 && s == SOCK_INVALID; pass++) {
    int fam = (pass == 0) == !!prefer6 ? AF_INET6 : AF_INET;
    for (struct addrinfo *p = res; p && s == SOCK_INVALID && tries < DIAL_MAX_TRIES; p = p->ai_next) {
      if (p->ai_family != fam) continue;
      s = connect_addr(p->ai_addr, (socklen_t)p->ai_addrlen, tries++ == 0 ? 8000 : 4000);
      if (s != SOCK_INVALID && out_family) *out_family = fam;
    }
  }
  freeaddrinfo(res);
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
  tls_track tt;
} cut_watch;

static void report(const char *ev, const char *host, const char *strat, int attempts, int fam);

/* Bidirectional relay until either side closes. a = client, b = server. */
static void relay(sock_t a, sock_t b, cut_watch *cw) {
  uint8_t *buf = (uint8_t *)malloc(RELAY_BUF);
  if (!buf) return;
  int reported = 0;
  uint64_t t = now_ms(), last_down = t;
  uint64_t waiting_since = 0;   /* client sent something the server has not answered */
  for (;;) {
    int w = sock_wait_either(a, b, 1000);
    if (w < 0) break;
    t = now_ms();
    if (cw && cw->host && !reported && cw->down < CUT_MAX_BYTES) {
      if (tls_mid_record(&cw->tt) && t - last_down >= CUT_STALL_MS) {
        report("cut", cw->host, "stall", (int)(cw->down / 1024), cw->fam); reported = 1;
        hs_on_cut(cw->host);
      } else if (waiting_since && t - waiting_since >= CUT_NOREPLY_MS) {
        report("cut", cw->host, "noreply", (int)(cw->down / 1024), cw->fam); reported = 1;
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
        { report("cut", cw->host, "reset", (int)(cw->down / 1024), cw->fam); hs_on_cut(cw->host); }
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
      w = sock_wait_either(c, up, left < QUIET_WAIT ? left : QUIET_WAIT);
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

static void report(const char *ev, const char *host, const char *strat,
                   int attempts, int fam) {
  char h[256];
  json_host(h, sizeof(h), host);
  printf("{\"type\":\"%s\",\"host\":\"%s\",\"strategy\":\"%s\","
         "\"attempts\":%d,\"family\":\"%s\"}\n",
         ev, h, strat ? strat : "", attempts, fam == AF_INET6 ? "ipv6" : "ipv4");
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

/* Send the first payload using `preset` (or unmodified for ATT_PLAIN), then
 * wait for the server to say something. On success the server's first bytes
 * are left in `rbuf` and their length stored in `*rlen`. */
static int attempt(sock_t up, int fam, uint8_t *payload, int pcap, int len,
                   const proto_info *pi, int preset, int wait_ms,
                   uint8_t *rbuf, int rcap, int *rlen) {
  *rlen = 0;
  if (preset == ATT_PLAIN || pi->kind == PROTO_UNKNOWN) {
    if (sock_send_all(up, payload, (size_t)len, 0) != 0) return ATT_LOCAL;
  } else {
    const strategy *st = (preset >= 0) ? strategy_preset(preset) : &g_cfg.strat;
    if (desync_send_first(up, fam, payload, len, pcap, pi, st, &g_stats.desync_applied) != 0)
      return ATT_LOCAL;
  }
  atomic_fetch_add(&g_stats.bytes_up, (uint64_t)len);

  int w = sock_wait_readable(up, wait_ms);
  if (w < 0) return ATT_REFUSED;
  if (w == 0) return ATT_SILENT;         /* blackholed, or merely slow */
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

static void handle(sock_t client) {
  atomic_fetch_add(&g_stats.conns_total, 1);
  atomic_fetch_add(&g_stats.conns_active, 1);

  char host[256]; uint16_t port; int is_ip6 = 0;
  uint8_t *first = NULL, *work = NULL, *rbuf = NULL;
  sock_t up = SOCK_INVALID;

  sock_set_timeouts(client, 30000);
  sock_set_nodelay(client, 1);

  if (socks5_accept(client, host, sizeof(host), &port, &is_ip6) != 0) goto done;

  int fam = 0;
  up = dial(host, port, g_cfg.prefer_ipv6, &fam);
  if (up == SOCK_INVALID) { socks5_reply(client, 0x04); goto done; }
  if (socks5_reply(client, 0x00) != 0) goto done;

  first = (uint8_t *)malloc(RELAY_BUF);
  work  = (uint8_t *)malloc(RELAY_BUF);
  rbuf  = (uint8_t *)malloc(RELAY_BUF);
  if (!first || !work || !rbuf) goto done;

  int flen = read_first(client, up, first, RELAY_BUF);
  int rlen = 0;
  int watch_tls = 0;
  char cut_key[256]; cut_key[0] = 0;

  if (flen > 0) {
    proto_info pi;
    proto_inspect(first, (size_t)flen, &pi);
    if (pi.kind == PROTO_TLS)  atomic_fetch_add(&g_stats.tls_seen, 1);
    if (pi.kind == PROTO_HTTP) atomic_fetch_add(&g_stats.http_seen, 1);

    const char *key = pi.host[0] ? pi.host : host;
    watch_tls = pi.kind == PROTO_TLS;
    strncpy(cut_key, key, sizeof(cut_key) - 1); cut_key[sizeof(cut_key) - 1] = 0;

    /* Build the ladder. */
    int cand[ATT_MAX]; int ncand = 0;
    int ladder = g_cfg.auto_probe && pi.kind != PROTO_UNKNOWN &&
                 retry_safe(&pi, first, flen);
    if (!ladder) {
      cand[ncand++] = g_cfg.auto_probe ? ATT_PLAIN : -1;   /* -1 = configured */
    } else {
      int learned = hs_get(key);
      if (learned >= 0) cand[ncand++] = learned;           /* known to work */
      else              cand[ncand++] = ATT_PLAIN;         /* untouched first */
      int np = strategy_preset_count();
      for (int i = 0; i < np && ncand < ATT_MAX; i++) {
        if (i == learned) continue;
        cand[ncand++] = i;
      }
      /* If a strategy was learned, still allow an untouched attempt last: the
       * block may have been lifted, or the host may have changed. */
      if (learned >= 0 && ncand < ATT_MAX) cand[ncand++] = ATT_PLAIN;
    }

    uint64_t deadline = now_ms() + ATT_BUDGET_MS;
    int saw_refusal = 0, silent = 0;
    for (int a = 0; a < ncand; a++) {
      if (a > 0) {
        /* Anything the client sent meanwhile belongs in the replay. */
        while (flen < RELAY_BUF && sock_wait_readable(client, 0) == 1) {
          int n = recv(client, (char *)first + flen, RELAY_BUF - flen, 0);
          if (n <= 0) break;
          flen += n;
        }
        sock_close(up);
        up = dial(host, port, g_cfg.prefer_ipv6, &fam);
        if (up == SOCK_INVALID) break;
      }
      memcpy(work, first, (size_t)flen);   /* strategies may rewrite in place */
      int wait_ms = (cand[a] == ATT_PLAIN) ? VERIFY_PLAIN_MS : VERIFY_DESYNC_MS;
      int r = attempt(up, fam, work, RELAY_BUF, flen, &pi, cand[a], wait_ms, rbuf, RELAY_BUF, &rlen);
      if (r == ATT_OK) {
        /* Remember the technique only when we actually saw a refusal. A server
         * that was merely slow must not leave this host permanently desynced. */
        if (ladder && cand[a] >= 0 && saw_refusal) hs_put(key, cand[a]);
        atomic_fetch_add(&g_stats.probe_success, 1);
        /* Only worth reporting when something had to be done about it: a site
         * that opened untouched is not news, one that needed a technique is. */
        /* Only call it a bypass if something actually refused us. A server
         * that was just slow is not a censored one, and saying so in the log
         * would send the user chasing a block that never happened. */
        if (a > 0 && cand[a] >= 0 && saw_refusal)
          report("bypass", key, strategy_preset(cand[a])->name, a + 1, fam);
        break;
      }
      if (r == ATT_LOCAL || !ladder) {
        if (r == ATT_LOCAL) report("send_failed", key, "", a + 1, fam);
        break;
      }
      if (r == ATT_REFUSED) saw_refusal = 1;
      else if (++silent >= 2 && !saw_refusal) {
        /* Twice now the far end simply said nothing, and nothing has ever been
         * refused. That is a slow or unreachable server far more often than a
         * censored one, and working through ten more techniques would only
         * make an already slow page slower. Let the relay wait it out. */
        break;
      }
      atomic_fetch_add(&g_stats.probe_fail, 1);
      if (a + 1 >= ncand || now_ms() >= deadline) {
        /* Nothing got through. This line is what a support log needs: the host,
         * how many techniques were tried, and which address family was used. */
        report("blocked", key, "", a + 1, fam);
        break;
      }
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
    if (rlen > 0) tls_follow(&cw.tt, rbuf, rlen);
    relay(client, up, &cw);
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
  printf("{\"type\":\"ready\",\"port\":%d}\n", cfg->listen_port);
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
