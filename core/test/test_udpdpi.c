#include "../src/udpdpi.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(c) do { if(!(c)){ printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c); fails++; } } while(0)

/* Local, independent Internet-checksum verifier: for a correctly checksummed
 * span the one's-complement sum folds to all-ones, so the complement is 0. */
static uint16_t verify_csum(const uint8_t *d, int len, uint32_t init) {
  uint32_t sum = init;
  int i = 0;
  for (; i + 1 < len; i += 2) sum += (uint32_t)((d[i] << 8) | d[i + 1]);
  if (i < len) sum += (uint32_t)(d[i] << 8);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (uint16_t)~sum;
}

/* ── QUIC Initial ──────────────────────────────────────────────────────── */
static void test_quic(void) {
  /* v1: long header (0xc0 = long+fixed+Initial), version 0x00000001 */
  uint8_t v1[64] = { 0xc0, 0x00, 0x00, 0x00, 0x01, 0x08, 0, 0, 0, 0, 0, 0, 0, 0 };
  CHECK(quic_is_initial(v1, sizeof(v1)) == 1);

  /* MSB-set but not fixed bit still counts (task defines Initial by 0x80) */
  uint8_t v1b[16] = { 0x80, 0x00, 0x00, 0x00, 0x01 };
  CHECK(quic_is_initial(v1b, sizeof(v1b)) == 1);

  /* v2: 0x6b3343cf */
  uint8_t v2[32] = { 0xd0, 0x6b, 0x33, 0x43, 0xcf, 0x08 };
  CHECK(quic_is_initial(v2, sizeof(v2)) == 1);

  /* draft-29: 0xff00001d */
  uint8_t d29[32] = { 0xc3, 0xff, 0x00, 0x00, 0x1d };
  CHECK(quic_is_initial(d29, sizeof(d29)) == 1);
  /* draft-ff000022 */
  uint8_t d34[32] = { 0xc0, 0xff, 0x00, 0x00, 0x22 };
  CHECK(quic_is_initial(d34, sizeof(d34)) == 1);

  /* Version Negotiation: long header but version 0x00000000 -> reject */
  uint8_t vn[32] = { 0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02 };
  CHECK(quic_is_initial(vn, sizeof(vn)) == 0);

  /* short header (MSB clear) -> reject */
  uint8_t sh[32] = { 0x40, 0x00, 0x00, 0x00, 0x01 };
  CHECK(quic_is_initial(sh, sizeof(sh)) == 0);

  /* unknown / GREASE version -> reject */
  uint8_t gr[32] = { 0xc0, 0x0a, 0x1a, 0x2a, 0x3a };
  CHECK(quic_is_initial(gr, sizeof(gr)) == 0);
  uint8_t ff2[32] = { 0xc0, 0xff, 0x01, 0x00, 0x00 }; /* 0xff010000, not 0xff0000xx */
  CHECK(quic_is_initial(ff2, sizeof(ff2)) == 0);

  /* too short -> reject */
  uint8_t sshort[4] = { 0xc0, 0x00, 0x00, 0x00 };
  CHECK(quic_is_initial(sshort, 4) == 0);
  CHECK(quic_is_initial(v1, 0) == 0);

  /* ordinary UDP (DNS query) -> reject */
  uint8_t dns[] = { 0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x03, 'w','w','w', 0x00 };
  CHECK(quic_is_initial(dns, sizeof(dns)) == 0);
}

/* ── Discord IP-discovery ──────────────────────────────────────────────── */
static void test_discord(void) {
  uint8_t ok[74];
  memset(ok, 0xab, sizeof(ok));
  ok[0] = 0x00; ok[1] = 0x01; ok[2] = 0x00; ok[3] = 0x46;
  CHECK(discord_is_ip_discovery(ok, 74) == 1);
  CHECK(udp_is_discord_voice(ok, 74) == 1);

  /* wrong length */
  CHECK(discord_is_ip_discovery(ok, 73) == 0);
  CHECK(discord_is_ip_discovery(ok, 75) == 0);

  /* wrong length field */
  uint8_t badlen[74]; memcpy(badlen, ok, 74); badlen[3] = 0x45;
  CHECK(discord_is_ip_discovery(badlen, 74) == 0);

  /* wrong type (response 0x0002) */
  uint8_t resp[74]; memcpy(resp, ok, 74); resp[1] = 0x02;
  CHECK(discord_is_ip_discovery(resp, 74) == 0);
}

