#ifndef SHROUDLY_DOH_H
#define SHROUDLY_DOH_H

#include "platform.h"

/* Minimal DNS-over-HTTPS A/AAAA resolver.
 * The DoH server is reached over TLS with the desync engine applied to its own
 * ClientHello, so even the resolver connection survives SNI-based blocking.
 * Results are cached. Thread-safe. */

void doh_init(const char *doh_host, const char *doh_ip);
/* Most addresses one name is answered with (and cached under). */
#define DOH_MAX_ADDRS 8

/* Resolve name; fills sockaddr_storage + len. want6: prefer AAAA.
 * Returns 0 on success. Falls back to the OS resolver if DoH fails. */
int  doh_resolve(const char *name, uint16_t port, int want6,
                 struct sockaddr_storage *out, socklen_t *outlen);
/* Every usable address of the name (A, or AAAA when want6), in DNS order, up
 * to max. Returns how many were filled in, or -1. Answers are cached for their
 * TTL, held between 20 s and 5 minutes, and still handed out for 10 minutes
 * past it while a fresh one is fetched in the background. */
int  doh_resolve_all(const char *name, uint16_t port, int want6,
                     struct sockaddr_storage *out, socklen_t *outlen, int max);
/* A connection to this address of the name failed: drop it from the cache. */
void doh_forget(const char *name, const struct sockaddr_storage *sa);
void doh_clear_cache(void);

/* Point the resolver at a local DoH forwarder (127.0.0.1:port) that speaks real
 * encrypted DNS; tried before the public UDP resolvers. port<=0 disables it. */
void doh_set_local(const char *ip, int port);
/* That forwarder's address: 0, or -1 when there is none. */
int  doh_local_addr(struct sockaddr_in *out);
/* Strict: the forwarder alone answers (the user's own DNS server, set to be
 * used with no fallback): no public resolver over UDP, no system resolver,
 * except for a name only the local network knows (doh_local_name). */
void doh_set_strict(int on);
int  doh_strict(void);

/* Names that never resolve on the public internet (RFC 6761, 6762, 8375 and
 * their usual relatives): one label ("router"), or ending in .local, .lan,
 * .home.arpa, .internal, .localhost, .test or .invalid. Only the system's
 * resolver knows them, so it alone is asked, and the private address it
 * gives is taken (a known block page still is not). */
int  doh_local_name(const char *name);

/* Add an ISP block-page / sinkhole IPv4 (dotted). Such answers are rejected
 * like bogons. Turk Telekom's 195.175.254.2 is built in. */
void doh_add_block_ip(const char *ip);

/* True if a resolved address is a censorship answer (block page or bogon). */
int  doh_addr_is_block(const struct sockaddr_storage *sa);

/* True for an IPv4 (host order) that is a known block page: the built-in one
 * or one added with doh_add_block_ip. Never 0.0.0.0 or 127.0.0.0/8, which a
 * hosts file or the user's own filtering DNS answers with on purpose. */
int  doh_ipv4_is_blockpage(uint32_t ip);

/* A reply that may be handed to another program as it is (Advanced mode's
 * DNS gate, dnsgate.h): no error and, for A or AAAA (qtype 1, 28), a public
 * address or no record of that type at all. Not a private or block-page
 * address only, a failure or "no such name": that program's own DNS answers
 * those (an intranet, a VPN's names). */
int  doh_reply_usable(const uint8_t *r, int len, uint16_t qtype);

#endif
