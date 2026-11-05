/*
 * Connections, by name (issue #74): what goes through the engine, per site
 * name, for the app's "Connections" list, and the names the user blocked
 * there.
 *
 * Every connection the engine takes is counted under the name it is for (the
 * TLS server name or the HTTP host once seen, else the name or address the
 * app asked for): how many are open now, how many there were, the bytes each
 * way, and how they went out (straight, with a technique, through the user's
 * own server, through Tor). Kept in memory only, for this run, at most
 * CONNS_HOSTS names (the longest idle one makes room); never written
 * anywhere. CONNS prints the list.
 *
 * BLOCK <name> refuses new connections to that name and every name under it
 * (as the ad and tracker list does) and ends the open ones at once. The list
 * is the app's to keep: it gives it again at every start. UNBLOCK lifts one,
 * BLOCK-CLEAR all.
 */
#ifndef SHROUDLY_CONNS_H
#define SHROUDLY_CONNS_H

#include <stdint.h>
#include "platform.h"

#define CONNS_HOSTS  256
#define CONNS_ACTIVE 1024
#define CONNS_BLOCK  512

enum { CONN_DIRECT = 0, CONN_TECHNIQUE = 1, CONN_SERVER = 2, CONN_TOR = 3 };

void conns_init(void);
/* A new connection for `host`: its slot, or -1 when the table is full
 * (it is then simply not listed). */
int  conns_begin(const char *host);
/* The name it turned out to be for (the TLS server name of a connection
 * asked for by address). */
void conns_name(int slot, const char *host);
void conns_route(int slot, int route);
/* Its two sockets, so a BLOCK can end it. */
void conns_sockets(int slot, sock_t a, sock_t b);
void conns_bytes(int slot, uint64_t up, uint64_t down);
void conns_end(int slot);

/* 1 if the user blocked this name or one above it (counted for the list). */
int  conns_blocked(const char *host);
int  conns_block(const char *host);
int  conns_unblock(const char *host);
void conns_block_clear(void);

/* The list as JSON lines: {"type":"conn",...} per name, most recent first,
 * then {"type":"conns_end","n":N}. */
void conns_emit(void);
/* Everything forgotten (a new run in the same process). */
void conns_forget(void);

#endif
