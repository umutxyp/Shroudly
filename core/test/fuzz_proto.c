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
