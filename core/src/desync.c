#include "desync.h"
#include "fake.h"
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
    default:          base = offset < 0 ? len + offset : offset; offset = 0; break;
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


/* ── real out-of-order delivery, without raw sockets ─────────────────────
 * The first half is sent with a TTL too small to cross the network, so it
 * dies at an early hop; the second half then goes out normally and is what
 * the filter sees first. The kernel retransmits the lost half a moment later
 * with its original sequence numbers, so the server still receives a correct,
 * in-order stream and nothing about the connection is malformed. A filter
 * that reassembles TCP is defeated too, because it only ever saw the tail of
 * the ClientHello before deciding. Costs one retransmit timeout on the
 * connections that need it, and is never used on traffic that is not blocked.
 */
static int send_disordered(sock_t up, int family, const uint8_t *buf,
                           int a, int mid, int b, int ttl) {
  int saved = sock_get_ttl(up, family);
  if (saved <= 0) saved = 64;           /* Windows defaults to 128, so read it */
  if (ttl <= 0 || ttl > 8) ttl = 1;     /* 1 = dies at the first hop, which is all we need */
  if (sock_set_ttl(up, family, ttl) != 0) {
    /* No per-socket TTL control here: plain fragmentation still helps. */
    if (sock_send_all(up, buf + a, (size_t)(mid - a), 0) != 0) return -1;
    sock_wait_sent(up, 10);
    return sock_send_all(up, buf + mid, (size_t)(b - mid), 0);
  }
  int rc = sock_send_all(up, buf + a, (size_t)(mid - a), 0);
  /* The TTL must not be restored until this segment has actually been
   * transmitted, or the kernel sends it with the restored TTL and the whole
   * technique silently does nothing. Linux can be asked precisely; elsewhere a
   * 10 ms pause is the established value — and is all that is needed, so the
   * generic wait (a flat sleep off Linux) is not paid on top of it. */
#ifdef __linux__
  sock_wait_sent(up, 10);
#else
  sleep_ms(10);
#endif
  sock_set_ttl(up, family, saved);          /* restore before the real half */
  if (rc != 0) return -1;
  return sock_send_all(up, buf + mid, (size_t)(b - mid), 0);
}

/* ── TLS record fragmentation ────────────────────────────────────────────
 * One handshake record becomes two, split inside the server name. RFC 8446
 * §5.1 lets a handshake message be fragmented across records, so every TLS
 * server reassembles this correctly, but a filter that parses only the first
 * record of a connection never sees a complete name. Unlike the TCP tricks it
 * needs no control over timing or TTL, so it behaves identically on every
 * operating system and survives middleboxes that normalise TCP.
 *
 * Done as an in-place rewrite rather than at send time, so that a strategy can
 * combine it with splitting: the TCP-level cuts then apply to the re-framed
 * bytes, which is the combination that several networks need.
 * Returns the new length, or -1 if it does not apply. */
static int tls_insert_record(uint8_t *buf, int len, int cap, int rec_total, int pos) {
  if (len < 7 || buf[0] != 0x16) return -1;
  if (len + 5 > cap) return -1;
  /* Re-framing half a record would hand the server two records whose lengths
   * describe bytes that never arrive, so only do it when the whole record is
   * here. */
  if (rec_total <= 0 || rec_total > len) return -1;
  int total = rec_total;
  int body  = total - 5;
  if (body < 2) return -1;
  int n1 = pos - 5;                     /* bytes of body in the first record */
  if (n1 < 1 || n1 >= body) n1 = body / 2;
  int n2 = body - n1;
  if (n1 < 1 || n2 < 1) return -1;

  /* Open a five-byte gap for the second record header. */
  memmove(buf + 5 + n1 + 5, buf + 5 + n1, (size_t)(len - (5 + n1)));
  buf[3] = (uint8_t)((n1 >> 8) & 0xff); buf[4] = (uint8_t)(n1 & 0xff);
  uint8_t *h = buf + 5 + n1;
  h[0] = buf[0]; h[1] = buf[1]; h[2] = buf[2];
  h[3] = (uint8_t)((n2 >> 8) & 0xff); h[4] = (uint8_t)(n2 & 0xff);
  return len + 5;
}

/* ── out-of-band byte ────────────────────────────────────────────────────
 * One byte of the payload is replaced and sent as TCP urgent data. The
 * receiving stack removes the urgent byte from the stream, so the server
 * reassembles the original request exactly; a filter that ignores the urgent
 * pointer (almost all of them — RFC 6093 §3) keeps the byte and ends up with a
 * corrupted server name. Placing it inside the SNI is the point. */
static int send_oob_at(sock_t up, uint8_t *buf, int len, int pos) {
  if (pos < 1 || pos >= len) return -2;
  /* Send the leading bytes normally, then the urgent byte on its own. Passing
   * MSG_OOB to a loop that retries partial sends would mark a byte urgent in
   * every chunk it sent, which corrupts the stream the server rebuilds. */
  if (pos > 0 && sock_send_all(up, buf, (size_t)pos, 0) != 0) return -1;
  uint8_t urgent = (uint8_t)'a';
  if (send(up, (const char *)&urgent, 1, MSG_OOB) != 1) return -1;
  sock_wait_sent(up, 10);
  /* The urgent byte stood in for buf[pos], so the real stream resumes there. */
  return sock_send_all(up, buf + pos, (size_t)(len - pos), 0);
}

