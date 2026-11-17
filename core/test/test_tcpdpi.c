/*
 * test_tcpdpi — the Advanced-mode packet-layer helpers (core/src/tcpdpi.c),
 * exercised directly with hand-built IPv4/IPv6 + TCP buffers. No sockets, no
 * privileges: pure byte in, byte out, so it runs everywhere and under ASan.
 *
 * Covers: the injected-RST classifier (forged matched; a genuine server RST,
 * the genuine Linux socket-less reset with DF set and IP ID 0, a payload-bearing
 * RST and a non-80/443 RST NOT matched), the hop-count math
 * (the three TTL bands and the unmeasurable case), the seqovl builder (sequence
 * moved back by the overlap, length and checksums correct) and the
 * fakedsplit / fakeddisorder builder (two real segments + one fake, order,
 * sequence numbers, TTLs and checksums), and the stronger first segment for a
 * server the usual way did not open: the TCP timestamp option found (and not
 * found) among the others, the "ts" decoy (TSval moved back, everything else
 * as the plain segment, good checksum), seqovl with a ClientHello in front
 * (sequence moved back by the prefix, the prefix then the original, shrunk to
 * the path's 1500 bytes) and the whole sequence (decoys, then the real
 * payload cut after its first byte, which the server puts back together as
 * the original).
 */
#include "../src/tcpdpi.h"
#include <stdio.h>
#include <string.h>
#include <stdint.h>

static int fails = 0;
#define CHECK(c) do{ if(!(c)){printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c);fails++;} }while(0)

