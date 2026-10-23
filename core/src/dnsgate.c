/*
 * dnsgate.c — Advanced mode answers other programs' plain DNS with encrypted
 * DNS. See dnsgate.h.
 */
#include "dnsgate.h"
#include "doh.h"
#include "platform.h"
#include "rawscope.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Names being asked at once, and programs waiting for each. A question that
 * finds no room goes on unchanged. */
#define SLOTS   32
#define WAITERS 6
#define PKT_MAX 1500

typedef struct {
  int     len;
  uint8_t pkt[PKT_MAX];
  uint8_t meta[DNSGATE_META_MAX];
} waiter;

typedef struct {
  int      used;
  uint32_t gen;
  char     name[256];
  uint16_t qtype;
  uint16_t ask_id;      /* the id the gate asks the forwarder with */
  int      nw;
  waiter  *w[WAITERS];
} slot;

typedef struct {
  int      idx;
  uint32_t gen;
  uint16_t qtype;
  int      qlen;
  int      qend;
  uint8_t  q[PKT_MAX];
} job;

static mutex_t g_mx;
static _Atomic int g_mx_ready = 0;
static slot g_slots[SLOTS];
static uint32_t g_gen = 0;
static uint64_t g_rest_until = 0;
static uint32_t g_idseq = 0;
static int g_port = 0;
static int g_meta_len = 0;
static dnsgate_send_fn g_send = NULL;
static _Atomic int g_running = 0;
static _Atomic unsigned long g_answered = 0, g_passed = 0;

static uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

/* ── the pure parts ─────────────────────────────────────────────────────── */

int dnsgate_payload(const uint8_t *pkt, int len, int *dns_len) {
  if (!pkt || len < 20) return -1;
  int off, ulen;
  if ((pkt[0] >> 4) == 4) {
    int ihl = (pkt[0] & 0x0f) * 4;
    if (ihl < 20 || len < ihl + 8 || pkt[9] != 17) return -1;
    if ((rd16(pkt + 6) & 0x3fff) != 0) return -1;            /* a fragment */
    if (rd16(pkt + ihl + 2) != 53) return -1;
    off = ihl + 8;
    ulen = rd16(pkt + ihl + 4);
    if (ulen < 8 || ihl + ulen > len) return -1;
    *dns_len = ulen - 8;
  } else if ((pkt[0] >> 4) == 6) {
    if (len < 48 || pkt[6] != 17) return -1;                  /* extension headers: not ours */
    if (rd16(pkt + 42) != 53) return -1;
    off = 48;
    ulen = rd16(pkt + 44);
    if (ulen < 8 || 40 + ulen > len) return -1;
    *dns_len = ulen - 8;
  } else {
    return -1;
  }
  return *dns_len >= 12 ? off : -1;
}

