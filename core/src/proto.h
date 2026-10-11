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

#endif
