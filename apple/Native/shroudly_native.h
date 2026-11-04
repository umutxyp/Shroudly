/*
 * What the Swift side of the packet tunnel calls in C (import ShroudlyNative):
 * the engine's whole run, and the tunnel's packet descriptor.
 */
#ifndef SHROUDLY_NATIVE_H
#define SHROUDLY_NATIVE_H

/* Codes shroudly_engine_run() returns that come from here, not the engine. */
#define SHROUDLY_ENGINE_BUSY      (-100)
#define SHROUDLY_ENGINE_NO_MEMORY (-101)

/* The engine's whole run on the calling thread, as the shroudly-core program
 * makes it with these arguments (args[0] is the first option, not a program
 * name): commands (STATS, STOP) are read from cmd_fd, one JSON line per event
 * is written to event_fd. Both descriptors belong to this call from now on
 * and are closed when it returns, which is when the engine has stopped (on
 * STOP, or when the other end of cmd_fd is closed). The result is the
 * program's exit code, or SHROUDLY_ENGINE_BUSY while an earlier run has not
 * returned: the engine keeps its state in globals, one run at a time. */
int shroudly_engine_run(const char *const *args, int nargs, int cmd_fd, int event_fd);

/* The packet tunnel's utun descriptor in this process, or -1 when there is
 * none (no tunnel set up yet). */
int shroudly_tun_fd(void);

/* Codes shroudly_tor_start() returns instead of a descriptor. */
#define SHROUDLY_TOR_ONCE      (-200)
#define SHROUDLY_TOR_NO_MEMORY (-201)

/* Tor with these command-line options (args[0] is the first option) on a
 * thread of its own (tor_glue.c): the descriptor of a control connection it
 * owns and trusts, or one of the codes above. Once per process: Tor cannot
 * be started a second time in it. Needs Tor.xcframework linked (the Mac's
 * tunnel). */
int shroudly_tor_start(const char *const *args, int nargs);

#endif
