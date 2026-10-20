/*
 * test_rawscope — what the Advanced-mode engine may touch (core/src/rawscope.c).
 * Pure, no sockets: runs everywhere and under ASan.
 *
 * Covers: every edge of the local / private / special IPv4 ranges and the
 * public addresses right beside them (the documentation ranges included, which
 * are not local), the IPv6 ranges and IPv4-mapped addresses, the
 * recently-desynced table (a reset from a server never desynced passes, expiry,
 * refresh, a full table reusing its oldest entry, IPv4 and IPv6 kept apart),
 * "desynced within", the no-decoy table and its expiry, the TLS record
 * classifier, the signs that a decoy hurt a handshake (and the ones that must
 * not count: a close_notify late in a healthy flow, another flow, too late),
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

static void test_touched_within(void) {
  uint8_t a[4] = { 198, 51, 100, 2 }, b[4] = { 203, 0, 113, 7 };
  uint8_t v6[16]; p6("2001:db8::7", v6);
  rawscope_touch_reset();
  CHECK(rawscope_touched_within(a, 4, 1000, 5000) == 0);       /* never desynced */
  rawscope_touch(a, 4, 1000);
  CHECK(rawscope_touched_within(a, 4, 1000, 5000) == 1);
  CHECK(rawscope_touched_within(a, 4, 6000, 5000) == 1);       /* the edge counts */
  CHECK(rawscope_touched_within(a, 4, 6001, 5000) == 0);
  CHECK(rawscope_touched(a, 4, 6001) == 1);                    /* still in the table */
  CHECK(rawscope_touched_within(a, 4, 6001, 0) == 0);
  CHECK(rawscope_touched_within(a, 4, 1000, 0) == 1);
  CHECK(rawscope_touched_within(b, 4, 1000, 5000) == 0);
  rawscope_touch(a, 4, 9000);                                  /* refreshed */
  CHECK(rawscope_touched_within(a, 4, 9500, 5000) == 1);
  /* Past the table's own lifetime it is gone, whatever window is asked. */
  CHECK(rawscope_touched_within(a, 4, 9000 + RAWSCOPE_TOUCH_TTL_MS + 1, (uint64_t)-1) == 0);
  rawscope_touch(v6, 16, 100);
  CHECK(rawscope_touched_within(v6, 16, 200, 5000) == 1);
  CHECK(rawscope_touched_within(v6, 4, 200, 5000) == 0);
  CHECK(rawscope_touched_within(NULL, 4, 200, 5000) == 0);
  CHECK(rawscope_touched_within(v6, 7, 200, 5000) == 0);
  rawscope_touch_reset();
}

