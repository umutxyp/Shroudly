#ifndef SHROUDLY_PROTO_H
#define SHROUDLY_PROTO_H

#include <stddef.h>
#include <stdint.h>

typedef enum { PROTO_UNKNOWN = 0, PROTO_TLS = 1, PROTO_HTTP = 2 } proto_kind;

typedef struct {
  proto_kind kind;
  /* TLS: absolute offset/length of the SNI hostname inside the buffer.
   * HTTP: absolute offset/length of the Host header value. -1 if absent. */
  int host_off;
  int host_len;
  /* HTTP only: offset of the "Host" header name (start of line). */
  int http_hdr_off;
  /* TLS only: total length of the first TLS record (5 + record length). */
  int tls_record_total;
  char host[256];
} proto_info;

/* Returns how many bytes of a first TLS record are expected given the bytes
 * seen so far: 0 if the buffer does not start a TLS handshake record. */
int  tls_expected_len(const uint8_t *buf, size_t len);

/* Inspect the first client payload. */
void proto_inspect(const uint8_t *buf, size_t len, proto_info *out);

/* True if buf starts an HTTP/1.x request line. */
int  http_is_request(const uint8_t *buf, size_t len);

/* ───────── decoy names (networks that let only allowed sites through) ─────
 * A decoy normally carries a scrambled name: enough for a filter that blocks
 * a list of names, which reads it, finds nothing on its list and lets the
 * connection go. A network that lets through only the names on ITS list (a
 * whitelist, as during Iran's shutdowns) stops a scrambled name as surely as
 * the real one. There the decoy has to carry a name the network allows: a
 * large site of that country, given with --decoy-name (the app passes the
 * country's own sites when it finds that only the country's network works).
 * Up to PROTO_DECOY_NAMES names, used in turn. The decoy still never
 * reaches the server (low TTL, bad checksum); only the filter reads it. */
#define PROTO_DECOY_NAMES 8

/* Adds a name (letters, digits, '-' and '.', with a dot, 4..253 bytes).
 * 0 when added, -1 when it is not a host name or the table is full. */
int  proto_decoy_name_add(const char *name);
void proto_decoy_names_reset(void);
int  proto_decoy_name_count(void);

/* The decoy of a packet-layer backend: `real` (n bytes, a TLS ClientHello or
 * an HTTP request whose name is at host_off/host_len) copied into dst with
 * the name replaced by the next decoy name, whatever its length; a TLS
 * ClientHello has its record, handshake, extensions and server-name lengths
 * rewritten to match. The result is at most `limit` bytes (the caller's
 * room on the wire). Returns its length, or 0 when there is no decoy name,
 * the request is not one this can rewrite, or no name fits: the caller then
 * sends its scrambled decoy as before. */
int  proto_decoy_rename(uint8_t *dst, int cap, const uint8_t *real, int n,
                         int is_tls, int host_off, int host_len, int limit);

/* The same where the decoy must keep the real request's length (the Linux
 * stream decoy, whose bytes TCP later resends as the real ones): the name
 * field of buf is overwritten with a decoy name of exactly host_len bytes,
 * the name itself or a subdomain of it ("cdn.example.ir"). Returns 1 when
 * done, 0 when no decoy name fits that length. */
int  proto_decoy_fill(uint8_t *buf, int n, int host_off, int host_len);

#endif
