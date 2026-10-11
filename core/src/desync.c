#include "desync.h"
#include <string.h>
#include <stdlib.h>

/* Resolve a strategy position reference to an absolute offset in the payload. */
static int resolve_pos(pos_ref ref, int offset, int len, const proto_info *pi) {
  int base;
  switch (ref) {
    case POS_SNI:     base = pi->host_off >= 0 ? pi->host_off : len / 2; break;
    case POS_SNI_MID: base = pi->host_off >= 0 ? pi->host_off + pi->host_len / 2 : len / 2; break;
    case POS_SNI_END: base = pi->host_off >= 0 ? pi->host_off + pi->host_len : len / 2; break;
    case POS_HOST:    base = pi->http_hdr_off >= 0 ? pi->http_hdr_off : len / 2; break;
    case POS_ABS:
    default:          base = offset; offset = 0; break;
  }
  int p = base + offset;
  if (p < 1) p = 1;
  if (p > len - 1) p = len - 1;
  return p;
}

#ifdef SHROUDLY_RAW
/* Build and send a decoy ("fake") segment: same length prefix as the real first
 * chunk but with the SNI/Host bytes overwritten, sent at a low TTL so it expires
 * before reaching the server (the DPI on the path still inspects it and is
 * desynchronised). We then restore the TTL for the genuine data.
 * Only correct with raw-socket injection; see note in desync_send_first. */
static void send_fake(sock_t up, int family, const uint8_t *payload, int upto,
                      const proto_info *pi, const strategy *st) {
  if (upto < 1) return;
  uint8_t *decoy = (uint8_t *)malloc(upto);
  if (!decoy) return;
  memcpy(decoy, payload, upto);

  /* Scramble the host bytes that fall within the decoy region. */
  if (pi->host_off >= 0) {
    for (int i = pi->host_off; i < pi->host_off + pi->host_len && i < upto; i++)
      decoy[i] ^= 0x5a;
  } else {
    for (int i = upto / 3; i < upto; i++) decoy[i] ^= 0x5a;
  }

  int saved = sock_get_ttl(up, family);
  int ttl = st->fake_ttl > 0 ? st->fake_ttl : 4;
  sock_set_ttl(up, family, ttl);
  sock_send_all(up, decoy, (size_t)upto, 0);
  sock_wait_sent(up, 20);
  sock_set_ttl(up, family, saved);
  free(decoy);
}
#endif

int desync_send_first(sock_t up, int family,
                      uint8_t *payload, int len,
                      const proto_info *pi, const strategy *st,
                      _Atomic uint64_t *desync_counter) {
  if (len <= 0) return 0;
#ifndef SHROUDLY_RAW
  (void)family;
#endif

  /* Optional HTTP Host case-scramble. */
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind == OP_HTTP_CASE && pi->kind == PROTO_HTTP && pi->http_hdr_off >= 0) {
      /* "Host" -> "hOsT" in place */
      int o = pi->http_hdr_off;
      if (o + 4 <= len) { payload[o+1] = 'O'; payload[o+3] = 'T'; }
    }
  }

  /* Collect split points from split/disorder ops, in order. */
  int splits[MAX_OPS]; int nsplits = 0; int disorder = 0; int do_fake = 0;
  for (int i = 0; i < st->n_ops; i++) {
    op_kind k = st->ops[i].kind;
    if (k == OP_FAKE) do_fake = 1;
    if (k == OP_SPLIT || k == OP_DISORDER) {
      int p = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi);
      /* keep sorted & unique */
      int dup = 0;
      for (int j = 0; j < nsplits; j++) if (splits[j] == p) dup = 1;
      if (!dup && nsplits < MAX_OPS) splits[nsplits++] = p;
      if (k == OP_DISORDER) disorder = 1;
    }
  }
  /* simple insertion sort */
  for (int i = 1; i < nsplits; i++) {
    int v = splits[i], j = i - 1;
    while (j >= 0 && splits[j] > v) { splits[j+1] = splits[j]; j--; }
    splits[j+1] = v;
  }

  if (desync_counter) (*desync_counter)++;

  /* NOTE: A low-TTL "fake" decoy cannot be injected in-stream over a userspace
   * relay — it would corrupt the real TCP byte stream the server reassembles.
   * True fake-packet injection needs a raw-socket path (optional elevated mode).
   * In the default unprivileged relay we rely on split + disorder, which are
   * sufficient against stateless SNI/Host DPI. The fake op is honored only when
   * raw injection is wired in (SHROUDLY_RAW build), so by default it is skipped. */
#ifdef SHROUDLY_RAW
  if (do_fake) {
    int upto = nsplits ? splits[0] : len;
    if (upto > len) upto = len;
    send_fake(up, family, payload, upto, pi, st);
  }
#else
  (void)do_fake;
#endif

  if (nsplits == 0) {
    return sock_send_all(up, payload, (size_t)len, 0);
  }

  /* Build segments [0,s0) [s0,s1) ... [sk,len). */
  int bounds[MAX_OPS + 2]; int nb = 0;
  bounds[nb++] = 0;
  for (int i = 0; i < nsplits; i++) if (splits[i] > 0 && splits[i] < len) bounds[nb++] = splits[i];
  bounds[nb++] = len;

  if (disorder && nb >= 3) {
    /* Send later segments before earlier ones. The kernel at the receiver
     * reorders by sequence number; a stateless DPI that reads in arrival order
     * never sees a contiguous SNI. */
    for (int i = nb - 2; i >= 0; i--) {
      int a = bounds[i], b = bounds[i+1];
      if (b > a) {
        if (sock_send_all(up, payload + a, (size_t)(b - a), 0) != 0) return -1;
        sock_wait_sent(up, 10);
      }
    }
  } else {
    for (int i = 0; i + 1 < nb; i++) {
      int a = bounds[i], b = bounds[i+1];
      if (b > a) {
        if (sock_send_all(up, payload + a, (size_t)(b - a), 0) != 0) return -1;
        sock_wait_sent(up, 10);
      }
    }
  }
  return 0;
}
