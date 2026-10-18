/*
 * test_rawscope — what the Advanced-mode engine may touch (core/src/rawscope.c).
 * Pure, no sockets: runs everywhere and under ASan.
 *
 * Covers: every edge of the local / private / special IPv4 ranges and the
 * public addresses right beside them (the documentation ranges included, which
 * are not local), the IPv6 ranges and IPv4-mapped addresses, the
 * recently-desynced table (a reset from a server never desynced passes, expiry,
 * refresh, a full table reusing its oldest entry, IPv4 and IPv6 kept apart)
 * and the raw_stats line.
 */
#include "../src/rawscope.h"
#include <stdio.h>
#include <string.h>
#include <stdint.h>

static int fails = 0, checks = 0;
#define CHECK(c) do{ checks++; if(!(c)){printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c);fails++;} }while(0)

static int l4(int a, int b, int c, int d) {
  uint8_t x[4] = { (uint8_t)a, (uint8_t)b, (uint8_t)c, (uint8_t)d };
  return rawscope_local4(x);
}

/* Parse a small IPv6 text form ("fe80::1", "::ffff:10.0.0.1") into 16 bytes. */
static void p6(const char *s, uint8_t out[16]) {
  uint16_t head[8], tail[8]; int nh = 0, nt = 0, gap = 0;
  uint8_t v4[4]; int has4 = 0;
  memset(out, 0, 16);
  const char *p = s;
  if (p[0] == ':' && p[1] == ':') { gap = 1; p += 2; }
  while (*p) {
    const char *q = p; int dots = 0;
    while (*q && *q != ':') { if (*q == '.') dots++; q++; }
    if (dots == 3) {
      unsigned a, b, c, d; sscanf(p, "%u.%u.%u.%u", &a, &b, &c, &d);
      v4[0]=(uint8_t)a; v4[1]=(uint8_t)b; v4[2]=(uint8_t)c; v4[3]=(uint8_t)d; has4 = 1;
      break;
    }
    unsigned v = 0; sscanf(p, "%x", &v);
    if (gap) tail[nt++] = (uint16_t)v; else head[nh++] = (uint16_t)v;
    p = q;
    if (*p == ':') { p++; if (*p == ':') { gap = 1; p++; } }
  }
  int words = 8 - (has4 ? 2 : 0);
  for (int i = 0; i < nh; i++) { out[2*i] = (uint8_t)(head[i] >> 8); out[2*i+1] = (uint8_t)head[i]; }
  for (int i = 0; i < nt; i++) {
    int w = words - nt + i;
    out[2*w] = (uint8_t)(tail[i] >> 8); out[2*w+1] = (uint8_t)tail[i];
  }
  if (has4) memcpy(out + 12, v4, 4);
}
static int l6(const char *s) { uint8_t a[16]; p6(s, a); return rawscope_local6(a); }

