/* libFuzzer target for the protocol parser — the code that handles untrusted
 * bytes from the network. Build: clang -fsanitize=fuzzer,address,undefined.
 * Also usable as a standalone replay: ./fuzz_proto <file> */
#include "../src/proto.h"
#include <stdint.h>
#include <stddef.h>
#include <string.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  proto_info pi;
  proto_inspect(data, size, &pi);
  /* exercise tls_expected_len on every prefix length boundary too */
  tls_expected_len(data, size);
  /* if a host was found it must be within bounds */
  if (pi.host_off >= 0) {
    if (pi.host_off + pi.host_len > (int)size) __builtin_trap();
  }
  /* The decoy with another name (packet layer: any length; stream: the
   * same length), from whatever the parser found: never out of bounds, and
   * a rewritten ClientHello still parses to the name put in. */
  if (pi.host_off > 0 && size <= 1500) {
    static int names;
    if (!names) { proto_decoy_name_add("divar.ir"); proto_decoy_name_add("www.digikala.com"); names = 1; }
    static uint8_t out[1600], copy[1500];
    int m = proto_decoy_rename(out, (int)sizeof out, data, (int)size, pi.kind == PROTO_TLS,
                               pi.host_off, pi.host_len, 1500);
    if (m < 0 || m > 1500) __builtin_trap();
    if (m > 0 && pi.kind == PROTO_TLS) {
      proto_info po;
      proto_inspect(out, (size_t)m, &po);
      if (po.kind != PROTO_TLS || (strcmp(po.host, "divar.ir") && strcmp(po.host, "www.digikala.com"))) __builtin_trap();
    }
    memcpy(copy, data, size);
    proto_decoy_fill(copy, (int)size, pi.host_off, pi.host_len);
  }
  return 0;
}

#ifdef STANDALONE
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv){
  if(argc<2){ 
    /* built-in smoke: random-ish inputs */
    uint8_t buf[2048];
    for(int it=0; it<200000; it++){
      size_t n = (size_t)(it % sizeof(buf));
      for(size_t i=0;i<n;i++) buf[i]=(uint8_t)((i*2654435761u + it)>>16);
      LLVMFuzzerTestOneInput(buf, n);
    }
    printf("STANDALONE FUZZ SMOKE OK (200k iters)\n");
    return 0;
  }
  FILE*f=fopen(argv[1],"rb"); if(!f)return 1;
  uint8_t b[65536]; size_t n=fread(b,1,sizeof(b),f); fclose(f);
  LLVMFuzzerTestOneInput(b,n); printf("replay ok\n"); return 0;
}
#endif