int desync_send_first(sock_t up, int family,
                      uint8_t *payload, int len, int cap,
                      const proto_info *pi, const strategy *st,
                      _Atomic uint64_t *desync_counter) {
  if (len <= 0) return 0;

  /* Optional HTTP Host case-scramble. */
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind == OP_HTTP_CASE && pi->kind == PROTO_HTTP && pi->http_hdr_off >= 0) {
      int o = pi->http_hdr_off;
      if (o + 4 <= len) { payload[o+1] = 'O'; payload[o+3] = 'T'; }
    }
  }

  /* Collect the TCP cut points first, from the untouched payload, so the
   * positions still refer to the names the strategy was written against. */
  int splits[MAX_OPS]; int nsplits = 0; int disorder = 0;
  for (int i = 0; i < st->n_ops; i++) {
    op_kind k = st->ops[i].kind;
    if (k != OP_SPLIT && k != OP_DISORDER) continue;
    int p = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi);
    int dup = 0;
    for (int j = 0; j < nsplits; j++) if (splits[j] == p) dup = 1;
    if (!dup && nsplits < MAX_OPS) splits[nsplits++] = p;
    if (k == OP_DISORDER) disorder = 1;
  }

  /* Re-frame the handshake, then move any cut that now sits after the inserted
   * record header. */
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind != OP_TLSREC || pi->kind != PROTO_TLS) continue;
    int pos = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi);
    int nl = tls_insert_record(payload, len, cap, pi->tls_record_total, pos);
    if (nl > 0) {
      for (int j = 0; j < nsplits; j++) if (splits[j] > pos) splits[j] += 5;
      len = nl;
    }
    break;
  }

  /* An out-of-band byte replaces one byte of the name; the receiving stack
   * removes it again, so it is sent on its own rather than combined. */
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind != OP_OOB) continue;
    int pos = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi);
    int r = send_oob_at(up, payload, len, pos);
    if (desync_counter) (*desync_counter)++;
    if (r == 0) return 0;
    if (r == -1) return -1;
    break;
  }

  /* A decoy first segment, where the platform can take one back. The filter
   * reads a complete request for a harmless name and makes its decision on
   * that; the server is never given those bytes, and receives the real request
   * when TCP resends the segment. Not built on macOS — see fake.h. */
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind != OP_FAKE || !fake_available()) continue;
    int pos = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi);
    int done = fake_send_first(up, family, payload, pos, pi,
                               st->fake_ttl, st->fmode == FAKE_MD5);
    if (done <= 0) break;                 /* could not: fall through to the rest */
    if (desync_counter) (*desync_counter)++;
    /* Bytes the decoy covered are already in flight and will arrive for real;
     * send whatever it did not reach. */
    if (done < len)
      return sock_send_all(up, payload + done, (size_t)(len - done), 0);
    return 0;
  }


  for (int i = 1; i < nsplits; i++) {   /* insertion sort, ascending */
    int v = splits[i], j = i - 1;
    while (j >= 0 && splits[j] > v) { splits[j+1] = splits[j]; j--; }
    splits[j+1] = v;
  }

  /* A strategy of no operations ("none") changes nothing: not counted. */
  if (desync_counter && st->n_ops) (*desync_counter)++;

  int bounds[MAX_OPS + 2]; int nb = 0;
  bounds[nb++] = 0;
  for (int i = 0; i < nsplits; i++)
    if (splits[i] > 0 && splits[i] < len) bounds[nb++] = splits[i];
  bounds[nb++] = len;

  if (nb <= 2) return sock_send_all(up, payload, (size_t)len, 0);

  if (disorder) {
    if (send_disordered(up, family, payload, bounds[0], bounds[1], bounds[2],
                        st->fake_ttl) != 0) return -1;
    for (int i = 2; i + 1 < nb; i++) {
      if (bounds[i+1] > bounds[i]) {
        sock_wait_sent(up, 10);
        if (sock_send_all(up, payload + bounds[i],
                          (size_t)(bounds[i+1] - bounds[i]), 0) != 0) return -1;
      }
    }
    return 0;
  }

  for (int i = 0; i + 1 < nb; i++) {
    if (bounds[i+1] > bounds[i]) {
      if (sock_send_all(up, payload + bounds[i],
                        (size_t)(bounds[i+1] - bounds[i]), 0) != 0) return -1;
      /* Only between chunks: waiting after the last one keeps the segments
       * apart from nothing and simply delays the connection. Off Linux that
       * wait is a flat sleep, so the saving is real. */
      if (i + 2 < nb) sock_wait_sent(up, 10);
    }
  }
  return 0;
}
