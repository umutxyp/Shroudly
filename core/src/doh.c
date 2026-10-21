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
 *
 * A forwarder that has not answered within FWD_WAIT_MS is asked once more and
 * still listened to while the fallback runs, and its answer is taken first:
 * on a network that forges plaintext answers the fallback has nothing to give
 * for a filtered name.
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

/* One cached answer: every usable address the name has (up to DOH_MAX_ADDRS,
 * in the order DNS gave them), kept for as long as its TTL says. Addresses are
 * stored bare rather than as sockaddr_storage, which would make the table five
 * times larger for no gain; the port is filled in when an answer is handed out,
 * so one entry serves every port of the name. */
#define TTL_MIN_S 20     /* a lower TTL would mean a lookup on nearly every connection */
#define TTL_MAX_S 300    /* a higher one would keep an address the site has moved away from */
#define PLAIN_DEAD_MS 60000  /* public resolvers that never answered: skipped this long */
#define FWD_WAIT_MS   4000   /* the forwarder's answer, before anything else is asked */
#define FWD_LATE_MS   8000   /* still taken this long after the question, when nothing else answers */

typedef struct {
  char     name[256];
  int      family;
  uint8_t  addr[DOH_MAX_ADDRS][16];
  int      naddr;
  uint64_t expires;
  int      used;
} cache_entry;

static cache_entry g_cache[CACHE_SIZE];
static mutex_t     g_cache_mx;
static int         g_init = 0;
static uint64_t    g_plain_dead_until = 0;   /* under g_cache_mx */

void doh_init(const char *doh_host, const char *doh_ip) {
  (void)doh_host; (void)doh_ip;
  if (!g_init) { mutex_init(&g_cache_mx); g_init = 1; }
}

void doh_clear_cache(void) {
  if (!g_init) return;
  mutex_lock(&g_cache_mx);
  memset(g_cache, 0, sizeof(g_cache));
  g_plain_dead_until = 0;   /* a new network: its resolvers are asked again */
  mutex_unlock(&g_cache_mx);
}

static uint32_t ttl_clamp(uint32_t ttl) {
  if (ttl < TTL_MIN_S) return TTL_MIN_S;
  if (ttl > TTL_MAX_S) return TTL_MAX_S;
  return ttl;
}

static int addr_len(int family) { return family == AF_INET6 ? 16 : 4; }

/* Build the sockaddr for a stored address. */
static socklen_t addr_out(int family, const uint8_t *a, uint16_t port, struct sockaddr_storage *out) {
  memset(out, 0, sizeof(*out));
  if (family == AF_INET6) {
    struct sockaddr_in6 *s = (struct sockaddr_in6 *)out;
    s->sin6_family = AF_INET6; s->sin6_port = htons(port);
    memcpy(&s->sin6_addr, a, 16);
    return (socklen_t)sizeof(*s);
  }
  struct sockaddr_in *s = (struct sockaddr_in *)out;
  s->sin_family = AF_INET; s->sin_port = htons(port);
  memcpy(&s->sin_addr, a, 4);
  return (socklen_t)sizeof(*s);
}

/* Caller holds g_cache_mx. */
static cache_entry *cache_find(const char *name, int family) {
  uint64_t t = now_ms();
  for (int i = 0; i < CACHE_SIZE; i++) {
    cache_entry *e = &g_cache[i];
    if (e->used && e->naddr > 0 && e->expires > t && e->family == family &&
        strcmp(e->name, name) == 0)
      return e;
  }
  return NULL;
}

/* Caller holds g_cache_mx. */
static void cache_put(const char *name, int family, uint8_t (*addrs)[16], int n, uint32_t ttl) {
  if (n <= 0) return;
  if (n > DOH_MAX_ADDRS) n = DOH_MAX_ADDRS;
  uint64_t t = now_ms();
  int slot = -1, victim = 0;
  uint64_t oldest = (uint64_t)-1;
  /* The name's own entry first, so a fresh answer replaces the old one
   * instead of sitting next to it; else a free or expired slot; else the
   * entry closest to expiring. */
  for (int i = 0; i < CACHE_SIZE; i++)
    if (g_cache[i].used && g_cache[i].family == family && strcmp(g_cache[i].name, name) == 0) { slot = i; break; }
  for (int i = 0; i < CACHE_SIZE && slot < 0; i++) {
    if (!g_cache[i].used || g_cache[i].expires <= t) { slot = i; break; }
    if (g_cache[i].expires < oldest) { oldest = g_cache[i].expires; victim = i; }
  }
  if (slot < 0) slot = victim;
  cache_entry *e = &g_cache[slot];
  memset(e, 0, sizeof(*e));
  strncpy(e->name, name, sizeof(e->name) - 1);
  e->family = family;
  memcpy(e->addr, addrs, (size_t)n * 16);
  e->naddr = n;
  e->expires = t + (uint64_t)ttl_clamp(ttl) * 1000;
  e->used = 1;
}

