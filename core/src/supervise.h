#ifndef SHROUDLY_SUPERVISE_H
#define SHROUDLY_SUPERVISE_H

/* Lifecycle of the privileged Advanced-mode engine (shroudly-core-adv).
 *
 * The app starts the engine through UAC (Windows) or pkexec (Linux), so it can
 * neither read the engine's stdout nor signal it. Instead:
 *   --status-file F   stdout + stderr go to F, which the app tails;
 *   --parent-pid P    the engine exits as soon as process P is gone;
 *   F.stop            the app creates this file to ask the engine to exit.
 * Any stop request (also SIGINT/SIGTERM/SIGHUP) runs the teardown callback,
 * reports {"type":"stopped"} and exits; the OS then releases the packet hook. */

typedef void (*sup_teardown_fn)(void);

/* Send stdout and stderr to status_file. Returns 0 on success. */
int  sup_redirect_output(const char *status_file);

/* Install signal handlers and start the watchdog thread. status_file may be
 * empty and parent_pid 0 when the engine is run by hand. Returns 0 on success. */
int  sup_start(const char *status_file, long parent_pid, sup_teardown_fn teardown);

#endif