static void test_nodecoy_table(void) {
  uint8_t a[4] = { 198, 51, 100, 2 }, b[4] = { 203, 0, 113, 7 };
  uint8_t m6[16]; p6("::ffff:198.51.100.2", m6);
  uint8_t v6[16]; p6("2001:db8::7", v6);
  rawscope_nodecoy_reset();
  CHECK(rawscope_nodecoy(a, 4, 1000) == 0);
  rawscope_nodecoy_add(a, 4, 1000);
  CHECK(rawscope_nodecoy(a, 4, 1000) == 1);
  CHECK(rawscope_nodecoy(m6, 16, 1000) == 1);                 /* same server */
  CHECK(rawscope_nodecoy(b, 4, 1000) == 0);
  CHECK(rawscope_nodecoy(v6, 16, 1000) == 0);
  /* Ten minutes, then the decoy is tried again. */
  CHECK(RAWSCOPE_NODECOY_TTL_MS == 600000);
  CHECK(rawscope_nodecoy(a, 4, 1000 + RAWSCOPE_NODECOY_TTL_MS) == 1);
  CHECK(rawscope_nodecoy(a, 4, 1000 + RAWSCOPE_NODECOY_TTL_MS + 1) == 0);
  CHECK(rawscope_nodecoy(a, 4, 1000) == 0);                   /* expired entries are removed */
  rawscope_nodecoy_add(v6, 16, 50);
  CHECK(rawscope_nodecoy(v6, 16, 60) == 1);
  rawscope_nodecoy_add(NULL, 4, 60);                           /* ignored */
  rawscope_nodecoy_add(a, 3, 60);                              /* ignored */
  CHECK(rawscope_nodecoy(a, 4, 60) == 0);
  CHECK(rawscope_nodecoy(a, 3, 60) == 0);

  /* A full table reuses its oldest entry only. */
  rawscope_nodecoy_reset();
  CHECK(RAWSCOPE_NODECOY_CAP == 256);
  for (int i = 0; i < RAWSCOPE_NODECOY_CAP; i++) {
    uint8_t x[4] = { 198, 18, (uint8_t)(i >> 8), (uint8_t)i };
    rawscope_nodecoy_add(x, 4, 10000 + (uint64_t)i);
  }
  int all = 1;
  for (int i = 0; i < RAWSCOPE_NODECOY_CAP; i++) {
    uint8_t x[4] = { 198, 18, (uint8_t)(i >> 8), (uint8_t)i };
    if (!rawscope_nodecoy(x, 4, 20000)) all = 0;
  }
  CHECK(all == 1);
  rawscope_nodecoy_add(b, 4, 30000);
  uint8_t first[4] = { 198, 18, 0, 0 }, second[4] = { 198, 18, 0, 1 };
  CHECK(rawscope_nodecoy(b, 4, 30000) == 1);
  CHECK(rawscope_nodecoy(first, 4, 30000) == 0);
  CHECK(rawscope_nodecoy(second, 4, 30000) == 1);
  rawscope_nodecoy_reset();
  CHECK(rawscope_nodecoy(b, 4, 30000) == 0);
}

