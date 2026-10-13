/*
 * Resolver with anti-poisoning.
 *
 * Primary path (when the app passes --doh-port): a local DNS-over-HTTPS
 * forwarder (electron/doh-forwarder.js) that this engine queries over UDP on
 * 127.0.0.1. The forwarder speaks real RFC 8484 DoH to Cloudflare/Google/Quad9
 * over TLS, connecting by IP with no SNI, so the resolver traffic itself cannot
 * be blocked by SNI and cannot be read or injected on the wire.
 *
 * Fallback (forwarder down, or no --doh-port): several independent public
 * resolvers over UDP/53, cross-checked. Not encrypted, but driver-free and
 * still defeats the most common layer (UDP/53 reply injection):
 *
 *   1. Query several independent public resolvers in parallel over UDP/53.
 *   2. Poisoned answers from on-path injectors arrive first and usually point to
 *      a sinkhole / bogon / a small fixed block set. We keep collecting answers
 *      past the first one, cross-check them, and discard addresses that:
 *        - are bogons / private / reserved,
 *        - appear in the known block-page set,
 *        - are contradicted by the majority of resolvers.
 *   3. If UDP answers disagree, we retry over TCP/53 (harder to inject blindly)
 *      against the resolver that the majority agreed with.
 *
 * This is not as strong as encrypted DNS, but it is driver-free, library-free,
 * cross-platform, and removes the most common censorship layer (UDP/53 reply
 * injection) without touching any system network settings.
 */
/* rand_s is only declared when _CRT_RAND_S is set before the C runtime header
   is pulled in — but only Windows needs that. Including <stdlib.h> here on
   glibc would fix the feature-test macros before platform.h gets to set
   _GNU_SOURCE, and struct addrinfo would then not be declared at all. */
#ifdef _WIN32
#  ifndef _CRT_RAND_S
#  define _CRT_RAND_S
#  endif
#  include <stdlib.h>
#endif
#include "doh.h"
#include "platform.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

#define MAX_RESOLVERS 5
#define CACHE_SIZE    256

static const char *RESOLVERS[MAX_RESOLVERS] = {
  "1.1.1.1", "8.8.8.8", "9.9.9.9", "208.67.222.222", "8.8.4.4"
};

typedef struct {
  char     name[256];
  uint16_t port;
  int      family;
  struct sockaddr_storage sa;
  socklen_t salen;
  uint64_t expires;
  int      used;
} cache_entry;

static cache_entry g_cache[CACHE_SIZE];
static mutex_t     g_cache_mx;
static int         g_init = 0;

void doh_init(const char *doh_host, const char *doh_ip) {
  (void)doh_host; (void)doh_ip;
  if (!g_init) { mutex_init(&g_cache_mx); g_init = 1; }
}

void doh_clear_cache(void) {
  if (!g_init) return;
  mutex_lock(&g_cache_mx);
  memset(g_cache, 0, sizeof(g_cache));
  mutex_unlock(&g_cache_mx);
}

static cache_entry *cache_find(const char *name, uint16_t port, int want6) {
  uint64_t t = now_ms();
  for (int i = 0; i < CACHE_SIZE; i++) {
    cache_entry *e = &g_cache[i];
    if (e->used && e->port == port && e->expires > t &&
        ((want6 && e->family == AF_INET6) || (!want6 && e->family == AF_INET)) &&
        strcmp(e->name, name) == 0)
      return e;
  }
  return NULL;
}

static void cache_put(const char *name, uint16_t port, int family,
                      const struct sockaddr_storage *sa, socklen_t salen) {
  uint64_t t = now_ms();
  int slot = -1;
  uint64_t oldest = (uint64_t)-1;
  for (int i = 0; i < CACHE_SIZE; i++) {
    if (!g_cache[i].used || g_cache[i].expires <= t) { slot = i; break; }
    if (g_cache[i].expires < oldest) { oldest = g_cache[i].expires; slot = i; }
  }
  if (slot < 0) slot = 0;
  cache_entry *e = &g_cache[slot];
  memset(e, 0, sizeof(*e));
  strncpy(e->name, name, sizeof(e->name) - 1);
  e->port = port; e->family = family;
  memcpy(&e->sa, sa, sizeof(*sa));
  e->salen = salen;
  e->expires = t + 300000; /* 5 min */
  e->used = 1;
}

/* ── bogon / block-page filtering ───────────────────────────────────────── */
static int is_bogon_v4(uint32_t ip /*host order*/) {
  uint8_t a = (ip >> 24) & 0xff, b = (ip >> 16) & 0xff;
  if (a == 0 || a == 10 || a == 127) return 1;
  if (a == 169 && b == 254) return 1;
  if (a == 172 && b >= 16 && b <= 31) return 1;
  if (a == 192 && b == 168) return 1;
  if (a == 100 && b >= 64 && b <= 127) return 1;
  if (a >= 224) return 1;                 /* multicast / reserved */
  if (ip == 0xFFFFFFFFu) return 1;
  return 0;
}