static uint16_t rd16(const uint8_t *p){ return (uint16_t)((p[0]<<8)|p[1]); }
static uint32_t rd32(const uint8_t *p){ return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
static void wr16(uint8_t *p, uint16_t v){ p[0]=(uint8_t)(v>>8); p[1]=(uint8_t)v; }
static void wr32(uint8_t *p, uint32_t v){ p[0]=(uint8_t)(v>>24);p[1]=(uint8_t)(v>>16);p[2]=(uint8_t)(v>>8);p[3]=(uint8_t)v; }

/* Build a minimal IPv4+TCP header template. Returns header length (ihl+tcphl).
 * ihl=20, tcphl=20. src/dst are 1.2.3.4 -> 5.6.7.8. */
static int mk_hdr(uint8_t *b, int sport, int dport, uint8_t flags, uint32_t seq) {
  memset(b, 0, 40);
  b[0] = 0x45;            /* v4, ihl 5 */
  b[8] = 64;             /* ttl */
  b[9] = 6;              /* TCP */
  b[12]=1;b[13]=2;b[14]=3;b[15]=4;   /* src 1.2.3.4 */
  b[16]=5;b[17]=6;b[18]=7;b[19]=8;   /* dst 5.6.7.8 */
  wr16(b+20, (uint16_t)sport);
  wr16(b+22, (uint16_t)dport);
  wr32(b+24, seq);
  b[32] = 0x50;          /* data offset 5 */
  b[33] = flags;
  return 40;
}

/* The one's-complement sum over a buffer is 0xffff when the checksum is right. */
static int ip_csum_ok(const uint8_t *pkt, int ihl) {
  uint32_t s = 0; for (int i=0;i+1<ihl;i+=2) s += (uint32_t)((pkt[i]<<8)|pkt[i+1]);
  while (s>>16) s=(s&0xffff)+(s>>16); return (s & 0xffff) == 0xffff;
}
static int tcp_csum_ok(const uint8_t *pkt, int len, int ihl) {
  int tlen = len - ihl;
  uint32_t s = 0;
  for (int i=12;i+1<16;i+=2) s += (uint32_t)((pkt[i]<<8)|pkt[i+1]);   /* src */
  for (int i=16;i+1<20;i+=2) s += (uint32_t)((pkt[i]<<8)|pkt[i+1]);   /* dst */
  s += 6; s += (uint32_t)tlen;
  for (int i=0;i+1<tlen;i+=2) s += (uint32_t)((pkt[ihl+i]<<8)|pkt[ihl+i+1]);
  if (tlen & 1) s += (uint32_t)(pkt[ihl+tlen-1]<<8);
  while (s>>16) s=(s&0xffff)+(s>>16); return (s & 0xffff) == 0xffff;
}

/* ───────── injected-RST classifier ───────── */
static void test_rst(void) {
  uint8_t p[60];
  /* forged RST: sport 443, no payload, tiny IP ID -> matched */
  int n = mk_hdr(p, 443, 51000, 0x04, 1000);
  wr16(p+2, (uint16_t)n); wr16(p+4, 0x0005);  /* total len, IP ID 5 */
  CHECK(tcpdpi_is_injected_rst4(p, n) == 1);

  /* RST+ACK variant, IP ID 0, DF clear (mk_hdr zeroes the flags byte) -> matched */
  n = mk_hdr(p, 80, 40000, (uint8_t)(0x04|0x10), 1); wr16(p+2,(uint16_t)n); wr16(p+4,0);
  CHECK(tcpdpi_is_injected_rst4(p, n) == 1);

  /* genuine Linux socket-less reset: RST+ACK, no payload, sport 443, IP ID 0,
   * but DF SET — ip_select_ident_segs() writes IP ID 0 with DF on a closed-port
   * connection-refused or a dead-socket reset, so this real reset must be KEPT. */
  n = mk_hdr(p, 443, 51000, (uint8_t)(0x04|0x10), 1); wr16(p+2,(uint16_t)n);
  wr16(p+4, 0); p[6] |= 0x40;   /* DF */
  CHECK(tcpdpi_is_injected_rst4(p, n) == 0);
  /* the same packet with DF cleared is the forged signature again -> matched */
  p[6] &= (uint8_t)~0x40;
  CHECK(tcpdpi_is_injected_rst4(p, n) == 1);

  /* IP ID 5 (non-zero) with DF set: only the DF+zero-ID Linux fingerprint is
   * kept, so a small non-zero ID is still the forged signature -> matched */
  n = mk_hdr(p, 443, 51000, 0x04, 1000); wr16(p+2,(uint16_t)n); wr16(p+4, 0x0005); p[6] |= 0x40;
  CHECK(tcpdpi_is_injected_rst4(p, n) == 1);

  /* genuine server RST: normal (large) IP ID -> NOT matched */
  n = mk_hdr(p, 443, 51000, 0x04, 1000); wr16(p+2,(uint16_t)n); wr16(p+4, 0x4e21);
  CHECK(tcpdpi_is_injected_rst4(p, n) == 0);

  /* IP ID just above the window (0x10) -> NOT matched */
  n = mk_hdr(p, 443, 51000, 0x04, 1000); wr16(p+2,(uint16_t)n); wr16(p+4, 0x10);
  CHECK(tcpdpi_is_injected_rst4(p, n) == 0);

  /* RST but with payload -> NOT matched */
  n = mk_hdr(p, 443, 51000, 0x04, 1000); p[40]=0xaa; p[41]=0xbb; n += 2;
  wr16(p+2,(uint16_t)n); wr16(p+4, 0x0003);
  CHECK(tcpdpi_is_injected_rst4(p, n) == 0);

  /* RST on a non-80/443 port -> NOT matched */
  n = mk_hdr(p, 8443, 51000, 0x04, 1000); wr16(p+2,(uint16_t)n); wr16(p+4, 0x0002);
  CHECK(tcpdpi_is_injected_rst4(p, n) == 0);

  /* a plain ACK (no RST) with a tiny IP ID -> NOT matched */
  n = mk_hdr(p, 443, 51000, 0x10, 1000); wr16(p+2,(uint16_t)n); wr16(p+4, 0x0002);
  CHECK(tcpdpi_is_injected_rst4(p, n) == 0);

  /* IPv6 forged RST: flow label 0, sport 443, no payload -> matched */
  uint8_t v6[60]; memset(v6,0,sizeof v6);
  v6[0]=0x60;              /* v6, flow label 0 */
  v6[6]=6;                 /* next header TCP */
  v6[7]=64;                /* hop limit */
  v6[40+12]=0x50; v6[40+13]=0x04;
  wr16(v6+40, 443); wr16(v6+42, 51000);
  wr16(v6+4, 20);          /* payload length = TCP header only */
  CHECK(tcpdpi_is_injected_rst6(v6, 60) == 1);
  /* non-zero flow label -> NOT matched */
  v6[1]=0x01; CHECK(tcpdpi_is_injected_rst6(v6, 60) == 0);
}

/* ───────── hop count from SYN-ACK TTL ───────── */
static void test_hops(void) {
  CHECK(tcpdpi_hops_from_ttl(64) == 0);     /* exactly 64 = adjacent is band edge */
  CHECK(tcpdpi_hops_from_ttl(57) == 7);     /* 64 band */
  CHECK(tcpdpi_hops_from_ttl(50) == 14);
  CHECK(tcpdpi_hops_from_ttl(120) == 8);    /* 128 band */
  CHECK(tcpdpi_hops_from_ttl(118) == 10);
  CHECK(tcpdpi_hops_from_ttl(245) == 10);   /* 255 band */
  CHECK(tcpdpi_hops_from_ttl(34) == 0);     /* below every band */
  CHECK(tcpdpi_hops_from_ttl(80) == 0);     /* between the 64 and 128 bands */
  CHECK(tcpdpi_hops_from_ttl(200) == 0);    /* between the 128 and 255 bands */

  CHECK(tcpdpi_decoy_ttl(10, 1, 1) == 9);   /* nhops - margin */
  CHECK(tcpdpi_decoy_ttl(2, 1, 1) == 1);
  CHECK(tcpdpi_decoy_ttl(1, 1, 1) == 1);    /* clamped up to the minimum */
  CHECK(tcpdpi_decoy_ttl(5, 1, 3) == 4);
  CHECK(tcpdpi_decoy_ttl(3, 1, 3) == 3);    /* clamp holds */

  /* the hop table remembers, expires and evicts */
  tcpdpi_hops_reset();
  tcpdpi_hops_put(0x01020304u, 12, 1000);
  CHECK(tcpdpi_hops_get(0x01020304u, 2000) == 12);
  CHECK(tcpdpi_hops_get(0x09090909u, 2000) == 0);           /* unknown */
  CHECK(tcpdpi_hops_get(0x01020304u, 1000 + TCPDPI_HOPS_TTL_MS + 1) == 0); /* expired */
  tcpdpi_hops_put(0x01020304u, 7, 5000);                    /* refresh keeps one slot */
  CHECK(tcpdpi_hops_get(0x01020304u, 6000) == 7);
}

/* ───────── seqovl builder ───────── */
static void test_seqovl(void) {
  uint8_t tmpl[40]; int hl = mk_hdr(tmpl, 50000, 443, 0x18, 0); /* PSH+ACK */
  (void)hl;
  uint8_t real[64]; for (int i=0;i<64;i++) real[i]=(uint8_t)(0x40+i);
  uint32_t seq = 1000000;
  int overlap = 8;
  uint8_t out[1600];
  int n = tcpdpi_build_seqovl4(out, sizeof out, tmpl, 20, tmpl+20, 20,
                               0xBEEF, seq, 64, real, 64, overlap, 0x61);
  CHECK(n == 20 + 20 + overlap + 64);          /* headers + overlap + real */
  CHECK(rd32(out + 20 + 4) == seq - (uint32_t)overlap); /* sequence moved back */
  CHECK(rd16(out + 2) == n);                   /* IP total length */
  CHECK(rd16(out + 4) == 0xBEEF);              /* IP id */
  /* first `overlap` payload bytes are the pattern, then the real bytes */
  for (int i=0;i<overlap;i++) CHECK(out[40+i] == 0x61);
  CHECK(memcmp(out + 40 + overlap, real, 64) == 0);
  CHECK(ip_csum_ok(out, 20));
  CHECK(tcp_csum_ok(out, n, 20));              /* real segment: GOOD checksum */

  /* overlap larger than the sequence still builds (wraps), tiny inputs rejected */
  CHECK(tcpdpi_build_seqovl4(out, sizeof out, tmpl, 20, tmpl+20, 20, 1, 100, 64, real, 64, 0, 0) == 0);
  CHECK(tcpdpi_build_seqovl4(out, 8, tmpl, 20, tmpl+20, 20, 1, 100, 64, real, 64, 4, 0) == 0); /* no room */
}

/* ───────── fakedsplit / fakeddisorder builder ───────── */
static void check_seg_ip(const tcpdpi_seg *s) {
  CHECK(ip_csum_ok(s->data, 20));
  CHECK(rd16(s->data + 2) == s->len);
}
static void test_fakedsplit(void) {
  uint8_t tmpl[40]; mk_hdr(tmpl, 50000, 443, 0x18, 0);
  uint8_t real[40]; for (int i=0;i<40;i++) real[i]=(uint8_t)(0x30+i);
  uint32_t seq = 777000; int split = 12, fake_ttl = 5, ttl = 64;

  tcpdpi_seg segs[3]; int ns = 0;
  /* fakedsplit: A, fake, B  */
  CHECK(tcpdpi_build_fakedsplit4(segs, &ns, tmpl, 20, tmpl+20, 20, 0x100, seq, ttl,
                                 real, 40, split, fake_ttl, 0xCC, 0) == 1);
  CHECK(ns == 3);
  CHECK(segs[0].is_fake == 0 && segs[1].is_fake == 1 && segs[2].is_fake == 0);
  /* seg0 = real A at seq, carries real[0,split) */
  CHECK(rd32(segs[0].data + 24) == seq);
  CHECK(segs[0].len == 40 + split);
  CHECK(memcmp(segs[0].data + 40, real, split) == 0);
  CHECK(segs[0].data[8] == ttl);
  /* seg1 = fake at seq+split, low TTL, junk, BAD checksum */
  CHECK(rd32(segs[1].data + 24) == seq + (uint32_t)split);
  CHECK(segs[1].data[8] == fake_ttl);
  CHECK(segs[1].data[40] == 0xCC);
  CHECK(!tcp_csum_ok(segs[1].data, segs[1].len, 20));
  /* seg2 = real B at seq+split, carries real[split,n), GOOD checksum */
  CHECK(rd32(segs[2].data + 24) == seq + (uint32_t)split);
  CHECK(segs[2].len == 40 + (40 - split));
  CHECK(memcmp(segs[2].data + 40, real + split, 40 - split) == 0);
  CHECK(segs[2].data[8] == ttl);
  CHECK(tcp_csum_ok(segs[2].data, segs[2].len, 20));
  for (int i=0;i<3;i++) check_seg_ip(&segs[i]);
  /* the two real parts reassemble (by sequence) to exactly the original */
  CHECK(rd32(segs[2].data+24) == rd32(segs[0].data+24) + (uint32_t)split);

  /* fakeddisorder: B first, fake, A */
  CHECK(tcpdpi_build_fakedsplit4(segs, &ns, tmpl, 20, tmpl+20, 20, 0x200, seq, ttl,
                                 real, 40, split, fake_ttl, 0xCC, 1) == 1);
  CHECK(segs[0].is_fake == 0 && segs[1].is_fake == 1 && segs[2].is_fake == 0);
  CHECK(rd32(segs[0].data + 24) == seq + (uint32_t)split);   /* B first */
  CHECK(memcmp(segs[0].data + 40, real + split, 40 - split) == 0);
  CHECK(segs[1].data[8] == fake_ttl);                        /* fake low TTL */
  CHECK(!tcp_csum_ok(segs[1].data, segs[1].len, 20));
  CHECK(rd32(segs[2].data + 24) == seq);                     /* A last */
  CHECK(memcmp(segs[2].data + 40, real, split) == 0);
  CHECK(tcp_csum_ok(segs[2].data, segs[2].len, 20));
  for (int i=0;i<3;i++) check_seg_ip(&segs[i]);

  /* bad split positions are rejected */
  CHECK(tcpdpi_build_fakedsplit4(segs, &ns, tmpl, 20, tmpl+20, 20, 1, seq, ttl, real, 40, 0, fake_ttl, 0, 0) == 0);
  CHECK(tcpdpi_build_fakedsplit4(segs, &ns, tmpl, 20, tmpl+20, 20, 1, seq, ttl, real, 40, 40, fake_ttl, 0, 0) == 0);
}

/* ───────── cutting the real first segment ───────── */
/* Where the cuts land, relative to the start of the name; -1 for none. */
static int cuts_in(const char *host, int *a, int *b) {
  const char *pre = "hdr:";
  uint8_t buf[300]; int po = (int)strlen(pre), hl = (int)strlen(host);
  memcpy(buf, pre, (size_t)po); memcpy(buf + po, host, (size_t)hl); memcpy(buf + po + hl, "tail", 4);
  int c[2] = { -1, -1 };
  int n = tcpdpi_split_points(buf, po + hl + 4, po, hl, c);
  *a = n > 0 ? c[0] - po : -1; *b = n > 1 ? c[1] - po : -1;
  return n;
}
static void test_split(void) {
  int a, b;
  CHECK(cuts_in("remote-auth-gateway.discord.gg", &a, &b) == 2 && a == 1 && b == 23);  /* r|...dis|cord.gg */
  CHECK(cuts_in("discord.com", &a, &b) == 2 && a == 1 && b == 3);                      /* d|is|cord.com */
  CHECK(cuts_in("discord.com.", &a, &b) == 2 && a == 1 && b == 3);                     /* trailing dot */
  CHECK(cuts_in("x.com", &a, &b) == 2 && a == 1 && b == 2);                            /* 1-char label: the whole name */
  CHECK(cuts_in("localhost", &a, &b) == 2 && a == 1 && b == 4);                        /* one label: its middle */
  CHECK(cuts_in("ab", &a, &b) == 1 && a == 1);                                         /* both cuts at the same place: one */
  CHECK(cuts_in("x", &a, &b) == 0);                                                    /* too short to cut */
  uint8_t z[8] = {0}; int c[2];
  CHECK(tcpdpi_split_points(z, 8, 0, 4, c) == 0);    /* a name at the very start: nothing before it to keep */
  CHECK(tcpdpi_split_points(z, 8, 4, 6, c) == 0);    /* a name past the end */
  CHECK(tcpdpi_split_points(NULL, 8, 1, 4, c) == 0);

  uint8_t tmpl[40]; mk_hdr(tmpl, 50000, 443, 0x18, 0);
  uint8_t real[60]; for (int i = 0; i < 60; i++) real[i] = (uint8_t)(0x30 + i);
  uint32_t seq = 4294967280u; int ttl = 64;           /* the sequence number wraps */
  int cuts[2] = { 7, 31 };
  for (int rev = 0; rev <= 1; rev++) {
    tcpdpi_seg segs[3]; int ns = 0;
    CHECK(tcpdpi_build_multisplit4(segs, &ns, tmpl, 20, tmpl + 20, 20, 0x300, seq, ttl, real, 60, cuts, 2, rev) == 1);
    CHECK(ns == 3);
    /* Put back by sequence number, whatever the order sent: the original. */
    uint8_t back[60]; int got = 0, ids[3];
    for (int i = 0; i < 3; i++) {
      CHECK(!segs[i].is_fake && segs[i].data[8] == ttl && tcp_csum_ok(segs[i].data, segs[i].len, 20));
      uint32_t off = rd32(segs[i].data + 24) - seq;
      int len = segs[i].len - 40;
      CHECK(off + (uint32_t)len <= 60);
      memcpy(back + off, segs[i].data + 40, (size_t)len); got += len;
      ids[i] = rd16(segs[i].data + 4);
    }
    CHECK(got == 60 && memcmp(back, real, 60) == 0);
    CHECK(ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2]);
    /* In order: first bytes first; reversed: last bytes first. */
    CHECK(rd32(segs[0].data + 24) == (rev ? seq + 31u : seq));
    CHECK(rd32(segs[2].data + 24) == (rev ? seq : seq + 31u));
  }
  tcpdpi_seg segs[3]; int ns = 0;
  int one[1] = { 13 };
  CHECK(tcpdpi_build_multisplit4(segs, &ns, tmpl, 20, tmpl + 20, 20, 1, seq, ttl, real, 60, one, 1, 0) == 1 && ns == 2);
  int bad1[2] = { 31, 7 }, bad2[2] = { 7, 60 }, bad3[1] = { 0 };
  CHECK(tcpdpi_build_multisplit4(segs, &ns, tmpl, 20, tmpl + 20, 20, 1, seq, ttl, real, 60, bad1, 2, 0) == 0);  /* not ascending */
  CHECK(tcpdpi_build_multisplit4(segs, &ns, tmpl, 20, tmpl + 20, 20, 1, seq, ttl, real, 60, bad2, 2, 0) == 0);  /* at the end */
  CHECK(tcpdpi_build_multisplit4(segs, &ns, tmpl, 20, tmpl + 20, 20, 1, seq, ttl, real, 60, bad3, 1, 0) == 0);  /* at the start */
  CHECK(tcpdpi_build_multisplit4(segs, &ns, tmpl, 20, tmpl + 20, 20, 1, seq, ttl, real, 60, one, 0, 0) == 0);   /* no cut */
}

