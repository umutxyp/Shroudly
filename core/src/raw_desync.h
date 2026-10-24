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

/* After the plain decoy, the real first segment is cut so that no segment
 * carries the whole name (tcpdpi_split_points): in order, or last part first. */
enum { RAW_SPLIT_OFF = 0, RAW_SPLIT_ON = 1, RAW_SPLIT_DISORDER = 2 };

typedef struct {
  int     fake_ttl;       /* fixed decoy TTL; the fallback when autottl can't measure */
  int     drop_rst;       /* 1: drop DPI-injected inbound RSTs on ports 80/443 */
  int     autottl;        /* 1: set the decoy TTL from the SYN-ACK hop distance */
  int     autottl_margin; /* decoy TTL = hops - margin */
  int     autottl_min;    /* ... clamped to at least this */
  int     seqovl;         /* >0: sequence-overlap the real first segment by N bytes */
  int     split;          /* RAW_SPLIT_*: cut the real first segment after the decoy */
  int     desync_mode;    /* RAW_DESYNC_* */
  uint8_t seqovl_pattern; /* fill byte for the seqovl prefix */
  uint8_t fake_pattern;   /* fill byte for fakedsplit/fakeddisorder junk */
  int     quic_block;     /* 1: drop QUIC Initial (UDP/443) so browsers fall back to TCP */
  int     udp_fake;       /* 1: decoys ahead of the first Discord voice datagrams */
  int     fake_repeats;   /* decoy datagrams per voice flow (defaults if <= 0) */
  int     dns_gate;       /* >0: other programs' DNS answered from the forwarder
                           * on this 127.0.0.1 port (dnsgate.h); 0: off */
  int     tlsrec;         /* 1: split the TLS record of a ClientHello into two
                           * records (tcpdpi tlsrec), for a DPI that reassembles
                           * the TCP stream before it inspects (issue #48). The
                           * split grows the segment, so the backend translates
                           * the connection's later sequence numbers. */
} raw_config;

/* Sensible defaults: the strictly-additive, always-safe protections are on:
 * drop injected RSTs, measure the decoy TTL, and cut the real first segment
 * after the decoy (every TCP receiver puts a cut segment back together, and a
 * program that ignores the proxy gets nothing else). The decoy stays the
 * proven plain fake, with sequence overlap off. */
#define RAW_DEF_DROP_RST       1
#define RAW_DEF_AUTOTTL        1
#define RAW_DEF_AUTOTTL_MARGIN 1
#define RAW_DEF_AUTOTTL_MIN    1
#define RAW_DEF_SEQOVL         0
#define RAW_DEF_SPLIT          RAW_SPLIT_ON
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
  c->dns_gate = 0;
  c->tlsrec = 0;
}

#endif
