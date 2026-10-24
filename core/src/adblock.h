#ifndef SHROUDLY_ADBLOCK_H
#define SHROUDLY_ADBLOCK_H

/*
 * adblock — names not to reach: ads and trackers, when the user turns it on.
 *
 * DNS-level, like AdGuard DNS or Pi-hole: what is matched is the name a
 * connection or a lookup asks for, never anything inside the traffic. A name
 * on the list is blocked with every name under it (doubleclick.net takes
 * ad.doubleclick.net with it), unless the user allowed it or a name above it,
 * or it is one of Shroudly's own (adb_kept: its encrypted DNS, updates, the
 * live count, Discord, Roblox and the captchas they use).
 *
 * A list is text, one entry per line, in any of the usual forms:
 *     example.com
 *     0.0.0.0 example.com          (a hosts file; 127.0.0.1, ::, ::1 too,
 *                                   and several names on one line)
 *     ||example.com^               (an ad-blocker domain rule, no options)
 *     @@||example.com^             (an exception: that name and every name
 *                                   under it are not blocked, whatever else
 *                                   the list says, as in any ad blocker)
 * "#" and "!" start a comment. An entry that is not a usable domain is
 * skipped: one label ("localhost"), an address, a public suffix ("co.uk"), a
 * platform whose names belong to unrelated people ("blogspot.com", which
 * would take every blog with it), or a local name.
 *
 * Only a 64-bit hash of each entry is kept, in an open-addressing table that
 * is at most three quarters full: 11 to 22 bytes per entry, no strings. A
 * lookup hashes each suffix of the name of two labels or more, so it costs a
 * few hashes and probes whatever the list's size. Two names with one hash is
 * a 1 in 10^14 chance per lookup with a list of 100 000.
 *
 * Nothing is logged about a blocked name, by the engine or here: only a count.
 *
 * The parsing and matching (adb_*) are pure and unit-tested in
 * core/test/test_adblock.c; the engine-wide state (adblock_*) is what the
 * engine and its commands use (main.c, engine.c).
 */

#include <stddef.h>
#include <stdint.h>

/* The most a list file may hold, and the most entries (and exceptions) it
 * may give. The table is 4 MB up to 393 216 entries (2^19 slots), 8 MB
 * above. */
#define ADB_MAX_FILE    (16u * 1024 * 1024)
#define ADB_MAX_ENTRIES 500000u
#define ADB_MAX_EXCEPTIONS 50000u
/* A downloaded list with fewer entries than this is not the list asked for
 * (adblock_check): an error page, a cut download, an empty file. */
#define ADB_MIN_DOWNLOADED 10000u
/* The TTL of a blocked answer: short, so an allowed name works again soon. */
#define ADB_TTL 10

typedef struct adb_list adb_list;

typedef struct {
  size_t entries;   /* distinct entries kept */
  size_t skipped;   /* entries that were not a usable domain */
  size_t bytes;     /* memory the tables hold */
  size_t exceptions; /* distinct exceptions kept */
} adb_stats;

/* Parse len bytes of text. Never NULL for a text with nothing usable (an
 * empty list), NULL only when memory runs out or the text holds more than
 * max_entries usable entries. st may be NULL. */
adb_list *adb_parse(const char *text, size_t len, size_t max_entries, adb_stats *st);
void      adb_free(adb_list *l);
/* The file at path (UTF-8, also on Windows). NULL with *why set when it
 * cannot be read, is larger than ADB_MAX_FILE, or adb_parse fails. */
adb_list *adb_load(const char *path, adb_stats *st, const char **why);

/* name, or a name above it of two labels or more, is on the list, and
 * neither it nor any name above it is an exception. name is as asked (any
 * case, a trailing dot allowed). */
int adb_listed(const adb_list *l, const char *name);

/* name lower-cased, without a trailing dot, into out (cap >= 256): 0, or -1
 * when it is not a plain domain name (letters, digits, '-', '_', dots; no
 * empty label; at most 253 characters). */
int adb_norm(const char *name, char *out, size_t cap);

/* One of Shroudly's own names, or under one: never blocked. */
int adb_kept(const char *name);

/* The answer to a blocked lookup: q is a standard query whose question ends
 * at qend (a valid question, as the engine's own parser leaves it). Written
 * to out: the query's id, RD as asked, RA, NOERROR, the question, and for an
 * A or AAAA question of class IN one answer, 0.0.0.0 or ::, with TTL
 * ADB_TTL; for any other type no answer (NODATA). Returns its length, or -1
 * when cap is too small or q is shorter than a header. */
int adb_dns_answer(const uint8_t *q, size_t qend, uint8_t *out, size_t cap);

/* ── the engine's ───────────────────────────────────────────────────────── */

/* Once, before any other adblock_* call (the engine's start). */
void adblock_init(void);
/* Off, the allowed names forgotten, the count at 0: a new engine run. */
void adblock_reset(void);
/* Use the list in path from now on. 0, or -1 with *why set (the list in
 * use, if any, stays). */
int  adblock_use(const char *path, adb_stats *st, const char **why);
/* Is the list in path one to use? The list a download brought: it has to
 * have ADB_MIN_DOWNLOADED entries or more, list the names every ad list
 * lists, and spare the sites no list may take. Nothing changes. 0, or -1
 * with *why set. */
int  adblock_check(const char *path, adb_stats *st, const char **why);
void adblock_off(void);
int  adblock_on(void);
/* The user's own exceptions: name and every name under it. 0, or -1 when
 * it is not a domain name or there are ADBLOCK_ALLOW_MAX already. */
#define ADBLOCK_ALLOW_MAX 512
int  adblock_allow(const char *name);
void adblock_allow_clear(void);
/* Is name to be blocked now: on, listed, not allowed, not kept. An address
 * is never blocked by name. Counts nothing (see adblock_count). */
int  adblock_blocked(const char *name);
/* One blocked connection or lookup; and how many since the reset. */
void     adblock_count(void);
uint64_t adblock_total(void);

#endif
