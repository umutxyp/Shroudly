/*
 * nfq — see nfq.h.
 *
 * The protocol (the kernel's include/uapi/linux/netfilter/nfnetlink_queue.h):
 * every message is a netlink header (length, type, flags, sequence, port;
 * host byte order), a netfilter header (family, version, the queue number in
 * network byte order) and attributes (length and type, host order; their
 * contents in network order), each padded to four bytes. The type of a
 * queue message is the subsystem (3) in its high byte and the message in its
 * low one: a packet (0), a verdict (1), a config (2). Written out here so the
 * parsing and the messages build and are tested on any system.
 */
#include "nfq.h"

#include <string.h>

#define NLHDR        16
#define NFGEN        4
#define ALIGN4(n)    (((n) + 3u) & ~3u)
#define NLM_F_REQ    0x01
#define NLM_F_ACKREQ 0x04
#define NLMSG_ERR    2
#define SUBSYS_QUEUE 3
#define MSG_PACKET   0
#define MSG_VERDICT  1
#define MSG_CONFIG   2
#define CFG_CMD      1          /* NFQA_CFG_CMD */
#define CFG_PARAMS   2          /* NFQA_CFG_PARAMS */
#define CFG_MASK     4          /* NFQA_CFG_MASK */
#define CFG_FLAGS    5          /* NFQA_CFG_FLAGS */
#define F_FAIL_OPEN  1u         /* NFQA_CFG_F_FAIL_OPEN: a full queue lets packets through */
#define A_PACKET_HDR 1          /* NFQA_PACKET_HDR */
#define A_VERDICT    2          /* NFQA_VERDICT_HDR */
#define A_MARK       3          /* NFQA_MARK */
#define A_PAYLOAD    10         /* NFQA_PAYLOAD */
#define COPY_PACKET  2          /* NFQNL_COPY_PACKET */
#define TYPE_MASK    0x3fff     /* without NLA_F_NESTED / NLA_F_NET_BYTEORDER */