/* ───────── splitting the TLS record (tlsrec) ───────── */
static void test_tlsrec(void) {
  uint8_t tmpl[40]; mk_hdr(tmpl, 50000, 443, 0x18, 0);
  /* A ClientHello-shaped first segment: a TLS record of 40 body bytes, then
   * four trailing bytes that belong to no record (kept after the split). */
  uint8_t real[64]; int rl = 40, tail = 4, rlen = 5 + rl + tail;
  real[0] = 0x16; real[1] = 0x03; real[2] = 0x01; wr16(real + 3, (uint16_t)rl);
  for (int i = 0; i < rl + tail; i++) real[5 + i] = (uint8_t)(0x41 + i);

  uint8_t out[256];
  int cut = 5 + 15;                       /* 15 bytes into the record body */
  int n = tcpdpi_build_tlsrec4(out, sizeof out, tmpl, 20, tmpl + 20, 20, 0x700, 9000, 64, real, rlen, cut);
  int poff = 40, plen = n - poff;
  CHECK(n > 0 && plen == rlen + TCPDPI_TLSREC_GROWTH);     /* grew by one record header */
  const uint8_t *p = out + poff;
  /* record 1: 0x16 03 01, length 15, body = real body[0..15) */
  CHECK(p[0] == 0x16 && p[1] == 0x03 && p[2] == 0x01 && rd16(p + 3) == 15);
  CHECK(memcmp(p + 5, real + 5, 15) == 0);
  /* record 2: 0x16 03 01, length 25, body = real body[15..40) */
  const uint8_t *q = p + 5 + 15;
  CHECK(q[0] == 0x16 && q[1] == 0x03 && q[2] == 0x01 && rd16(q + 3) == 25);
  CHECK(memcmp(q + 5, real + 5 + 15, 25) == 0);
  /* the four trailing bytes, unchanged, after the second record */
  CHECK(memcmp(q + 5 + 25, real + 5 + 40, 4) == 0);
  /* the two record bodies back to back are the original record body */
  uint8_t body[40]; memcpy(body, p + 5, 15); memcpy(body + 15, q + 5, 25);
  CHECK(memcmp(body, real + 5, 40) == 0);
  CHECK(rd32(out + 24) == 9000);                           /* sequence unchanged */
  CHECK(out[8] == 64 && tcp_csum_ok(out, n, 20) && ip_csum_ok(out, 20));  /* good checksum */

  /* refusals: not a TLS record; the cut at the very start or end of the record */
  uint8_t bad[48]; memcpy(bad, real, 48);
  bad[0] = 0x17; CHECK(tcpdpi_build_tlsrec4(out, sizeof out, tmpl, 20, tmpl + 20, 20, 1, 1, 64, bad, rlen, cut) == 0);
  CHECK(tcpdpi_build_tlsrec4(out, sizeof out, tmpl, 20, tmpl + 20, 20, 1, 1, 64, real, rlen, 5) == 0);        /* cut at body start */
  CHECK(tcpdpi_build_tlsrec4(out, sizeof out, tmpl, 20, tmpl + 20, 20, 1, 1, 64, real, rlen, 5 + 40) == 0);   /* cut at body end */

  /* A ClientHello that spans several TCP segments: this first segment holds a
   * record header claiming 200 body bytes but only 95 of them (real_len 100).
   * The record is still split at the cut (which must be within what is present);
   * record 2 declares the whole remainder and continues in the later segments. */
  uint8_t span[100];
  span[0] = 0x16; span[1] = 0x03; span[2] = 0x01; wr16(span + 3, 200);     /* body claims 200 */
  for (int i = 0; i < 95; i++) span[5 + i] = (uint8_t)(0x41 + (i % 26));
  int sn = tcpdpi_build_tlsrec4(out, sizeof out, tmpl, 20, tmpl + 20, 20, 0x800, 1, 64, span, 100, 5 + 40);
  CHECK(sn > 0 && sn - 40 == 100 + TCPDPI_TLSREC_GROWTH);                    /* grew by one header */
  const uint8_t *sp = out + 40;
  CHECK(sp[0] == 0x16 && rd16(sp + 3) == 40);                               /* record 1: 40 body bytes */
  CHECK(memcmp(sp + 5, span + 5, 40) == 0);
  const uint8_t *sq = sp + 5 + 40;
  CHECK(sq[0] == 0x16 && rd16(sq + 3) == 160);                              /* record 2 declares 200-40 */
  CHECK(memcmp(sq + 5, span + 5 + 40, 55) == 0);                            /* 95-40 = 55 of it present here */
  /* the cut must be inside the bytes present: past them, it is refused */
  CHECK(tcpdpi_build_tlsrec4(out, sizeof out, tmpl, 20, tmpl + 20, 20, 1, 1, 64, span, 100, 5 + 96) == 0);
}

