# Shroudly Core — native build
# Cross-OS builds: see scripts/build-core.js (uses zig cc).

CC      ?= cc
CFLAGS  ?= -std=c11 -O2 -Wall -Wextra -pthread
SRC      = $(wildcard src/*.c)
BIN      = shroudly-core

UNAME_S := $(shell uname -s)
ifeq ($(OS),Windows_NT)
  LDLIBS = -lws2_32 -liphlpapi
  BIN    = shroudly-core.exe
endif

.PHONY: all test clean

all: $(BIN)

$(BIN): $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDLIBS)

# The sources engine.c needs besides itself, for tests that include it.
ENGINE_DEPS = src/platform.c src/proto.c src/strategy.c src/desync.c src/fake.c src/doh.c

test: test/test_proto.c test/test_udpdpi.c test/test_desync.c test/test_engine.c test/test_tcpdpi.c test/test_rawscope.c $(SRC)
	$(CC) -std=c11 -O2 -Wall -o /tmp/shroudly_test_proto src/proto.c src/strategy.c test/test_proto.c
	/tmp/shroudly_test_proto
	$(CC) -std=c11 -O2 -Wall -Wextra -o /tmp/shroudly_test_udpdpi src/udpdpi.c test/test_udpdpi.c
	/tmp/shroudly_test_udpdpi
	$(CC) -std=c11 -O2 -Wall -pthread -o /tmp/shroudly_test_desync \
		src/platform.c src/proto.c src/strategy.c src/desync.c src/fake.c src/doh.c test/test_desync.c $(LDLIBS)
	/tmp/shroudly_test_desync
	$(CC) -std=c11 -O2 -Wall -Wextra -pthread -o /tmp/shroudly_test_engine \
		$(ENGINE_DEPS) test/test_engine.c $(LDLIBS)
	/tmp/shroudly_test_engine
	$(CC) -std=c11 -O2 -Wall -Wextra -o /tmp/shroudly_test_tcpdpi src/tcpdpi.c test/test_tcpdpi.c
	/tmp/shroudly_test_tcpdpi
	$(CC) -std=c11 -O2 -Wall -Wextra -o /tmp/shroudly_test_rawscope src/rawscope.c test/test_rawscope.c
	/tmp/shroudly_test_rawscope

# Sanitizer build of the full test set (memory + UB checks).
test-asan: test/test_proto.c test/test_udpdpi.c test/test_desync.c test/test_bogon.c test/test_engine.c test/test_tcpdpi.c test/test_rawscope.c $(SRC)
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined -pthread \
		-o /tmp/shroudly_test_asan \
		src/platform.c src/proto.c src/strategy.c src/desync.c src/fake.c src/doh.c \
		test/test_desync.c $(LDLIBS)
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_asan
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined -Wall -Wextra \
		-o /tmp/shroudly_test_udpdpi_asan src/udpdpi.c test/test_udpdpi.c
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_udpdpi_asan
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined \
		-o /tmp/shroudly_test_tcpdpi_asan src/tcpdpi.c test/test_tcpdpi.c
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_tcpdpi_asan
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined -Wall -Wextra \
		-o /tmp/shroudly_test_rawscope_asan src/rawscope.c test/test_rawscope.c
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_rawscope_asan
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined -pthread \
		-o /tmp/shroudly_test_bogon src/platform.c test/test_bogon.c $(LDLIBS)
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_bogon
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined -pthread \
		-o /tmp/shroudly_test_engine_asan $(ENGINE_DEPS) test/test_engine.c $(LDLIBS)
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_engine_asan

# Fuzz the untrusted-input parser (random + grammar-aware) under sanitizers.
fuzz: test/fuzz_proto.c test/fuzz_mut.c src/proto.c
	$(CC) -std=c11 -O1 -g -DSTANDALONE -fsanitize=address,undefined \
		-o /tmp/shroudly_fuzz_rand src/proto.c test/fuzz_proto.c
	ASAN_OPTIONS=halt_on_error=1 /tmp/shroudly_fuzz_rand
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined \
		-o /tmp/shroudly_fuzz_mut src/proto.c test/fuzz_mut.c
	ASAN_OPTIONS=halt_on_error=1 /tmp/shroudly_fuzz_mut

clean:
	rm -f $(BIN) shroudly-core shroudly-core.exe /tmp/shroudly_test
