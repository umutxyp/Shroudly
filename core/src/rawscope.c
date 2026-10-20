/*
 * rawscope.c — see rawscope.h. Which destinations the Advanced-mode engine
 * leaves alone, which servers it recently desynced, which ones the decoy
 * hurts, and its counters.
 */
#include "rawscope.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

/* ───────────────────────── destination scope ───────────────────────── */
int rawscope_local4(const uint8_t a4[4]) {
  if (!a4) return 1;
  uint8_t a = a4[0], b = a4[1];
  if (a == 0)   return 1;                          /* 0/8 "this network" */
  if (a == 10)  return 1;                          /* 10/8 private */
  if (a == 100 && (b & 0xc0) == 64) return 1;      /* 100.64/10 CGNAT */
  if (a == 127) return 1;                          /* 127/8 loopback */
  if (a == 169 && b == 254) return 1;              /* 169.254/16 link-local */
  if (a == 172 && (b & 0xf0) == 16) return 1;      /* 172.16/12 private */
  if (a == 192 && b == 168) return 1;              /* 192.168/16 private */
  if (a >= 224) return 1;                          /* 224/4 multicast, 240/4 reserved + broadcast */
  return 0;
}

int rawscope_local6(const uint8_t a6[16]) {
  if (!a6) return 1;
  static const uint8_t zero[16];
  static const uint8_t mapped[12] = { 0,0,0,0, 0,0,0,0, 0,0,0xff,0xff };
  if (!memcmp(a6, zero, 15) && a6[15] <= 1) return 1;     /* :: and ::1 */
  if (!memcmp(a6, mapped, 12)) return rawscope_local4(a6 + 12); /* ::ffff:a.b.c.d */
  if ((a6[0] & 0xfe) == 0xfc) return 1;                     /* fc00::/7 unique local */
  if (a6[0] == 0xfe && (a6[1] & 0xc0) == 0x80) return 1;    /* fe80::/10 link-local */
  if (a6[0] == 0xff) return 1;                              /* ff00::/8 multicast */
  return 0;
}

/* ───────────────────────── address tables ───────────────────────── */
/* IPv4 is kept as its IPv4-mapped IPv6 form, so one table holds both. */
typedef struct { uint8_t a[16]; uint64_t t; int used; } addr_ent;

static int addr_key(const uint8_t *addr, int alen, uint8_t key[16]) {
  if (!addr) return 0;
  if (alen == 16) { memcpy(key, addr, 16); return 1; }
  if (alen != 4) return 0;
  memset(key, 0, 10);
  key[10] = 0xff; key[11] = 0xff;
  memcpy(key + 12, addr, 4);
  return 1;
}

/* Add or refresh; a full table reuses its oldest entry. */
static void tab_put(addr_ent *tab, int cap, const uint8_t key[16], uint64_t now_ms) {
  int free_slot = -1, oldest = -1;
  for (int i = 0; i < cap; i++) {
    if (!tab[i].used) { if (free_slot < 0) free_slot = i; continue; }
    if (!memcmp(tab[i].a, key, 16)) { tab[i].t = now_ms; return; } /* refresh */
    if (oldest < 0 || tab[i].t < tab[oldest].t) oldest = i;
  }
  int slot = free_slot >= 0 ? free_slot : oldest;
  memcpy(tab[slot].a, key, 16);
  tab[slot].t = now_ms;
  tab[slot].used = 1;
}

/* The live entry for key, or NULL. An entry older than ttl is removed. */
static addr_ent *tab_get(addr_ent *tab, int cap, const uint8_t key[16], uint64_t now_ms, uint64_t ttl) {
  for (int i = 0; i < cap; i++) {
    if (!tab[i].used || memcmp(tab[i].a, key, 16)) continue;
    if (now_ms - tab[i].t > ttl) { tab[i].used = 0; return NULL; }
    return &tab[i];
  }
  return NULL;
}

/* ───────────────────────── recently desynced ───────────────────────── */
static addr_ent g_touch[RAWSCOPE_TOUCH_CAP];

void rawscope_touch_reset(void) { memset(g_touch, 0, sizeof(g_touch)); }

void rawscope_touch(const uint8_t *addr, int alen, uint64_t now_ms) {
  uint8_t key[16];
  if (addr_key(addr, alen, key)) tab_put(g_touch, RAWSCOPE_TOUCH_CAP, key, now_ms);
}

int rawscope_touched(const uint8_t *addr, int alen, uint64_t now_ms) {
  uint8_t key[16];
  if (!addr_key(addr, alen, key)) return 0;
  return tab_get(g_touch, RAWSCOPE_TOUCH_CAP, key, now_ms, RAWSCOPE_TOUCH_TTL_MS) != NULL;
}

