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

/*
 * A correct "fake packet" desync (to beat stateful DPI such as Iran/China)
 * cannot be done over this stream socket: it requires injecting an out-of-band
 * decoy TCP segment with the live connection's sequence numbers and a low TTL /
 * bad checksum, via a raw socket or a kernel queue (NFQUEUE / WinDivert / pf).
 * That is a platform-specific packet backend and is deliberately NOT part of the
 * portable, driver-free default build. See core/src/CAPABILITIES.md. The
 * previous stream-socket TTL hack was removed because it corrupts the real
 * stream (the server would receive the scrambled decoy bytes in-band).
 */

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
      if (k == OP_DISORDER) {
        disorder = 1;
        /* disorder implies extra fragmentation: add a second cut just before the
         * marker so the SNI lands in its own middle fragment even in the
         * userspace (flush-based) path. */
        int p2 = p > 1 ? p - 1 : p + 1;
        if (p2 > 0 && p2 < len) {
          int d2 = 0;
          for (int j = 0; j < nsplits; j++) if (splits[j] == p2) d2 = 1;
          if (!d2 && nsplits < MAX_OPS) splits[nsplits++] = p2;
        }
      }
    }
  }
  /* simple insertion sort */
  for (int i = 1; i < nsplits; i++) {
    int v = splits[i], j = i - 1;
    while (j >= 0 && splits[j] > v) { splits[j+1] = splits[j]; j--; }
    splits[j+1] = v;
  }

  if (desync_counter) (*desync_counter)++;

  /* A "fake" op is accepted by the parser but has no effect in the portable
   * userspace build: a real decoy packet must be injected out-of-band at the
   * packet layer (raw socket / NFQUEUE / WinDivert), which is a platform backend
   * left out of the driver-free default. See CAPABILITIES.md. We rely on
   * split + disorder, which defeat stateless SNI/Host DPI. */
  (void)do_fake;

  if (nsplits == 0) {
    return sock_send_all(up, payload, (size_t)len, 0);
  }

  /* Build segments [0,s0) [s0,s1) ... [sk,len). */
  int bounds[MAX_OPS + 2]; int nb = 0;
  bounds[nb++] = 0;
  for (int i = 0; i < nsplits; i++) if (splits[i] > 0 && splits[i] < len) bounds[nb++] = splits[i];
  bounds[nb++] = len;

  /* IMPORTANT: over a userspace TCP stream we cannot truly reorder segments —
   * the kernel always transmits them in ascending sequence order, so sending a
   * later chunk "first" with send() does not put it on the wire first. True
   * out-of-order injection needs raw sockets (optional SHROUDLY_RAW build).
   *
   * What *does* reliably defeat stateless SNI/Host DPI here is fragmentation:
   * forcing the ClientHello onto the wire as multiple small segments (with a
   * flush between them) so the SNI never appears whole in one segment. So in the
   * userspace path we always send in order with per-segment flushes, and treat
   * "disorder" as a request for an extra early fragment to maximise splitting. */
#ifdef SHROUDLY_RAW
  if (disorder && nb >= 3) {
    for (int i = nb - 2; i >= 0; i--) {
      int a = bounds[i], b = bounds[i+1];
      if (b > a) {
        if (sock_send_all(up, payload + a, (size_t)(b - a), 0) != 0) return -1;
        sock_wait_sent(up, 10);
      }
    }
    return 0;
  }
#else
  (void)disorder;
#endif
  for (int i = 0; i + 1 < nb; i++) {
    int a = bounds[i], b = bounds[i+1];
    if (b > a) {
      if (sock_send_all(up, payload + a, (size_t)(b - a), 0) != 0) return -1;
      sock_wait_sent(up, 10);
    }
  }
  return 0;
}