static void test_tls_kind(void) {
  /* Plaintext alerts: 15 03 0X 00 02 <level> <desc>. */
  const uint8_t al12[] = { 0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28 };   /* handshake_failure */
  const uint8_t al10[] = { 0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46 };
  const uint8_t al13v[] = { 0x15, 0x03, 0x04, 0x00, 0x02, 0x02, 0x28 };
  const uint8_t al30[] = { 0x15, 0x03, 0x00, 0x00, 0x02, 0x02, 0x28 };
  const uint8_t alv5[] = { 0x15, 0x03, 0x05, 0x00, 0x02, 0x02, 0x28 };   /* no such version */
  const uint8_t alv2[] = { 0x15, 0x02, 0x03, 0x00, 0x02, 0x02, 0x28 };
  const uint8_t al_l3[] = { 0x15, 0x03, 0x03, 0x00, 0x03, 0x02, 0x28, 0x00 };
  const uint8_t al_l26[31] = { 0x15, 0x03, 0x03, 0x00, 26 };            /* a TLS 1.2 encrypted alert */
  CHECK(rawscope_tls_kind(al12, sizeof al12) == RAWSCOPE_TLS_ALERT);
  CHECK(rawscope_tls_kind(al10, sizeof al10) == RAWSCOPE_TLS_ALERT);
  CHECK(rawscope_tls_kind(al13v, sizeof al13v) == RAWSCOPE_TLS_ALERT);
  CHECK(rawscope_tls_kind(al30, sizeof al30) == RAWSCOPE_TLS_ALERT);
  CHECK(rawscope_tls_kind(alv5, sizeof alv5) == RAWSCOPE_TLS_OTHER);
  CHECK(rawscope_tls_kind(alv2, sizeof alv2) == RAWSCOPE_TLS_OTHER);
  CHECK(rawscope_tls_kind(al_l3, sizeof al_l3) == RAWSCOPE_TLS_OTHER);
  CHECK(rawscope_tls_kind(al_l26, sizeof al_l26) == RAWSCOPE_TLS_OTHER);
  /* Short buffers: the record must be whole. */
  for (int n = 0; n < 7; n++) CHECK(rawscope_tls_kind(al12, n) == RAWSCOPE_TLS_OTHER);
  CHECK(rawscope_tls_kind(NULL, 7) == RAWSCOPE_TLS_OTHER);
  CHECK(rawscope_tls_kind(al12, -1) == RAWSCOPE_TLS_OTHER);

  /* Application data: 19 bytes is an encrypted TLS 1.3 alert, a Finished is
   * 53 (SHA-256) or 69 (SHA-384), and 2 is nothing of the sort. */
  uint8_t ad[5 + 69] = { 0x17, 0x03, 0x03, 0x00, 19 };
  CHECK(rawscope_tls_kind(ad, 5 + 19) == RAWSCOPE_TLS_ENC_ALERT);
  CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_ENC_ALERT);      /* more after it */
  CHECK(rawscope_tls_kind(ad, 5 + 18) == RAWSCOPE_TLS_OTHER);            /* cut short */
  ad[4] = 53; CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER);
  ad[4] = 69; CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER);
  ad[4] = 2;  CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER);
  ad[4] = 18; CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER);
  ad[4] = 20; CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER);
  ad[3] = 0x01; ad[4] = 19; CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER); /* 275 */
  ad[3] = 0x00; ad[2] = 0x01; CHECK(rawscope_tls_kind(ad, sizeof ad) == RAWSCOPE_TLS_OTHER); /* not 1.3's 03 03 */
  ad[2] = 0x03;

  /* A ChangeCipherSpec in front is skipped; alone it is nothing. */
  uint8_t ccs_ad[6 + 24] = { 0x14, 0x03, 0x03, 0x00, 0x01, 0x01, 0x17, 0x03, 0x03, 0x00, 19 };
  CHECK(rawscope_tls_kind(ccs_ad, sizeof ccs_ad) == RAWSCOPE_TLS_ENC_ALERT);
  CHECK(rawscope_tls_skip(ccs_ad, sizeof ccs_ad) == 6);
  CHECK(rawscope_tls_skip(ad, sizeof ad) == 0);
  CHECK(rawscope_tls_kind(ccs_ad, 6) == RAWSCOPE_TLS_OTHER);
  CHECK(rawscope_tls_skip(ccs_ad, 6) == 0);
  uint8_t ccs_al[13] = { 0x14, 0x03, 0x03, 0x00, 0x01, 0x01, 0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x14 };
  CHECK(rawscope_tls_kind(ccs_al, sizeof ccs_al) == RAWSCOPE_TLS_ALERT);
  CHECK(rawscope_tls_kind(ccs_al, 12) == RAWSCOPE_TLS_OTHER);
  /* Two CCS records are not skipped twice. */
  uint8_t ccs2[12 + 7] = { 0x14,3,3,0,1,1, 0x14,3,3,0,1,1, 0x15,3,3,0,2,2,0x28 };
  CHECK(rawscope_tls_kind(ccs2, sizeof ccs2) == RAWSCOPE_TLS_OTHER);

  /* Not TLS at all. */
  const char *get = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
  CHECK(rawscope_tls_kind((const uint8_t *)get, (int)strlen(get)) == RAWSCOPE_TLS_OTHER);
  const uint8_t hello[] = { 0x16, 0x03, 0x01, 0x00, 0x02, 0x01, 0x00 };
  CHECK(rawscope_tls_kind(hello, sizeof hello) == RAWSCOPE_TLS_OTHER);
  uint8_t zeros[64] = { 0 };
  CHECK(rawscope_tls_kind(zeros, sizeof zeros) == RAWSCOPE_TLS_OTHER);

  /* Where the client's next record starts after a first segment. */
  const uint8_t ch[] = { 0x16, 0x03, 0x01, 0x06, 0x00, 0x01 };   /* a 1536-byte record */
  CHECK(rawscope_tls_next_seq(1000, ch, sizeof ch) == 1000u + 5u + 1536u);
  CHECK(rawscope_tls_next_seq(0xfffffff0u, ch, sizeof ch) == (uint32_t)(0xfffffff0u + 5u + 1536u));
  CHECK(rawscope_tls_next_seq(1000, ch, 4) == 1004);             /* no whole header */
  CHECK(rawscope_tls_next_seq(1000, (const uint8_t *)get, (int)strlen(get)) == 1000u + (uint32_t)strlen(get));
  CHECK(rawscope_tls_next_seq(1000, ch, 0) == 1000);
  CHECK(rawscope_tls_next_seq(1000, NULL, 10) == 1000);
}