/* ───────── the two-segment split (never bigger than the original) ───────── */
static void test_tlsrec_pair(void) {
  uint8_t tmpl[40]; mk_hdr(tmpl, 50000, 443, 0x18, 0);
  uint8_t real[64]; int rl = 50, rlen = 5 + rl;
  real[0] = 0x16; real[1] = 0x03; real[2] = 0x01; wr16(real + 3, (uint16_t)rl);
  for (int i = 0; i < rl; i++) real[5 + i] = (uint8_t)(0x41 + i);
  uint32_t seq = 7000; int cut = 5 + 20;                 /* k = 20 */

  tcpdpi_seg segs[2]; int ns = 0;
  CHECK(tcpdpi_build_tlsrec_pair(segs, &ns, tmpl, 20, tmpl + 20, 20, 0x900, seq, 64, real, rlen, cut) == 1);
  CHECK(ns == 2);
  /* segment 1 = record 1 (5 + 20), at seq; segment 2 = record 2 (5 + 30), at seq+25 */
  CHECK(segs[0].len - 40 == 25 && rd32(segs[0].data + 24) == seq);
  CHECK(segs[1].len - 40 == 35 && rd32(segs[1].data + 24) == seq + 25);
  /* neither segment is larger than the original would have been */
  CHECK(segs[0].len - 40 <= rlen && segs[1].len - 40 <= rlen);
  /* both carry a good checksum and the normal TTL */
  CHECK(segs[0].data[8] == 64 && tcp_csum_ok(segs[0].data, segs[0].len, 20) && ip_csum_ok(segs[0].data, 20));
  CHECK(segs[1].data[8] == 64 && tcp_csum_ok(segs[1].data, segs[1].len, 20) && ip_csum_ok(segs[1].data, 20));
  /* the two record headers and the name across the boundary */
  const uint8_t *r1 = segs[0].data + 40, *r2 = segs[1].data + 40;
  CHECK(r1[0] == 0x16 && rd16(r1 + 3) == 20 && memcmp(r1 + 5, real + 5, 20) == 0);
  CHECK(r2[0] == 0x16 && rd16(r2 + 3) == 30 && memcmp(r2 + 5, real + 5 + 20, 30) == 0);
  CHECK(segs[0].data[9] != segs[1].data[9] || rd16(segs[0].data + 4) != rd16(segs[1].data + 4)); /* distinct IP ids */
}

