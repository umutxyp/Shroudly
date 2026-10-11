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
} engine_config;

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
int  engine_is_running(void);
const engine_stats *engine_get_stats(void);

/* Emit a one-line JSON stats record to stdout (consumed by the UI). */
void engine_emit_stats(void);

#endif
