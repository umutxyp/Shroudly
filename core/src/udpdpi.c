/*
 * udpdpi.c — see udpdpi.h. Pure classifiers + flow table + decoy builder for
 * Advanced-mode UDP handling. No network, no platform headers.
 */
#include "udpdpi.h"
#include <stdio.h>
#include <string.h>

/* ── QUIC ────────────────────────────────────────────────────────────────── */
int quic_is_initial(const uint8_t *p, int len) {
  if (!p || len < 5) return 0;
  if ((p[0] & 0x80) == 0) return 0;             /* short header -> not Initial */
  uint32_t ver = ((uint32_t)p[1] << 24) | ((uint32_t)p[2] << 16) |
                 ((uint32_t)p[3] << 8) | (uint32_t)p[4];
  if (ver == 0x00000000u) return 0;             /* Version Negotiation */
  if (ver == 0x00000001u) return 1;             /* QUIC v1 (RFC 9000) */
  if (ver == 0x6b3343cfu) return 1;             /* QUIC v2 (RFC 9369) */
  if ((ver & 0xffffff00u) == 0xff000000u) return 1; /* IETF drafts 0xff0000xx */
  return 0;
}

/* ── Discord voice / STUN ────────────────────────────────────────────────── */
int discord_is_ip_discovery(const uint8_t *p, int len) {
  /* type 0x0001, length 0x0046 (70), 70 + 4 == 74 total. Exact match. */
  if (!p || len != 74) return 0;
  return p[0] == 0x00 && p[1] == 0x01 && p[2] == 0x00 && p[3] == 0x46;
}

int stun_is_binding_request(const uint8_t *p, int len) {
  if (!p || len < 20) return 0;
  if (p[0] != 0x00 || p[1] != 0x01) return 0;   /* message type: Binding request */
  /* magic cookie 0x2112A442 at offset 4 */
  if (p[4] != 0x21 || p[5] != 0x12 || p[6] != 0xa4 || p[7] != 0x42) return 0;
  int mlen = (p[2] << 8) | p[3];                /* STUN message length */
  if (mlen & 0x3) return 0;                     /* must be a multiple of 4 */
  if (20 + mlen > len) return 0;                /* must fit the datagram */
  return 1;
}

int udp_is_discord_voice(const uint8_t *p, int len) {
  return discord_is_ip_discovery(p, len) || stun_is_binding_request(p, len);
}

int discord_voice_port(uint16_t dport_host) {
  if (dport_host >= 50000) return 1;            /* 50000-65535 media range */
  if (dport_host == 3478) return 1;             /* STUN */
  if (dport_host >= 19302 && dport_host <= 19309) return 1; /* Google STUN */
  return 0;
}

/* ── Kernel pre-filters ──────────────────────────────────────────────────── */
#define WD_VOICE_PORTS \
  "(udp.DstPort == 3478 or (udp.DstPort >= 19302 and udp.DstPort <= 19309) or udp.DstPort >= 50000)"

int udp_windivert_clause(char *buf, size_t cap, int quic, int voice, int how) {
  if (!buf || cap == 0) return -1;
  buf[0] = 0;
  if (!quic && !voice) return 0;
  const char *q, *v;
  if (how == UDP_PREFILTER_PAYLOAD) {
    /* A long header: the most significant bit of the first byte. */
    q = "(udp.DstPort == 443 and udp.PayloadLength >= 5 and udp.Payload[0] >= 128)";
    /* 00 01, then either 00 46 in a 74-byte payload (Discord's request) or
     * the STUN magic cookie 21 12 a4 42 (33 18 164 66) at offset 4. Single
     * bytes only: their indexing is the same in every WinDivert 2.x. */
    v = "(" WD_VOICE_PORTS " and udp.PayloadLength >= 20 and udp.Payload[0] == 0 and udp.Payload[1] == 1"
        " and ((udp.PayloadLength == 74 and udp.Payload[2] == 0 and udp.Payload[3] == 70)"
        " or (udp.Payload[4] == 33 and udp.Payload[5] == 18 and udp.Payload[6] == 164 and udp.Payload[7] == 66)))";
  } else {
    q = "udp.DstPort == 443";
    v = WD_VOICE_PORTS;
  }
  int n = snprintf(buf, cap, "(%s%s%s)", quic ? q : "", quic && voice ? " or " : "", voice ? v : "");
  if (n < 0 || (size_t)n >= cap) { buf[0] = 0; return -1; }
  return n;
}

/* ── Per-flow table ──────────────────────────────────────────────────────── */
void udp_flow_init(udp_flow_table *t) {
  memset(t, 0, sizeof(*t));
}

static int flow_match(const udp_flow_entry *e, uint32_t saddr, uint16_t sport,
                      uint32_t daddr, uint16_t dport) {
  return e->saddr == saddr && e->sport == sport &&
         e->daddr == daddr && e->dport == dport;
}