/* ───────── sequence-number translation ───────── */
static void test_xlate(void) {
  uint32_t sa = 0x01020304, da = 0x05060708; uint16_t sp = 0xc350, dp = 0x01bb;
  uint64_t T = 1000000;
  tcpdpi_xlate_reset();
  CHECK(tcpdpi_xlate_begin(sa, da, sp, dp, 1000, 5, T) == 1);
  uint32_t s;
  s = 1000; CHECK(tcpdpi_xlate_out(sa, da, sp, dp, &s, T) == 1 && s == 1005);  /* at the growth */
  s = 2000; CHECK(tcpdpi_xlate_out(sa, da, sp, dp, &s, T) == 1 && s == 2005);  /* after it */
  s = 999;  CHECK(tcpdpi_xlate_out(sa, da, sp, dp, &s, T) == 0 && s == 999);   /* before it */
  s = 1234; CHECK(tcpdpi_xlate_out(sa, da, 0x1111, dp, &s, T) == 0);           /* another connection */
  /* inbound (server -> client): the tuple reversed, the ack brought back */
  uint32_t a;
  a = 1005; CHECK(tcpdpi_xlate_in(da, sa, dp, sp, &a, T) == 1 && a == 1000);
  a = 2005; CHECK(tcpdpi_xlate_in(da, sa, dp, sp, &a, T) == 1 && a == 2000);
  a = 1004; CHECK(tcpdpi_xlate_in(da, sa, dp, sp, &a, T) == 0 && a == 1004);   /* not yet past the growth */
  /* the sequence space wraps */
  CHECK(tcpdpi_xlate_begin(sa, da, 0x2222, dp, 0xfffffff0u, 5, T) == 1);
  s = 0x00000003u; CHECK(tcpdpi_xlate_out(sa, da, 0x2222, dp, &s, T) == 1 && s == 0x00000008u);
  /* closing a connection forgets it */
  tcpdpi_xlate_end(sa, da, sp, dp);
  s = 2000; CHECK(tcpdpi_xlate_out(sa, da, sp, dp, &s, T) == 0 && s == 2000);
  /* a full table of live connections refuses a new one, never corrupts one */
  tcpdpi_xlate_reset();
  for (int i = 0; i < TCPDPI_XLATE_CAP; i++) CHECK(tcpdpi_xlate_begin((uint32_t)(0x0a000000u + i), da, sp, dp, 100, 5, T) == 1);
  CHECK(tcpdpi_xlate_live(T) == TCPDPI_XLATE_CAP);
  CHECK(tcpdpi_xlate_begin(0xdeadbeef, da, sp, dp, 100, 5, T) == 0);
  /* once the live ones age out, there is room again */
  CHECK(tcpdpi_xlate_begin(0xdeadbeef, da, sp, dp, 100, 5, T + TCPDPI_XLATE_TTL_MS + 1) == 1);
  tcpdpi_xlate_reset();
}