/* ── STUN Binding request ──────────────────────────────────────────────── */
static void test_stun(void) {
  /* 20-byte header, no attributes */
  uint8_t s[28];
  memset(s, 0, sizeof(s));
  s[0] = 0x00; s[1] = 0x01;                 /* Binding request */
  s[2] = 0x00; s[3] = 0x00;                 /* message length 0 */
  s[4] = 0x21; s[5] = 0x12; s[6] = 0xa4; s[7] = 0x42; /* magic cookie */
  CHECK(stun_is_binding_request(s, 20) == 1);
  CHECK(udp_is_discord_voice(s, 20) == 1);

  /* with an 8-byte attribute: message length 8, total 28 */
  s[3] = 0x08;
  CHECK(stun_is_binding_request(s, 28) == 1);
  CHECK(stun_is_binding_request(s, 24) == 0); /* declared length overflows */

  /* message length not a multiple of 4 */
  uint8_t s2[28]; memcpy(s2, s, 28); s2[3] = 0x06;
  CHECK(stun_is_binding_request(s2, 28) == 0);

  /* wrong magic cookie */
  uint8_t s3[20]; memset(s3, 0, 20); s3[1] = 0x01;
  s3[4] = 0x21; s3[5] = 0x12; s3[6] = 0xa4; s3[7] = 0x43;
  CHECK(stun_is_binding_request(s3, 20) == 0);

  /* Binding response/indication type, not a request */
  uint8_t s4[20]; memcpy(s4, s, 20); s4[3] = 0x00; s4[0] = 0x01; s4[1] = 0x01;
  CHECK(stun_is_binding_request(s4, 20) == 0);

  /* too short */
  CHECK(stun_is_binding_request(s, 19) == 0);

  /* near-misses: WireGuard handshake init, NTP, DNS */
  uint8_t wg[148]; memset(wg, 0, sizeof(wg));
  wg[0] = 0x01; wg[1] = 0x00; wg[2] = 0x00; wg[3] = 0x00; /* type 1, reserved */
  CHECK(stun_is_binding_request(wg, sizeof(wg)) == 0);
  CHECK(udp_is_discord_voice(wg, sizeof(wg)) == 0);

  uint8_t ntp[48]; memset(ntp, 0, sizeof(ntp)); ntp[0] = 0x1b;
  CHECK(udp_is_discord_voice(ntp, sizeof(ntp)) == 0);

  uint8_t dns[] = { 0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x03, 'w','w','w', 0x00, 0x00, 0x01, 0x00, 0x01 };
  CHECK(udp_is_discord_voice(dns, sizeof(dns)) == 0);
}

static void test_ports(void) {
  CHECK(discord_voice_port(50000) == 1);
  CHECK(discord_voice_port(65535) == 1);
  CHECK(discord_voice_port(49999) == 0);
  CHECK(discord_voice_port(3478) == 1);
  CHECK(discord_voice_port(3479) == 0);
  CHECK(discord_voice_port(19302) == 1);
  CHECK(discord_voice_port(19309) == 1);
  CHECK(discord_voice_port(19310) == 0);
  CHECK(discord_voice_port(443) == 0);
  CHECK(discord_voice_port(53) == 0);
}

/* ── Flow table ────────────────────────────────────────────────────────── */
static void test_flow(void) {
  udp_flow_table t;
  udp_flow_init(&t);
  uint32_t A = 0x0100007f, B = 0x0203a8c0; /* arbitrary network-order addrs */
  uint16_t sp = 0x1234, dp = 0x9876;

  /* first UDP_FLOW_FIRST_N datagrams trigger, the rest do not */
  CHECK(udp_flow_note(&t, A, sp, B, dp, 1000) == 1);
  CHECK(udp_flow_note(&t, A, sp, B, dp, 1001) == 1);
  CHECK(udp_flow_note(&t, A, sp, B, dp, 1002) == 0);
  CHECK(udp_flow_note(&t, A, sp, B, dp, 1003) == 0);

  /* a different flow is independent */
  CHECK(udp_flow_note(&t, A, 0x5555, B, dp, 1004) == 1);

  /* after expiry the same flow starts over */
  CHECK(udp_flow_note(&t, A, sp, B, dp, 1002 + UDP_FLOW_EXPIRE_MS + 1) == 1);

  /* bounded: fill the table with distinct flows, then one more still works */
  udp_flow_init(&t);
  for (int i = 0; i < UDP_FLOW_MAX; i++) {
    CHECK(udp_flow_note(&t, A, (uint16_t)i, B, dp, 2000) == 1);
  }
  /* table full of live flows; a brand-new flow evicts the oldest and triggers */
  CHECK(udp_flow_note(&t, A, 0xffff, B, dp, 2001) == 1);
  /* and it is now tracked (its 2nd datagram triggers, 3rd does not) */
  CHECK(udp_flow_note(&t, A, 0xffff, B, dp, 2002) == 1);
  CHECK(udp_flow_note(&t, A, 0xffff, B, dp, 2003) == 0);
}

