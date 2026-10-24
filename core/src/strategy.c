/* strtok_r is POSIX; expose it under strict -std=c11. */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif
#include "strategy.h"
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

#ifdef _WIN32
#define strtok_r strtok_s
#endif

static pos_ref parse_ref(const char *s, int *off) {
  *off = 0;
  const char *plus = strpbrk(s, "+-");
  if (plus) *off = atoi(plus);
  if (strncmp(s, "sni_mid", 7) == 0) return POS_SNI_MID;
  if (strncmp(s, "sni_end", 7) == 0) return POS_SNI_END;
  if (strncmp(s, "sni", 3) == 0)     return POS_SNI;
  if (strncmp(s, "host", 4) == 0)    return POS_HOST;
  return POS_ABS;
}

int strategy_parse(const char *spec, strategy *out) {
  memset(out, 0, sizeof(*out));
  out->fake_ttl = 4;
  out->fmode = FAKE_TTL;
  out->split_pos = 2;
  strncpy(out->name, "custom", sizeof(out->name) - 1);
  if (!spec || !*spec) return -1;
  /* "none": every connection relayed as it is, encrypted DNS only (the
   * Settings choice "Off"; issue #37). With --auto the engine still starts
   * every connection untouched and tries techniques only on a refusal. */
  if (strcmp(spec, "none") == 0) {
    strncpy(out->name, "none", sizeof(out->name) - 1);
    return 0;
  }

  char tmp[512];
  strncpy(tmp, spec, sizeof(tmp) - 1);
  tmp[sizeof(tmp) - 1] = 0;

  char *save = NULL;
  for (char *tok = strtok_r(tmp, ",", &save); tok && out->n_ops < MAX_OPS;
       tok = strtok_r(NULL, ",", &save)) {
    while (isspace((unsigned char)*tok)) tok++;
    char args[128] = {0};
    char *lp = strchr(tok, '(');
    if (lp) {
      *lp = 0;
      char *rp = strchr(lp + 1, ')');
      if (rp) *rp = 0;
      strncpy(args, lp + 1, sizeof(args) - 1);
    }
    strat_op op;
    memset(&op, 0, sizeof(op));

    if (strcmp(tok, "split") == 0)        op.kind = OP_SPLIT;
    else if (strcmp(tok, "disorder") == 0) op.kind = OP_DISORDER;
    else if (strcmp(tok, "fake") == 0)     op.kind = OP_FAKE;
    else if (strcmp(tok, "httpcase") == 0) op.kind = OP_HTTP_CASE;
    else if (strcmp(tok, "tlsrec") == 0)   op.kind = OP_TLSREC;
    else if (strcmp(tok, "oob") == 0)      op.kind = OP_OOB;
    else continue;

    if (op.kind == OP_FAKE) {
      char *t = strstr(args, "ttl=");
      if (t) out->fake_ttl = atoi(t + 4);
      if (strstr(args, "badsum")) out->fmode = FAKE_BADSUM;
      if (strstr(args, "md5"))    out->fmode = FAKE_MD5;
      /* Everything but the last byte, so the filter reads a whole decoy
       * request. A negative absolute position counts back from the end. */
      op.ref = POS_ABS;
      op.offset = -1;
      { char *at = strstr(args, "pos=");
        if (at) op.offset = atoi(at + 4); }
    } else if (op.kind == OP_TLSREC || op.kind == OP_OOB) {
      op.ref = parse_ref(args, &op.offset);
      if (op.ref == POS_ABS && args[0]) op.offset = atoi(args);
    } else if (op.kind == OP_SPLIT || op.kind == OP_DISORDER) {
      op.ref = parse_ref(args, &op.offset);
      /* A bare number is the position itself. It used to be stored in a field
       * nothing read, so split(2) and split(76) both silently became split(1)
       * — which made two presets duplicates of a third and quietly ignored any
       * offset a user copied from another tool. */
      if (op.ref == POS_ABS && args[0]) op.offset = atoi(args);
    }
    out->ops[out->n_ops++] = op;
  }
  return out->n_ops > 0 ? 0 : -1;
}

/* Presets ordered most-universal first. These mirror the techniques that work
 * against real-world DPI (split at SNI, disorder, fakes at low TTL). */
static strategy PRESETS[STRATEGY_MAX_PRESETS];
static int N_PRESETS = 0;

static void add(const char *name, const char *spec) {
  if (N_PRESETS >= (int)(sizeof(PRESETS) / sizeof(PRESETS[0]))) return;
  strategy_parse(spec, &PRESETS[N_PRESETS]);
  strncpy(PRESETS[N_PRESETS].name, name, sizeof(PRESETS[N_PRESETS].name) - 1);
  N_PRESETS++;
}

