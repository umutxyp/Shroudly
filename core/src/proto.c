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

/* ───────── decoy names ───────── */

static char g_dnames[PROTO_DECOY_NAMES][254];
static int  g_dn_count;
static unsigned g_dn_next;

static int host_name_ok(const char *s, size_t len) {
  if (len < 4 || len > 253 || s[0] == '.' || s[0] == '-' || s[len - 1] == '.' || s[len - 1] == '-') return 0;
  int dot = 0, label = 0;
  for (size_t i = 0; i < len; i++) {
    char ch = s[i];
    if (ch == '.') { if (label == 0) return 0; dot = 1; label = 0; continue; }
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-')) return 0;
    if (++label > 63) return 0;
  }
  return dot;
}

int proto_decoy_name_add(const char *name) {
  if (!name || g_dn_count >= PROTO_DECOY_NAMES) return -1;
  size_t len = strlen(name);
  if (!host_name_ok(name, len)) return -1;
  for (size_t i = 0; i < len; i++) {
    char ch = name[i];
    g_dnames[g_dn_count][i] = (ch >= 'A' && ch <= 'Z') ? (char)(ch + 32) : ch;
  }
  g_dnames[g_dn_count][len] = 0;
  g_dn_count++;
  return 0;
}

void proto_decoy_names_reset(void) { g_dn_count = 0; g_dn_next = 0; }
int  proto_decoy_name_count(void) { return g_dn_count; }

static int dn_rd16(const uint8_t *p) { return (p[0] << 8) | p[1]; }
static void dn_wr16(uint8_t *p, int v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

/* Where a ClientHello's extensions length is, or -1 when `real` does not
 * hold a ClientHello whose server name sits at host_off as the server_name
 * extension lays it out (type 0, then three lengths that agree). */
static int tls_ext_len_at(const uint8_t *real, int n, int host_off, int host_len) {
  if (n < 9 + 38 || real[0] != 0x16 || real[5] != 0x01) return -1;
  int p = 9 + 2 + 32;                       /* version, random */
  if (p >= n) return -1;
  p += 1 + real[p];                         /* session id */
  if (p + 2 > n) return -1;
  p += 2 + dn_rd16(real + p);                  /* cipher suites */
  if (p + 1 > n) return -1;
  p += 1 + real[p];                         /* compression methods */
  if (p + 2 > n) return -1;
  int ext_at = p;
  if (host_off - 9 < ext_at + 2 || host_off + host_len > n) return -1;
  const uint8_t *e = real + host_off - 9;   /* the server_name extension */
  if (dn_rd16(e) != 0x0000) return -1;
  if (dn_rd16(e + 2) != host_len + 5 || dn_rd16(e + 4) != host_len + 3 || e[6] != 0 || dn_rd16(e + 7) != host_len) return -1;
  return ext_at;
}

int proto_decoy_rename(uint8_t *dst, int cap, const uint8_t *real, int n,
                        int is_tls, int host_off, int host_len, int limit) {
  if (g_dn_count == 0 || !dst || !real || n <= 0 || host_off <= 0 || host_len <= 0 || host_off + host_len > n) return 0;
  int ext_at = -1;
  if (is_tls && (ext_at = tls_ext_len_at(real, n, host_off, host_len)) < 0) return 0;
  for (int tries = 0; tries < g_dn_count; tries++) {
    const char *name = g_dnames[g_dn_next++ % (unsigned)g_dn_count];
    int len = (int)strlen(name), delta = len - host_len, out = n + delta;
    if (out > cap || out > limit) continue;
    memcpy(dst, real, (size_t)host_off);
    memcpy(dst + host_off, name, (size_t)len);
    memcpy(dst + host_off + len, real + host_off + host_len, (size_t)(n - host_off - host_len));
    if (is_tls) {
      dn_wr16(dst + 3, dn_rd16(real + 3) + delta);                               /* record */
      int hs = (real[6] << 16) | (real[7] << 8) | real[8];
      hs += delta;
      dst[6] = (uint8_t)(hs >> 16); dst[7] = (uint8_t)(hs >> 8); dst[8] = (uint8_t)hs;  /* handshake */
      dn_wr16(dst + ext_at, dn_rd16(real + ext_at) + delta);                     /* extensions */
      uint8_t *e = dst + host_off - 9;
      dn_wr16(e + 2, len + 5); dn_wr16(e + 4, len + 3); dn_wr16(e + 7, len);        /* server_name */
    }
    return out;
  }
  return 0;
}

int proto_decoy_fill(uint8_t *buf, int n, int host_off, int host_len) {
  if (g_dn_count == 0 || !buf || host_off <= 0 || host_len <= 0 || host_off + host_len > n) return 0;
  for (int tries = 0; tries < g_dn_count; tries++) {
    const char *name = g_dnames[g_dn_next++ % (unsigned)g_dn_count];
    int len = (int)strlen(name);
    uint8_t *d = buf + host_off;
    if (len == host_len) { memcpy(d, name, (size_t)len); return 1; }
    int pre = host_len - len - 1;           /* "<pre>." in front of the name */
    if (pre < 1) continue;
    /* Letters, with a dot every so often so no label exceeds 63, never a dot
     * first or last. */
    for (int i = 0; i < pre; i++) d[i] = (uint8_t)((i % 16 == 15 && i != pre - 1) ? '.' : ('a' + ((i * 5 + 2) % 26)));
    d[pre] = '.';
    memcpy(d + pre + 1, name, (size_t)len);
    return 1;
  }
  return 0;
}