/* An address of this name could not be connected to. Take it out of the
 * cached answer, so the next connection starts with one that may work instead
 * of waiting out the same timeout again; once none are left the name is looked
 * up afresh. */
void doh_forget(const char *name, const struct sockaddr_storage *sa) {
  if (!g_init || !name || !sa) return;
  int family = sa->ss_family;
  const uint8_t *a;
  if (family == AF_INET) a = (const uint8_t *)&((const struct sockaddr_in *)sa)->sin_addr;
  else if (family == AF_INET6) a = (const uint8_t *)&((const struct sockaddr_in6 *)sa)->sin6_addr;
  else return;
  mutex_lock(&g_cache_mx);
  cache_entry *e = cache_find(name, family);
  if (e) {
    for (int i = 0; i < e->naddr; i++) {
      if (memcmp(e->addr[i], a, (size_t)addr_len(family)) != 0) continue;
      memmove(e->addr[i], e->addr[i + 1], (size_t)(e->naddr - i - 1) * 16);
      e->naddr--;
      break;
    }
    if (e->naddr <= 0) e->used = 0;
  }
  mutex_unlock(&g_cache_mx);
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

/* The private and shared ranges a LAN, an intranet or a carrier hands out:
 * 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10. Bogons too (a censor
 * answers with them), but a real answer for a name only the local network
 * knows. */
static int is_private_v4(uint32_t ip /*host order*/) {
  uint8_t a = (ip >> 24) & 0xff, b = (ip >> 16) & 0xff;
  return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) ||
         (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127);
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

/* A known block page: the built-in one and every address the app passed with
 * --block-ip. Only these. 0.0.0.0 and 127.0.0.0/8 are left out on purpose:
 * they are what a hosts-file ad blocker, Pi-hole, AdGuard Home or NextDNS in
 * null-IP mode, a malware sinkhole or a developer's own override answer with,
 * and those are the user's decisions, not a censor's. Narrower than the bogon
 * set for the same reason — 192.168.1.1 is a real destination when a client
 * asks for it directly. */
int doh_ipv4_is_blockpage(uint32_t ip /*host order*/) {
  return is_blockpage_v4(ip);
}

/* True if a resolved address is a censorship answer (block page or bogon). */
int doh_addr_is_block(const struct sockaddr_storage *sa) {
  if (sa->ss_family != AF_INET) return 0;
  uint32_t ip = ntohl(((const struct sockaddr_in *)sa)->sin_addr.s_addr);
  return is_bogon_v4(ip) || is_blockpage_v4(ip);
}

/* Is an address the system resolver gave refused? Every bogon and block
 * page, as doh_addr_is_block(); with trusted (a name doh_local_name() calls
 * local, and only such a name) only a block page and what no connection can
 * use: 0.0.0.0/8, loopback, multicast and reserved. A public name answered
 * only with a private address is refused: that is a censor's answer, or a
 * page pointing a public name at the LAN (DNS rebinding). */
static int sys_answer_refused(const struct sockaddr_storage *sa, int trusted) {
  if (!trusted) return doh_addr_is_block(sa);
  if (sa->ss_family != AF_INET) return 0;
  uint32_t ip = ntohl(((const struct sockaddr_in *)sa)->sin_addr.s_addr);
  return is_blockpage_v4(ip) || (is_bogon_v4(ip) && !is_private_v4(ip));
}

/* Optional local DoH forwarder (127.0.0.1:port), tried before public UDP. */
static char     g_fwd_ip[64] = "";
static uint16_t g_fwd_port = 0;
void doh_set_local(const char *ip, int port) {
  if (!ip || port <= 0 || port > 65535) { g_fwd_ip[0] = 0; g_fwd_port = 0; return; }
  strncpy(g_fwd_ip, ip, sizeof(g_fwd_ip) - 1); g_fwd_ip[sizeof(g_fwd_ip) - 1] = 0;
  g_fwd_port = (uint16_t)port;
}

int doh_local_addr(struct sockaddr_in *out) {
  if (!g_fwd_port) return -1;
  memset(out, 0, sizeof(*out));
  out->sin_family = AF_INET;
  out->sin_port = htons(g_fwd_port);
  return inet_pton(AF_INET, g_fwd_ip, &out->sin_addr) == 1 ? 0 : -1;
}

int doh_local_name(const char *h) {
  static const char *const SUFFIX[] = {
    ".localhost", ".local", ".test", ".invalid", ".internal", ".lan", ".home.arpa", NULL
  };
  if (!h || !h[0]) return 0;
  size_t n = strlen(h);
  if (h[n - 1] == '.') n--;                /* "router.", "nas.lan.": the same names */
  if (n == 0) return 0;
  if (!memchr(h, '.', n)) return 1;        /* "localhost", "router", ... */
  for (int i = 0; SUFFIX[i]; i++) {
    size_t m = strlen(SUFFIX[i]), k = 0;
    if (n < m) continue;
    for (; k < m; k++) {
      char c = h[n - m + k];
      if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
      if (c != SUFFIX[i][k]) break;
    }
    if (k == m) return 1;
  }
  return 0;
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

/* dns_parse: 0 with at least one usable address, DNS_NODATA when the answer
 * is valid but holds no usable record of that type (e.g. a name without
 * AAAA), DNS_NXDOMAIN when the name does not exist, -1 when the reply is
 * unusable. */
#define DNS_NODATA   (-2)
#define DNS_NXDOMAIN (-3)
/* As DNS_NODATA, but what was left out was a private address (is_private_v4):
 * the name is published with one. */
#define DNS_PRIVATE  (-4)
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

/* Skip a (possibly compressed) name; returns the offset after it, or -1. */
static int dns_skip_name(const uint8_t *r, int len, int p) {
  while (p < len) {
    uint8_t l = r[p];
    if (l == 0) return p + 1;
    if ((l & 0xc0) == 0xc0) return p + 2 <= len ? p + 2 : -1;   /* a pointer ends the name */
    if (l & 0xc0) return -1;                                     /* reserved label types */
    p += 1 + l;
  }
  return -1;
}

/* Every usable A (or AAAA) record of the answer, in the order given, up to
 * `max`, and the smallest TTL among them. A name usually has several
 * addresses, and the first one being down or unreachable from here is common
 * enough (a CDN node, an IPv6 route that is not there) that dialling only the
 * first would fail sites that work. Records pointing at a bogon or a known
 * block page are left out, since that is how DNS censorship answers. */
static int dns_parse(const uint8_t *r, int len, int want6,
                     uint8_t (*addrs)[16], int max, int *naddr, uint32_t *min_ttl) {
  *naddr = 0;
  if (min_ttl) *min_ttl = 0;
  if (len < 12) return -1;
  int qd = (r[4] << 8) | r[5];
  int an = (r[6] << 8) | r[7];
  /* NXDOMAIN is an answer, not a broken reply: treated as unusable, every
   * lookup of a name that does not exist sat out each resolver's whole
   * timeout, so a mistyped or dead host took tens of seconds to fail. Any other
   * error code is a resolver problem: ask the next. */
  if ((r[3] & 0x0f) == 3) return DNS_NXDOMAIN;
  if ((r[3] & 0x0f) != 0) return -1;
  int p = 12;
  for (int i = 0; i < qd; i++) {
    p = dns_skip_name(r, len, p);
    if (p < 0 || p + 4 > len) return -1;
    p += 4;
  }
  int wtype = want6 ? 28 : 1;
  uint32_t ttl_lo = 0xffffffffu;
  int damaged = 0, private = 0;
  for (int i = 0; i < an && *naddr < max; i++) {
    p = dns_skip_name(r, len, p);
    /* A damaged record ends the walk; what was read before it stands. */
    if (p < 0 || p + 10 > len) { damaged = 1; break; }
    int type = (r[p] << 8) | r[p + 1];
    uint32_t ttl = ((uint32_t)r[p + 4] << 24) | ((uint32_t)r[p + 5] << 16) |
                   ((uint32_t)r[p + 6] << 8) | (uint32_t)r[p + 7];
    int rdlen = (r[p + 8] << 8) | r[p + 9];
    int rdata = p + 10;
    if (rdata + rdlen > len) { damaged = 1; break; }
    p = rdata + rdlen;
    if (type != wtype) continue;
    if (!want6 && rdlen == 4) {
      uint32_t ip = ((uint32_t)r[rdata] << 24) | ((uint32_t)r[rdata+1] << 16) |
                    ((uint32_t)r[rdata+2] << 8) | (uint32_t)r[rdata+3];
      if (is_bogon_v4(ip) || is_blockpage_v4(ip)) {
        if (is_private_v4(ip) && !is_blockpage_v4(ip)) private = 1;
        continue;
      }
    } else if (!(want6 && rdlen == 16)) {
      continue;
    }
    int dup = 0;
    for (int k = 0; k < *naddr; k++) if (memcmp(addrs[k], r + rdata, (size_t)rdlen) == 0) dup = 1;
    if (dup) continue;
    memset(addrs[*naddr], 0, 16);
    memcpy(addrs[*naddr], r + rdata, (size_t)rdlen);
    (*naddr)++;
    if (ttl < ttl_lo) ttl_lo = ttl;
  }
  if (*naddr == 0) return damaged ? -1 : private ? DNS_PRIVATE : DNS_NODATA;
  if (min_ttl) *min_ttl = ttl_lo;
  return 0;
}

/* One question to one resolver over UDP: asked once (udp_ask_open), its
 * replies read for as long as the caller chooses (udp_ask_wait, which may be
 * called again later on the same question), then let go (udp_ask_close). */
typedef struct {
  sock_t             s;
  struct sockaddr_in to;
  uint8_t            q[512];
  int                qlen;
  uint16_t           id;
  int                want6;
} udp_ask;

static void udp_ask_close(udp_ask *a) {
  if (a->s != SOCK_INVALID) { sock_close(a->s); a->s = SOCK_INVALID; }
}

static int udp_ask_open(udp_ask *a, const char *resolver, uint16_t rport, const char *name, int want6) {
  memset(a, 0, sizeof(*a));
  a->s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (a->s == SOCK_INVALID) return -1;
  a->want6 = want6;
  a->to.sin_family = AF_INET;
  a->to.sin_port = htons(rport);
  if (inet_pton(AF_INET, resolver, &a->to.sin_addr) != 1) { udp_ask_close(a); return -1; }

  /* Bind the socket to this one peer. The kernel then drops datagrams from
   * anywhere else before they ever reach us, which is a stronger filter than
   * checking the sender afterwards — and it means a process on this machine
   * cannot answer our lookups. */
  if (connect(a->s, (struct sockaddr *)&a->to, sizeof(a->to)) != 0) { udp_ask_close(a); return -1; }

  a->id = dns_query_id();
  a->qlen = dns_build(a->q, name, a->id, want6 ? 28 : 1);
  if (a->qlen < 0) { udp_ask_close(a); return -1; }
  if (send(a->s, (const char *)a->q, a->qlen, 0) < 0) { udp_ask_close(a); return -1; }
  /* Replies are read only once the socket says one is there, and a read
   * must never block past that (a datagram dropped for a bad checksum after
   * the socket said so). */
  sock_set_nonblock(a->s, 1);
  return 0;
}

/* The same question once more, on the same socket and with the same id: an
 * answer to either is taken. */
static void udp_ask_again(udp_ask *a) {
  if (a->s != SOCK_INVALID) send(a->s, (const char *)a->q, a->qlen, 0);
}

/* Read the replies for up to timeout_ms; the first one with a usable
 * (non-bogon) address wins. Returns as dns_parse does, and -1 when nothing
 * usable came (yet): the question stays open for another wait. */
static int udp_ask_wait(udp_ask *a, int timeout_ms, uint8_t (*addrs)[16], int *naddr, uint32_t *ttl) {
  if (a->s == SOCK_INVALID) return -1;
  uint64_t deadline = now_ms() + (uint64_t)(timeout_ms > 0 ? timeout_ms : 0);
  int rc = -1;
  for (;;) {
    /* One reading of the clock for both: read twice, the second could be past
     * the deadline the first was not, and the difference would wrap. A wait
     * of 0 still takes what has already arrived. */
    uint64_t t = now_ms();
    int left = t >= deadline ? 0 : (int)(deadline - t);
    int w = sock_wait_readable(a->s, left);
    if (w <= 0) break;
    uint8_t r[1500];
    struct sockaddr_in from; socklen_t fl = sizeof(from);
    int n = recvfrom(a->s, (char *)r, sizeof(r), 0, (struct sockaddr *)&from, &fl);
    if (n < 12) { if (left == 0) break; continue; }
    if (((r[0] << 8) | r[1]) != a->id) { if (left == 0) break; continue; }          /* id mismatch = spoof */
    if (from.sin_addr.s_addr != a->to.sin_addr.s_addr) { if (left == 0) break; continue; } /* wrong source */
    if (from.sin_port != a->to.sin_port) { if (left == 0) break; continue; }        /* right host, wrong port */
    if (!dns_question_matches(r, n, a->q, a->qlen)) { if (left == 0) break; continue; } /* answers something else */
    int pr = dns_parse(r, n, a->want6, addrs, DOH_MAX_ADDRS, naddr, ttl);
    if (pr == 0) { rc = 0; break; }
    /* "No such record" (or name): don't sit out the whole window, but leave a
     * short grace period in case it was a forged reply racing the real one.
     * Longer for "no such name", the answer an injector would forge to make a
     * site vanish. */
    if ((pr == DNS_NODATA || pr == DNS_NXDOMAIN || pr == DNS_PRIVATE) && rc == -1) {
      rc = pr;
      uint64_t grace = now_ms() + (pr == DNS_NXDOMAIN ? 600 : 250);
      if (grace < deadline) deadline = grace;
    }
    if (left == 0) break;
  }
  return rc;
}

/* Query one resolver over UDP; collect replies within the window and return
 * the first one that carries a usable (non-bogon) address. */
static int query_udp_at(const char *resolver, uint16_t rport, int timeout_ms,
                        const char *name, int want6,
                        uint8_t (*addrs)[16], int *naddr, uint32_t *ttl) {
  udp_ask a;
  if (udp_ask_open(&a, resolver, rport, name, want6) != 0) return -1;
  int rc = udp_ask_wait(&a, timeout_ms, addrs, naddr, ttl);
  udp_ask_close(&a);
  return rc;
}

/* Hand out up to `max` cached addresses with the port filled in. Caller holds
 * g_cache_mx. */
static int cache_copy(const cache_entry *e, uint16_t port, struct sockaddr_storage *out,
                      socklen_t *outlen, int max) {
  int n = e->naddr < max ? e->naddr : max;
  for (int i = 0; i < n; i++) outlen[i] = addr_out(e->family, e->addr[i], port, &out[i]);
  return n;
}

static int answer(const char *name, uint16_t port, int family, uint8_t (*addrs)[16], int n,
                  uint32_t ttl, struct sockaddr_storage *out, socklen_t *outlen, int max) {
  mutex_lock(&g_cache_mx);
  cache_put(name, family, addrs, n, ttl);
  mutex_unlock(&g_cache_mx);
  if (n > max) n = max;
  for (int i = 0; i < n; i++) outlen[i] = addr_out(family, addrs[i], port, &out[i]);
  return n;
}

/* The forwarder's answer to a question it did not answer in time, if it has
 * come within wait_ms: 1 with addresses (the encrypted answer, taken over
 * any other), 2 when it says the name has no usable address of this family
 * (believed, as at first), 0 for nothing yet. The question is let go once
 * the forwarder has answered at all. */
static int fwd_late(udp_ask *fwd, int wait_ms, uint8_t (*addrs)[16], int *n, uint32_t *ttl) {
  if (fwd->s == SOCK_INVALID) return 0;
  int r = udp_ask_wait(fwd, wait_ms, addrs, n, ttl);
  if (r == -1) return 0;
  udp_ask_close(fwd);
  if (r == 0) return 1;
  if (r == DNS_NODATA || r == DNS_PRIVATE) return 2;
  return 0;   /* no such name: what follows may still know it */
}

/* Everything after the forwarder: the public resolvers over UDP/53, then the
 * system's. fwd: the forwarder's question while it is still open; its late
 * answer is looked for before each of them, and taken first. */
static int resolve_fallback(const char *name, uint16_t port, int want6, int trusted, udp_ask *fwd,
                            struct sockaddr_storage *out, socklen_t *outlen, int max) {
  int family = want6 ? AF_INET6 : AF_INET;
  uint8_t addrs[DOH_MAX_ADDRS][16];
  int n = 0;
  uint32_t ttl = 0;
  int lr;

  /* 2. Fallback: several independent public resolvers over UDP/53. An on-path
   * injector must poison all of them identically to win. Where none of them
   * answers at all (a network that only lets its own DNS through), they are
   * skipped for a minute: otherwise every new name waits for all five to
   * time out before the system's resolver is asked. Not for a trusted name:
   * they have nothing to add. */
  int nodata = 0, nxdomain = 0, silent = 0;
  mutex_lock(&g_cache_mx);
  int plain_dead = trusted || now_ms() < g_plain_dead_until;
  mutex_unlock(&g_cache_mx);
  for (int i = 0; i < MAX_RESOLVERS && !plain_dead; i++) {
    if ((lr = fwd_late(fwd, 0, addrs, &n, &ttl)) == 1) return answer(name, port, family, addrs, n, ttl, out, outlen, max);
    if (lr == 2) return -1;
    uint64_t t0 = now_ms();
    int qr = query_udp_at(RESOLVERS[i], 53, 1500, name, want6, addrs, &n, &ttl);
    if (qr == -1 && now_ms() - t0 >= 1400) silent++;
    if (qr == 0) return answer(name, port, family, addrs, n, ttl, out, outlen, max);
    /* Two independent resolvers agree the name has no record of this type:
     * believe them (the caller then tries the other address family). */
    if ((qr == DNS_NODATA || qr == DNS_PRIVATE) && ++nodata >= 2) return -1;
    /* Two agree the name does not exist at all: the other public resolvers
     * will not know better, but the system's may — a hosts-file entry, an
     * intranet name — so that one still gets asked. */
    if (qr == DNS_NXDOMAIN && ++nxdomain >= 2) break;
  }
  if (!plain_dead && silent == MAX_RESOLVERS) {
    mutex_lock(&g_cache_mx);
    g_plain_dead_until = now_ms() + PLAIN_DEAD_MS;
    mutex_unlock(&g_cache_mx);
  }
  if ((lr = fwd_late(fwd, 0, addrs, &n, &ttl)) == 1) return answer(name, port, family, addrs, n, ttl, out, outlen, max);
  if (lr == 2) return -1;

  /* Last resort: OS resolver (may be poisoned, but better than failing). It
   * gives no TTL and it is the answer we trust least, so it is kept only for
   * the shortest time (TTL_MIN_S): enough that a page's many connections do
   * not each ask again. Its bogons are refused, unless the name is a local
   * one (doh_local_name); a known block page always is. */
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = family;
  hints.ai_socktype = SOCK_STREAM;
  char portstr[8]; snprintf(portstr, sizeof(portstr), "%u", port);
  if (getaddrinfo(name, portstr, &hints, &res) != 0 || !res) { if (res) freeaddrinfo(res); return -1; }
  int got = 0, keep = 0;
  uint8_t kept[DOH_MAX_ADDRS][16];
  for (struct addrinfo *ai = res; ai && got < max; ai = ai->ai_next) {
    if ((size_t)ai->ai_addrlen > sizeof(struct sockaddr_storage)) continue;
    struct sockaddr_storage cand; memset(&cand, 0, sizeof(cand));
    memcpy(&cand, ai->ai_addr, ai->ai_addrlen);
    if (sys_answer_refused(&cand, trusted)) continue;  /* OS DNS was poisoned too */
    memcpy(&out[got], &cand, sizeof(cand));
    outlen[got] = (socklen_t)ai->ai_addrlen;
    got++;
    if (keep < DOH_MAX_ADDRS && cand.ss_family == family) {
      memset(kept[keep], 0, 16);
      if (family == AF_INET) memcpy(kept[keep], &((struct sockaddr_in *)&cand)->sin_addr, 4);
      else memcpy(kept[keep], &((struct sockaddr_in6 *)&cand)->sin6_addr, 16);
      keep++;
    }
  }
  freeaddrinfo(res);
  if (keep > 0) {
    mutex_lock(&g_cache_mx);
    cache_put(name, family, kept, keep, TTL_MIN_S);
    mutex_unlock(&g_cache_mx);
  }
  return got > 0 ? got : -1;
}

int doh_resolve_all(const char *name, uint16_t port, int want6,
                    struct sockaddr_storage *out, socklen_t *outlen, int max) {
  if (!g_init) doh_init(NULL, NULL);
  if (!name || max <= 0) return -1;
  int family = want6 ? AF_INET6 : AF_INET;

  /* literal IP? */
  struct in_addr a4; struct in6_addr a6;
  if (inet_pton(AF_INET, name, &a4) == 1) {
    outlen[0] = addr_out(AF_INET, (const uint8_t *)&a4, port, &out[0]); return 1;
  }
  if (inet_pton(AF_INET6, name, &a6) == 1) {
    outlen[0] = addr_out(AF_INET6, (const uint8_t *)&a6, port, &out[0]); return 1;
  }

  mutex_lock(&g_cache_mx);
  cache_entry *c = cache_find(name, family);
  if (c) { int n = cache_copy(c, port, out, outlen, max); mutex_unlock(&g_cache_mx); return n; }
  mutex_unlock(&g_cache_mx);

  uint8_t addrs[DOH_MAX_ADDRS][16];
  int n = 0;
  uint32_t ttl = 0;
  /* The system resolver's private answer is believed: only for a local name. */
  int trusted = 0;

  /* 0. A name only the local network knows ("nas.lan", "router"): the public
   * resolvers would only see it and say it does not exist. */
  if (doh_local_name(name)) trusted = 1;

  /* 1. Real encrypted DNS via the local forwarder, if the app started one. */
  udp_ask fwd;
  fwd.s = SOCK_INVALID;
  uint64_t asked = 0;
  if (g_fwd_port && !trusted && udp_ask_open(&fwd, g_fwd_ip, g_fwd_port, name, want6) == 0) {
    asked = now_ms();
    int fr = udp_ask_wait(&fwd, FWD_WAIT_MS, addrs, &n, &ttl);
    if (fr == 0) { udp_ask_close(&fwd); return answer(name, port, family, addrs, n, ttl, out, outlen, max); }
    /* It says the name has no address of this family. That is an answer, not
     * a failure, and one nobody on the path could forge: asking the plaintext
     * resolvers below as well would only show the name to whoever watches the
     * network, and wait seconds where they are blocked. The dialler asks for
     * the other family whenever a connect is slow, so this is common.
     * Or it says the name is published with only a private address. Its
     * owner may mean that, but so may an attacker who points a public name
     * at the LAN (DNS rebinding), and a private address is also what a censor
     * answers with: refused, as the plaintext resolvers' would be. */
    if (fr == DNS_NODATA || fr == DNS_PRIVATE) { udp_ask_close(&fwd); return -1; }
    if (fr == -1) {
      /* No answer in time. The forwarder goes on looking, and may only now
       * be getting its routes back (a network that has just returned, its
       * connections gone with the old one): ask once more, so a fresh try
       * runs while the fallback below is asked, and keep listening for an
       * answer to either (see fwd_late). On a network that forges plaintext
       * answers the fallback has nothing to give for a filtered name, and
       * that name failed although encrypted DNS answered a moment later. */
      udp_ask_again(&fwd);
    } else {
      /* "No such name" (DNS_NXDOMAIN) falls through: a hosts-file entry may
       * still know it, but the system resolver's private answer is taken only
       * for a name doh_local_name() calls local, never for a public-looking
       * one, whatever encrypted DNS said about it. */
      udp_ask_close(&fwd);
    }
  }

  int got = resolve_fallback(name, port, want6, trusted, &fwd, out, outlen, max);
  /* Nothing usable from the fallback either: the forwarder's answer, if it
   * comes before FWD_LATE_MS from the first question. */
  if (got <= 0 && fwd.s != SOCK_INVALID) {
    uint64_t t = now_ms();
    int left = t - asked < FWD_LATE_MS ? (int)(FWD_LATE_MS - (t - asked)) : 0;
    if (fwd_late(&fwd, left, addrs, &n, &ttl) == 1) got = answer(name, port, family, addrs, n, ttl, out, outlen, max);
  }
  udp_ask_close(&fwd);
  return got;
}

int doh_resolve(const char *name, uint16_t port, int want6,
                struct sockaddr_storage *out, socklen_t *outlen) {
  return doh_resolve_all(name, port, want6, out, outlen, 1) > 0 ? 0 : -1;
}
