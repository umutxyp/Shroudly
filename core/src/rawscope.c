/*
 * rawscope.c — see rawscope.h. Which destinations the Advanced-mode engine
 * leaves alone, which servers it recently desynced, and its counters.
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

/* ───────────────────────── recently desynced ───────────────────────── */
/* IPv4 is kept as its IPv4-mapped IPv6 form, so one table holds both. */
typedef struct { uint8_t a[16]; uint64_t t; int used; } touch_ent;
static touch_ent g_touch[RAWSCOPE_TOUCH_CAP];

static int touch_key(const uint8_t *addr, int alen, uint8_t key[16]) {
  if (!addr) return 0;
  if (alen == 16) { memcpy(key, addr, 16); return 1; }
  if (alen != 4) return 0;
  memset(key, 0, 10);
  key[10] = 0xff; key[11] = 0xff;
  memcpy(key + 12, addr, 4);
  return 1;
}

void rawscope_touch_reset(void) { memset(g_touch, 0, sizeof(g_touch)); }

void rawscope_touch(const uint8_t *addr, int alen, uint64_t now_ms) {
  uint8_t key[16];
  if (!touch_key(addr, alen, key)) return;
  int free_slot = -1, oldest = -1;
  for (int i = 0; i < RAWSCOPE_TOUCH_CAP; i++) {
    if (!g_touch[i].used) { if (free_slot < 0) free_slot = i; continue; }
    if (!memcmp(g_touch[i].a, key, 16)) { g_touch[i].t = now_ms; return; } /* refresh */
    if (oldest < 0 || g_touch[i].t < g_touch[oldest].t) oldest = i;
  }
  int slot = free_slot >= 0 ? free_slot : oldest;   /* full: reuse the oldest */
  memcpy(g_touch[slot].a, key, 16);
  g_touch[slot].t = now_ms;
  g_touch[slot].used = 1;
}

int rawscope_touched(const uint8_t *addr, int alen, uint64_t now_ms) {
  uint8_t key[16];
  if (!touch_key(addr, alen, key)) return 0;
  for (int i = 0; i < RAWSCOPE_TOUCH_CAP; i++) {
    if (!g_touch[i].used || memcmp(g_touch[i].a, key, 16)) continue;
    if (now_ms - g_touch[i].t > RAWSCOPE_TOUCH_TTL_MS) { g_touch[i].used = 0; return 0; }
    return 1;
  }
  return 0;
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
    "{\"type\":\"raw_stats\",\"desynced\":%lu,\"skipped\":%lu,\"rst_dropped\":%lu,\"rst_passed\":%lu}",
    rawscope_counter(RAWSCOPE_DESYNCED), rawscope_counter(RAWSCOPE_SKIPPED),
    rawscope_counter(RAWSCOPE_RST_DROPPED), rawscope_counter(RAWSCOPE_RST_PASSED));
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