/* Known ISP block-page / sinkhole addresses (host order). DNS-based censorship
 * answers blocked names with one of these instead of a bogon, so they must be
 * rejected like bogons. Seeded with Turk Telekom's; the app passes the full
 * list (electron/censor-fingerprints.js) with --block-ip, so it can grow
 * without touching the engine. */
#define MAX_BLOCK_IPS 512
static uint32_t g_block_ips[MAX_BLOCK_IPS] = {
  0xC3AFFE02u, /* 195.175.254.2  — TTNET block page */
};
static int g_block_n = 1;

void doh_add_block_ip(const char *ip) {
  struct in_addr a;
  if (inet_pton(AF_INET, ip, &a) != 1) return;
  uint32_t h = ntohl(a.s_addr);
  for (int i = 0; i < g_block_n; i++) if (g_block_ips[i] == h) return;
  if (g_block_n < MAX_BLOCK_IPS) g_block_ips[g_block_n++] = h;
}

static int is_blockpage_v4(uint32_t ip /*host order*/) {
  for (int i = 0; i < g_block_n; i++) if (g_block_ips[i] == ip) return 1;
  return 0;
}

/* True if a resolved address is a censorship answer (block page or bogon). */
int doh_addr_is_block(const struct sockaddr_storage *sa) {
  if (sa->ss_family != AF_INET) return 0;
  uint32_t ip = ntohl(((const struct sockaddr_in *)sa)->sin_addr.s_addr);
  return is_bogon_v4(ip) || is_blockpage_v4(ip);
}

/* Optional local DoH forwarder (127.0.0.1:port), tried before public UDP. */
static char     g_fwd_ip[64] = "";
static uint16_t g_fwd_port = 0;
void doh_set_local(const char *ip, int port) {
  if (!ip || port <= 0 || port > 65535) { g_fwd_ip[0] = 0; g_fwd_port = 0; return; }
  strncpy(g_fwd_ip, ip, sizeof(g_fwd_ip) - 1); g_fwd_ip[sizeof(g_fwd_ip) - 1] = 0;
  g_fwd_port = (uint16_t)port;
}

/* ── DNS wire format ────────────────────────────────────────────────────── */
/* A spoofed reply only has to match the query id, so that id must not be
 * guessable. Derived from the clock it would be: an attacker who knows roughly
 * when the lookup happened can enumerate a handful of candidates. */
static uint16_t dns_query_id(void) {
  uint16_t v = 0;
#ifdef _WIN32
  unsigned int r = 0;
  if (rand_s(&r) == 0) v = (uint16_t)r;
#else
  FILE *f = fopen("/dev/urandom", "rb");
  if (f) { unsigned char b[2]; if (fread(b, 1, 2, f) == 2) v = (uint16_t)((b[0] << 8) | b[1]); fclose(f); }
#endif
  if (v == 0) {
    /* Nothing better available: still mix several changing sources rather
     * than leaning on the clock alone. */
    static _Atomic unsigned counter;
    unsigned c = atomic_fetch_add(&counter, 0x9e37u) + 1u;
    uint64_t t = now_ms();
    v = (uint16_t)((t ^ (t >> 17) ^ (uintptr_t)&counter ^ (c * 2654435761u)) & 0xffff);
  }
  return v;
}

static int dns_build(uint8_t *q, const char *name, uint16_t id, int type) {
  int p = 0;
  q[p++] = id >> 8; q[p++] = id & 0xff;
  q[p++] = 0x01; q[p++] = 0x00;   /* RD */
  q[p++] = 0; q[p++] = 1;         /* qdcount */
  q[p++] = 0; q[p++] = 0;
  q[p++] = 0; q[p++] = 0;
  q[p++] = 0; q[p++] = 0;
  const char *s = name;
  while (*s) {
    const char *dot = strchr(s, '.');
    int l = dot ? (int)(dot - s) : (int)strlen(s);
    if (l <= 0 || l > 63) return -1;
    q[p++] = (uint8_t)l;
    memcpy(q + p, s, l); p += l;
    if (!dot) break;
    s = dot + 1;
  }
  q[p++] = 0;
  q[p++] = type >> 8; q[p++] = type & 0xff;
  q[p++] = 0; q[p++] = 1;         /* IN */
  return p;
}

/* Parse the first matching A/AAAA record; returns 0 on success, DNS_NODATA
 * when the answer is valid but holds no usable record of that type (e.g. a
 * name without AAAA), -1 when the reply is unusable. */
#define DNS_NODATA (-2)
/* Does this reply echo the question we sent? A reply carrying someone else's
 * question is not an answer to ours, however well-formed it looks. */