static void test_decoy_hurt(void) {
  uint8_t srv[4] = { 198, 51, 100, 2 }, other[4] = { 203, 0, 113, 7 };
  const uint8_t al[] = { 0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28 };
  uint8_t enc[24] = { 0x17, 0x03, 0x03, 0x00, 19 };
  uint8_t ccs_enc[30] = { 0x14, 0x03, 0x03, 0x00, 0x01, 0x01, 0x17, 0x03, 0x03, 0x00, 19 };
  const uint32_t next = 5000 + 5 + 600;   /* after a 600-byte ClientHello record at seq 5000 */

  rawscope_touch_reset(); rawscope_nodecoy_reset(); rawscope_counters_reset();

  /* A server alert on a flow that never carried a decoy: nothing. */
  rawscope_touch(srv, 4, 1000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50000, al, sizeof al, 1100) == 0);
  CHECK(rawscope_nodecoy(srv, 4, 1100) == 0);

  /* The server answers a decoyed ClientHello with an alert: no decoy next time. */
  rawscope_decoy_sent(srv, 4, 443, 50000, next, 1000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50001, al, sizeof al, 1100) == 0);   /* another flow */
  CHECK(rawscope_decoy_hurt_in(other, 4, 443, 50000, al, sizeof al, 1100) == 0);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50000, enc, sizeof enc, 1100) == 0); /* not a plaintext alert */
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50000, al, 6, 1100) == 0);           /* cut short */
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50000, al, sizeof al, 1100) == 1);
  CHECK(rawscope_nodecoy(srv, 4, 1100) == 1);
  CHECK(rawscope_nodecoy(other, 4, 1100) == 0);
  CHECK(rawscope_counter(RAWSCOPE_DECOY_HURT) == 1);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50000, al, sizeof al, 1200) == 0);   /* once per flow */
  CHECK(rawscope_counter(RAWSCOPE_DECOY_HURT) == 1);

  /* Too late: more than five seconds after the decoy. */
  rawscope_nodecoy_reset();
  rawscope_touch(srv, 4, 10000);
  rawscope_decoy_sent(srv, 4, 443, 50002, next, 10000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50002, al, sizeof al, 10000 + RAWSCOPE_HURT_WINDOW_MS + 1) == 0);
  CHECK(rawscope_nodecoy(srv, 4, 15002) == 0);
  /* The flow is still young, but the server was last desynced too long ago
   * (a flow table entry alone is not enough). */
  rawscope_touch_reset();
  rawscope_decoy_sent(srv, 4, 443, 50003, next, 20000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50003, al, sizeof al, 20100) == 0);
  rawscope_touch(srv, 4, 20000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50003, al, sizeof al, 20100) == 1);

  /* The client's plaintext alert, anywhere in the young flow. */
  rawscope_nodecoy_reset(); rawscope_counters_reset();
  rawscope_touch(srv, 4, 30000);
  rawscope_decoy_sent(srv, 4, 443, 50010, next, 30000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50010, next + 400, al, sizeof al, 30050) == 1);
  CHECK(rawscope_nodecoy(srv, 4, 30050) == 1);

  /* The client's encrypted alert straight after the ClientHello: it counts;
   * at next_seq + 6 (a ChangeCipherSpec sent on its own before it) too; the
   * ChangeCipherSpec and the alert in one segment too. */
  rawscope_nodecoy_reset();
  rawscope_decoy_sent(srv, 4, 443, 50011, next, 30000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50011, next, enc, sizeof enc, 30100) == 1);
  rawscope_nodecoy_reset();
  rawscope_decoy_sent(srv, 4, 443, 50012, next, 30000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50012, next + 6, enc, sizeof enc, 30100) == 1);
  rawscope_nodecoy_reset();
  rawscope_decoy_sent(srv, 4, 443, 50013, next, 30000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50013, next, ccs_enc, sizeof ccs_enc, 30100) == 1);

  /* A close_notify at the end of a short, healthy connection is the same 19
   * bytes, but after the Finished and the request: it does not count. */
  rawscope_nodecoy_reset(); rawscope_counters_reset();
  rawscope_decoy_sent(srv, 4, 443, 50014, next, 30000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50014, next + 6 + 58 + 120, enc, sizeof enc, 30200) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50014, next + 3, enc, sizeof enc, 30200) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50014, next - 1, enc, sizeof enc, 30200) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50014, next + 6, ccs_enc, sizeof ccs_enc, 30200) == 0);
  CHECK(rawscope_nodecoy(srv, 4, 30200) == 0);
  CHECK(rawscope_counter(RAWSCOPE_DECOY_HURT) == 0);
  /* Ordinary data and a Finished on the flow: nothing. */
  uint8_t fin[58] = { 0x17, 0x03, 0x03, 0x00, 53 };
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50014, next, fin, sizeof fin, 30200) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50014, next, NULL, 0, 30200) == 0);
  /* Sequence numbers that wrap around 2^32. */
  rawscope_decoy_sent(srv, 4, 443, 50015, 0xfffffffeu, 30000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50015, 0xfffffff0u, enc, sizeof enc, 30300) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50015, 0xfffffffeu + 6u + 6u, enc, sizeof enc, 30300) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 50015, 0xfffffffeu + 6u, enc, sizeof enc, 30300) == 1); /* seq 4 */

  /* IPv6 flows are kept apart from IPv4 ones. */
  uint8_t v6[16]; p6("2001:db8::7", v6);
  rawscope_nodecoy_reset();
  rawscope_touch(v6, 16, 40000);
  rawscope_decoy_sent(v6, 16, 443, 50020, next, 40000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 50020, al, sizeof al, 40010) == 0);
  CHECK(rawscope_decoy_hurt_in(v6, 16, 443, 50020, al, sizeof al, 40010) == 1);
  CHECK(rawscope_nodecoy(v6, 16, 40010) == 1);
  CHECK(rawscope_nodecoy(srv, 4, 40010) == 0);
  rawscope_decoy_sent(NULL, 4, 443, 1, next, 40000);              /* ignored, no crash */
  rawscope_decoy_sent(srv, 2, 443, 1, next, 40000);

  /* The flow table is bounded: more flows than it holds push out the oldest,
   * and a newer one still counts. */
  rawscope_nodecoy_reset();
  rawscope_touch(srv, 4, 50000);
  for (int i = 0; i < RAWSCOPE_FLOW_CAP + 10; i++)
    rawscope_decoy_sent(srv, 4, 443, (uint16_t)(1000 + i), next, 50000 + (uint64_t)i / 100);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 1000, al, sizeof al, 50010) == 0);   /* pushed out */
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, (uint16_t)(1000 + RAWSCOPE_FLOW_CAP + 9), al, sizeof al, 50010) == 1);
  /* The same flow sent again replaces its entry instead of taking another. */
  rawscope_nodecoy_reset();
  rawscope_decoy_sent(srv, 4, 443, 60000, 100, 50000);
  rawscope_decoy_sent(srv, 4, 443, 60000, 900, 50001);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 60000, 100, enc, sizeof enc, 50002) == 0);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 60000, 900, enc, sizeof enc, 50002) == 1);

  rawscope_touch_reset(); rawscope_nodecoy_reset(); rawscope_counters_reset();
}