static void test_scope4(void) {
  /* 0/8 */
  CHECK(l4(0,0,0,0) == 1);       CHECK(l4(0,255,255,255) == 1);  CHECK(l4(1,0,0,0) == 0);
  /* 10/8 */
  CHECK(l4(9,255,255,255) == 0); CHECK(l4(10,0,0,0) == 1);
  CHECK(l4(10,255,255,255) == 1); CHECK(l4(11,0,0,0) == 0);
  /* 100.64/10 */
  CHECK(l4(100,63,255,255) == 0); CHECK(l4(100,64,0,0) == 1);
  CHECK(l4(100,127,255,255) == 1); CHECK(l4(100,128,0,0) == 0);
  /* 127/8 */
  CHECK(l4(126,255,255,255) == 0); CHECK(l4(127,0,0,1) == 1);
  CHECK(l4(127,255,255,255) == 1); CHECK(l4(128,0,0,0) == 0);
  /* 169.254/16 */
  CHECK(l4(169,253,255,255) == 0); CHECK(l4(169,254,0,0) == 1);
  CHECK(l4(169,254,169,254) == 1); CHECK(l4(169,254,255,255) == 1); CHECK(l4(169,255,0,0) == 0);
  /* 172.16/12 */
  CHECK(l4(172,15,255,255) == 0); CHECK(l4(172,16,0,0) == 1);
  CHECK(l4(172,31,255,255) == 1); CHECK(l4(172,32,0,0) == 0);
  /* 192.168/16 */
  CHECK(l4(192,167,255,255) == 0); CHECK(l4(192,168,0,0) == 1);
  CHECK(l4(192,168,1,1) == 1);     CHECK(l4(192,168,255,255) == 1); CHECK(l4(192,169,0,0) == 0);
  /* 224/4 multicast and 240/4 reserved, up to the broadcast address */
  CHECK(l4(223,255,255,255) == 0); CHECK(l4(224,0,0,0) == 1); CHECK(l4(224,0,0,251) == 1);
  CHECK(l4(239,255,255,255) == 1); CHECK(l4(240,0,0,0) == 1); CHECK(l4(255,255,255,255) == 1);
  /* The documentation (TEST-NET) ranges are not local. */
  CHECK(l4(192,0,2,1) == 0); CHECK(l4(198,51,100,2) == 0); CHECK(l4(203,0,113,9) == 0);
  /* Ordinary public addresses. */
  CHECK(l4(1,1,1,1) == 0); CHECK(l4(8,8,8,8) == 0); CHECK(l4(162,159,128,233) == 0);
  CHECK(l4(192,0,0,1) == 0); CHECK(l4(198,18,0,1) == 0); CHECK(l4(172,217,0,1) == 0);
  CHECK(rawscope_local4(NULL) == 1);   /* no address: leave it alone */
}

static void test_scope6(void) {
  CHECK(l6("::") == 1);  CHECK(l6("::1") == 1);  CHECK(l6("::2") == 0);
  /* fc00::/7 */
  CHECK(l6("fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff") == 0);
  CHECK(l6("fc00::") == 1); CHECK(l6("fd12:3456::1") == 1);
  CHECK(l6("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff") == 1); CHECK(l6("fe00::") == 0);
  /* fe80::/10 */
  CHECK(l6("fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff") == 0);
  CHECK(l6("fe80::") == 1); CHECK(l6("fe80::1") == 1);
  CHECK(l6("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff") == 1); CHECK(l6("fec0::") == 0);
  /* ff00::/8 */
  CHECK(l6("feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff") == 0);
  CHECK(l6("ff00::") == 1); CHECK(l6("ff02::1") == 1);
  CHECK(l6("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff") == 1);
  /* IPv4-mapped: by the IPv4 rule. */
  CHECK(l6("::ffff:10.0.0.1") == 1);   CHECK(l6("::ffff:192.168.1.1") == 1);
  CHECK(l6("::ffff:127.0.0.1") == 1);  CHECK(l6("::ffff:1.1.1.1") == 0);
  CHECK(l6("::ffff:198.51.100.2") == 0);
  /* Public and documentation addresses are not local. */
  CHECK(l6("2001:db8::1") == 0); CHECK(l6("2606:4700:4700::1111") == 0);
  CHECK(l6("2a00:1450:4001::1") == 0);
  CHECK(rawscope_local6(NULL) == 1);
}