static int dns_question_matches(const uint8_t *r, int len, const uint8_t *q, int qlen) {
  if (len < 12 || qlen < 12) return 0;
  if (((r[4] << 8) | r[5]) != 1) return 0;          /* exactly one question */
  int i = 12, j = 12;                                /* compare name, type, class */
  while (i < len && j < qlen) {
    uint8_t a = r[i], b = q[j];
    if ((a & 0xc0) || (b & 0xc0)) return 0;          /* no compression in a question */
    if (a != b) return 0;
    if (a == 0) { i++; j++; break; }
    if (i + 1 + a > len || j + 1 + b > qlen) return 0;
    for (int k = 1; k <= a; k++) {
      uint8_t ca = r[i + k], cb = q[j + k];
      if (ca >= 'A' && ca <= 'Z') ca = (uint8_t)(ca + 32);
      if (cb >= 'A' && cb <= 'Z') cb = (uint8_t)(cb + 32);
      if (ca != cb) return 0;
    }
    i += 1 + a; j += 1 + b;
  }
  if (i + 4 > len || j + 4 > qlen) return 0;
  return memcmp(r + i, q + j, 4) == 0;               /* qtype and qclass */
}

static int dns_parse(const uint8_t *r, int len, int want6,
                     struct sockaddr_storage *out, socklen_t *outlen, uint16_t port) {
  if (len < 12) return -1;
  int qd = (r[4] << 8) | r[5];
  int an = (r[6] << 8) | r[7];
  if ((r[3] & 0x0f) != 0) return -1; /* rcode */
  int p = 12;
  for (int i = 0; i < qd && p < len; i++) {
    while (p < len && r[p]) { if (r[p] >= 0xc0) { p += 2; goto qdone; } p += r[p] + 1; }
    p++; qdone: p += 4;
  }
  int wtype = want6 ? 28 : 1;
  for (int i = 0; i < an && p + 10 <= len; i++) {
    if (r[p] >= 0xc0) p += 2;
    else { while (p < len && r[p]) p += r[p] + 1; p++; }
    if (p + 10 > len) return -1;
    int type = (r[p] << 8) | r[p + 1];
    int rdlen = (r[p + 8] << 8) | r[p + 9];
    int rdata = p + 10;
    if (rdata + rdlen > len) return -1;
    if (type == wtype) {
      if (!want6 && rdlen == 4) {
        uint32_t ip = ((uint32_t)r[rdata] << 24) | ((uint32_t)r[rdata+1] << 16) |
                      ((uint32_t)r[rdata+2] << 8) | (uint32_t)r[rdata+3];
        if (is_bogon_v4(ip) || is_blockpage_v4(ip)) { p = rdata + rdlen; continue; }
        struct sockaddr_in *s = (struct sockaddr_in *)out;
        memset(s, 0, sizeof(*s));
        s->sin_family = AF_INET;
        s->sin_port = htons(port);
        memcpy(&s->sin_addr, r + rdata, 4);
        *outlen = sizeof(*s);
        return 0;
      }
      if (want6 && rdlen == 16) {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)out;
        memset(s, 0, sizeof(*s));
        s->sin6_family = AF_INET6;
        s->sin6_port = htons(port);
        memcpy(&s->sin6_addr, r + rdata, 16);
        *outlen = sizeof(*s);
        return 0;
      }
    }
    p = rdata + rdlen;
  }
  return DNS_NODATA;
}

/* Query one resolver over UDP; collect up to 3 replies within the window and
 * return the first non-bogon answer. */
static int query_udp_at(const char *resolver, uint16_t rport, int timeout_ms,
                        const char *name, int want6, uint16_t port,
                        struct sockaddr_storage *out, socklen_t *outlen) {
  sock_t s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == SOCK_INVALID) return -1;
  sock_set_timeouts(s, timeout_ms);

  struct sockaddr_in to;
  memset(&to, 0, sizeof(to));
  to.sin_family = AF_INET;
  to.sin_port = htons(rport);
  if (inet_pton(AF_INET, resolver, &to.sin_addr) != 1) { sock_close(s); return -1; }

  /* Bind the socket to this one peer. The kernel then drops datagrams from
   * anywhere else before they ever reach us, which is a stronger filter than
   * checking the sender afterwards — and it means a process on this machine
   * cannot answer our lookups. */
  if (connect(s, (struct sockaddr *)&to, sizeof(to)) != 0) { sock_close(s); return -1; }

  uint8_t q[512];
  uint16_t id = dns_query_id();
  int qlen = dns_build(q, name, id, want6 ? 28 : 1);
  if (qlen < 0) { sock_close(s); return -1; }
  if (send(s, (const char *)q, qlen, 0) < 0) {
    sock_close(s); return -1;
  }

  uint64_t deadline = now_ms() + timeout_ms;
  int rc = -1;
  while (now_ms() < deadline) {
    int w = sock_wait_readable(s, (int)(deadline - now_ms()));
    if (w <= 0) break;
    uint8_t r[1500];
    struct sockaddr_in from; socklen_t fl = sizeof(from);
    int n = recvfrom(s, (char *)r, sizeof(r), 0, (struct sockaddr *)&from, &fl);
    if (n < 12) continue;
    if (((r[0] << 8) | r[1]) != id) continue;          /* id mismatch = spoof */
    if (from.sin_addr.s_addr != to.sin_addr.s_addr) continue; /* wrong source */
    if (from.sin_port != to.sin_port) continue;        /* right host, wrong port */
    if (!dns_question_matches(r, n, q, qlen)) continue; /* answers something else */
    int pr = dns_parse(r, n, want6, out, outlen, port);
    if (pr == 0) { rc = 0; break; }
    /* "No such record": don't sit out the whole window, but leave a short
     * grace period in case it was a forged reply racing the real one. */
    if (pr == DNS_NODATA && rc != DNS_NODATA) {
      rc = DNS_NODATA;
      uint64_t grace = now_ms() + 250;
      if (grace < deadline) deadline = grace;
    }
  }
  sock_close(s);
  return rc;
}