static void ensure_presets(void) {
  if (N_PRESETS) return;
  /* Ordered by how much of the world each one opens, cheapest first. The engine
   * walks this list when a connection is refused, so the entries that work
   * nearly everywhere come before the ones that only help a few networks.
   *
   * What each technique is for:
   *   tlsrec   — the handshake is re-framed as two TLS records (legal: RFC 8446
   *              §5.1). Beats filters that reassemble TCP, which plain splitting
   *              cannot, and costs nothing because it needs no timing or TTL.
   *   split    — the ClientHello leaves as several TCP segments.
   *   disorder — the halves genuinely arrive out of order (see desync.c).
   *   oob      — one byte goes as TCP urgent data; the server drops it from the
   *              stream, a filter that ignores the urgent pointer does not.
   *
   * The combined entries are the ones Turkish users have converged on across
   * several independent projects (split + disorder + tlsrec together), which
   * matches what we measured: a filter that reassembles TCP defeats split on
   * its own but not tlsrec, while some networks need the record split placed
   * slightly inside the name rather than at its start.
   *
   * First, the record cut in the middle of the name: it does what the cut at
   * the name's start does against a filter that parses the handshake (no
   * record holds the whole name), and also beats one that only looks for the
   * blocked domain's bytes anywhere in a packet, which every cut near the
   * start leaves whole ("www." | "blocked.example"). Behind such a filter
   * that drops silently, it came sixth and the first connection's 15 s ran
   * out before it (tests/lab/censor-lab.sh). */
  add("tlsrec-sni-mid",       "tlsrec(sni_mid)");
  add("tlsrec-sni",           "tlsrec(sni+1)");
  add("split-tlsrec",         "split(1),tlsrec(sni+1)");
  add("split-disorder-tlsrec","split(1),disorder(sni+3),tlsrec(sni+1)");
  add("disorder-tlsrec",      "disorder(sni+1),tlsrec(sni+1)");
  /* The record cut one byte before the name ends, so no record carries its
   * last label whole (ByeByeDPI's "-r-1+se"): what opens YouTube's video
   * servers in Iran, where every cut at or near the start of the name is
   * dropped (issue #37). Last of the record cuts: a site's first name that
   * gets nowhere with the five before it leaves its next name to start
   * here (see ladder_start). */
  add("tlsrec-sni-end",       "tlsrec(sni_end-1)");
  add("split-sni",            "split(sni)");
  add("disorder-sni",         "disorder(sni)");
  add("oob-tlsrec",           "oob(sni+1),tlsrec(sni+1)");
  add("oob-sni",              "oob(sni+1)");
  add("split-sni-mid",        "split(sni_mid)");
  add("disorder-sni-mid",     "disorder(sni_mid)");
  add("split-disorder",       "split(1),disorder(sni)");
  add("split2",               "split(2)");
  add("disorder2",            "disorder(2)");
  add("split-sni-end",        "split(sni_end)");
  /* Several cuts at once (what zapret calls multisplit / multidisorder, the
   * basis of the strategies Turkish users run against Türk Telekom and
   * Turkcell): the start of the record, inside the name, and its end all
   * become separate segments, so a filter never sees the name whole however
   * it reassembles. Costs nothing extra over a single split. */
  add("multisplit",           "split(1),split(sni_mid),split(sni_end)");
  add("multidisorder",        "disorder(1),disorder(sni_mid),disorder(sni_end)");
  add("multisplit-tlsrec",    "split(1),split(sni_mid),tlsrec(sni+1)");
  /* A decoy first segment, where the platform can guarantee the server never
   * sees it (Linux, via a TCP signature key). It comes last because it is the
   * least portable, and there is only one of it: variants that differ only in
   * a TTL guess were removed, because a guess that lands short delivers the
   * forged request to the origin and poisons that site for the session. */
  add("fake-decoy",           "fake(md5,ttl=6)");
}

int strategy_preset_count(void) { ensure_presets(); return N_PRESETS; }

/* The techniques for streams that are not TLS or HTTP (see strategy.h).
 * Filters that recognise such a protocol do it from its first bytes: an
 * MTProto connection, for one, is recognisable from the 64 bytes it opens
 * with, and an "everything that looks random" rule from the first segment's
 * contents. So the cuts go there: one byte in (the first segment then holds
 * nothing to recognise), several cuts across the first 64 bytes, the head
 * arriving after the rest, and a decoy where the platform can guarantee the
 * server never sees it. Cheapest first.
 *
 * No urgent byte (oob): a real server, Telegram's, takes it into the stream
 * (tests/net/telegram-real.test.js saw the connection closed), so it would
 * corrupt the very protocol it is meant to carry. A TLS server at least
 * answers a corrupted handshake with an alert, which the TLS ladder catches;
 * an unknown protocol gives no such word. */
static strategy RAW[STRATEGY_MAX_RAW];
static int N_RAW = 0;

static void add_raw(const char *name, const char *spec) {
  if (N_RAW >= STRATEGY_MAX_RAW) return;
  strategy_parse(spec, &RAW[N_RAW]);
  strncpy(RAW[N_RAW].name, name, sizeof(RAW[N_RAW].name) - 1);
  N_RAW++;
}

static void ensure_raw(void) {
  if (N_RAW) return;
  add_raw("raw-split1",      "split(1)");
  add_raw("raw-disorder1",   "disorder(1)");
  add_raw("raw-multisplit",  "split(1),split(8),split(32),split(56)");
  add_raw("raw-disorder32",  "disorder(32)");
  add_raw("raw-fake",        "fake(md5,ttl=6)");
}

int strategy_raw_count(void) { ensure_raw(); return N_RAW; }
const strategy *strategy_raw(int i) {
  ensure_raw();
  if (i < 0 || i >= N_RAW) return &RAW[0];
  return &RAW[i];
}
const strategy *strategy_preset(int i) {
  ensure_presets();
  if (i < 0 || i >= N_PRESETS) return &PRESETS[0];
  return &PRESETS[i];
}