/* ── Decoy builder ─────────────────────────────────────────────────────── */
static void test_builder(void) {
  uint8_t buf[1600];
  uint32_t saddr = 0x0100007f;  /* 127.0.0.1 as stored (network order) */
  uint32_t daddr = 0x0203a8c0;  /* 192.168.3.2 */
  uint16_t sport = 0x3412;      /* network order */
  uint16_t dport = 0xdca9;
  int plen = 70;
  int total = udp_build_decoy(buf, sizeof(buf), saddr, daddr, sport, dport, plen, 4, 0x1111, 0xdeadbeef);
  CHECK(total == 20 + 8 + 70);

  /* IPv4 basics */
  CHECK(buf[0] == 0x45);
  CHECK(buf[8] == 4);           /* TTL set low */
  CHECK(buf[9] == 17);          /* UDP */
  CHECK(((buf[2] << 8) | buf[3]) == total);

  /* same 5-tuple (network order copied verbatim) */
  CHECK(memcmp(buf + 12, &saddr, 4) == 0);
  CHECK(memcmp(buf + 16, &daddr, 4) == 0);
  CHECK(memcmp(buf + 20, &sport, 2) == 0);
  CHECK(memcmp(buf + 22, &dport, 2) == 0);

  /* UDP length field */
  CHECK(((buf[24] << 8) | buf[25]) == 8 + plen);

  /* valid IPv4 header checksum */
  CHECK(verify_csum(buf, 20, 0) == 0);

  /* valid UDP checksum: pseudo-header + udp header + payload */
  uint32_t ph = 0;
  ph += (buf[12] << 8) | buf[13]; ph += (buf[14] << 8) | buf[15];
  ph += (buf[16] << 8) | buf[17]; ph += (buf[18] << 8) | buf[19];
  ph += 17;
  ph += 8 + plen;
  CHECK(verify_csum(buf + 20, 8 + plen, ph) == 0);

  /* a different seed yields a different payload */
  uint8_t buf2[1600];
  udp_build_decoy(buf2, sizeof(buf2), saddr, daddr, sport, dport, plen, 4, 0x1111, 0x12345678);
  CHECK(memcmp(buf + 28, buf2 + 28, plen) != 0);

  /* capacity too small -> 0, nothing written past cap */
  CHECK(udp_build_decoy(buf, 20, saddr, daddr, sport, dport, plen, 4, 0, 0) == 0);
  /* zero-length payload is still a valid 28-byte datagram */
  CHECK(udp_build_decoy(buf, sizeof(buf), saddr, daddr, sport, dport, 0, 4, 1, 1) == 28);
  CHECK(verify_csum(buf, 20, 0) == 0);
}


/* ── Kernel pre-filters ────────────────────────────────────────────────── */

/* The iptables u32 match, as the kernel runs it (net/netfilter/xt_u32.c):
 * tests joined by "&&"; each reads 4 bytes big-endian at its first number,
 * then applies "&", "<<", ">>" and "@" in order ("@n": the value so far is
 * added to the base and 4 bytes are read at base + n), and passes when the
 * result is one of the values after "=" ("a" or "a:b", comma-separated). A
 * read past the end fails the test. Returns -1 on a syntax error. */
static int u32_eval(const char *expr, const uint8_t *pkt, int len) {
  const char *p = expr;
  while (*p) {
    char *e;
    uint32_t at = 0;
    uint32_t pos = (uint32_t)strtoul(p, &e, 0);
    if (e == p) return -1;
    p = e;
    if (len < 4 || pos > (uint32_t)len - 4) return 0;
    uint32_t val = ((uint32_t)pkt[pos] << 24) | ((uint32_t)pkt[pos + 1] << 16) | ((uint32_t)pkt[pos + 2] << 8) | pkt[pos + 3];
    while (*p && *p != '=') {
      int op;
      if (*p == '&') { op = '&'; p++; }
      else if (p[0] == '<' && p[1] == '<') { op = '<'; p += 2; }
      else if (p[0] == '>' && p[1] == '>') { op = '>'; p += 2; }
      else if (*p == '@') { op = '@'; p++; }
      else return -1;
      uint32_t n = (uint32_t)strtoul(p, &e, 0);
      if (e == p) return -1;
      p = e;
      if (op == '&') val &= n;
      else if (op == '<') val <<= n;
      else if (op == '>') val >>= n;
      else {
        at += val;
        if ((uint64_t)at + 4 > (uint64_t)len || n > (uint32_t)len - at - 4) return 0;
        const uint8_t *q = pkt + at + n;
        val = ((uint32_t)q[0] << 24) | ((uint32_t)q[1] << 16) | ((uint32_t)q[2] << 8) | q[3];
      }
    }
    if (*p != '=') return -1;
    p++;
    int hit = 0;
    for (;;) {
      uint32_t lo = (uint32_t)strtoul(p, &e, 0), hi;
      if (e == p) return -1;
      p = e;
      hi = lo;
      if (*p == ':') { p++; hi = (uint32_t)strtoul(p, &e, 0); if (e == p) return -1; p = e; }
      if (lo <= val && val <= hi) hit = 1;
      if (*p != ',') break;
      p++;
    }
    if (!hit) return 0;
    if (*p == 0) break;
    if (p[0] != '&' || p[1] != '&') return -1;
    p += 2;
  }
  return 1;
}