static void test_stats(void) {
  char line[512];
  rawscope_counters_reset();
  CHECK(rawscope_stats_json(line, sizeof line) > 0);
  CHECK(strcmp(line, "{\"type\":\"raw_stats\",\"desynced\":0,\"skipped\":0,\"rst_dropped\":0,\"rst_passed\":0,\"nodecoy\":0,\"decoy_hurt\":0,"
                     "\"udp_seen\":0,\"udp_decoys\":0,\"quic_dropped\":0}") == 0);
  rawscope_count(RAWSCOPE_DESYNCED); rawscope_count(RAWSCOPE_DESYNCED);
  rawscope_count(RAWSCOPE_SKIPPED);
  for (int i = 0; i < 3; i++) rawscope_count(RAWSCOPE_RST_DROPPED);
  for (int i = 0; i < 4; i++) rawscope_count(RAWSCOPE_RST_PASSED);
  for (int i = 0; i < 5; i++) rawscope_count(RAWSCOPE_NODECOY);
  for (int i = 0; i < 6; i++) rawscope_count(RAWSCOPE_DECOY_HURT);
  for (int i = 0; i < 7; i++) rawscope_count(RAWSCOPE_UDP_SEEN);
  for (int i = 0; i < 8; i++) rawscope_count(RAWSCOPE_UDP_DECOYS);
  for (int i = 0; i < 9; i++) rawscope_count(RAWSCOPE_QUIC_DROPPED);
  rawscope_count(-1); rawscope_count(RAWSCOPE_NCOUNTERS);   /* ignored */
  CHECK(rawscope_counter(RAWSCOPE_DESYNCED) == 2);
  CHECK(rawscope_counter(RAWSCOPE_NCOUNTERS) == 0);
  CHECK(rawscope_stats_json(line, sizeof line) > 0);
  CHECK(strcmp(line, "{\"type\":\"raw_stats\",\"desynced\":2,\"skipped\":1,\"rst_dropped\":3,\"rst_passed\":4,\"nodecoy\":5,\"decoy_hurt\":6,"
                     "\"udp_seen\":7,\"udp_decoys\":8,\"quic_dropped\":9}") == 0);
  /* The largest counters still fit the line rawscope_stats_print writes. */
  char big[512];
  for (int c = 0; c < RAWSCOPE_NCOUNTERS; c++) for (int i = 0; i < 3; i++) rawscope_count(c);
  CHECK(rawscope_stats_json(big, sizeof big) > 0 && strlen(big) + RAWSCOPE_NCOUNTERS * 19 < sizeof big);
  CHECK(rawscope_stats_json(line, 10) == 0 && line[0] == 0);  /* too small: nothing */
  rawscope_counters_reset();
  CHECK(rawscope_counter(RAWSCOPE_SKIPPED) == 0);
}

