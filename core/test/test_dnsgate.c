/*
 * test_dnsgate — Advanced mode's DNS gate (core/src/dnsgate.c): other
 * programs' plain DNS questions answered from the encrypted-DNS forwarder,
 * against a forwarder standing in on 127.0.0.1, the packets the gate sends
 * caught by the send callback.
 */
#include "../src/platform.h"
#include "../src/dnsgate.h"
#include "../src/doh.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)

static uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }

/* A question packet from a program: IPv4 192.168.1.20:5353+ -> 192.168.1.1:53,
 * or IPv6 fd00::20 -> fd00::1; with an EDNS OPT record of `edns` bytes (0: none). */
static int mkq(uint8_t *b, int v6, const char *name, uint16_t qtype, uint16_t id, uint16_t sport, int edns) {
  uint8_t d[600];
  int p = 0;
  d[p++] = (uint8_t)(id >> 8); d[p++] = (uint8_t)id;
  d[p++] = 0x01; d[p++] = 0x00;
  d[p++] = 0; d[p++] = 1; d[p++] = 0; d[p++] = 0; d[p++] = 0; d[p++] = 0; d[p++] = 0; d[p++] = edns ? 1 : 0;
  const char *s = name;
  while (*s) {
    const char *dot = strchr(s, '.');
    int l = dot ? (int)(dot - s) : (int)strlen(s);
    d[p++] = (uint8_t)l; memcpy(d + p, s, (size_t)l); p += l;
    if (!dot) break;
    s = dot + 1;
  }
  d[p++] = 0;
  d[p++] = (uint8_t)(qtype >> 8); d[p++] = (uint8_t)qtype; d[p++] = 0; d[p++] = 1;
  if (edns) {
    uint8_t opt[11] = { 0, 0, 41, (uint8_t)(edns >> 8), (uint8_t)edns, 0, 0, 0, 0, 0, 0 };
    memcpy(d + p, opt, 11); p += 11;
  }
  int hl = v6 ? 40 : 20;
  memset(b, 0, (size_t)(hl + 8));
  if (v6) {
    b[0] = 0x60; b[4] = (uint8_t)((8 + p) >> 8); b[5] = (uint8_t)(8 + p); b[6] = 17; b[7] = 64;
    b[8] = 0xfd; b[23] = 0x20; b[24] = 0xfd; b[39] = 0x01;
  } else {
    b[0] = 0x45; b[2] = (uint8_t)((28 + p) >> 8); b[3] = (uint8_t)(28 + p); b[4] = 0x12; b[5] = 0x34;
    b[8] = 128; b[9] = 17;
    b[12] = 192; b[13] = 168; b[14] = 1; b[15] = 20; b[16] = 192; b[17] = 168; b[18] = 1; b[19] = 1;
  }
  uint8_t *u = b + hl;
  u[0] = (uint8_t)(sport >> 8); u[1] = (uint8_t)sport; u[2] = 0; u[3] = 53;
  u[4] = (uint8_t)((8 + p) >> 8); u[5] = (uint8_t)(8 + p);
  memcpy(u + 8, d, (size_t)p);
  return hl + 8 + p;
}

static uint32_t sum16(uint32_t s, const uint8_t *p, int n) {
  for (int i = 0; i + 1 < n; i += 2) s += (uint32_t)((p[i] << 8) | p[i + 1]);
  if (n & 1) s += (uint32_t)(p[n - 1] << 8);
  return s;
}
static int csum_ok(uint32_t s) { while (s >> 16) s = (s & 0xffff) + (s >> 16); return s == 0xffff; }

/* ── the forwarder standing in ─────────────────────────────────────────────
 * gate.example: 93.184.216.34; lan.example: 10.1.2.3 only; aaaa.example:
 * no AAAA (an answer, no record); big.example: 40 addresses; slow.example:
 * answers after 400 ms; anything else does not exist. */
static struct { sock_t s; int port; _Atomic int stop; _Atomic int asked; _Atomic int slow_id; } F;

