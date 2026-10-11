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

test: test/test_proto.c src/proto.c src/strategy.c
	$(CC) -std=c11 -O2 -Wall -o /tmp/shroudly_test src/proto.c src/strategy.c test/test_proto.c
	/tmp/shroudly_test

clean:
	rm -f $(BIN) shroudly-core shroudly-core.exe /tmp/shroudly_test
