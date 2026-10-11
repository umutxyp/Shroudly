#include "proto.h"
#include <string.h>
#include <ctype.h>

static int rd16(const uint8_t *p) { return (p[0] << 8) | p[1]; }

int tls_expected_len(const uint8_t *buf, size_t len) {
  if (len < 1 || buf[0] != 0x16) return 0;
  if (len < 5) return 5; /* need the header */
  if (buf[1] != 0x03) return 0;
  int rl = rd16(buf + 3);
  if (rl <= 0 || rl > 16384 + 2048) return 0;
  return 5 + rl;
}

static void parse_tls(const uint8_t *buf, size_t len, proto_info *out) {
  if (len < 6 || buf[0] != 0x16 || buf[1] != 0x03) return;
  int rec_total = 5 + rd16(buf + 3);
  size_t end = (size_t)rec_total < len ? (size_t)rec_total : len;
  if (buf[5] != 0x01) return; /* ClientHello */
  out->kind = PROTO_TLS;
  out->tls_record_total = rec_total;

  size_t p = 5 + 4 + 2 + 32; /* rec hdr + hs hdr + version + random */
  if (p + 1 > end) return;
  p += 1 + buf[p];                          /* session id */
  if (p + 2 > end) return;
  p += 2 + (size_t)rd16(buf + p);           /* cipher suites */
  if (p + 1 > end) return;
  p += 1 + buf[p];                          /* compression */
  if (p + 2 > end) return;
  size_t ext_end = p + 2 + (size_t)rd16(buf + p);
  p += 2;
  if (ext_end > end) ext_end = end;

  while (p + 4 <= ext_end) {
    int type = rd16(buf + p);
    size_t elen = (size_t)rd16(buf + p + 2);
    p += 4;
    if (p + elen > ext_end) return;
    if (type == 0x0000 && elen >= 5) {
      /* list_len(2) type(1) name_len(2) name */
      if (buf[p + 2] != 0x00) return;
      size_t nlen = (size_t)rd16(buf + p + 3);
      size_t noff = p + 5;
      if (nlen == 0 || noff + nlen > p + elen) return;
      out->host_off = (int)noff;
      out->host_len = (int)nlen;
      size_t c = nlen < sizeof(out->host) - 1 ? nlen : sizeof(out->host) - 1;
      memcpy(out->host, buf + noff, c);
      out->host[c] = 0;
      return;
    }
    p += elen;
  }
}

static const char *const METHODS[] = {
  "GET ", "POST ", "HEAD ", "PUT ", "DELETE ", "OPTIONS ", "PATCH ", "TRACE ", NULL
};

int http_is_request(const uint8_t *buf, size_t len) {
  for (int i = 0; METHODS[i]; i++) {
    size_t ml = strlen(METHODS[i]);
    if (len >= ml && memcmp(buf, METHODS[i], ml) == 0) return 1;
  }
  return 0;
}

static void parse_http(const uint8_t *buf, size_t len, proto_info *out) {
  if (!http_is_request(buf, len)) return;
  out->kind = PROTO_HTTP;
  /* scan header lines; stop at end of headers */
  size_t i = 0;
  while (i + 1 < len) {
    /* find next line start */
    while (i + 1 < len && !(buf[i] == '\r' && buf[i + 1] == '\n')) i++;
    if (i + 1 >= len) return;
    i += 2;
    if (i + 1 < len && buf[i] == '\r' && buf[i + 1] == '\n') return; /* end of headers */
    if (i + 5 <= len &&
        tolower(buf[i]) == 'h' && tolower(buf[i + 1]) == 'o' &&
        tolower(buf[i + 2]) == 's' && tolower(buf[i + 3]) == 't' && buf[i + 4] == ':') {
      size_t v = i + 5;
      while (v < len && (buf[v] == ' ' || buf[v] == '\t')) v++;
      size_t ve = v;
      while (ve < len && buf[ve] != '\r' && buf[ve] != '\n') ve++;
      /* strip port for the logical host name */
      out->http_hdr_off = (int)i;
      out->host_off = (int)v;
      out->host_len = (int)(ve - v);
      size_t hl = ve - v;
      if (hl >= sizeof(out->host)) hl = sizeof(out->host) - 1;
      memcpy(out->host, buf + v, hl);
      out->host[hl] = 0;
      char *colon = strrchr(out->host, ':');
      if (colon && out->host[0] != '[') *colon = 0;
      return;
    }
  }
}

void proto_inspect(const uint8_t *buf, size_t len, proto_info *out) {
  memset(out, 0, sizeof(*out));
  out->host_off = -1;
  out->http_hdr_off = -1;
  if (len == 0) return;
  if (buf[0] == 0x16) parse_tls(buf, len, out);
  else parse_http(buf, len, out);
  for (char *c = out->host; *c; c++) *c = (char)tolower((unsigned char)*c);
}
