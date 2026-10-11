#ifndef SHROUDLY_DOH_H
#define SHROUDLY_DOH_H

#include "platform.h"

/* Minimal DNS-over-HTTPS A/AAAA resolver.
 * The DoH server is reached over TLS with the desync engine applied to its own
 * ClientHello, so even the resolver connection survives SNI-based blocking.
 * Results are cached. Thread-safe. */

void doh_init(const char *doh_host, const char *doh_ip);
/* Resolve name; fills sockaddr_storage + len. want6: prefer AAAA.
 * Returns 0 on success. Falls back to the OS resolver if DoH fails. */
int  doh_resolve(const char *name, uint16_t port, int want6,
                 struct sockaddr_storage *out, socklen_t *outlen);
void doh_clear_cache(void);

#endif
