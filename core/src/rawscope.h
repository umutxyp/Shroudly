#ifndef SHROUDLY_RAWSCOPE_H
#define SHROUDLY_RAWSCOPE_H

#include <stddef.h>
#include <stdint.h>

/*
 * rawscope — what the Advanced-mode packet engine may touch. Shared by both
 * raw backends (raw_windows.c, raw_linux.c) and tested directly
 * (core/test/test_rawscope.c). Pure: no sockets, no OS packet API.
 *
 * The engine sends decoys, cuts segments, drops QUIC Initials and drops
 * resets. All of that is meant for servers out on the internet. On a shared
 * network (an internet cafe, an office, a dorm) the same tricks aimed at the
 * router or at other machines on the LAN could upset them, so:
 *   - traffic to a local / private / special destination is never changed:
 *     no TCP decoy, cut, seqovl or fakedsplit, no UDP decoys, no QUIC drop;
 *   - an inbound reset is only ever dropped when it comes from a remote
 *     address this engine itself desynced a short while ago. A reset from any
 *     other host passes, whatever it looks like.
 */

/* 1 when the destination must be left alone, 0 when it is a normal internet
 * address. a4 is the 4 address bytes as on the wire, a6 the 16 bytes.
 * IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12,
 *       192.168/16, 224/4 (multicast) and 240/4 (reserved + broadcast).
 * IPv6: :: and ::1, fc00::/7 (unique local), fe80::/10 (link-local),
 *       ff00::/8 (multicast), and an IPv4-mapped ::ffff:a.b.c.d by its IPv4
 *       rule. The documentation ranges (192.0.2/24, 198.51.100/24,
 *       203.0.113/24, 2001:db8::/32) are not in the list. */
int rawscope_local4(const uint8_t a4[4]);
int rawscope_local6(const uint8_t a6[16]);

/* ── recently desynced destinations ──────────────────────────────────────
 * A small fixed table of the remote addresses the engine sent decoys or cut
 * segments to, each with the time it last did. A reset is only a candidate
 * for dropping when its source is in here and not older than
 * RAWSCOPE_TOUCH_TTL_MS. A full table reuses its oldest entry. Each backend
 * reads and writes it from its single packet-loop thread only, so it has no
 * lock (the same as the hop-count table in tcpdpi.c). */
#define RAWSCOPE_TOUCH_CAP    256
#define RAWSCOPE_TOUCH_TTL_MS 180000 /* 3 minutes */

void rawscope_touch_reset(void);
/* alen is 4 (IPv4) or 16 (IPv6); anything else is ignored / never touched. */
void rawscope_touch(const uint8_t *addr, int alen, uint64_t now_ms);
int  rawscope_touched(const uint8_t *addr, int alen, uint64_t now_ms);

/* ── counters ────────────────────────────────────────────────────────────
 * Bumped by the packet thread, read by whoever reports them (the supervise
 * thread at stop), so they are atomic. */
enum {
  RAWSCOPE_DESYNCED = 0, /* first segments to a remote server that got the decoy / cut */
  RAWSCOPE_SKIPPED,      /* packets the engine would have changed, left alone: local destination */
  RAWSCOPE_RST_DROPPED,  /* injected-looking resets dropped (from a desynced server) */
  RAWSCOPE_RST_PASSED,   /* injected-looking resets let through (from anywhere else) */
  RAWSCOPE_NCOUNTERS
};
void          rawscope_count(int which);
unsigned long rawscope_counter(int which);
void          rawscope_counters_reset(void);

/* The counters as one status line, without a newline:
 *   {"type":"raw_stats","desynced":N,"skipped":N,"rst_dropped":N,"rst_passed":N}
 * Returns its length, or 0 when it does not fit cap. */
int  rawscope_stats_json(char *buf, size_t cap);
/* Print that line to stdout (the status file when the engine is elevated). */
void rawscope_stats_print(void);

#endif
