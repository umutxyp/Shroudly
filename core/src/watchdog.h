#ifndef SHROUDLY_WATCHDOG_H
#define SHROUDLY_WATCHDOG_H

/* shroudly-core --watchdog <app-pid> <restore-exe> [restore-args...]
 *
 * Started by Shroudly the first time it changes something that must not
 * outlive it (the system proxy, the HTTPS_PROXY it gives programs). Shroudly
 * writes one line per state file on stdin: "proxy<TAB><file>" or
 * "env<TAB><file>". When the pipe closes and <app-pid> has ended, a state file
 * still there means a change that was never undone: the restore command
 * ("Shroudly --restore-proxy") is started, detached, and the watchdog exits.
 * A normal quit removes the files first, so the watchdog then just exits. */
int watchdog_main(int argc, char **argv);

#endif
