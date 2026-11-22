#include "desync.h"
#include "fake.h"
#include <string.h>
#include <stdlib.h>

/* Second levels under which people register their own names under a
 * two-letter country domain (co.uk, com.tr): the name's own label is then
 * the one before them. The same list as GENERIC_SLD in engine.c; a name it
 * misses only has its cut land one label off, still inside the name. */
static const char *const SLD_GENERIC[] = {
  "co", "com", "net", "org", "gov", "edu", "ac", "gen", "biz", "info", "or", "ne", "go",
  "mil", "int", "nom", "ltd", "plc", "sch", "k12", "gob", "gouv", "govt", NULL
};

/* Where the name's own label (see POS_SLD) starts and ends, as offsets into
 * the name h[0..n): sld[0], sld[1]; both -1 when there is no name. A name of
 * one label is its own label. */
static void sld_span(const uint8_t *h, int n, int sld[2]) {
  sld[0] = sld[1] = -1;
  if (!h || n <= 0) return;
  if (h[n - 1] == '.') n--;                 /* "example.com." */
  if (n <= 0) return;
  int dot[3] = { -1, -1, -1 }, nd = 0;      /* the last three dots, last first */
  for (int i = n - 1; i >= 0 && nd < 3; i--) if (h[i] == '.') dot[nd++] = i;
  if (nd == 0) { sld[0] = 0; sld[1] = n; return; }
  int b = dot[1] + 1, e = dot[0];           /* the second-to-last label */
  if (n - dot[0] - 1 == 2 && nd >= 2) {     /* a two-letter country domain */
    for (int i = 0; SLD_GENERIC[i]; i++)
      if ((int)strlen(SLD_GENERIC[i]) == e - b && memcmp(h + b, SLD_GENERIC[i], (size_t)(e - b)) == 0) {
        b = dot[2] + 1; e = dot[1]; break;
      }
  }
  if (e <= b) return;                       /* "..com": no label */
  sld[0] = b; sld[1] = e;
}

/* Resolve a strategy position reference to an absolute offset in the payload.
 * sld: the name's own label (sld_span), relative to the name's start. */
