#include "socksudp.h"
#include <string.h>

int sudp_parse(const uint8_t *p, size_t n, sudp_dst *d) {
  memset(d, 0, sizeof(*d));
  if (!p || n < 4) return SUDP_BAD;
  if (p[2] != 0) return SUDP_FRAG;
  size_t off = 4;
  d->atyp = p[3];
  if (d->atyp == 0x01) {
    if (n < off + 4 + 2) return SUDP_BAD;
    memcpy(d->addr, p + off, 4);
    off += 4;
  } else if (d->atyp == 0x04) {
    if (n < off + 16 + 2) return SUDP_BAD;
    memcpy(d->addr, p + off, 16);
    off += 16;
  } else if (d->atyp == 0x03) {
    if (n < off + 1) return SUDP_BAD;
    size_t l = p[off++];
    if (l == 0 || n < off + l + 2) return SUDP_BAD;
    if (memchr(p + off, 0, l)) return SUDP_BAD;
    memcpy(d->host, p + off, l);   /* 255 at most: always fits */
    d->host[l] = 0;
    off += l;
  } else {
    return SUDP_BAD;
  }
  d->port = (uint16_t)((p[off] << 8) | p[off + 1]);
  off += 2;
  if (d->port == 0) return SUDP_BAD;
  d->hdr_len = off;
  return SUDP_OK;
}

int sudp_dst_addr(const sudp_dst *d, struct sockaddr_storage *ss, socklen_t *sl) {
  memset(ss, 0, sizeof(*ss));
  if (d->atyp == 0x01) {
    struct sockaddr_in *a = (struct sockaddr_in *)ss;
    a->sin_family = AF_INET;
    a->sin_port = htons(d->port);
    memcpy(&a->sin_addr, d->addr, 4);
    *sl = (socklen_t)sizeof(*a);
    return 0;
  }
  if (d->atyp == 0x04) {
    struct sockaddr_in6 *a = (struct sockaddr_in6 *)ss;
    a->sin6_family = AF_INET6;
    a->sin6_port = htons(d->port);
    memcpy(&a->sin6_addr, d->addr, 16);
    *sl = (socklen_t)sizeof(*a);
    return 0;
  }
  return -1;
}

int sudp_build(const struct sockaddr *sa, uint8_t *out, size_t cap) {
  if (!sa || !out) return -1;
  const uint8_t *ip; size_t alen; uint8_t atyp; uint16_t port;
  if (sa->sa_family == AF_INET) {
    const struct sockaddr_in *a = (const struct sockaddr_in *)sa;
    ip = (const uint8_t *)&a->sin_addr; alen = 4; atyp = 0x01; port = ntohs(a->sin_port);
  } else if (sa->sa_family == AF_INET6) {
    const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)sa;
    static const uint8_t mapped[12] = { 0,0,0,0, 0,0,0,0, 0,0,0xff,0xff };
    ip = (const uint8_t *)&a->sin6_addr; alen = 16; atyp = 0x04; port = ntohs(a->sin6_port);
    if (memcmp(ip, mapped, 12) == 0) { ip += 12; alen = 4; atyp = 0x01; }
  } else {
    return -1;
  }
  size_t len = 4 + alen + 2;
  if (cap < len) return -1;
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = atyp;
  memcpy(out + 4, ip, alen);
  out[4 + alen] = (uint8_t)(port >> 8);
  out[5 + alen] = (uint8_t)(port & 0xff);
  return (int)len;
}
