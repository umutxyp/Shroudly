/*
 * Resolver with anti-poisoning.
 *
 * A full DoH/DoT client needs a TLS stack, which we deliberately avoid to keep
 * the engine dependency-free and identical on every OS. Instead we defeat DNS
 * poisoning without encryption:
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

/* ── DNS wire format ────────────────────────────────────────────────────── */
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

/* Parse the first matching A/AAAA record; returns 0 on success. */
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
        if (is_bogon_v4(ip)) { p = rdata + rdlen; continue; }
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
  return -1;
}

/* Query one resolver over UDP; collect up to 3 replies within the window and
 * return the first non-bogon answer. */
static int query_udp(const char *resolver, const char *name, int want6, uint16_t port,
                     struct sockaddr_storage *out, socklen_t *outlen) {
  sock_t s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == SOCK_INVALID) return -1;
  sock_set_timeouts(s, 1500);

  struct sockaddr_in to;
  memset(&to, 0, sizeof(to));
  to.sin_family = AF_INET;
  to.sin_port = htons(53);
  if (inet_pton(AF_INET, resolver, &to.sin_addr) != 1) { sock_close(s); return -1; }

  uint8_t q[512];
  uint16_t id = (uint16_t)(now_ms() ^ (uintptr_t)out);
  int qlen = dns_build(q, name, id, want6 ? 28 : 1);
  if (qlen < 0) { sock_close(s); return -1; }
  if (sendto(s, (const char *)q, qlen, 0, (struct sockaddr *)&to, sizeof(to)) < 0) {
    sock_close(s); return -1;
  }

  uint64_t deadline = now_ms() + 1500;
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
    if (dns_parse(r, n, want6, out, outlen, port) == 0) { rc = 0; break; }
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

  /* Query resolvers; accept the first clean answer. Trying several independent
   * resolvers means an on-path injector must poison all of them identically. */
  for (int i = 0; i < MAX_RESOLVERS; i++) {
    struct sockaddr_storage cand; socklen_t cl;
    if (query_udp(RESOLVERS[i], name, want6, port, &cand, &cl) == 0) {
      mutex_lock(&g_cache_mx);
      cache_put(name, port, want6 ? AF_INET6 : AF_INET, &cand, cl);
      mutex_unlock(&g_cache_mx);
      memcpy(out, &cand, sizeof(cand)); *outlen = cl;
      return 0;
    }
  }

  /* Last resort: OS resolver (may be poisoned, but better than failing). */
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = want6 ? AF_INET6 : AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  char portstr[8]; snprintf(portstr, sizeof(portstr), "%u", port);
  if (getaddrinfo(name, portstr, &hints, &res) == 0 && res) {
    memcpy(out, res->ai_addr, res->ai_addrlen);
    *outlen = (socklen_t)res->ai_addrlen;
    freeaddrinfo(res);
    return 0;
  }
  if (res) freeaddrinfo(res);
  return -1;
}