static int resolve_pos(pos_ref ref, int offset, int len, const proto_info *pi, const int sld[2]) {
  int base;
  int has_sld = pi->host_off >= 0 && sld[0] >= 0;
  switch (ref) {
    case POS_SNI:     base = pi->host_off >= 0 ? pi->host_off : len / 2; break;
    case POS_SNI_MID: base = pi->host_off >= 0 ? pi->host_off + pi->host_len / 2 : len / 2; break;
    case POS_SNI_END: base = pi->host_off >= 0 ? pi->host_off + pi->host_len : len / 2; break;
    case POS_HOST:    base = pi->http_hdr_off >= 0 ? pi->http_hdr_off : len / 2; break;
    case POS_SLD:     base = has_sld ? pi->host_off + sld[0] : len / 2; break;
    case POS_MIDSLD:  base = has_sld ? pi->host_off + (sld[0] + sld[1]) / 2 : len / 2; break;
    case POS_ENDSLD:  base = has_sld ? pi->host_off + sld[1] : len / 2; break;
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

/* ── several TLS records ─────────────────────────────────────────────────
 * The record that holds absolute position p (strictly inside its body) is
 * cut in two there, the way tls_insert_record cuts the first one. Used when
 * a strategy asks for more than one record cut (NoDPI's many records): the
 * handshake then arrives in three or more records, legal by RFC 8446 §5.1,
 * so a filter that reassembles records only up to a point, or reads only
 * the first one or two, never holds the whole name. Only whole records
 * already here are cut. Returns the new length, or -1. */
static int tls_split_at(uint8_t *buf, int len, int cap, int p) {
  int o = 0;
  while (o + 5 <= len) {
    if (buf[o] != 0x16) return -1;
    int rl = (buf[o + 3] << 8) | buf[o + 4];
    int end = o + 5 + rl;
    if (end > len) return -1;
    if (p > o + 5 && p < end) {
      if (len + 5 > cap) return -1;
      int n1 = p - (o + 5), n2 = rl - n1;
      memmove(buf + p + 5, buf + p, (size_t)(len - p));
      buf[o + 3] = (uint8_t)(n1 >> 8); buf[o + 4] = (uint8_t)n1;
      buf[p] = buf[o]; buf[p + 1] = buf[o + 1]; buf[p + 2] = buf[o + 2];
      buf[p + 3] = (uint8_t)(n2 >> 8); buf[p + 4] = (uint8_t)n2;
      return len + 5;
    }
    o = end;
  }
  return -1;
}

/* ── plain HTTP rewrites the RFC allows (tpws) ───────────────────────────
 * A filter that looks for "Host: blocked.example" byte for byte misses each
 * of these, while every server takes them: header names are case-
 * insensitive and so is a host name (RFC 9110 §5.1, §4.2.3); the space
 * after the colon is optional whitespace, a space or a tab (RFC 9112 §5);
 * and a server ignores an empty line before the request line (RFC 9112
 * §2.2). Nothing that changes what is asked for (no trailing dot on the
 * name, no doubled spaces), so a server can never answer a different
 * request. Returns the new length (the same, longer or shorter), or len
 * unchanged when it cannot apply; pi's offsets are moved with the bytes. */
static int http_rewrite(uint8_t *buf, int len, int cap, proto_info *pi, int m) {
  int h = pi->http_hdr_off, v = pi->host_off;
  if (pi->kind != PROTO_HTTP || h < 0 || v < 0 || h + 5 > len || v > len || v < h + 5) return len;
  if (m & HTTP_DOMCASE) {
    int up = 1;
    for (int i = v; i < v + pi->host_len && i < len; i++) {
      uint8_t c = buf[i];
      if (c >= 'a' && c <= 'z') { if (up) buf[i] = (uint8_t)(c - 32); up = !up; }
      else if (c >= 'A' && c <= 'Z') { if (!up) buf[i] = (uint8_t)(c + 32); up = !up; }
    }
  }
  /* Mixed case, not all lower: "host:" is what every HTTP/2 client
   * writes, and a filter that looks for "Host:" looks for "host:" too
   * (Vietnam's resets both, and lets "hOsT:" and "HOST:" through, measured
   * 2026-11-22); every one of 96 web servers answered "hOsT:" as it
   * answers "Host:". tpws writes "host". */
  if (m & HTTP_HOSTCASE) { buf[h] = 'h'; buf[h + 1] = 'O'; buf[h + 2] = 's'; buf[h + 3] = 'T'; }
  if (m & (HTTP_NOSPACE | HTTP_HOSTTAB)) {
    /* The whitespace between "Host:" and the name, h+5 .. v, becomes none
     * or one tab. */
    int want = (m & HTTP_NOSPACE) ? 0 : 1, have = v - (h + 5);
    if (len - have + want <= cap) {
      memmove(buf + h + 5 + want, buf + v, (size_t)(len - v));
      if (want) buf[h + 5] = '\t';
      len += want - have;
      pi->host_off += want - have;
    }
  }
  if ((m & HTTP_METHODEOL) && len + 2 <= cap) {
    memmove(buf + 2, buf, (size_t)len);
    buf[0] = '\r'; buf[1] = '\n';
    len += 2;
    pi->http_hdr_off += 2;
    pi->host_off += 2;
  }
  return len;
}

/* ── random-size segments (Xray's "fragment") ───────────────────────────
 * The whole first payload leaves as segments of a random size in
 * [chop_min, chop_max], each followed by a random pause in
 * [chop_wait_min, chop_wait_max] ms. A filter that keys on the sizes or
 * the timing of a cut it knows (the one always at the name, the one always
 * one byte in) meets neither, and one that reads only the first segment or
 * two never sees the name. The server receives the bytes exactly as they
 * were. */
static uint32_t chop_rand(uint32_t *s) {
  uint32_t x = *s ? *s : 0x9e3779b9u;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  return *s = x;
}
static int send_chopped(sock_t up, const uint8_t *buf, int len, const strategy *st) {
  static _Atomic uint32_t calls = 0;
  uint32_t seed = (uint32_t)now_ms() ^ (uint32_t)(uintptr_t)buf ^ (++calls * 2654435761u);
  int lo = st->chop_min > 0 ? st->chop_min : 1, hi = st->chop_max >= lo ? st->chop_max : lo;
  int off = 0;
  while (off < len) {
    int n = lo + (int)(chop_rand(&seed) % (uint32_t)(hi - lo + 1));
    if (n > len - off) n = len - off;
    if (sock_send_all(up, buf + off, (size_t)n, 0) != 0) return -1;
    off += n;
    if (off < len) {
      sock_wait_sent(up, 10);
      int w = st->chop_wait_min;
      if (st->chop_wait_max > w) w += (int)(chop_rand(&seed) % (uint32_t)(st->chop_wait_max - w + 1));
      if (w > 0) sleep_ms(w);
    }
  }
  return 0;
}

int desync_send_first(sock_t up, int family,
                      uint8_t *payload, int len, int cap,
                      const proto_info *pi, const strategy *st,
                      _Atomic uint64_t *desync_counter) {
  if (len <= 0) return 0;

  /* Plain HTTP rewrites (http(...)): done first, with the positions moved
   * along, so every position below refers to the bytes that leave. */
  proto_info pi_http;
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind != OP_HTTP || pi->kind != PROTO_HTTP) continue;
    pi_http = *pi;
    len = http_rewrite(payload, len, cap, &pi_http, st->ops[i].offset);
    pi = &pi_http;
    break;
  }

  /* The name's own label, found after the HTTP rewrites (they move the name, never
   * change its dots) and before anything below rewrites the payload. */
  int sld[2] = { -1, -1 };
  if (pi->host_off >= 0 && pi->host_len > 0 && pi->host_off + pi->host_len <= len)
    sld_span(payload + pi->host_off, pi->host_len, sld);

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
    int p = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi, sld);
    int dup = 0;
    for (int j = 0; j < nsplits; j++) if (splits[j] == p) dup = 1;
    if (!dup && nsplits < MAX_OPS) splits[nsplits++] = p;
    if (k == OP_DISORDER) disorder = 1;
  }

  /* Re-frame the handshake, then move any cut that now sits after the inserted
   * record header. Several record cuts (more than one tlsrec): each record
   * that holds a cut is cut there, the last cut first so the earlier
   * positions still mean the same bytes. One record cut goes exactly as it
   * always has (below). */
  int nrec = 0;
  for (int i = 0; i < st->n_ops; i++) if (st->ops[i].kind == OP_TLSREC) nrec++;
  if (nrec > 1 && pi->kind == PROTO_TLS) {
    int cuts[MAX_OPS]; int nc = 0;
    for (int i = 0; i < st->n_ops; i++) {
      if (st->ops[i].kind != OP_TLSREC) continue;
      int p = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi, sld), dup = 0;
      for (int j = 0; j < nc; j++) if (cuts[j] == p) dup = 1;
      if (!dup) cuts[nc++] = p;
    }
    for (int i = 1; i < nc; i++) {        /* insertion sort, descending */
      int v = cuts[i], j = i - 1;
      while (j >= 0 && cuts[j] < v) { cuts[j + 1] = cuts[j]; j--; }
      cuts[j + 1] = v;
    }
    for (int i = 0; i < nc; i++) {
      int nl = tls_split_at(payload, len, cap, cuts[i]);
      if (nl < 0) continue;
      for (int j = 0; j < nsplits; j++) if (splits[j] > cuts[i]) splits[j] += 5;
      len = nl;
    }
  }
  for (int i = 0; i < st->n_ops && nrec == 1; i++) {
    if (st->ops[i].kind != OP_TLSREC || pi->kind != PROTO_TLS) continue;
    int pos = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi, sld);
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
    int pos = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi, sld);
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
    int pos = resolve_pos(st->ops[i].ref, st->ops[i].offset, len, pi, sld);
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


  /* Random-size segments (chop): the whole payload, as it now is, cut its
   * own way; the cuts of split and disorder are not used beside it. */
  for (int i = 0; i < st->n_ops; i++) {
    if (st->ops[i].kind != OP_CHOP) continue;
    if (desync_counter) (*desync_counter)++;
    return send_chopped(up, payload, len, st);
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
