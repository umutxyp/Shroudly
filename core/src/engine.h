#ifndef SHROUDLY_ENGINE_H
#define SHROUDLY_ENGINE_H

#include "platform.h"

#include <stdint.h>
#include "strategy.h"

typedef struct {
  char     listen_addr[64];   /* default 127.0.0.1 */
  int      listen_port;       /* SOCKS5 listen port, default 10800 */
  int      use_doh;           /* resolve names via DoH */
  char     doh_host[128];     /* e.g. cloudflare-dns.com */
  char     doh_ip[64];        /* bootstrap IP, e.g. 1.1.1.1 */
  int      auto_probe;        /* pick a working strategy per host automatically */
  int      prefer_ipv6;
  strategy strat;             /* active strategy (used when auto_probe is off,
                                 and as the first candidate when it is on) */
  /* SOCKS5 username/password (RFC 1929), from --auth-file. Empty: no
   * authentication, and SOCKS4 is taken as well. Set: every connection must
   * be SOCKS5 and give exactly these. */
  char     auth_user[256];
  char     auth_pass[256];
  /* --fake-net: address ranges that stand in for names and are no real
   * destination (a tunnel's own map of names to made-up addresses). A
   * CONNECT to one is refused at once and a datagram to one is dropped, so a
   * stand-in address that outlived its mapping fails fast instead of waiting
   * out a connect timeout. */
#define ENGINE_FAKE_NET_MAX 8
  struct { int fam; uint8_t addr[16]; int bits; } fake_net[ENGINE_FAKE_NET_MAX];
  int      fake_net_n;
  /* --watch: domains the app wants to hear about. A connection to one of them
   * or to a name under it is told as {"type":"seen","host":...}, once per
   * name every ENGINE_WATCH_EVERY_MS; nothing about the connection changes.
   * The desktop app watches Discord's voice servers: a call starting, in a
   * browser or in the app, whose sound then goes over UDP, which only the
   * Advanced mode can do anything for. */
#define ENGINE_WATCH_MAX      8
#define ENGINE_WATCH_EVERY_MS (10 * 60 * 1000)
  char     watch[ENGINE_WATCH_MAX][128];
  int      watch_n;
} engine_config;

/* Add the ranges in spec ("198.18.0.0/15", or several joined by commas;
 * IPv4 or IPv6, a bare address is one host) to cfg's fake_net. 0, or -1 when
 * one does not parse or there are more than ENGINE_FAKE_NET_MAX in all. */
int  engine_add_fake_net(engine_config *cfg, const char *spec);

/* Add a domain to watch (see watch above): lower-cased, a trailing dot
 * dropped. 0, or -1 when it is not a plain domain name or there are more
 * than ENGINE_WATCH_MAX. */
int  engine_add_watch(engine_config *cfg, const char *domain);

/* Read "user:pass" (one line; a trailing newline is ignored) from path into
 * cfg. Each part 1..255 bytes. 0 on success, -1 when the file cannot be read
 * or does not hold that. */
int  engine_load_auth(engine_config *cfg, const char *path);

typedef struct {
  _Atomic uint64_t conns_total;
  _Atomic uint64_t conns_active;
  _Atomic uint64_t bytes_up;
  _Atomic uint64_t bytes_down;
  _Atomic uint64_t desync_applied;
  _Atomic uint64_t tls_seen;
  _Atomic uint64_t http_seen;
  _Atomic uint64_t probe_success;
  _Atomic uint64_t probe_fail;
} engine_stats;

/* Lifecycle. start() returns 0 on success and runs the accept loop on its own
 * thread; stop() is safe to call from any thread and from a signal handler path
 * (it just flips a flag and closes the listener). */
int  engine_start(const engine_config *cfg);
void engine_stop(void);
/* A technique an earlier run learned for host, age milliseconds ago (see engine.c). */
int  engine_restore(const char *host, const char *technique, uint64_t age);
int  engine_is_running(void);
const engine_stats *engine_get_stats(void);

/* Emit a one-line JSON stats record to stdout (consumed by the UI). */
void engine_emit_stats(void);

#endif
