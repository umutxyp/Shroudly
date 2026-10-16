#ifndef SHROUDLY_RAW_DESYNC_H
#define SHROUDLY_RAW_DESYNC_H

#include <stdint.h>

/*
 * raw_config — the Advanced-mode packet-layer options, parsed from the command
 * line in main.c (passed by electron/advanced-mode.js the same way the fake TTL
 * already is) and handed to the per-OS raw backend. See tcpdpi.h for the
 * techniques themselves.
 */

/* Decoy desync mode for the outbound ClientHello / first request. */
enum {
  RAW_DESYNC_FAKE = 0,          /* the proven decoy: a low-TTL/bad-checksum copy,
                                 * then the real packet unchanged (the default). */
  RAW_DESYNC_FAKEDSPLIT = 1,    /* split into two real segments + a fake at the
                                 * boundary, in order. */
  RAW_DESYNC_FAKEDDISORDER = 2  /* the same, second real part sent first. */
};

typedef struct {
  int     fake_ttl;       /* fixed decoy TTL; the fallback when autottl can't measure */
  int     drop_rst;       /* 1: drop DPI-injected inbound RSTs on ports 80/443 */
  int     autottl;        /* 1: set the decoy TTL from the SYN-ACK hop distance */
  int     autottl_margin; /* decoy TTL = hops - margin */
  int     autottl_min;    /* ... clamped to at least this */
  int     seqovl;         /* >0: sequence-overlap the real first segment by N bytes */
  int     split;          /* 1: after the plain decoy, send the real first segment
                           * as two, cut inside the name (tcpdpi_split_pos) */
  int     desync_mode;    /* RAW_DESYNC_* */
  uint8_t seqovl_pattern; /* fill byte for the seqovl prefix */
  uint8_t fake_pattern;   /* fill byte for fakedsplit/fakeddisorder junk */
  int     quic_block;     /* 1: drop QUIC Initial (UDP/443) so browsers fall back to TCP */
  int     udp_fake;       /* 1: decoys ahead of the first Discord voice datagrams */
  int     fake_repeats;   /* decoy datagrams per voice flow (defaults if <= 0) */
} raw_config;

/* Sensible defaults: the strictly-additive, always-safe protections (drop
 * injected RSTs, measure the decoy TTL, cut the real first segment inside the
 * name — every server reassembles a split segment) are on; the decoy stays the
 * proven plain fake, with sequence overlap off. Without the cut, a program that
 * ignores the proxy (Lampcord, #11) sent its ClientHello whole and stayed
 * blocked on networks the fake alone does not fool, though the proxy's own
 * cuts opened the same site in the browser. */
#define RAW_DEF_DROP_RST       1
#define RAW_DEF_AUTOTTL        1
#define RAW_DEF_AUTOTTL_MARGIN 1
#define RAW_DEF_AUTOTTL_MIN    1
#define RAW_DEF_SEQOVL         0
#define RAW_DEF_SPLIT          1
#define RAW_DEF_DESYNC_MODE    RAW_DESYNC_FAKE
#define RAW_DEF_SEQOVL_PATTERN 0x00
#define RAW_DEF_FAKE_PATTERN   0x00

static inline void raw_config_defaults(raw_config *c, int fake_ttl) {
  c->fake_ttl = fake_ttl > 0 ? fake_ttl : 4;
  c->drop_rst = RAW_DEF_DROP_RST;
  c->autottl = RAW_DEF_AUTOTTL;
  c->autottl_margin = RAW_DEF_AUTOTTL_MARGIN;
  c->autottl_min = RAW_DEF_AUTOTTL_MIN;
  c->seqovl = RAW_DEF_SEQOVL;
  c->split = RAW_DEF_SPLIT;
  c->desync_mode = RAW_DEF_DESYNC_MODE;
  c->seqovl_pattern = RAW_DEF_SEQOVL_PATTERN;
  c->fake_pattern = RAW_DEF_FAKE_PATTERN;
  c->quic_block = 1;
  c->udp_fake = 1;
  c->fake_repeats = 6;
}

#endif
