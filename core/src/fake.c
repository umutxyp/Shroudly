#include "fake.h"
#include <string.h>
#include <stdlib.h>

int fake_available(void) {
#ifdef SHROUDLY_HAS_FAKE
  return 1;
#else
  return 0;
#endif
}

#ifdef SHROUDLY_HAS_FAKE

/* The decoy is the real request with the server name replaced by a harmless
 * one of exactly the same length. Keeping the length identical means every
 * length field in the record stays correct, so what the filter reads is a
 * complete, well-formed request for a site nobody blocks — which is the point:
 * it has to be convincing enough that the filter makes its decision on it. */
/* Returns 0 when there is no name to replace: without one the "decoy" would
 * be an exact copy of the real request, which teaches the filter nothing and
 * is not worth an attempt. */
static int build_decoy(uint8_t *dst, const uint8_t *real, int n,
                       const proto_info *pi) {
  /* A stream that is neither TLS nor HTTP has no name to swap. What a filter
   * recognises such a protocol by is its first bytes, so the decoy is zeros
   * of the same length: nothing any protocol filter matches, and low enough
   * in entropy that an "everything that looks random" rule passes it. */
  if (pi->kind == PROTO_UNKNOWN) { memset(dst, 0, (size_t)n); return n > 0; }
  memcpy(dst, real, (size_t)n);
  int off = pi->host_off, len = pi->host_len;
  if (off <= 0 || len < 6 || off + len > n) return 0;
  /* Letters, with a dot every so often so no label exceeds the 63 the DNS
   * grammar allows, and a plausible suffix. */
  for (int i = 0; i < len - 4; i++)
    dst[off + i] = (uint8_t)((i % 16 == 15) ? '.' : ('a' + ((i * 7 + 3) % 23)));
  memcpy(dst + off + len - 4, ".com", 4);
  if (dst[off] == '.') dst[off] = 'a';
  if (dst[off + len - 5] == '.') dst[off + len - 5] = 'a';
  return 1;
}

/* ───────────────────────────── Linux ───────────────────────────── */
#if defined(__linux__)
#include <sys/mman.h>
#include <sys/uio.h>
#include <fcntl.h>
#include <unistd.h>
#include <netinet/tcp.h>

/* Declared in <linux/tcp.h>, which cannot be included next to <netinet/tcp.h>
 * without clashing, so the kernel's layout is restated here. */
#ifndef TCP_MD5SIG
#define TCP_MD5SIG 14
#endif
struct shr_md5sig {
  struct sockaddr_storage tcpm_addr;
  uint8_t  tcpm_flags;
  uint8_t  tcpm_prefixlen;
  uint16_t tcpm_keylen;
  uint32_t tcpm_pad;
  uint8_t  tcpm_key[80];
};

/* With a signature key installed, Linux adds an RFC 2385 option to every
 * segment on this connection. A peer that has no matching key must discard
 * those segments, so the decoy is dropped by the server itself no matter how
 * many hops away it is — no TTL guessing. Middleboxes are not RFC 2385
 * endpoints and read the payload regardless. */
static int set_md5(sock_t s, int keylen) {
  struct shr_md5sig m;
  memset(&m, 0, sizeof(m));
  socklen_t al = sizeof(m.tcpm_addr);
  if (getpeername(s, (struct sockaddr *)&m.tcpm_addr, &al) != 0) return -1;
  m.tcpm_keylen = (uint16_t)keylen;
  return setsockopt(s, IPPROTO_TCP, TCP_MD5SIG, &m, sizeof(m));
}

int fake_send_first(sock_t s, int family, const uint8_t *real, int n,
                    const proto_info *pi, int ttl, int use_md5) {
  if (n <= 0) return -1;

  long ps = sysconf(_SC_PAGESIZE);
  if (ps <= 0) ps = 4096;
  size_t alloc = ((size_t)n + (size_t)ps - 1) & ~((size_t)ps - 1);
  void *pages = mmap(NULL, alloc, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (pages == MAP_FAILED) return -1;
  if (!build_decoy((uint8_t *)pages, real, n, pi)) { munmap(pages, alloc); return -1; }

  int fds[2];
  if (pipe(fds) != 0) { munmap(pages, alloc); return -1; }

  /* The decoy MUST NOT reach the server: if it did, the origin would answer
   * the forged name, the reply would look like a perfectly good handshake, and
   * the browser would then fail on a certificate for a site the user never
   * asked for. A signature key makes the drop certain — the server has no
   * matching key, so RFC 2385 requires it to discard the segment, whatever the
   * hop count. A low TTL only guesses, and guesses wrong whenever the origin
   * is nearer than the guess, so it is not used on its own. */
  int md5_set = (set_md5(s, 5) == 0);
  if (!md5_set) {                    /* no signature support: do not risk it */
    close(fds[0]); close(fds[1]); munmap(pages, alloc);
    return -1;
  }
  int saved = sock_get_ttl(s, family);
  if (saved <= 0) saved = 64;
  /* A low TTL on top is belt and braces: it costs nothing and drops the decoy
   * even earlier, but nothing depends on it. */
  int ttl_set = (ttl > 0 && ttl < 16 && sock_set_ttl(s, family, ttl) == 0);
  (void)use_md5;

  /* Hand the pages to the kernel rather than copying them, so the socket's
   * send queue points at memory we can still write to. */
  struct iovec iov; iov.iov_base = pages; iov.iov_len = (size_t)n;
  ssize_t gifted = vmsplice(fds[1], &iov, 1, SPLICE_F_GIFT);
  ssize_t sent = (gifted > 0) ? splice(fds[0], NULL, s, NULL, (size_t)gifted, 0) : -1;
  close(fds[0]); close(fds[1]);

  /* The swap has to happen after the decoy is on the wire and before TCP
   * resends it. Waiting for the send queue to drain gives us that window. */
  if (sent > 0) {
    sock_wait_sent(s, 50);
    memcpy(pages, real, (size_t)n);   /* every retransmission is now the truth */
  }

  if (md5_set) set_md5(s, 0);
  if (ttl_set) sock_set_ttl(s, family, saved);
  munmap(pages, alloc);               /* the kernel keeps its own reference */

  return sent > 0 ? (int)sent : -1;
}

#endif

#else  /* no decoy support on this platform */

int fake_send_first(sock_t s, int family, const uint8_t *real, int n,
                    const proto_info *pi, int ttl, int use_md5) {
  (void)s; (void)family; (void)real; (void)n; (void)pi; (void)ttl; (void)use_md5;
  return -1;
}

#endif