/* An IPv4 + UDP datagram carrying `pay`, with `opt` bytes of IP options. */
static int datagram(uint8_t *buf, int cap, const uint8_t *pay, int plen, int opt) {
  uint8_t tmp[1600];
  int n = udp_build_decoy(tmp, sizeof tmp, 0x0101000a, 0x04066433, 0x3930, 0x53c3, plen, 64, 1, 7);
  if (n <= 0 || n + opt > cap) return 0;
  memcpy(buf, tmp, 20);
  buf[0] = (uint8_t)(0x40 | ((20 + opt) / 4));
  memset(buf + 20, 1, (size_t)opt);                 /* NOP options */
  memcpy(buf + 20 + opt, tmp + 20, 8);
  memcpy(buf + 28 + opt, pay, (size_t)plen);
  return n + opt;
}

static void test_prefilters(void) {
  /* The three u32 expressions parse, and say yes exactly where the
   * classifiers do, with and without IP options. */
  uint8_t disc[74] = { 0x00, 0x01, 0x00, 0x46, 0x00, 0x00, 0x30, 0x39 };
  uint8_t stun[28] = { 0x00, 0x01, 0x00, 0x08, 0x21, 0x12, 0xa4, 0x42, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
                       0x00, 0x24, 0x00, 0x04, 0x6e, 0x00, 0x01, 0xff };
  uint8_t rtp[160] = { 0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x03, 0xc0, 0x00, 0x00, 0x30, 0x39 };
  uint8_t dtls[90] = { 0x16, 0xfe, 0xfd, 0x00, 0x00 };
  uint8_t qlong[1200] = { 0xc3, 0x00, 0x00, 0x00, 0x01, 0x08 };
  uint8_t qshort[60] = { 0x41, 0x99, 0x10 };
  uint8_t tiny[3] = { 0x00, 0x01, 0x00 };
  /* d, s, q: what the kernel tests answer. A STUN header cut short (its
   * declared length does not fit) still passes the kernel's test, which only
   * reads the type and the cookie; the classifier refuses it. */
  struct { const uint8_t *p; int n, d, s, q; } cases[] = {
    { disc, sizeof disc, 1, 0, 0 }, { stun, sizeof stun, 0, 1, 0 }, { rtp, sizeof rtp, 0, 0, 1 },
    { dtls, sizeof dtls, 0, 0, 0 }, { qlong, sizeof qlong, 0, 0, 1 }, { qshort, sizeof qshort, 0, 0, 0 },
    { tiny, sizeof tiny, 0, 0, 0 }, { disc, 73, 0, 0, 0 }, { stun, 20, 0, 1, 0 },
  };
  uint8_t pkt[1700];
  for (int opt = 0; opt <= 8; opt += 4) {
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
      int n = datagram(pkt, sizeof pkt, cases[i].p, cases[i].n, opt);
      CHECK(n > 0);
      int d = u32_eval(UDP_U32_DISCOVERY, pkt, n), st = u32_eval(UDP_U32_STUN, pkt, n), q = u32_eval(UDP_U32_QUIC_LONG, pkt, n);
      CHECK(d == cases[i].d && st == cases[i].s && q == cases[i].q);
      /* never stricter than the classifiers */
      if (discord_is_ip_discovery(cases[i].p, cases[i].n)) CHECK(d == 1);
      if (stun_is_binding_request(cases[i].p, cases[i].n)) CHECK(st == 1);
      if (quic_is_initial(cases[i].p, cases[i].n)) CHECK(q == 1);
    }
  }
  /* Whatever the classifiers take, the kernel test takes too: random STUN
   * requests (attributes of every length) and random datagrams. */
  uint32_t x = 0x2545f491u;
  for (int k = 0; k < 4000; k++) {
    uint8_t pay[300];
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    int plen = (int)(x % 300);
    for (int i = 0; i < plen; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; pay[i] = (uint8_t)x; }
    if (k % 3 == 0 && plen >= 20) {
      int mlen = (plen - 20) & ~3;
      memcpy(pay, "\x00\x01", 2); pay[2] = (uint8_t)(mlen >> 8); pay[3] = (uint8_t)mlen;
      memcpy(pay + 4, "\x21\x12\xa4\x42", 4);
    } else if (k % 3 == 1) {
      plen = 74; memcpy(pay, "\x00\x01\x00\x46", 4);
    }
    int n = datagram(pkt, sizeof pkt, pay, plen, (k % 2) * 4);
    CHECK(n > 0);
    if (discord_is_ip_discovery(pay, plen)) CHECK(u32_eval(UDP_U32_DISCOVERY, pkt, n) == 1);
    if (stun_is_binding_request(pay, plen)) CHECK(u32_eval(UDP_U32_STUN, pkt, n) == 1);
    if (quic_is_initial(pay, plen)) CHECK(u32_eval(UDP_U32_QUIC_LONG, pkt, n) == 1);
    if (u32_eval(UDP_U32_DISCOVERY, pkt, n) == 1 || u32_eval(UDP_U32_STUN, pkt, n) == 1)
      CHECK(plen >= 20 && pay[0] == 0 && pay[1] == 1);
  }
  CHECK(u32_eval("0>>22&0x3C@8=", pkt, 40) == -1);   /* the evaluator itself refuses nonsense */
  CHECK(UDP_DISCOVERY_LEN + 8 == 0x52);

  /* The WinDivert clause: payload tests, or the ports alone, for what is on. */
  char b[1024];
  CHECK(udp_windivert_clause(b, sizeof b, 1, 1, UDP_PREFILTER_PAYLOAD) > 0);
  CHECK(strcmp(b,
    "((udp.DstPort == 443 and udp.PayloadLength >= 5 and udp.Payload[0] >= 128) or "
    "((udp.DstPort == 3478 or (udp.DstPort >= 19302 and udp.DstPort <= 19309) or udp.DstPort >= 50000)"
    " and udp.PayloadLength >= 20 and udp.Payload[0] == 0 and udp.Payload[1] == 1"
    " and ((udp.PayloadLength == 74 and udp.Payload[2] == 0 and udp.Payload[3] == 70)"
    " or (udp.Payload[4] == 33 and udp.Payload[5] == 18 and udp.Payload[6] == 164 and udp.Payload[7] == 66))))") == 0);
  CHECK(udp_windivert_clause(b, sizeof b, 1, 0, UDP_PREFILTER_PAYLOAD) > 0);
  CHECK(strcmp(b, "((udp.DstPort == 443 and udp.PayloadLength >= 5 and udp.Payload[0] >= 128))") == 0);
  CHECK(udp_windivert_clause(b, sizeof b, 0, 1, UDP_PREFILTER_PAYLOAD) > 0 && strncmp(b, "(((udp.DstPort == 3478", 22) == 0);
  CHECK(udp_windivert_clause(b, sizeof b, 1, 1, UDP_PREFILTER_PORTS) > 0);
  CHECK(strcmp(b, "(udp.DstPort == 443 or (udp.DstPort == 3478 or (udp.DstPort >= 19302 and udp.DstPort <= 19309) or udp.DstPort >= 50000))") == 0);
  CHECK(udp_windivert_clause(b, sizeof b, 0, 0, UDP_PREFILTER_PAYLOAD) == 0 && b[0] == 0);
  CHECK(udp_windivert_clause(b, 40, 1, 1, UDP_PREFILTER_PAYLOAD) == -1 && b[0] == 0);
  CHECK(udp_windivert_clause(NULL, 40, 1, 1, UDP_PREFILTER_PAYLOAD) == -1);
  /* Its numbers are the classifiers' own. */
  CHECK(0x21 == 33 && 0x12 == 18 && 0xa4 == 164 && 0x42 == 66 && 0x46 == 70 && UDP_DISCOVERY_LEN == 74);
}

int main(void) {
  test_quic();
  test_discord();
  test_stun();
  test_ports();
  test_flow();
  test_builder();
  test_prefilters();
  if (fails == 0) { printf("ALL TESTS PASSED\n"); return 0; }
  printf("%d TEST(S) FAILED\n", fails);
  return 1;
}