/* ───────── the stronger first segment (ts decoys, seqovl with a ClientHello) ───────── */
/* An IPv4+TCP template whose TCP header is 32 bytes: NOP, NOP, then a
 * timestamp option (TSval tsval, TSecr tsecr), as Windows and Linux send it
 * once timestamps are on. Returns ihl + tcphl (52). */
static int mk_hdr_ts(uint8_t *b, uint32_t seq, uint32_t tsval, uint32_t tsecr) {
  memset(b, 0, 52);
  mk_hdr(b, 50000, 443, 0x18, seq);
  b[32] = 0x80;                         /* data offset 8: 32 bytes */
  b[40] = 1; b[41] = 1;                 /* NOP NOP */
  b[42] = 8; b[43] = 10;                /* timestamps, length 10 */
  wr32(b + 44, tsval);
  wr32(b + 48, tsecr);
  return 52;
}

static void test_ts_offset(void) {
  uint8_t t[60];
  mk_hdr_ts(t, 1, 0x11223344, 0x55667788);
  CHECK(tcpdpi_ts_offset(t + 20, 32) == 24);           /* TSval right after kind, length */
  /* MSS, window scale, SACK permitted, then the timestamp: found past them. */
  uint8_t o[40] = {0};
  o[12] = 0xa0;                                        /* data offset 10: 40 bytes */
  int i = 20;
  o[i++] = 2; o[i++] = 4; o[i++] = 0x05; o[i++] = 0xb4; /* MSS */
  o[i++] = 1; o[i++] = 3; o[i++] = 3; o[i++] = 7;       /* NOP, window scale */
  o[i++] = 4; o[i++] = 2;                              /* SACK permitted */
  o[i++] = 8; o[i++] = 10;                             /* timestamps */
  CHECK(tcpdpi_ts_offset(o, 40) == i);
  /* None: a bare 20-byte header, End of Options first, NOPs alone. */
  uint8_t b[40]; mk_hdr(b, 50000, 443, 0x18, 1);
  CHECK(tcpdpi_ts_offset(b + 20, 20) == -1);
  uint8_t e[32] = {0}; e[20] = 0; e[21] = 8; e[22] = 10;
  CHECK(tcpdpi_ts_offset(e, 32) == -1);                /* after End of Options: not read */
  uint8_t n[24] = {0}; n[20] = n[21] = n[22] = n[23] = 1;
  CHECK(tcpdpi_ts_offset(n, 24) == -1);
  /* Malformed: a length past the header, a zero length, a timestamp of the
   * wrong length, a header length out of range. */
  uint8_t m[28] = {0}; m[20] = 2; m[21] = 12;
  CHECK(tcpdpi_ts_offset(m, 28) == -1);
  m[21] = 0;
  CHECK(tcpdpi_ts_offset(m, 28) == -1);
  m[20] = 8; m[21] = 8;
  CHECK(tcpdpi_ts_offset(m, 28) == -1);
  CHECK(tcpdpi_ts_offset(t + 20, 19) == -1 && tcpdpi_ts_offset(t + 20, 64) == -1 && tcpdpi_ts_offset(NULL, 32) == -1);
  /* An option whose length byte would be the header's last byte + 1. */
  uint8_t l[24] = {0}; l[20] = 1; l[21] = 1; l[22] = 1; l[23] = 2;
  CHECK(tcpdpi_ts_offset(l, 24) == -1);
}