/* A warning alert is not harm; a ClientHello in two records moves the spot
 * where the client's encrypted alert is looked for. */
static void test_decoy_hurt_more(void) {
  uint8_t srv[4] = { 198, 51, 100, 9 };
  const uint8_t warn[] = { 0x15, 0x03, 0x03, 0x00, 0x02, 0x01, 0x70 };   /* warning unrecognized_name */
  uint8_t rec2[5 + 100] = { 0x16, 0x03, 0x01, 0x00, 100 };              /* the rest of the ClientHello */
  uint8_t enc[24] = { 0x17, 0x03, 0x03, 0x00, 19 };
  const uint32_t next = 7000 + 5 + 400;
  rawscope_touch_reset(); rawscope_nodecoy_reset(); rawscope_counters_reset();
  rawscope_touch(srv, 4, 1000);
  CHECK(rawscope_tls_kind(warn, sizeof warn) == RAWSCOPE_TLS_OTHER);
  rawscope_decoy_sent(srv, 4, 443, 51000, next, 1000);
  CHECK(rawscope_decoy_hurt_in(srv, 4, 443, 51000, warn, sizeof warn, 1100) == 0);
  CHECK(rawscope_nodecoy(srv, 4, 1100) == 0);
  rawscope_decoy_sent(srv, 4, 443, 51001, next, 1000);
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 51001, next, rec2, sizeof rec2, 1050) == 0);  /* followed */
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 51001, next, enc, sizeof enc, 1060) == 0);    /* old spot: no */
  CHECK(rawscope_decoy_hurt_out(srv, 4, 443, 51001, next + sizeof rec2, enc, sizeof enc, 1070) == 1);
  CHECK(rawscope_nodecoy(srv, 4, 1100) == 1);
}

int main(void) {
  test_scope4();
  test_scope6();
  test_touched();
  test_touched_within();
  test_nodecoy_table();
  test_tls_kind();
  test_decoy_hurt();
  test_decoy_hurt_more();
  test_stats();
  if (fails) { printf("test_rawscope: %d of %d checks FAILED\n", fails, checks); return 1; }
  printf("test_rawscope: all %d checks passed\n", checks);
  return 0;
}