int dnsgate_question(const uint8_t *dns, int len, char *name, int cap, uint16_t *qtype, int *qend) {
  if (len < 17 || cap < 2) return -1;
  if (dns[2] & 0x80) return -1;                    /* a response */
  if ((dns[2] >> 3) & 0x0f) return -1;             /* not a standard query */
  if (rd16(dns + 4) != 1 || rd16(dns + 6) != 0 || rd16(dns + 8) != 0) return -1;
  int p = 12, k = 0;
  for (;;) {
    if (p >= len) return -1;
    int l = dns[p];
    if (l == 0) { p++; break; }
    if (l & 0xc0 || p + 1 + l > len) return -1;    /* no compression in a question */
    if (k + l + 2 > cap || k + l + 1 > 253) return -1;
    if (k) name[k++] = '.';
    for (int i = 0; i < l; i++) {
      uint8_t c = dns[p + 1 + i];
      if (c == 0 || c == '.') return -1;
      name[k++] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    p += 1 + l;
  }
  if (p + 4 > len || rd16(dns + p + 2) != 1) return -1;   /* class IN */
  name[k] = 0;
  *qtype = rd16(dns + p);
  *qend = p + 4;
  return 0;
}

int dnsgate_udp_limit(const uint8_t *dns, int len, int qend) {
  /* An OPT record first among the additional ones: root name, type 41,
   * its class the sender's UDP size. */
  if (rd16(dns + 10) >= 1 && qend + 11 <= len && dns[qend] == 0 && rd16(dns + qend + 1) == 41) {
    int size = rd16(dns + qend + 3);
    return size < 512 ? 512 : size > 1232 ? 1232 : size;
  }
  return 512;
}

static uint32_t sum16(uint32_t s, const uint8_t *p, int n) {
  for (int i = 0; i + 1 < n; i += 2) s += (uint32_t)((p[i] << 8) | p[i + 1]);
  if (n & 1) s += (uint32_t)(p[n - 1] << 8);
  return s;
}
static uint16_t fold(uint32_t s) {
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (uint16_t)~s;
}

void dnsgate_checksum(uint8_t *pkt, int len) {
  int dl, off = dnsgate_payload(pkt, len, &dl);
  if (off < 0) return;
  uint8_t *udp = pkt + off - 8;
  uint32_t s;
  if ((pkt[0] >> 4) == 6) {
    s = sum16(0, pkt + 8, 32);
  } else {
    int ihl = (pkt[0] & 0x0f) * 4;
    wr16(pkt + 10, 0);
    wr16(pkt + 10, fold(sum16(0, pkt, ihl)));
    s = sum16(0, pkt + 12, 8);
  }
  wr16(udp + 6, 0);
  s += 17 + (uint32_t)(8 + dl);
  uint16_t c = fold(sum16(s, udp, 8 + dl));
  wr16(udp + 6, c ? c : 0xffff);
}

int dnsgate_reply(const uint8_t *q, int qlen, const uint8_t *dns, int dlen, uint8_t *out, int cap) {
  int qdl, qoff = dnsgate_payload(q, qlen, &qdl);
  if (qoff < 0 || dlen < 12) return -1;
  int v6 = (q[0] >> 4) == 6;
  int hl = v6 ? 40 : 20;
  int n = hl + 8 + dlen;
  if (n > cap || 8 + dlen > 0xffff) return -1;
  const uint8_t *qudp = q + qoff - 8;
  uint8_t *udp = out + hl;
  memset(out, 0, (size_t)(hl + 8));
  uint32_t s;
  if (v6) {
    out[0] = 0x60;
    wr16(out + 4, (uint16_t)(8 + dlen));
    out[6] = 17;
    out[7] = 64;
    memcpy(out + 8, q + 24, 16);                 /* from the server it asked */
    memcpy(out + 24, q + 8, 16);                 /* to the program */
    s = sum16(0, out + 8, 32);
  } else {
    out[0] = 0x45;
    wr16(out + 2, (uint16_t)n);
    wr16(out + 4, (uint16_t)(rd16(q + 4) + 1));
    out[6] = 0x40;                               /* don't fragment */
    out[8] = 64;
    out[9] = 17;
    memcpy(out + 12, q + 16, 4);
    memcpy(out + 16, q + 12, 4);
    wr16(out + 10, fold(sum16(0, out, 20)));
    s = sum16(0, out + 12, 8);
  }
  memcpy(udp, qudp + 2, 2);                      /* from port 53 */
  memcpy(udp + 2, qudp, 2);                      /* to the program's port */
  wr16(udp + 4, (uint16_t)(8 + dlen));
  memcpy(udp + 8, dns, (size_t)dlen);
  memcpy(udp + 8, q + qoff, 2);                  /* under the question's id */
  s += 17 + (uint32_t)(8 + dlen);
  uint16_t c = fold(sum16(s, udp, 8 + dlen));
  wr16(udp + 6, c ? c : 0xffff);
  return n;
}

/* ── the gate ───────────────────────────────────────────────────────────── */

int dnsgate_start(int fwd_port, dnsgate_send_fn send_fn, int meta_len) {
  if (fwd_port <= 0 || fwd_port > 65535 || !send_fn || meta_len < 0 || meta_len > DNSGATE_META_MAX) return -1;
  if (!atomic_exchange(&g_mx_ready, 1)) mutex_init(&g_mx);
  mutex_lock(&g_mx);
  g_port = fwd_port;
  g_send = send_fn;
  g_meta_len = meta_len;
  g_rest_until = 0;
  g_idseq = (uint32_t)now_ms();
  mutex_unlock(&g_mx);
  atomic_store(&g_answered, 0);
  atomic_store(&g_passed, 0);
  atomic_store(&g_running, 1);
  return 0;
}

void dnsgate_stop(void) { atomic_store(&g_running, 0); }
int dnsgate_on(void) { return atomic_load(&g_running); }
unsigned long dnsgate_answered(void) { return atomic_load(&g_answered); }
unsigned long dnsgate_passed(void) { return atomic_load(&g_passed); }

/* The forwarder's answer to q (its id the gate's): its length, or -1 when it
 * did not answer in time or is not there. */
static int ask(const job *j, uint8_t *r, int cap) {
  sock_t s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == SOCK_INVALID) return -1;
  struct sockaddr_in to;
  memset(&to, 0, sizeof(to));
  to.sin_family = AF_INET;
  to.sin_port = htons((uint16_t)g_port);
  to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int got = -1;
  if (connect(s, (struct sockaddr *)&to, sizeof(to)) == 0 &&
      send(s, (const char *)j->q, j->qlen, 0) == j->qlen) {
    sock_set_nonblock(s, 1);
    uint64_t end = now_ms() + DNSGATE_WAIT_MS;
    for (;;) {
      uint64_t t = now_ms();
      if (t >= end || sock_wait_readable(s, (int)(end - t)) <= 0) break;
      int n = (int)recv(s, (char *)r, cap, 0);
      /* An error after the socket said it was readable: nothing listens
       * there (an ICMP refusal), no use waiting. */
      if (n < 0) break;
      if (n < j->qend || rd16(r) != rd16(j->q) || !(r[2] & 0x80)) continue;
      int same = 1;
      for (int i = 12; i < j->qend && same; i++) {
        uint8_t a = r[i], b = j->q[i];
        if (a >= 'A' && a <= 'Z') a = (uint8_t)(a + 32);
        if (b >= 'A' && b <= 'Z') b = (uint8_t)(b + 32);
        same = a == b;
      }
      if (same) { got = n; break; }
    }
  }
  sock_close(s);
  return got;
}

