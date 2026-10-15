#include "../src/udpdpi.h"
#include <stdio.h>
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

int main(void) {
  test_quic();
  test_discord();
  test_stun();
  test_ports();
  test_flow();
  test_builder();
  if (fails == 0) { printf("ALL TESTS PASSED\n"); return 0; }
  printf("%d TEST(S) FAILED\n", fails);
  return 1;
}
