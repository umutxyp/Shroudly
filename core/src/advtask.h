#ifndef SHROUDLY_ADVTASK_H
#define SHROUDLY_ADVTASK_H

#include <stddef.h>

/*
 * Advanced mode started with the administrator permission given once
 * (Windows).
 *
 * Until 2.6.87 every start of the Advanced engine was a permission prompt
 * (UAC): at every start of the computer, and again whenever the engine had
 * ended. Now the prompt is answered once. The engine started through it
 * (--task-install USER) also
 *   - copies itself and WinDivert's two files to
 *     <Common Files>\Shroudly\advanced, which only an administrator can
 *     write (the folder Shroudly is installed in is often the user's own:
 *     whatever is there must never be what runs with administrator rights
 *     unasked), and
 *   - registers a scheduled task "Shroudly Advanced mode (USER)" that runs
 *     that copy with the highest privileges, on demand only, and that this
 *     user (and no other) may start.
 * From then on the app writes a request and starts the task (schtasks /Run):
 * no prompt. The app asks again, once, only when the engine's files have
 * changed (an update) or the task is gone.
 *
 * Started by the task (--task), the engine takes nothing from its command
 * line. It reads the request the app left in the user's own folder,
 *   %LOCALAPPDATA%\Shroudly\advanced\request
 * and accepts only what advtask_parse lets through: the packet options, each
 * checked, and the app's process id. Where it writes is not the request's to
 * say: its status goes to <Common Files>\Shroudly\advanced\run\<id>.log, a
 * new file every time (an id is used once), in a folder the user can read
 * and not write. The files the app controls it by (stop, standby, escalate:
 * supervise.h) are in the user's folder, named by the id; the engine only
 * looks at them and reads them, and never writes or removes anything there,
 * so nothing planted in that folder can turn it against another file.
 *
 * A request that says "uninstall" removes the task and the copies (the
 * uninstaller, which may not be elevated itself).
 */

#define ADVTASK_ID_LEN   32
#define ADVTASK_MAX_ARGS 48
#define ADVTASK_REQ_MAX  8192

/* The request's text (len bytes at text, which must be writable and have
 * room for one more byte): cut into the engine's arguments in place.
 * Returns how many were put in argv (at most max), 0 with *uninstall set
 * for an uninstall request, or -1 for anything that is not exactly a
 * request: the whole of it is refused then, never a part used. id gets the
 * request's id (32 hex digits). Pure: tested on every system. */
int advtask_parse(char *text, size_t len, char id[ADVTASK_ID_LEN + 1], char **argv, int max, int *uninstall);

#if defined(_WIN32) && defined(SHROUDLY_RAW)
/* --task: the arguments for engine_main, from the request. 0 when *argc and
 * *argv are set; otherwise the exit code (nothing to do, or an uninstall
 * done). */
int advtask_task(int *argc, char ***argv);
/* --task-install-only USER (UTF-8): the copies and the task, for the user
 * this process runs as, when that is USER. Its result is one line in
 * <Common Files>\Shroudly\advanced\run\install.log. */
int advtask_install(const char *user);
/* --task-install USER among the arguments of an engine started through the
 * prompt: taken out of them, and the installer started as a process of its
 * own (what goes wrong there never touches the engine). */
void advtask_install_spawn(int *argc, char **argv);
#endif

#endif