/* One program's question, answered with r (usable) or sent on unchanged. */
static void deliver(waiter *w, const uint8_t *r, int rl) {
  if (!atomic_load(&g_running)) return;
  if (r) {
    int dl, off = dnsgate_payload(w->pkt, w->len, &dl);
    char name[256]; uint16_t qt; int qend;
    if (off >= 0 && dnsgate_question(w->pkt + off, dl, name, sizeof name, &qt, &qend) == 0 &&
        rl <= dnsgate_udp_limit(w->pkt + off, dl, qend)) {
      uint8_t out[PKT_MAX + 48 + 1232];
      int n = dnsgate_reply(w->pkt, w->len, r, rl, out, (int)sizeof out);
      if (n > 0) {
        g_send(out, n, w->meta, 1);
        atomic_fetch_add(&g_answered, 1);
        rawscope_count(RAWSCOPE_DNS_ANSWERED);
        return;
      }
    }
  }
  g_send(w->pkt, w->len, w->meta, 0);
  atomic_fetch_add(&g_passed, 1);
  rawscope_count(RAWSCOPE_DNS_PASSED);
}

static void *worker(void *p) {
  job *j = (job *)p;
  uint8_t r[4096];
  int rl = ask(j, r, (int)sizeof r);
  int usable = rl > 0 && doh_reply_usable(r, rl, j->qtype);
  waiter *ws[WAITERS];
  int nw = 0;
  mutex_lock(&g_mx);
  slot *s = &g_slots[j->idx];
  if (s->used && s->gen == j->gen) {
    nw = s->nw;
    memcpy(ws, s->w, sizeof(ws[0]) * (size_t)nw);
    s->used = 0;
    s->nw = 0;
  }
  /* No answer at all: the forwarder is down or busy. The next questions go
   * straight on for a while, rather than each waiting out DNSGATE_WAIT_MS. */
  if (rl < 0) g_rest_until = now_ms() + DNSGATE_REST_MS;
  mutex_unlock(&g_mx);
  for (int i = 0; i < nw; i++) { deliver(ws[i], usable ? r : NULL, rl); free(ws[i]); }
  free(j);
  return NULL;
}