static uint32_t rd32h(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint16_t rd16h(const uint8_t *p) { uint16_t v; memcpy(&v, p, 2); return v; }
static uint32_t rd32be(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static void wr32h(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
static void wr16h(uint8_t *p, uint16_t v) { memcpy(p, &v, 2); }
static void wr32be(uint8_t *p, uint32_t v) { p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v; }
static void wr16be(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

int nfq_parse(uint8_t *buf, size_t len, void (*cb)(const nfq_packet *, void *), void *ud) {
  if (len < NLHDR) return -1;
  int n = 0;
  size_t off = 0;
  /* Offsets are compared by adding, never by subtracting: the padding after
   * the last message or attribute may take an offset past the end. */
  while (off + NLHDR <= len) {
    uint32_t mlen = rd32h(buf + off);
    uint16_t type = rd16h(buf + off + 4);
    if (mlen < NLHDR || mlen > len - off) break;
    if ((type >> 8) == SUBSYS_QUEUE && (type & 0xff) == MSG_PACKET && mlen >= NLHDR + NFGEN) {
      nfq_packet p = { 0, 0, NULL, 0 };
      int have_id = 0;
      size_t a = off + NLHDR + NFGEN, end = off + mlen;
      while (a + 4 <= end) {
        uint16_t alen = rd16h(buf + a), atype = rd16h(buf + a + 2) & TYPE_MASK;
        if (alen < 4 || alen > end - a) break;
        const uint8_t *v = buf + a + 4;
        size_t vlen = alen - 4u;
        if (atype == A_PACKET_HDR && vlen >= 4) { p.id = rd32be(v); have_id = 1; }
        else if (atype == A_MARK && vlen >= 4) p.mark = rd32be(v);
        else if (atype == A_PAYLOAD) { p.payload = buf + a + 4; p.len = (int)vlen; }
        a += ALIGN4(alen);
      }
      if (have_id) { if (cb) cb(&p, ud); n++; }
    }
    off += ALIGN4(mlen);
  }
  return n;
}

/* A message's two headers; the attributes go after them. */
static size_t head(uint8_t *out, uint16_t msg, uint16_t flags, uint32_t seq, uint8_t family, uint16_t queue) {
  memset(out, 0, NLHDR + NFGEN);
  wr16h(out + 4, (uint16_t)((SUBSYS_QUEUE << 8) | msg));
  wr16h(out + 6, flags);
  wr32h(out + 8, seq);
  out[NLHDR] = family;
  out[NLHDR + 1] = 0;                                   /* NFNETLINK_V0 */
  wr16be(out + NLHDR + 2, queue);
  return NLHDR + NFGEN;
}
static size_t attr(uint8_t *out, uint16_t type, const uint8_t *v, size_t vlen) {
  wr16h(out, (uint16_t)(4 + vlen));
  wr16h(out + 2, type);
  memcpy(out + 4, v, vlen);
  size_t all = ALIGN4(4 + vlen);
  memset(out + 4 + vlen, 0, all - 4 - vlen);
  return all;
}

int nfq_build_cmd(uint8_t *out, size_t cap, uint16_t queue, uint8_t cmd, uint32_t seq) {
  if (cap < 32) return -1;
  /* PF_BIND / PF_UNBIND (3, 4) name no queue; BIND / UNBIND (1, 2) do. */
  size_t n = head(out, MSG_CONFIG, NLM_F_REQ | NLM_F_ACKREQ, seq, 0, cmd >= 3 ? 0 : queue);
  uint8_t v[4] = { cmd, 0, 0, 0 };
  wr16be(v + 2, 2);                                     /* AF_INET */
  n += attr(out + n, CFG_CMD, v, 4);
  wr32h(out, (uint32_t)n);
  return (int)n;
}

int nfq_build_mode(uint8_t *out, size_t cap, uint16_t queue, uint32_t copy_range, uint32_t seq) {
  if (cap < 64) return -1;
  size_t n = head(out, MSG_CONFIG, NLM_F_REQ | NLM_F_ACKREQ, seq, 0, queue);
  uint8_t v[5];
  wr32be(v, copy_range);
  v[4] = COPY_PACKET;
  n += attr(out + n, CFG_PARAMS, v, 5);
  wr32h(out, (uint32_t)n);
  return (int)n;
}

int nfq_build_verdict(uint8_t *out, size_t cap, uint16_t queue, uint32_t id, uint32_t verdict) {
  if (cap < 32) return -1;
  size_t n = head(out, MSG_VERDICT, NLM_F_REQ, 0, 0, queue);
  uint8_t v[8];
  wr32be(v, verdict);
  wr32be(v + 4, id);
  n += attr(out + n, A_VERDICT, v, 8);
  wr32h(out, (uint32_t)n);
  return (int)n;
}

#if defined(__linux__)
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <linux/netlink.h>

/* Send one message asking for an ack, and read the ack: 0, or -1 with errno
 * the kernel's answer. */
static int ask(int fd, const uint8_t *msg, int len, uint32_t seq) {
  struct sockaddr_nl to;
  memset(&to, 0, sizeof(to));
  to.nl_family = AF_NETLINK;
  if (sendto(fd, msg, (size_t)len, 0, (struct sockaddr *)&to, sizeof(to)) != len) return -1;
  uint8_t buf[8192];
  for (int tries = 0; tries < 16; tries++) {
    ssize_t r = recv(fd, buf, sizeof(buf), 0);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    size_t off = 0;
    while (off + NLHDR <= (size_t)r) {
      uint32_t mlen = rd32h(buf + off);
      if (mlen < NLHDR || mlen > (size_t)r - off) break;
      if (rd16h(buf + off + 4) == NLMSG_ERR && rd32h(buf + off + 8) == seq && mlen >= NLHDR + 4) {
        int32_t err; memcpy(&err, buf + off + NLHDR, 4);
        if (err == 0) return 0;
        errno = -err;
        return -1;
      }
      off += ALIGN4(mlen);
    }
  }
  errno = ETIMEDOUT;
  return -1;
}

int nfq_open_queue(uint16_t queue, uint32_t copy_range) {
  int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_NETFILTER);
  if (fd < 0) return -1;
  struct sockaddr_nl me;
  memset(&me, 0, sizeof(me));
  me.nl_family = AF_NETLINK;
  if (bind(fd, (struct sockaddr *)&me, sizeof(me)) != 0) { int e = errno; close(fd); errno = e; return -1; }
  /* Room for bursts: a packet the socket has no room for is lost to us. */
  int rcv = 4 * 1024 * 1024;
  setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcv, sizeof(rcv));
  /* The kernel answers each config message at once; a setup never waits
   * longer than this for one. Cleared again before packets are read. */
  struct timeval tv = { 2, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  uint8_t msg[64];
  uint32_t seq = 1;
  /* What kernels before 3.8 needed (and later ones ignore): the family
   * bound to queueing at all. */
  int n = nfq_build_cmd(msg, sizeof(msg), queue, 4, seq);   /* PF_UNBIND */
  ask(fd, msg, n, seq++);
  n = nfq_build_cmd(msg, sizeof(msg), queue, 3, seq);       /* PF_BIND */
  ask(fd, msg, n, seq++);
  n = nfq_build_cmd(msg, sizeof(msg), queue, 1, seq);       /* BIND this queue */
  if (ask(fd, msg, n, seq++) != 0) { int e = errno; close(fd); errno = e; return -1; }
  n = nfq_build_mode(msg, sizeof(msg), queue, copy_range, seq);
  if (ask(fd, msg, n, seq++) != 0) { int e = errno; nfq_close_queue(fd, queue); errno = e; return -1; }
  /* A full queue lets packets through rather than dropping them (3.6 and
   * later; older kernels say no, which changes nothing). */
  size_t m = head(msg, MSG_CONFIG, NLM_F_REQ | NLM_F_ACKREQ, seq, 0, queue);
  uint8_t f[4]; wr32be(f, F_FAIL_OPEN);
  m += attr(msg + m, CFG_FLAGS, f, 4);
  m += attr(msg + m, CFG_MASK, f, 4);
  wr32h(msg, (uint32_t)m);
  ask(fd, msg, (int)m, seq++);
  struct timeval none = { 0, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &none, sizeof(none));
  return fd;
}

int nfq_verdict(int fd, uint16_t queue, uint32_t id, uint32_t verdict) {
  uint8_t msg[64];
  int n = nfq_build_verdict(msg, sizeof(msg), queue, id, verdict);
  struct sockaddr_nl to;
  memset(&to, 0, sizeof(to));
  to.nl_family = AF_NETLINK;
  return sendto(fd, msg, (size_t)n, 0, (struct sockaddr *)&to, sizeof(to)) == n ? 0 : -1;
}

void nfq_close_queue(int fd, uint16_t queue) {
  if (fd < 0) return;
  uint8_t msg[64];
  int n = nfq_build_cmd(msg, sizeof(msg), queue, 2, 99);    /* UNBIND */
  struct sockaddr_nl to;
  memset(&to, 0, sizeof(to));
  to.nl_family = AF_NETLINK;
  sendto(fd, msg, (size_t)n, 0, (struct sockaddr *)&to, sizeof(to));
  close(fd);
}
#endif
