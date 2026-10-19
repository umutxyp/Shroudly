#ifndef SHROUDLY_SOCKSUDP_H
#define SHROUDLY_SOCKSUDP_H

#include "platform.h"

/*
 * socksudp — the header every datagram of a SOCKS5 UDP association carries
 * (RFC 1928 section 7), between the client and the engine's relay port:
 *
 *   RSV(2) FRAG(1) ATYP(1) DST.ADDR DST.PORT(2) DATA
 *
 * ATYP 1 is an IPv4 address (4 bytes), 4 an IPv6 one (16), 3 a name (one
 * length byte, then the name). From the client DST is where the payload goes;
 * towards the client it is where a reply came from.
 *
 * Pure: nothing here touches the network, and both functions are total — a
 * short or malformed buffer is rejected, never read or written out of bounds.
 * Unit-tested in core/test/test_socksudp.c; the engine (engine.c) does the
 * sockets.
 */

#define SUDP_OK     0
#define SUDP_BAD  (-1)   /* malformed: too short, unknown ATYP, empty name, port 0 */
#define SUDP_FRAG (-2)   /* FRAG != 0: fragments are not reassembled, the datagram is dropped */

/* The longest header there can be (a 255-byte name), and the longest one the
 * engine writes (IPv6). */
#define SUDP_HDR_MAX       (4 + 1 + 255 + 2)
#define SUDP_REPLY_HDR_MAX (4 + 16 + 2)

typedef struct {
  uint8_t  atyp;       /* 1, 3 or 4 */
  uint8_t  addr[16];   /* ATYP 1: the first 4 bytes; ATYP 4: all 16 */
  char     host[256];  /* ATYP 3: the name, NUL-terminated */
  uint16_t port;       /* host order, never 0 */
  size_t   hdr_len;    /* where the payload starts: n - hdr_len bytes of it */
} sudp_dst;

/* Parse the header at the start of a datagram of n bytes from the client. A
 * name holding a NUL byte is refused (it would name something else once cut
 * at the NUL). RSV is not checked. Returns SUDP_OK, SUDP_BAD or SUDP_FRAG. */
int sudp_parse(const uint8_t *p, size_t n, sudp_dst *d);

/* For ATYP 1 and 4: the destination as a socket address. -1 for a name (the
 * caller resolves it). */
int sudp_dst_addr(const sudp_dst *d, struct sockaddr_storage *ss, socklen_t *sl);

/* Write the header for a reply that came from sa (AF_INET or AF_INET6; an
 * IPv4-mapped IPv6 address is written as IPv4) into out. Returns how many
 * bytes were written, or -1 when sa is of another family or cap is too small
 * (SUDP_REPLY_HDR_MAX is always enough). */
int sudp_build(const struct sockaddr *sa, uint8_t *out, size_t cap);

#endif