static void *fwd(void *arg) {
  (void)arg;
  while (!atomic_load(&F.stop)) {
    if (sock_wait_readable(F.s, 50) != 1) continue;
    uint8_t q[1500], r[1500];
    struct sockaddr_in from; socklen_t fl = sizeof(from);
    int n = (int)recvfrom(F.s, (char *)q, sizeof q, 0, (struct sockaddr *)&from, &fl);
    if (n < 17) continue;
    atomic_fetch_add(&F.asked, 1);
    char name[256]; int p = 12, k = 0;
    while (p < n && q[p]) { int l = q[p]; if (k) name[k++] = '.'; memcpy(name + k, q + p + 1, (size_t)l); k += l; p += 1 + l; }
    name[k] = 0;
    int qend = p + 5;
    uint16_t qtype = rd16(q + p + 1);
    memcpy(r, q, (size_t)qend);
    r[2] = 0x81; r[3] = 0x80;
    r[6] = r[7] = r[8] = r[9] = r[10] = r[11] = 0;
    int m = qend, an = 0;
    uint32_t ip = 0;
    if (!strcmp(name, "gate.example") || !strcmp(name, "slow.example")) ip = 0x5db8d822;
    else if (!strcmp(name, "lan.example")) ip = 0x0a010203;
    int count = !strcmp(name, "big.example") ? 40 : ip ? 1 : 0;
    if (!strcmp(name, "big.example")) ip = 0x5db8d800;
    if (qtype == 1) {
      for (int i = 0; i < count; i++) {
        uint32_t a = ip + (uint32_t)i;
        uint8_t rr[16] = { 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, (uint8_t)(a >> 24), (uint8_t)(a >> 16), (uint8_t)(a >> 8), (uint8_t)a };
        memcpy(r + m, rr, 16); m += 16; an++;
      }
    }
    if (!count && strcmp(name, "aaaa.example") != 0) r[3] = 0x83;      /* no such name */
    r[7] = (uint8_t)an;
    if (!strcmp(name, "slow.example")) { atomic_store(&F.slow_id, rd16(q)); sleep_ms(400); }
    sendto(F.s, (const char *)r, m, 0, (struct sockaddr *)&from, fl);
  }
  return NULL;
}

/* ── what the gate sends ───────────────────────────────────────────────── */
typedef struct { int inbound, len, meta; uint8_t pkt[2048]; } sent;
static mutex_t g_smx;
static sent g_sent[64];
static _Atomic int g_nsent = 0;

static void on_send(const uint8_t *pkt, int len, const void *meta, int inbound) {
  mutex_lock(&g_smx);
  int i = atomic_load(&g_nsent);
  if (i < 64 && len <= 2048) {
    g_sent[i].inbound = inbound; g_sent[i].len = len;
    memcpy(&g_sent[i].meta, meta, sizeof(int));
    memcpy(g_sent[i].pkt, pkt, (size_t)len);
    atomic_store(&g_nsent, i + 1);
  }
  mutex_unlock(&g_smx);
}
/* Waits for the n-th packet sent (1-based) and returns it, or NULL. */
static sent *nth(int n, int ms) {
  for (int t = 0; t < ms && atomic_load(&g_nsent) < n; t += 5) sleep_ms(5);
  return atomic_load(&g_nsent) >= n ? &g_sent[n - 1] : NULL;
}
/* The DNS id of an answer the gate built. */
static uint16_t reply_id(const sent *s) { return rd16(s->pkt + ((s->pkt[0] >> 4) == 6 ? 48 : 28)); }

