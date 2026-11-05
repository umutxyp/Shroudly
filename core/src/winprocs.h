#ifndef SHROUDLY_WINPROCS_H
#define SHROUDLY_WINPROCS_H

/*
 * What tasklist and netstat would print, read in the engine itself (Windows):
 * the app looks at the running programs and their connections every few
 * seconds while some features run (the anti-cheat guard of Advanced mode,
 * programs going around Shroudly, browsers set elsewhere), and starting
 * tasklist.exe or netstat.exe for each look costs a slow PC real CPU time.
 * Here it is one system call, without a new process.
 *
 *   PROCS -> {"type":"proc","n":"name.exe","p":pid,"s":session} per program,
 *            then {"type":"procs_end","n":count}
 *   TCP   -> {"type":"tcp","l":"local","r":"remote","st":state,"p":pid} per
 *            TCP connection (IPv4 and IPv6, as netstat -ano lists them),
 *            then {"type":"tcp_end","n":count}
 * Elsewhere only the end lines (count -1): the app uses its usual tools.
 */
void winprocs_emit(void);
void wintcp_emit(void);

#endif