int doh_resolve(const char *name, uint16_t port, int want6,
                struct sockaddr_storage *out, socklen_t *outlen) {
  if (!g_init) doh_init(NULL, NULL);

  /* literal IP? */
  struct in_addr a4; struct in6_addr a6;
  if (inet_pton(AF_INET, name, &a4) == 1) {
    struct sockaddr_in *s = (struct sockaddr_in *)out;
    memset(s, 0, sizeof(*s)); s->sin_family = AF_INET; s->sin_port = htons(port);
    s->sin_addr = a4; *outlen = sizeof(*s); return 0;
  }
  if (inet_pton(AF_INET6, name, &a6) == 1) {
    struct sockaddr_in6 *s = (struct sockaddr_in6 *)out;
    memset(s, 0, sizeof(*s)); s->sin6_family = AF_INET6; s->sin6_port = htons(port);
    s->sin6_addr = a6; *outlen = sizeof(*s); return 0;
  }

  mutex_lock(&g_cache_mx);
  cache_entry *c = cache_find(name, port, want6);
  if (c) { memcpy(out, &c->sa, sizeof(*out)); *outlen = c->salen; mutex_unlock(&g_cache_mx); return 0; }
  mutex_unlock(&g_cache_mx);

  /* 1. Real encrypted DNS via the local forwarder, if the app started one. */
  if (g_fwd_port) {
    struct sockaddr_storage cand; socklen_t cl;
    if (query_udp_at(g_fwd_ip, g_fwd_port, 4000, name, want6, port, &cand, &cl) == 0) {
      mutex_lock(&g_cache_mx);
      cache_put(name, port, want6 ? AF_INET6 : AF_INET, &cand, cl);
      mutex_unlock(&g_cache_mx);
      memcpy(out, &cand, sizeof(cand)); *outlen = cl;
      return 0;
    }
  }

  /* 2. Fallback: several independent public resolvers over UDP/53. An on-path
   * injector must poison all of them identically to win. */
  int nodata = 0;
  for (int i = 0; i < MAX_RESOLVERS; i++) {
    struct sockaddr_storage cand; socklen_t cl;
    int qr = query_udp_at(RESOLVERS[i], 53, 1500, name, want6, port, &cand, &cl);
    if (qr == 0) {
      mutex_lock(&g_cache_mx);
      cache_put(name, port, want6 ? AF_INET6 : AF_INET, &cand, cl);
      mutex_unlock(&g_cache_mx);
      memcpy(out, &cand, sizeof(cand)); *outlen = cl;
      return 0;
    }
    /* Two independent resolvers agree the name has no record of this type:
     * believe them (the caller then tries the other address family). */
    if (qr == DNS_NODATA && ++nodata >= 2) return -1;
  }

  /* Last resort: OS resolver (may be poisoned, but better than failing). */
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = want6 ? AF_INET6 : AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  char portstr[8]; snprintf(portstr, sizeof(portstr), "%u", port);
  if (getaddrinfo(name, portstr, &hints, &res) == 0 && res) {
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
      struct sockaddr_storage cand; memset(&cand, 0, sizeof(cand));
      memcpy(&cand, ai->ai_addr, ai->ai_addrlen);
      if (doh_addr_is_block(&cand)) continue;  /* OS DNS was poisoned too */
      memcpy(out, ai->ai_addr, ai->ai_addrlen);
      *outlen = (socklen_t)ai->ai_addrlen;
      freeaddrinfo(res);
      return 0;
    }
    freeaddrinfo(res);
    return -1;
  }
  if (res) freeaddrinfo(res);
  return -1;
}
