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

test: test/test_proto.c test/test_desync.c $(SRC)
	$(CC) -std=c11 -O2 -Wall -o /tmp/shroudly_test_proto src/proto.c src/strategy.c test/test_proto.c
	/tmp/shroudly_test_proto
	$(CC) -std=c11 -O2 -Wall -pthread -o /tmp/shroudly_test_desync \
		src/platform.c src/proto.c src/strategy.c src/desync.c src/doh.c test/test_desync.c $(LDLIBS)
	/tmp/shroudly_test_desync

# Sanitizer build of the full test set (memory + UB checks).
test-asan: test/test_proto.c test/test_desync.c $(SRC)
	$(CC) -std=c11 -O1 -g -fsanitize=address,undefined -pthread \
		-o /tmp/shroudly_test_asan \
		src/platform.c src/proto.c src/strategy.c src/desync.c src/doh.c \
		test/test_desync.c $(LDLIBS)
	ASAN_OPTIONS=halt_on_error=0 /tmp/shroudly_test_asan

clean:
	rm -f $(BIN) shroudly-core shroudly-core.exe /tmp/shroudly_test
