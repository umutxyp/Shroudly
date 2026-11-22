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
 * then the report callback, reports {"type":"stopped"} and exits; the OS then
 * releases the packet hook. */

typedef void (*sup_teardown_fn)(void);

/* Send stdout and stderr to status_file. Returns 0 on success. */
int  sup_redirect_output(const char *status_file);

/* Install signal handlers and start the watchdog thread. status_file may be
 * empty and parent_pid 0 when the engine is run by hand. Returns 0 on success. */
int  sup_start(const char *status_file, long parent_pid, sup_teardown_fn teardown);

/* Optional, before sup_start: call `report` every `every_ms` (0: never) while
 * the engine runs, and once more at stop, after the teardown. It runs on the
 * watchdog thread. */
void sup_set_report(sup_teardown_fn report, int every_ms);

/* Optional, before sup_start: servers the app asks to be escalated. The app
 * appends one IPv4 address a line to F.escalate (F the status file); the
 * watchdog reads what was added every quarter second and hands the new bytes
 * to `fn` (rawscope_escalate_lines), which returns how many it consumed (up
 * to its last complete line). The file comes from the unprivileged app and
 * is read by a privileged process: at most SUP_ESCALATE_MAX bytes of it are
 * ever read, and a symlink is never followed. */
#define SUP_ESCALATE_MAX (256 * 1024)
typedef int (*sup_lines_fn)(const char *buf, int len);
void sup_set_escalate(sup_lines_fn fn);

/* Optional, before sup_start: standby. While F.standby exists (F the status
 * file; the app creates it, and removes it to end the standby), `pause` is
 * called once, and `resume` once when it is gone again; both in the
 * watchdog's thread. Lets the elevated engine let go of the packet hook
 * (for a game's anti-cheat, or protection stopped) and take it again with
 * no new permission prompt. */
void sup_set_standby(sup_teardown_fn pause, sup_teardown_fn resume);

/* Optional, before sup_start: the files the app controls the engine by
 * (F.stop, F.escalate, F.standby) named after `base` instead of the status
 * file, for an engine whose status is written where the app cannot write
 * (advtask.h). keep: they are only looked at and read, never removed (they
 * are in a folder of the user's, and this process is an administrator's). */
void sup_set_control(const char *base, int keep);

#endif