int rawscope_touched_within(const uint8_t *addr, int alen, uint64_t now_ms, uint64_t ms) {
  uint8_t key[16];
  if (!addr_key(addr, alen, key)) return 0;
  addr_ent *e = tab_get(g_touch, RAWSCOPE_TOUCH_CAP, key, now_ms, RAWSCOPE_TOUCH_TTL_MS);
  return e && e->t <= now_ms && now_ms - e->t <= ms;
}

/* ───────────────────────── no decoy ───────────────────────── */
static addr_ent g_nodecoy[RAWSCOPE_NODECOY_CAP];

/* First segments that carried a decoy, by flow, while a sign of harm can
 * still be pinned on them. */
typedef struct {
  uint8_t a[16]; uint16_t rport, lport; uint32_t next_seq; uint64_t t; int used;
} flow_ent;
static flow_ent g_flows[RAWSCOPE_FLOW_CAP];

void rawscope_nodecoy_reset(void) {
  memset(g_nodecoy, 0, sizeof(g_nodecoy));
  memset(g_flows, 0, sizeof(g_flows));
}

void rawscope_nodecoy_add(const uint8_t *addr, int alen, uint64_t now_ms) {
  uint8_t key[16];
  if (addr_key(addr, alen, key)) tab_put(g_nodecoy, RAWSCOPE_NODECOY_CAP, key, now_ms);
}

int rawscope_nodecoy(const uint8_t *addr, int alen, uint64_t now_ms) {
  uint8_t key[16];
  if (!addr_key(addr, alen, key)) return 0;
  return tab_get(g_nodecoy, RAWSCOPE_NODECOY_CAP, key, now_ms, RAWSCOPE_NODECOY_TTL_MS) != NULL;
}

static int rec_len(const uint8_t *p) { return (p[3] << 8) | p[4]; }

int rawscope_tls_skip(const uint8_t *p, int len) {
  /* A whole ChangeCipherSpec record with something after it. */
  if (p && len > 6 && p[0] == 0x14 && p[1] == 0x03 && p[2] <= 0x04 &&
      p[3] == 0x00 && p[4] == 0x01 && p[5] == 0x01) return 6;
  return 0;
}

int rawscope_tls_kind(const uint8_t *p, int len) {
  if (!p || len < 5) return RAWSCOPE_TLS_OTHER;
  int k = rawscope_tls_skip(p, len);
  p += k; len -= k;
  if (len < 5 || p[1] != 0x03) return RAWSCOPE_TLS_OTHER;
  int rl = rec_len(p);
  /* Fatal only (level 2): a warning, such as unrecognized_name before a
   * ServerHello, is followed by a handshake that goes on normally. */
  if (p[0] == 0x15 && p[2] <= 0x04 && rl == 2 && len >= 5 + 2 && p[5] == 0x02) return RAWSCOPE_TLS_ALERT;
  if (p[0] == 0x17 && p[2] == 0x03 && rl == 19 && len >= 5 + 19) return RAWSCOPE_TLS_ENC_ALERT;
  return RAWSCOPE_TLS_OTHER;
}

uint32_t rawscope_tls_next_seq(uint32_t seq, const uint8_t *p, int plen) {
  if (plen <= 0 || !p) return seq;
  if (plen >= 5 && p[0] == 0x16 && p[1] == 0x03) return seq + 5u + (uint32_t)rec_len(p);
  return seq + (uint32_t)plen;
}

static flow_ent *flow_find(const uint8_t key[16], uint16_t rport, uint16_t lport, uint64_t now_ms) {
  for (int i = 0; i < RAWSCOPE_FLOW_CAP; i++) {
    flow_ent *f = &g_flows[i];
    if (!f->used || f->rport != rport || f->lport != lport || memcmp(f->a, key, 16)) continue;
    if (now_ms - f->t > RAWSCOPE_HURT_WINDOW_MS) { f->used = 0; return NULL; }
    return f;
  }
  return NULL;
}

void rawscope_decoy_sent(const uint8_t *raddr, int alen, uint16_t rport, uint16_t lport,
                         uint32_t next_seq, uint64_t now_ms) {
  uint8_t key[16];
  if (!addr_key(raddr, alen, key)) return;
  int slot = -1, oldest = -1;
  for (int i = 0; i < RAWSCOPE_FLOW_CAP; i++) {
    flow_ent *f = &g_flows[i];
    if (!f->used) { if (slot < 0) slot = i; continue; }
    if (f->rport == rport && f->lport == lport && !memcmp(f->a, key, 16)) { slot = i; oldest = -1; break; }
    if (oldest < 0 || f->t < g_flows[oldest].t) oldest = i;
  }
  if (slot < 0) slot = oldest;
  flow_ent *f = &g_flows[slot];
  memcpy(f->a, key, 16);
  f->rport = rport; f->lport = lport; f->next_seq = next_seq; f->t = now_ms; f->used = 1;
}