static void test_touched(void) {
  uint8_t a[4] = { 198, 51, 100, 2 }, b[4] = { 203, 0, 113, 7 };
  uint8_t m6[16]; p6("::ffff:198.51.100.2", m6);
  uint8_t v6[16]; p6("2001:db8::7", v6);

  rawscope_touch_reset();
  /* Never desynced: a reset from it passes. */
  CHECK(rawscope_touched(a, 4, 1000) == 0);
  rawscope_touch(a, 4, 1000);
  CHECK(rawscope_touched(a, 4, 1000) == 1);
  CHECK(rawscope_touched(b, 4, 1000) == 0);
  /* Still there just before it expires, gone right after. */
  CHECK(rawscope_touched(a, 4, 1000 + RAWSCOPE_TOUCH_TTL_MS) == 1);
  CHECK(rawscope_touched(a, 4, 1000 + RAWSCOPE_TOUCH_TTL_MS + 1) == 0);
  CHECK(rawscope_touched(a, 4, 1000) == 0);          /* expired entries are removed */

  /* Touching again refreshes the time. */
  rawscope_touch(a, 4, 5000);
  rawscope_touch(a, 4, 5000 + 100000);
  CHECK(rawscope_touched(a, 4, 5000 + RAWSCOPE_TOUCH_TTL_MS + 50000) == 1);

  /* An IPv4 address and its IPv4-mapped IPv6 form are the same server; a
   * different IPv6 address is not. Bad lengths never match. */
  CHECK(rawscope_touched(m6, 16, 5000 + 100000) == 1);
  CHECK(rawscope_touched(v6, 16, 5000 + 100000) == 0);
  rawscope_touch(v6, 16, 6000);
  CHECK(rawscope_touched(v6, 16, 6000) == 1);
  CHECK(rawscope_touched(a, 5, 6000) == 0);
  CHECK(rawscope_touched(NULL, 4, 6000) == 0);
  rawscope_touch(NULL, 4, 6000);                     /* ignored, no crash */

  /* Capacity: fill the table, then one more reuses the oldest entry only. */
  rawscope_touch_reset();
  for (int i = 0; i < RAWSCOPE_TOUCH_CAP; i++) {
    uint8_t x[4] = { 198, 51, (uint8_t)(i >> 8), (uint8_t)i };
    rawscope_touch(x, 4, 10000 + (uint64_t)i);
  }
  int all = 1;
  for (int i = 0; i < RAWSCOPE_TOUCH_CAP; i++) {
    uint8_t x[4] = { 198, 51, (uint8_t)(i >> 8), (uint8_t)i };
    if (!rawscope_touched(x, 4, 20000)) all = 0;
  }
  CHECK(all == 1);
  rawscope_touch(b, 4, 30000);
  uint8_t first[4] = { 198, 51, 0, 0 }, second[4] = { 198, 51, 0, 1 };
  uint8_t last[4] = { 198, 51, (uint8_t)((RAWSCOPE_TOUCH_CAP - 1) >> 8), (uint8_t)(RAWSCOPE_TOUCH_CAP - 1) };
  CHECK(rawscope_touched(b, 4, 30000) == 1);
  CHECK(rawscope_touched(first, 4, 30000) == 0);     /* the oldest went */
  CHECK(rawscope_touched(second, 4, 30000) == 1);
  CHECK(rawscope_touched(last, 4, 30000) == 1);

  /* Reset forgets everything. */
  rawscope_touch_reset();
  CHECK(rawscope_touched(b, 4, 30000) == 0);
}

static void test_stats(void) {
  char line[256];
  rawscope_counters_reset();
  CHECK(rawscope_stats_json(line, sizeof line) > 0);
  CHECK(strcmp(line, "{\"type\":\"raw_stats\",\"desynced\":0,\"skipped\":0,\"rst_dropped\":0,\"rst_passed\":0}") == 0);
  rawscope_count(RAWSCOPE_DESYNCED); rawscope_count(RAWSCOPE_DESYNCED);
  rawscope_count(RAWSCOPE_SKIPPED);
  for (int i = 0; i < 3; i++) rawscope_count(RAWSCOPE_RST_DROPPED);
  for (int i = 0; i < 4; i++) rawscope_count(RAWSCOPE_RST_PASSED);
  rawscope_count(-1); rawscope_count(RAWSCOPE_NCOUNTERS);   /* ignored */
  CHECK(rawscope_counter(RAWSCOPE_DESYNCED) == 2);
  CHECK(rawscope_counter(RAWSCOPE_NCOUNTERS) == 0);
  CHECK(rawscope_stats_json(line, sizeof line) > 0);
  CHECK(strcmp(line, "{\"type\":\"raw_stats\",\"desynced\":2,\"skipped\":1,\"rst_dropped\":3,\"rst_passed\":4}") == 0);
  CHECK(rawscope_stats_json(line, 10) == 0 && line[0] == 0);  /* too small: nothing */
  rawscope_counters_reset();
  CHECK(rawscope_counter(RAWSCOPE_SKIPPED) == 0);
}

int main(void) {
  test_scope4();
  test_scope6();
  test_touched();
  test_stats();
  if (fails) { printf("test_rawscope: %d of %d checks FAILED\n", fails, checks); return 1; }
  printf("test_rawscope: all %d checks passed\n", checks);
  return 0;
}