static int pass(void) { atomic_fetch_add(&g_passed, 1); rawscope_count(RAWSCOPE_DNS_PASSED); return 0; }

int dnsgate_take(const uint8_t *pkt, int len, const void *meta) {
  if (!atomic_load(&g_running) || len > PKT_MAX) return 0;
  int dl, off = dnsgate_payload(pkt, len, &dl);
  if (off < 0) return 0;
  char name[256];
  uint16_t qt;
  int qend;
  if (dnsgate_question(pkt + off, dl, name, sizeof name, &qt, &qend) != 0) return pass();
  if (!name[0] || doh_local_name(name)) return pass();
  uint16_t id = rd16(pkt + off);

  waiter *w = (waiter *)malloc(sizeof(waiter));
  if (!w) return pass();
  w->len = len;
  memcpy(w->pkt, pkt, (size_t)len);
  memcpy(w->meta, meta, (size_t)g_meta_len);

  mutex_lock(&g_mx);
  if (now_ms() < g_rest_until) { mutex_unlock(&g_mx); free(w); return pass(); }
  int fresh = -1;
  for (int i = 0; i < SLOTS; i++) {
    slot *s = &g_slots[i];
    if (!s->used) { if (fresh < 0) fresh = i; continue; }
    if (s->qtype != qt || strcmp(s->name, name) != 0) continue;
    /* The gate's own question, on its way from the forwarder to the user's
     * own plain-DNS server: never answered by the gate itself. */
    if (id == s->ask_id) { mutex_unlock(&g_mx); free(w); return 0; }
    if (s->nw >= WAITERS) { mutex_unlock(&g_mx); free(w); return pass(); }
    s->w[s->nw++] = w;
    mutex_unlock(&g_mx);
    return 1;
  }
  job *j = fresh >= 0 ? (job *)malloc(sizeof(job)) : NULL;
  if (!j) { mutex_unlock(&g_mx); free(w); return pass(); }
  slot *s = &g_slots[fresh];
  s->used = 1;
  s->gen = ++g_gen;
  snprintf(s->name, sizeof s->name, "%s", name);
  s->qtype = qt;
  do { g_idseq = g_idseq * 1103515245u + 12345u; s->ask_id = (uint16_t)(g_idseq >> 16); } while (s->ask_id == id);
  s->nw = 1;
  s->w[0] = w;
  j->idx = fresh;
  j->gen = s->gen;
  j->qtype = qt;
  j->qlen = dl;
  j->qend = qend;
  memcpy(j->q, pkt + off, (size_t)dl);
  wr16(j->q, s->ask_id);
  mutex_unlock(&g_mx);
  if (thread_spawn(worker, j, 128 * 1024) != 0) {
    waiter *ws[WAITERS];
    int nw = 0;
    mutex_lock(&g_mx);
    if (s->used && s->gen == j->gen) {
      nw = s->nw;
      memcpy(ws, s->w, sizeof(ws[0]) * (size_t)nw);
      s->used = 0;
      s->nw = 0;
    }
    mutex_unlock(&g_mx);
    free(j);
    /* Whoever joined meanwhile is sent on as well; this one by the caller. */
    for (int i = 0; i < nw; i++) { if (ws[i] != w) deliver(ws[i], NULL, 0); free(ws[i]); }
    return pass();
  }
  return 1;
}