static void test_ts_decoy(void) {
  uint8_t t[60]; int hl = mk_hdr_ts(t, 777000, 0x01000000u, 0x0abcdef0u);
  uint8_t pay[100]; for (int i = 0; i < 100; i++) pay[i] = (uint8_t)(0x30 + i);
  uint8_t out[1600], plain[1600];
  int n = tcpdpi_build_ts_decoy4(out, sizeof out, t, 20, t + 20, 32, 0x4242, 777000, 64, pay, 100, TCPDPI_TS_BACK);
  CHECK(n == hl + 100);
  CHECK(rd32(out + 20 + 24) == 0x01000000u - TCPDPI_TS_BACK);  /* TSval moved back */
  CHECK(rd32(out + 20 + 28) == 0x0abcdef0u);                   /* TSecr as it was */
  CHECK(rd32(out + 24) == 777000 && out[8] == 64 && rd16(out + 4) == 0x4242);
  CHECK(memcmp(out + hl, pay, 100) == 0);
  CHECK(ip_csum_ok(out, 20));
  CHECK(tcp_csum_ok(out, n, 20));                              /* GOOD: the filter keeps it */
  /* Byte for byte the plain segment but for the TSval and the checksum. */
  int m = tcpdpi_build_segment4(plain, sizeof plain, t, 20, t + 20, 32, 0x4242, 777000, 64, pay, 100, 0);
  CHECK(m == n);
  for (int i = 0; i < n; i++)
    if (!((i >= 44 && i < 48) || i == 36 || i == 37)) CHECK(out[i] == plain[i]);
  /* A TSval below the amount taken off wraps round, as TCP's arithmetic does. */
  mk_hdr_ts(t, 777000, 5, 0);
  n = tcpdpi_build_ts_decoy4(out, sizeof out, t, 20, t + 20, 32, 1, 777000, 64, pay, 100, TCPDPI_TS_BACK);
  CHECK(n > 0 && rd32(out + 44) == (uint32_t)(5u - TCPDPI_TS_BACK));
  CHECK(tcp_csum_ok(out, n, 20));
  /* No timestamp option: nothing (the caller sends its TTL decoy). */
  uint8_t b[40]; mk_hdr(b, 50000, 443, 0x18, 1);
  CHECK(tcpdpi_build_ts_decoy4(out, sizeof out, b, 20, b + 20, 20, 1, 1, 64, pay, 100, TCPDPI_TS_BACK) == 0);
  CHECK(tcpdpi_build_ts_decoy4(out, 50, t, 20, t + 20, 32, 1, 1, 64, pay, 100, TCPDPI_TS_BACK) == 0); /* no room */
}

static void test_seqovl_prefix(void) {
  uint8_t t[60]; mk_hdr_ts(t, 0, 1000, 2000);
  uint8_t pre[1400]; for (int i = 0; i < 1400; i++) pre[i] = (uint8_t)(i * 7 + 3);
  uint8_t real[1448]; for (int i = 0; i < 1448; i++) real[i] = (uint8_t)(0x80 ^ i);
  uint8_t out[1600];
  uint32_t seq = 5000000;
  int ovl = -1;
  /* 681 bytes of ClientHello, as zapret's Google recipe, ahead of one real byte. */
  int n = tcpdpi_build_seqovl_prefix4(out, sizeof out, t, 20, t + 20, 32, 9, seq, 64, pre, 681, real, 1,
                                      TCPDPI_WIRE_MAX, &ovl);
  CHECK(ovl == 681 && n == 52 + 681 + 1);
  CHECK(rd32(out + 24) == seq - 681);                  /* seq = original seq minus the prefix */
  CHECK(memcmp(out + 52, pre, 681) == 0);              /* the prefix ... */
  CHECK(out[52 + 681] == real[0]);                     /* ... then the original */
  CHECK(rd16(out + 2) == n && ip_csum_ok(out, 20) && tcp_csum_ok(out, n, 20));
  CHECK(rd32(out + 44) == 1000);                       /* the real segment's own timestamp */
  /* Too long for the path: the overlap shrinks so the packet is exactly 1500. */
  n = tcpdpi_build_seqovl_prefix4(out, sizeof out, t, 20, t + 20, 32, 9, seq, 64, pre, 1400, real, 100,
                                  TCPDPI_WIRE_MAX, &ovl);
  CHECK(n == TCPDPI_WIRE_MAX && ovl == TCPDPI_WIRE_MAX - 52 - 100);
  CHECK(rd32(out + 24) == seq - (uint32_t)ovl);
  CHECK(memcmp(out + 52, pre, (size_t)ovl) == 0 && memcmp(out + 52 + ovl, real, 100) == 0);
  CHECK(tcp_csum_ok(out, n, 20));
  /* No room for even one prefix byte: nothing. */
  CHECK(tcpdpi_build_seqovl_prefix4(out, sizeof out, t, 20, t + 20, 32, 9, seq, 64, pre, 10, real, 1448,
                                    TCPDPI_WIRE_MAX, &ovl) == 0);
  /* Bad input. */
  CHECK(tcpdpi_build_seqovl_prefix4(out, sizeof out, t, 20, t + 20, 32, 9, seq, 64, pre, 0, real, 1, 1500, NULL) == 0);
  CHECK(tcpdpi_build_seqovl_prefix4(out, sizeof out, t, 20, t + 20, 32, 9, seq, 64, pre, 10, real, 0, 1500, NULL) == 0);
  CHECK(tcpdpi_build_seqovl_prefix4(out, sizeof out, t, 20, t + 20, 32, 9, seq, 64, NULL, 10, real, 1, 1500, NULL) == 0);
}

