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
#define MAX_CONNS   2048   /* hard cap on concurrent connections (loopback) */

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
  for (int i = 0; i < HS_SIZE; i++) {
    if (!g_hs[i].used) { slot = i; break; }
    if (g_hs[i].t < old) { old = g_hs[i].t; slot = i; }
  }
  if (slot < 0) slot = 0;
  memset(&g_hs[slot], 0, sizeof(g_hs[slot]));
  strncpy(g_hs[slot].host, h, sizeof(g_hs[slot].host) - 1);
  g_hs[slot].preset = preset; g_hs[slot].t = now_ms(); g_hs[slot].used = 1;
  mutex_unlock(&g_hs_mx);
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

static sock_t dial(const char *host, uint16_t port, int prefer6, int *out_family) {
  struct sockaddr_storage sa; socklen_t sl = 0;
  int want6 = prefer6;
  if (g_cfg.use_doh) {
    if (doh_resolve(host, port, want6, &sa, &sl) != 0) {
      if (doh_resolve(host, port, !want6, &sa, &sl) != 0) return SOCK_INVALID;
    }
  } else {
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    char ps[8]; snprintf(ps, sizeof(ps), "%u", port);
    if (getaddrinfo(host, ps, &hints, &res) != 0 || !res) return SOCK_INVALID;
    memcpy(&sa, res->ai_addr, res->ai_addrlen); sl = (socklen_t)res->ai_addrlen;
    freeaddrinfo(res);
  }
  sock_t s = socket(sa.ss_family, SOCK_STREAM, IPPROTO_TCP);
  if (s == SOCK_INVALID) return SOCK_INVALID;
  if (sock_connect_timeout(s, (struct sockaddr *)&sa, (int)sl, 8000) != 0) {
    sock_close(s); return SOCK_INVALID;
  }
  sock_set_nodelay(s, 1);
  sock_set_keepalive(s);
  if (out_family) *out_family = sa.ss_family;
  return s;
}

/* Bidirectional relay until either side closes. */
static void relay(sock_t a, sock_t b) {
  uint8_t *buf = (uint8_t *)malloc(RELAY_BUF);
  if (!buf) return;
  for (;;) {
    int w = sock_wait_either(a, b, 30000);
    if (w < 0) break;
    if (w == 0) continue;
    if (w & 1) {
      int n = recv(a, (char *)buf, RELAY_BUF, 0);
      if (n <= 0) break;
      if (sock_send_all(b, buf, (size_t)n, 0) != 0) break;
      atomic_fetch_add(&g_stats.bytes_up, (uint64_t)n);
    }
    if (w & 2) {
      int n = recv(b, (char *)buf, RELAY_BUF, 0);
      if (n <= 0) break;
      if (sock_send_all(a, buf, (size_t)n, 0) != 0) break;
      atomic_fetch_add(&g_stats.bytes_down, (uint64_t)n);
    }
  }
  free(buf);
}

/* Read the first client payload (ClientHello / HTTP request). For TLS we wait
 * until the whole first record has arrived so multi-segment ClientHellos are
 * handled correctly. Returns bytes read, or -1. */
static int read_first(sock_t c, uint8_t *buf, int cap) {
  int total = 0;
  uint64_t deadline = now_ms() + FIRST_WAIT;
  int want = 0;
  while (total < cap) {
    int left = (int)(deadline - now_ms());
    if (left <= 0) break;
    int w = sock_wait_readable(c, left);
    if (w <= 0) break;
    int n = recv(c, (char *)buf + total, cap - total, 0);
    if (n <= 0) break;
    total += n;
    if (want == 0) {
      want = tls_expected_len(buf, (size_t)total);
      if (want == 0) break;          /* not TLS: first recv is the HTTP request */
    }
    if (want > 0 && total >= want) break;
  }
  return total > 0 ? total : -1;
}

typedef struct { sock_t client; } conn_arg;

static void handle(sock_t client) {
  atomic_fetch_add(&g_stats.conns_total, 1);
  atomic_fetch_add(&g_stats.conns_active, 1);

  char host[256]; uint16_t port; int is_ip6 = 0;
  sock_set_timeouts(client, 30000);
  sock_set_nodelay(client, 1);

  if (socks5_accept(client, host, sizeof(host), &port, &is_ip6) != 0) goto done;

  int fam = 0;
  sock_t up = dial(host, port, g_cfg.prefer_ipv6, &fam);
  if (up == SOCK_INVALID) { socks5_reply(client, 0x04); goto done; }
  if (socks5_reply(client, 0x00) != 0) { sock_close(up); goto done; }

  /* First payload */
  uint8_t *first = (uint8_t *)malloc(RELAY_BUF);
  if (!first) { sock_close(up); goto done; }
  int flen = read_first(client, first, RELAY_BUF);

  if (flen > 0) {
    proto_info pi;
    proto_inspect(first, (size_t)flen, &pi);
    if (pi.kind == PROTO_TLS)  atomic_fetch_add(&g_stats.tls_seen, 1);
    if (pi.kind == PROTO_HTTP) atomic_fetch_add(&g_stats.http_seen, 1);

    const strategy *st = &g_cfg.strat;
    int preset = -1;
    if (g_cfg.auto_probe && pi.kind != PROTO_UNKNOWN) {
      preset = hs_get(pi.host[0] ? pi.host : host);
      if (preset >= 0) st = strategy_preset(preset);
    }

    /* Apply desync to the first payload; plain passthrough if unknown proto. */
    if (pi.kind != PROTO_UNKNOWN) {
      desync_send_first(up, fam, first, flen, &pi, st, &g_stats.desync_applied);
      atomic_fetch_add(&g_stats.bytes_up, (uint64_t)flen);
    } else {
      sock_send_all(up, first, (size_t)flen, 0);
      atomic_fetch_add(&g_stats.bytes_up, (uint64_t)flen);
    }
  }
  free(first);

  relay(client, up);
  sock_close(up);

done:
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
  setsockopt(g_listener, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
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
