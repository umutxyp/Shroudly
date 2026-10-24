/* The packet queue over netlink (nfq.c): the messages Shroudly sends are the
 * bytes the kernel's nfnetlink_queue expects, and what it reads back is
 * taken apart right, packets and the rest, whole or cut. Pure: runs on any
 * system; the socket itself runs in the Linux lab (tests/lab/advanced-lab.sh). */
#include "../src/nfq.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)

static uint32_t h32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint16_t h16(const uint8_t *p) { uint16_t v; memcpy(&v, p, 2); return v; }
static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static void put32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
static void put16(uint8_t *p, uint16_t v) { memcpy(p, &v, 2); }
static void putbe32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v; }

static void test_messages(void) {
  uint8_t m[128];
  /* Bind queue 200 for IPv4, asking for an ack. */
  int n = nfq_build_cmd(m, sizeof m, 200, 1, 7);
  CHECK(n == 28 && h32(m) == 28);
  CHECK(h16(m + 4) == ((3 << 8) | 2));          /* the queue subsystem, a config */
  CHECK(h16(m + 6) == (0x01 | 0x04));           /* a request, with an ack */
  CHECK(h32(m + 8) == 7);
  CHECK(m[16] == 0 && m[17] == 0 && m[18] == 0 && m[19] == 200);  /* AF_UNSPEC, v0, queue 200 */
  CHECK(h16(m + 20) == 8 && h16(m + 22) == 1);  /* NFQA_CFG_CMD, 4 bytes */
  CHECK(m[24] == 1 && m[25] == 0 && m[26] == 0 && m[27] == 2);    /* BIND, pf AF_INET */
  /* The family-wide commands name no queue. */
  n = nfq_build_cmd(m, sizeof m, 200, 3, 8);
  CHECK(n == 28 && m[18] == 0 && m[19] == 0 && m[24] == 3);
  /* Whole packets, up to 0xffff bytes. */
  n = nfq_build_mode(m, sizeof m, 200, 0xffff, 9);
  CHECK(n == 32 && h32(m) == 32);
  CHECK(h16(m + 20) == 9 && h16(m + 22) == 2);  /* NFQA_CFG_PARAMS: 4 + 5 bytes */
  CHECK(be32(m + 24) == 0xffff && m[28] == 2);  /* copy_range, NFQNL_COPY_PACKET */
  CHECK(m[29] == 0 && m[30] == 0 && m[31] == 0); /* padding */
  /* The verdict for packet 0x01020304: accept, no ack asked. */
  n = nfq_build_verdict(m, sizeof m, 200, 0x01020304, 1);
  CHECK(n == 32 && h16(m + 4) == ((3 << 8) | 1) && h16(m + 6) == 0x01);
  CHECK(h16(m + 20) == 12 && h16(m + 22) == 2);  /* NFQA_VERDICT_HDR */
  CHECK(be32(m + 24) == 1 && be32(m + 28) == 0x01020304);
  /* Too little room: nothing written. */
  CHECK(nfq_build_cmd(m, 16, 200, 1, 1) == -1 && nfq_build_verdict(m, 8, 200, 1, 1) == -1);
}

/* A packet message as the kernel writes it: id, mark, payload. */
static size_t packet_msg(uint8_t *out, uint32_t id, uint32_t mark, const uint8_t *pl, size_t plen, int with_mark) {
  size_t n = 20;
  memset(out, 0, 20);
  put16(out + 4, (3 << 8) | 0);
  out[16] = 2;                                  /* AF_INET */
  put16(out + 18, 0);
  /* NFQA_PACKET_HDR: id, hw_protocol, hook (7 bytes) */
  put16(out + n, 11); put16(out + n + 2, 1); putbe32(out + n + 4, id); out[n + 8] = 0x08; out[n + 9] = 0; out[n + 10] = 3;
  n += 12;
  if (with_mark) { put16(out + n, 8); put16(out + n + 2, 3 | 0x4000); putbe32(out + n + 4, mark); n += 8; }
  put16(out + n, (uint16_t)(4 + plen)); put16(out + n + 2, 10); memcpy(out + n + 4, pl, plen);
  n += (4 + plen + 3) & ~(size_t)3;
  put32(out, (uint32_t)n);
  return n;
}

typedef struct { int n; uint32_t id[8], mark[8]; int len[8]; uint8_t first[8]; } seen;
static void collect(const nfq_packet *p, void *ud) {
  seen *s = (seen *)ud;
  if (s->n < 8) { s->id[s->n] = p->id; s->mark[s->n] = p->mark; s->len[s->n] = p->len; s->first[s->n] = p->payload ? p->payload[0] : 0; }
  s->n++;
}

static void test_parse(void) {
  uint8_t buf[512], ip[45];
  memset(ip, 0, sizeof ip); ip[0] = 0x45;
  size_t n = packet_msg(buf, 42, 0x5badd0e, ip, sizeof ip, 1);
  /* An ack (NLMSG_ERROR, error 0) between two packets. */
  memset(buf + n, 0, 36); put32(buf + n, 36); put16(buf + n + 4, 2); n += 36;
  uint8_t ip2[20]; memset(ip2, 0, sizeof ip2); ip2[0] = 0x45;
  n += packet_msg(buf + n, 43, 0, ip2, sizeof ip2, 0);
  seen s; memset(&s, 0, sizeof s);
  CHECK(nfq_parse(buf, n, collect, &s) == 2 && s.n == 2);
  CHECK(s.id[0] == 42 && s.mark[0] == 0x5badd0e && s.len[0] == 45 && s.first[0] == 0x45);
  CHECK(s.id[1] == 43 && s.mark[1] == 0 && s.len[1] == 20);
  /* Cut short: the whole messages before the cut, nothing after. */
  memset(&s, 0, sizeof s);
  CHECK(nfq_parse(buf, n - 10, collect, &s) == 1 && s.id[0] == 42);
  /* An attribute longer than its message: the packet has no payload. */
  uint8_t bad[128];
  size_t bn = packet_msg(bad, 9, 0, ip2, sizeof ip2, 0);
  put16(bad + 32, 200);
  memset(&s, 0, sizeof s);
  CHECK(nfq_parse(bad, bn, collect, &s) == 1 && s.len[0] == 0);
  CHECK(nfq_parse(bad, 8, collect, &s) == -1);
  /* A message claiming more than the buffer holds: nothing. */
  put32(bad, 4096);
  memset(&s, 0, sizeof s);
  CHECK(nfq_parse(bad, bn, collect, &s) == 0);
}

static void test_fuzz(void) {
  uint8_t buf[256];
  srand(7);
  for (int i = 0; i < 200000; i++) {
    size_t n = (size_t)(rand() % (int)sizeof buf);
    for (size_t k = 0; k < n; k++) buf[k] = (uint8_t)rand();
    if (n >= 8 && (i & 1)) { put32(buf, (uint32_t)n); put16(buf + 4, (3 << 8)); }
    nfq_parse(buf, n, NULL, NULL);
  }
  CHECK(1);
}

int main(void) {
  test_messages();
  test_parse();
  test_fuzz();
  if (fails) { printf("test_nfq: %d FAILED\n", fails); return 1; }
  printf("test_nfq: all passed\n");
  return 0;
}