/* Wrap-safe age in ms. */
static uint32_t flow_age(uint32_t now, uint32_t then) { return now - then; }

int udp_flow_note(udp_flow_table *t, uint32_t saddr, uint16_t sport,
                  uint32_t daddr, uint16_t dport, uint32_t now_ms) {
  int free_slot = -1, oldest = 0;
  for (int i = 0; i < UDP_FLOW_MAX; i++) {
    udp_flow_entry *e = &t->e[i];
    if (!e->used) { if (free_slot < 0) free_slot = i; continue; }
    if (flow_age(now_ms, e->ts) > UDP_FLOW_EXPIRE_MS) {
      /* expired: reclaim the slot */
      e->used = 0;
      if (free_slot < 0) free_slot = i;
      continue;
    }
    if (flow_match(e, saddr, sport, daddr, dport)) {
      if (e->count >= UDP_FLOW_FIRST_N) return 0;
      e->count++;
      return 1;
    }
    if (flow_age(now_ms, e->ts) > flow_age(now_ms, t->e[oldest].ts) ||
        !t->e[oldest].used) oldest = i;
  }
  /* new flow */
  int slot = free_slot >= 0 ? free_slot : oldest;
  udp_flow_entry *e = &t->e[slot];
  e->used = 1;
  e->saddr = saddr; e->sport = sport;
  e->daddr = daddr; e->dport = dport;
  e->ts = now_ms;
  e->count = 1;
  return 1;
}

/* ── Checksums ───────────────────────────────────────────────────────────── */
/* One's-complement sum of big-endian 16-bit words, continuing from `sum`. */
static uint32_t csum_add(const uint8_t *data, int len, uint32_t sum) {
  int i = 0;
  for (; i + 1 < len; i += 2) sum += (uint32_t)((data[i] << 8) | data[i + 1]);
  if (i < len) sum += (uint32_t)(data[i] << 8); /* last odd byte, high half */
  return sum;
}
static uint16_t csum_fold(uint32_t sum) {
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (uint16_t)~sum;
}
static void put16(uint8_t *b, uint16_t v) { b[0] = (uint8_t)(v >> 8); b[1] = (uint8_t)(v & 0xff); }

/* ── Decoy datagram builder ──────────────────────────────────────────────── */
int udp_build_decoy(uint8_t *buf, int cap, uint32_t saddr, uint32_t daddr,
                    uint16_t sport, uint16_t dport, int payload_len,
                    int ttl, uint16_t ip_id, uint32_t rng_seed) {
  if (!buf || payload_len < 0) return 0;
  int total = 20 + 8 + payload_len;
  if (total > cap || total > 1500) return 0;
  if (ttl <= 0 || ttl > 255) ttl = 4;

  memset(buf, 0, 20 + 8);
  /* IPv4 header */
  buf[0] = 0x45;                         /* version 4, IHL 5 (no options) */
  buf[1] = 0x00;                         /* DSCP/ECN */
  put16(buf + 2, (uint16_t)total);       /* total length */
  put16(buf + 4, ip_id);                 /* identification */
  put16(buf + 6, 0x4000);                /* flags: Don't Fragment */
  buf[8] = (uint8_t)ttl;                 /* TTL (low, dies before the server) */
  buf[9] = 17;                           /* protocol: UDP */
  /* buf[10..11] checksum = 0 for now */
  memcpy(buf + 12, &saddr, 4);           /* source address (network order) */
  memcpy(buf + 16, &daddr, 4);           /* dest address (network order) */
  uint16_t ipck = csum_fold(csum_add(buf, 20, 0));
  put16(buf + 10, ipck);

  /* UDP header */
  uint8_t *u = buf + 20;
  memcpy(u + 0, &sport, 2);              /* source port (network order) */
  memcpy(u + 2, &dport, 2);              /* dest port (network order) */
  uint16_t udplen = (uint16_t)(8 + payload_len);
  put16(u + 4, udplen);                  /* UDP length */
  put16(u + 6, 0);                       /* checksum = 0 before computing */

  /* deterministic pseudo-random payload (xorshift32) */
  uint32_t x = rng_seed ? rng_seed : 0x9e3779b9u;
  for (int i = 0; i < payload_len; i++) {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    u[8 + i] = (uint8_t)(x & 0xff);
  }

  /* UDP checksum over the pseudo-header + UDP header + payload */
  uint32_t sum = 0;
  sum = csum_add(buf + 12, 8, sum);      /* src + dst addresses */
  sum += (uint32_t)17;                   /* zero byte + protocol */
  sum += (uint32_t)udplen;               /* UDP length (pseudo-header) */
  sum = csum_add(u, 8 + payload_len, sum);
  uint16_t udpck = csum_fold(sum);
  if (udpck == 0x0000) udpck = 0xffff;   /* 0 means "no checksum"; use all-ones */
  put16(u + 6, udpck);

  return total;
}