int main(void) {
  plat_init();
  mutex_init(&g_smx);
  uint8_t q[1600], out[3000];

  /* 1. the question inside the packet */
  { int n = mkq(q, 0, "Gate.Example", 1, 0x1111, 50000, 0);
    int dl, off = dnsgate_payload(q, n, &dl);
    CHECK(off == 28 && dl == n - 28);
    char name[256]; uint16_t qt; int qend;
    CHECK(dnsgate_question(q + off, dl, name, sizeof name, &qt, &qend) == 0 && !strcmp(name, "gate.example") && qt == 1 && qend == dl);
    CHECK(dnsgate_udp_limit(q + off, dl, qend) == 512);
    n = mkq(q, 1, "x.example", 28, 1, 50000, 4096);
    off = dnsgate_payload(q, n, &dl);
    CHECK(off == 48 && dnsgate_question(q + off, dl, name, sizeof name, &qt, &qend) == 0 && qt == 28);
    CHECK(dnsgate_udp_limit(q + off, dl, qend) == 1232);
    n = mkq(q, 0, "x.example", 1, 1, 50000, 0);
    q[28 + 2] |= 0x80;                                   /* a response */
    CHECK(dnsgate_question(q + 28, n - 28, name, sizeof name, &qt, &qend) == -1);
    n = mkq(q, 0, "x.example", 1, 1, 50000, 0);
    q[6] = 0x20;                                         /* a fragment */
    CHECK(dnsgate_payload(q, n, &dl) == -1);
    n = mkq(q, 0, "x.example", 1, 1, 50000, 0);
    q[23] = 54;                                          /* not to port 53 */
    CHECK(dnsgate_payload(q, n, &dl) == -1);
    for (int cut = 0; cut < n; cut++) dnsgate_payload(q, cut, &dl);   /* never past the end */
  }
  printf("  questions read, others refused: OK\n");

  /* 2. the answer packet: from the server asked, to the program, under its id,
   *    with good checksums */
  for (int v6 = 0; v6 <= 1; v6++) {
    int n = mkq(q, v6, "gate.example", 1, 0xabcd, 50001, 0);
    uint8_t dns[64]; memset(dns, 0, sizeof dns);
    dns[0] = 0x99; dns[1] = 0x99; dns[2] = 0x81; dns[3] = 0x80;
    int m = dnsgate_reply(q, n, dns, 40, out, sizeof out);
    int hl = v6 ? 40 : 20;
    CHECK(m == hl + 8 + 40);
    CHECK(rd16(out + hl) == 53 && rd16(out + hl + 2) == 50001 && rd16(out + hl + 4) == 48);
    CHECK(rd16(out + hl + 8) == 0xabcd);
    uint32_t ps;
    if (v6) {
      CHECK(out[0] == 0x60 && out[6] == 17 && rd16(out + 4) == 48);
      CHECK(!memcmp(out + 8, q + 24, 16) && !memcmp(out + 24, q + 8, 16));
      ps = sum16(0, out + 8, 32);
    } else {
      CHECK(out[0] == 0x45 && out[9] == 17 && rd16(out + 2) == m);
      CHECK(!memcmp(out + 12, q + 16, 4) && !memcmp(out + 16, q + 12, 4));
      CHECK(csum_ok(sum16(0, out, 20)));
      ps = sum16(0, out + 12, 8);
    }
    CHECK(csum_ok(sum16(ps + 17 + 48, out + hl, 48)));
    CHECK(dnsgate_reply(q, n, dns, 40, out, hl + 8 + 39) == -1);   /* does not fit */
  }
  /* A question whose checksums were left to the network card: filled in. */
  for (int v6 = 0; v6 <= 1; v6++) {
    int n = mkq(q, v6, "gate.example", 1, 0xabcd, 50001, 0);
    int hl = v6 ? 40 : 20;
    q[hl + 6] = 0x12; q[hl + 7] = 0x34;
    if (!v6) { q[10] = 0; q[11] = 0; }
    dnsgate_checksum(q, n);
    uint32_t ps = v6 ? sum16(0, q + 8, 32) : sum16(0, q + 12, 8);
    CHECK(csum_ok(sum16(ps + 17 + (uint32_t)(n - hl), q + hl, n - hl)));
    if (!v6) CHECK(csum_ok(sum16(0, q, 20)));
  }
  printf("  answer packets (IPv4, IPv6), checksums: OK\n");

  /* 3. the gate, against the forwarder standing in */
  F.s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  { struct sockaddr_in a; memset(&a, 0, sizeof a); socklen_t al = sizeof a;
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bind(F.s, (struct sockaddr *)&a, sizeof a); getsockname(F.s, (struct sockaddr *)&a, &al);
    F.port = ntohs(a.sin_port); }
  thread_spawn(fwd, NULL, 0);
  CHECK(dnsgate_take(q, mkq(q, 0, "gate.example", 1, 1, 1, 0), &(int){0}) == 0);   /* not started: hands off */
  CHECK(dnsgate_start(F.port, on_send, sizeof(int)) == 0 && dnsgate_on());
  int meta = 7;

  /* An address: answered as if from the server the program asked. */
  int n = mkq(q, 0, "gate.example", 1, 0x0101, 40001, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  sent *s = nth(1, 2000);
  CHECK(s && s->inbound && s->meta == 7 && reply_id(s) == 0x0101 && rd16(s->pkt + 22) == 40001);
  CHECK(s && s->len == 28 + 30 + 16 && s->pkt[28 + 3] == 0x80 && rd16(s->pkt + 28 + 6) == 1);
  /* IPv6 too, and "no AAAA record" is an answer. */
  n = mkq(q, 1, "aaaa.example", 28, 0x0202, 40002, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  s = nth(2, 2000);
  CHECK(s && s->inbound && (s->pkt[0] >> 4) == 6 && reply_id(s) == 0x0202 && rd16(s->pkt + 48 + 6) == 0);
  /* No such name, or a private address only: the program's own DNS answers
   * (an intranet), so the question goes on unchanged. */
  n = mkq(q, 0, "nx.example", 1, 0x0303, 40003, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  s = nth(3, 2000);
  CHECK(s && !s->inbound && s->len == n && !memcmp(s->pkt, q, (size_t)n));
  n = mkq(q, 0, "lan.example", 1, 0x0404, 40004, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  s = nth(4, 2000);
  CHECK(s && !s->inbound && !memcmp(s->pkt, q, (size_t)n));
  /* An answer bigger than the program takes over UDP: its own DNS answers;
   * with EDNS room for it, the gate does. */
  n = mkq(q, 0, "big.example", 1, 0x0505, 40005, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  s = nth(5, 2000);
  CHECK(s && !s->inbound);
  n = mkq(q, 0, "big.example", 1, 0x0606, 40006, 1232);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  s = nth(6, 2000);
  CHECK(s && s->inbound && rd16(s->pkt + 28 + 6) == 40);
  /* A name only the local network knows: not even asked. */
  int asked = atomic_load(&F.asked);
  CHECK(dnsgate_take(q, mkq(q, 0, "nas.lan", 1, 7, 40007, 0), &meta) == 0);
  CHECK(dnsgate_take(q, mkq(q, 0, "router", 1, 7, 40007, 0), &meta) == 0);
  CHECK(atomic_load(&F.asked) == asked);
  printf("  answered, sent on, not asked: OK\n");

  /* The same name asked again while the first is out (a program retrying
   * after a second): answered together. The gate's own question, coming
   * back from the forwarder on its way to the user's own plain-DNS server:
   * sent on, never answered by the gate itself. */
  n = mkq(q, 0, "slow.example", 1, 0x0707, 40008, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  for (int t = 0; t < 1000 && !atomic_load(&F.slow_id); t += 5) sleep_ms(5);
  int own = atomic_load(&F.slow_id);
  CHECK(own != 0 && own != 0x0707);
  CHECK(dnsgate_take(q, mkq(q, 0, "slow.example", 1, (uint16_t)own, 50000, 0), &meta) == 0);
  CHECK(dnsgate_take(q, mkq(q, 0, "SLOW.example", 1, 0x0808, 40009, 0), &meta) == 1);
  CHECK(dnsgate_take(q, mkq(q, 0, "slow.example", 28, 0x0909, 40010, 0), &meta) == 1);   /* another type: its own */
  s = nth(9, 3000);
  CHECK(s != NULL);
  int got7 = 0, got8 = 0;
  for (int i = 6; i < atomic_load(&g_nsent); i++)
    if (g_sent[i].inbound) { if (reply_id(&g_sent[i]) == 0x0707) got7++; if (reply_id(&g_sent[i]) == 0x0808) got8++; }
  CHECK(got7 == 1 && got8 == 1);
  printf("  asked again meanwhile: one question, both answered; the gate's own sent on: OK\n");

  /* The forwarder gone: the question goes on at once, and the next ones go
   * straight on, not asked, for a while. */
  dnsgate_stop();
  atomic_store(&F.stop, 1);
  sleep_ms(100);
  sock_close(F.s);
  CHECK(dnsgate_start(F.port, on_send, sizeof(int)) == 0);
  int before = atomic_load(&g_nsent);
  uint64_t t0 = now_ms();
  n = mkq(q, 0, "gate.example", 1, 0x0a0a, 40011, 0);
  CHECK(dnsgate_take(q, n, &meta) == 1);
  s = nth(before + 1, 3000);
  CHECK(s && !s->inbound && !memcmp(s->pkt, q, (size_t)n));
  CHECK(now_ms() - t0 <= DNSGATE_WAIT_MS + 200);
  CHECK(dnsgate_take(q, mkq(q, 0, "gate.example", 1, 0x0b0b, 40012, 0), &meta) == 0);
  CHECK(dnsgate_passed() >= 2 && dnsgate_answered() == 0);
  dnsgate_stop();
  CHECK(!dnsgate_on() && dnsgate_take(q, n, &meta) == 0);
  printf("  forwarder gone: sent on, then left alone: OK\n");

  if (fails == 0) { printf("DNS GATE TESTS PASSED\n"); return 0; }
  printf("%d FAILED\n", fails);
  return 1;
}