/* The flow carried a decoy and the server was desynced within the window:
 * mark the server, count it, forget the flow. */
static int hurt(const uint8_t *raddr, int alen, flow_ent *f, uint64_t now_ms) {
  if (!rawscope_touched_within(raddr, alen, now_ms, RAWSCOPE_HURT_WINDOW_MS)) return 0;
  f->used = 0;
  rawscope_nodecoy_add(raddr, alen, now_ms);
  rawscope_count(RAWSCOPE_DECOY_HURT);
  return 1;
}

int rawscope_decoy_hurt_out(const uint8_t *raddr, int alen, uint16_t rport, uint16_t lport,
                            uint32_t seq, const uint8_t *p, int plen, uint64_t now_ms) {
  uint8_t key[16];
  if (!p || plen <= 0 || !addr_key(raddr, alen, key)) return 0;
  flow_ent *f = flow_find(key, rport, lport, now_ms);
  if (!f) return 0;
  /* The ClientHello went on in another handshake record (a proxy cutting
   * it into records, or a large one): what counts as "right after it"
   * moves past that record too. */
  if (seq == f->next_seq && plen >= 5 && p[0] == 0x16 && p[1] == 0x03) {
    f->next_seq = rawscope_tls_next_seq(seq, p, plen);
    return 0;
  }
  int kind = rawscope_tls_kind(p, plen);
  if (kind == RAWSCOPE_TLS_OTHER) return 0;
  if (kind == RAWSCOPE_TLS_ENC_ALERT) {
    /* Right after the ClientHello: at next_seq, or 6 bytes on when a
     * ChangeCipherSpec went out in a segment of its own. */
    uint32_t at = seq + (uint32_t)rawscope_tls_skip(p, plen) - f->next_seq;
    if (at != 0 && at != 6) return 0;
  }
  return hurt(raddr, alen, f, now_ms);
}

int rawscope_decoy_hurt_in(const uint8_t *raddr, int alen, uint16_t rport, uint16_t lport,
                           const uint8_t *p, int plen, uint64_t now_ms) {
  if (rawscope_tls_kind(p, plen) != RAWSCOPE_TLS_ALERT) return 0;
  uint8_t key[16];
  if (!addr_key(raddr, alen, key)) return 0;
  flow_ent *f = flow_find(key, rport, lport, now_ms);
  return f ? hurt(raddr, alen, f, now_ms) : 0;
}

/* ───────────────────────── counters ───────────────────────── */
static atomic_ulong g_counters[RAWSCOPE_NCOUNTERS];

void rawscope_count(int which) {
  if (which >= 0 && which < RAWSCOPE_NCOUNTERS) atomic_fetch_add(&g_counters[which], 1ul);
}

unsigned long rawscope_counter(int which) {
  if (which < 0 || which >= RAWSCOPE_NCOUNTERS) return 0;
  return atomic_load(&g_counters[which]);
}

void rawscope_counters_reset(void) {
  for (int i = 0; i < RAWSCOPE_NCOUNTERS; i++) atomic_store(&g_counters[i], 0ul);
}

int rawscope_stats_json(char *buf, size_t cap) {
  if (!buf || cap == 0) return 0;
  int n = snprintf(buf, cap,
    "{\"type\":\"raw_stats\",\"desynced\":%lu,\"skipped\":%lu,\"rst_dropped\":%lu,\"rst_passed\":%lu,"
    "\"nodecoy\":%lu,\"decoy_hurt\":%lu}",
    rawscope_counter(RAWSCOPE_DESYNCED), rawscope_counter(RAWSCOPE_SKIPPED),
    rawscope_counter(RAWSCOPE_RST_DROPPED), rawscope_counter(RAWSCOPE_RST_PASSED),
    rawscope_counter(RAWSCOPE_NODECOY), rawscope_counter(RAWSCOPE_DECOY_HURT));
  if (n < 0 || (size_t)n >= cap) { buf[0] = 0; return 0; }
  return n;
}

void rawscope_stats_print(void) {
  char line[256];
  if (rawscope_stats_json(line, sizeof line) > 0) {
    printf("%s\n", line);
    fflush(stdout);
  }
}
