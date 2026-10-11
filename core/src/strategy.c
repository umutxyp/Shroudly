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
    else continue;

    if (op.kind == OP_FAKE) {
      char *t = strstr(args, "ttl=");
      if (t) out->fake_ttl = atoi(t + 4);
      if (strstr(args, "badsum")) out->fmode = FAKE_BADSUM;
      op.ref = POS_SNI;
      op.offset = 0;
    } else if (op.kind == OP_SPLIT || op.kind == OP_DISORDER) {
      op.ref = parse_ref(args, &op.offset);
      if (op.ref == POS_ABS && args[0]) out->split_pos = atoi(args);
    }
    out->ops[out->n_ops++] = op;
  }
  return out->n_ops > 0 ? 0 : -1;
}

/* Presets ordered most-universal first. These mirror the techniques that work
 * against real-world DPI (split at SNI, disorder, fakes at low TTL). */
static strategy PRESETS[12];
static int N_PRESETS = 0;

static void add(const char *name, const char *spec) {
  if (N_PRESETS >= (int)(sizeof(PRESETS) / sizeof(PRESETS[0]))) return;
  strategy_parse(spec, &PRESETS[N_PRESETS]);
  strncpy(PRESETS[N_PRESETS].name, name, sizeof(PRESETS[N_PRESETS].name) - 1);
  N_PRESETS++;
}

static void ensure_presets(void) {
  if (N_PRESETS) return;
  /* Relay-safe desyncs first (split/disorder); fake(...) variants are only
   * active in the optional raw-socket build and are listed after. */
  add("split-sni",            "split(sni)");
  add("disorder-sni",         "disorder(sni)");
  add("split-sni-mid",        "split(sni_mid)");
  add("disorder-sni-mid",     "disorder(sni_mid)");
  add("double-split",         "split(1),split(sni)");
  add("split2",               "split(2)");
  add("disorder2",            "disorder(2)");
  add("split-sni-end",        "split(sni_end)");
#ifdef SHROUDLY_RAW
  add("fake-split-sni",       "fake(ttl=4),split(sni)");
  add("fake-disorder-sni",    "fake(ttl=4),disorder(sni)");
#endif
}

int strategy_preset_count(void) { ensure_presets(); return N_PRESETS; }
const strategy *strategy_preset(int i) {
  ensure_presets();
  if (i < 0 || i >= N_PRESETS) return &PRESETS[0];
  return &PRESETS[i];
}