static void test_strong(void) {
  static tcpdpi_seg segs[TCPDPI_STRONG_SEGS];
  uint8_t t[60]; mk_hdr_ts(t, 0, 0x7f000000u, 0x12345678u);
  uint8_t real[600]; for (int i = 0; i < 600; i++) real[i] = (uint8_t)(i * 13 + 1);
  real[0] = 0x16;
  uint8_t decoy[520]; for (int i = 0; i < 520; i++) decoy[i] = (uint8_t)(i * 5 + 9);
  uint32_t seq = 0x10000;
  int ns = 0, ts = -1;
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 100, seq, 117,
                             real, 600, decoy, 520, 3, TCPDPI_STRONG_REPEATS) == 1);
  CHECK(ns == TCPDPI_STRONG_REPEATS + 2 && ts == 1);
  /* The decoys: "ts" ones, the whole way (the real TTL) with a good checksum. */
  for (int i = 0; i < TCPDPI_STRONG_REPEATS; i++) {
    const uint8_t *d = segs[i].data;
    CHECK(segs[i].is_fake == 1 && segs[i].len == 52 + 520);
    CHECK(rd32(d + 24) == seq && d[8] == 117 && rd16(d + 4) == (uint16_t)(100 + i));
    CHECK(rd32(d + 44) == 0x7f000000u - TCPDPI_TS_BACK && rd32(d + 48) == 0x12345678u);
    CHECK(memcmp(d + 52, decoy, 520) == 0);
    CHECK(ip_csum_ok(d, 20) && tcp_csum_ok(d, segs[i].len, 20));
  }
  /* The real first byte behind the decoy, at seq - 520; then the rest at seq + 1. */
  const tcpdpi_seg *a = &segs[TCPDPI_STRONG_REPEATS], *b = &segs[TCPDPI_STRONG_REPEATS + 1];
  CHECK(a->is_fake == 0 && a->len == 52 + 520 + 1);
  CHECK(rd32(a->data + 24) == seq - 520 && memcmp(a->data + 52, decoy, 520) == 0 && a->data[52 + 520] == 0x16);
  CHECK(rd32(a->data + 44) == 0x7f000000u && a->data[8] == 117 && tcp_csum_ok(a->data, a->len, 20));
  CHECK(b->is_fake == 0 && b->len == 52 + 599);
  CHECK(rd32(b->data + 24) == seq + 1 && memcmp(b->data + 52, real + 1, 599) == 0);
  CHECK(rd32(b->data + 44) == 0x7f000000u && tcp_csum_ok(b->data, b->len, 20));
  /* What the server keeps, put back together by sequence number, is the
   * original payload exactly: byte 0 from the seqovl part, the rest after. */
  uint8_t back[600];
  back[0] = a->data[52 + (seq - rd32(a->data + 24))];
  memcpy(back + 1, b->data + 52, 599);
  CHECK(memcmp(back, real, 600) == 0);

  /* No timestamp option: the usual low-TTL, bad-checksum decoy, as often. */
  uint8_t p[40]; mk_hdr(p, 50000, 443, 0x18, 0);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, p, 20, p + 20, 20, 100, seq, 117,
                             real, 600, decoy, 520, 3, 6) == 1);
  CHECK(ns == 8 && ts == 0);
  for (int i = 0; i < 6; i++) {
    CHECK(segs[i].is_fake == 1 && segs[i].data[8] == 3);
    CHECK(ip_csum_ok(segs[i].data, 20) && !tcp_csum_ok(segs[i].data, segs[i].len, 20));
  }
  CHECK(rd32(segs[6].data + 24) == seq - 520 && tcp_csum_ok(segs[6].data, segs[6].len, 20));
  CHECK(rd32(segs[7].data + 24) == seq + 1 && tcp_csum_ok(segs[7].data, segs[7].len, 20));

  /* A full-size first segment: the decoy prefix shrinks to keep the path's 1500. */
  uint8_t big[1448]; memset(big, 0x16, sizeof big);
  uint8_t bigdecoy[1448]; memset(bigdecoy, 0x42, sizeof bigdecoy);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64,
                             big, 1448, bigdecoy, 1448, 3, 2) == 1);
  CHECK(segs[2].len == TCPDPI_WIRE_MAX && rd32(segs[2].data + 24) == seq - (uint32_t)(TCPDPI_WIRE_MAX - 52 - 1));
  CHECK(segs[3].len == 52 + 1447);

  /* A PPPoE line (MTU 1492): the real first segment is 52 + 1400 bytes, and
   * the seqovl part is never larger than that, however long the decoy. */
  uint8_t ppp[1400]; memset(ppp, 0x16, sizeof ppp);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64,
                             ppp, 1400, bigdecoy, 1448, 3, 2) == 1);
  CHECK(segs[2].len == 52 + 1400 && rd32(segs[2].data + 24) == seq - (uint32_t)(1400 - 1));
  CHECK(segs[3].len == 52 + 1399);
  /* A small first segment: the seqovl part may still grow to 576 bytes. */
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64,
                             real, 200, bigdecoy, 1448, 3, 2) == 1);
  CHECK(segs[2].len == TCPDPI_PATH_MIN && rd32(segs[2].data + 24) == seq - (uint32_t)(TCPDPI_PATH_MIN - 52 - 1));

  /* Nothing to send when it cannot all be built: too short to cut, no decoy,
   * repeats out of range, too little room. */
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, real, 1, decoy, 520, 3, 8) == 0);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, real, 600, decoy, 0, 3, 8) == 0);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, real, 600, decoy, 520, 3, 0) == 0);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, real, 600, decoy, 520, 3, TCPDPI_STRONG_REPEATS + 1) == 0);
  CHECK(tcpdpi_build_strong4(segs, 5, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, real, 600, decoy, 520, 3, 4) == 0);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, big, 1448, decoy, 520, 3, 2) == 1);
  uint8_t huge[1700]; memset(huge, 1, sizeof huge);
  CHECK(tcpdpi_build_strong4(segs, TCPDPI_STRONG_SEGS, &ns, &ts, t, 20, t + 20, 32, 1, seq, 64, huge, 1700, decoy, 520, 3, 2) == 0);
}

int main(void) {
  test_rst();
  test_hops();
  test_seqovl();
  test_fakedsplit();
  test_split();
  test_tlsrec();
  test_tlsrec_pair();
  test_xlate();
  test_ts_offset();
  test_ts_decoy();
  test_seqovl_prefix();
  test_strong();
  if (fails == 0) { printf("ALL TCPDPI TESTS PASSED\n"); return 0; }
  printf("%d FAILED\n", fails); return 1;
}
