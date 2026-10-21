#ifndef SHROUDLY_STRATEGY_H
#define SHROUDLY_STRATEGY_H

#include <stddef.h>
#include <stdint.h>

/* A desync strategy is a small ordered list of operations applied to the first
 * client payload (the TLS ClientHello or HTTP request). Everything is done with
 * ordinary socket sends — no raw sockets, no driver — so it runs on any OS. */

typedef enum {
  OP_NONE = 0,
  OP_SPLIT,        /* split into two sends at a computed position */
  OP_DISORDER,     /* like split but send the 2nd part first      */
  OP_FAKE,         /* send a decoy packet (low TTL / bad data) before the real one */
  OP_HTTP_CASE,    /* rewrite Host -> hOsT for plain HTTP          */
  OP_TLSREC,       /* re-frame the ClientHello as two TLS records   */
  OP_OOB           /* reserved */
} op_kind;

/* Where to split, relative to the detected marker. */
typedef enum {
  POS_ABS = 0,   /* absolute byte offset from start of payload */
  POS_SNI,       /* at the SNI / Host value start              */
  POS_SNI_MID,   /* in the middle of the SNI / Host value      */
  POS_SNI_END,   /* just after the SNI / Host value            */
  POS_HOST       /* at the HTTP Host header name               */
} pos_ref;

typedef struct {
  op_kind kind;
  pos_ref ref;
  int     offset;  /* signed offset added to the reference position */
} strat_op;

#define MAX_OPS 8

typedef enum { FAKE_TTL = 0, FAKE_BADSUM = 1, FAKE_TTL_BADSEQ = 2, FAKE_MD5 = 3 } fake_mode;

typedef struct {
  char      name[32];
  strat_op  ops[MAX_OPS];
  int       n_ops;
  int       fake_ttl;     /* TTL used for OP_FAKE decoy packets */
  fake_mode fmode;
  int       split_pos;    /* default absolute split for payloads with no marker */
} strategy;

/* Parse a strategy string, e.g. "fake(ttl=4),split(sni),disorder(sni+1)".
 * Returns 0 on success. */
int strategy_parse(const char *spec, strategy *out);

/* Built-in presets, indexed 0..strategy_preset_count()-1, ordered by how often
 * they work in practice (most universal first). Used by auto-probe. There are
 * never more than STRATEGY_MAX_PRESETS of them, which is what lets the engine
 * size its attempt ladder to hold every one. */
#define STRATEGY_MAX_PRESETS 24
int             strategy_preset_count(void);
const strategy *strategy_preset(int i);

/* Techniques for a stream whose first payload is neither a TLS ClientHello
 * nor an HTTP request (MTProto, other obfuscated or custom protocols, games):
 * there is no name to cut around, so they cut at fixed places early in the
 * payload, where a filter that recognises a protocol by its first bytes
 * looks. Every one of them leaves the bytes the server receives exactly as
 * they were — only how they are cut into segments changes — so using one on
 * a connection that did not need it costs nothing. Their names start with
 * "raw-", which no technique of the list above does. */
#define STRATEGY_MAX_RAW 8
int             strategy_raw_count(void);
const strategy *strategy_raw(int i);

#endif
