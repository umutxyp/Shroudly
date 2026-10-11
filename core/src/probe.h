#ifndef SHROUDLY_PROBE_H
#define SHROUDLY_PROBE_H

#include "engine.h"

/* Try each preset strategy against `host:443` by performing a real TLS
 * handshake through the desync path and checking whether the server replies
 * with a ServerHello. Returns the index of the first working preset, or -1.
 * Writes a human line to stdout for the UI log. */
int probe_host(const char *host, const engine_config *cfg);

void engine_learn(const char *host, int preset); /* defined in engine.c */

#endif
