#ifndef SHROUDLY_DESYNC_H
#include <stdint.h>
#define SHROUDLY_DESYNC_H

#include "platform.h"
#include "strategy.h"
#include "proto.h"

/* Send the first client payload to the upstream socket applying the strategy.
 * `family` is the upstream address family (for TTL ops). Returns 0 on success. */
int desync_send_first(sock_t up, int family,
                      uint8_t *payload, int len,
                      const proto_info *pi, const strategy *st,
                      _Atomic uint64_t *desync_counter);

#endif
