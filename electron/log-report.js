'use strict';

/*
 * The log as text for a report: a few lines about this computer and
 * Shroudly's state, then the log's lines, in English, not as the window
 * shows them in the user's language. Nothing beyond what the log already
 * says about the sites visited, and nothing is sent anywhere.
 *
 *  - "Save logs" (Logs panel, tray): the whole log, every line as it was
 *    written with its full time, in a .txt file in the user's Downloads
 *    folder (else Desktop, Documents, home), shown in the file manager, to
 *    attach to a message or an issue (buildReport, saveReport).
 *  - "Copy logs" (Logs panel, tray): a short version for the clipboard
 *    that a chat app takes as one message (buildCompact): the same header,
 *    the time of day only, no engine command arguments, a line said again
 *    and again written once with how many times, and the newest lines that
 *    fit in COPY_MAX_CHARS (Telegram's limit is 4096; a chat that refused
 *    the whole log in 2.6.3 said "message too long").
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 'ERROR', warning: 'WARN', success: 'OK', info: 'INFO' };
// In the short version most lines are information and carry no level.
const SHORT_LEVELS = { error: 'ERROR ', warning: 'WARN ', success: 'OK ', info: '' };
const COPY_MAX_CHARS = 4000;
// One line of the short version at most this long.
const LINE_MAX_CHARS = 240;
// A line said before, longer than this, is cut to its first AGAIN_KEEP.
const AGAIN_FROM = 72;
const AGAIN_KEEP = 48;

const onOff = (v) => (v ? 'on' : 'off');

/*
 * s: { version, os, arch, protection: 'on' | 'off' | 'starting',
 *      routeMode, advanced: { on, available }, discordMode, appsMode,
 *      storeApps (Windows: true/false; elsewhere null), now,
 *      utcOffsetMin (the short version's times: this computer's offset
 *      from UTC in minutes; its own by default) }
 * logs: [{ timestamp, level, message }]
 */
function header(s, list, { verb = 'copied', lines = `${list.length}` } = {}) {
  // What the log said last about this computer's network (the engine writes
  // it at each start): "System: <os> — network <iface>, DNS <servers>".
  const sys = [...list].reverse().find((l) => typeof l.message === 'string' && l.message.startsWith('System: '));
  const network = sys ? sys.message.replace(/^System: .*? — network /, '') : 'not logged yet';
  const modes = [`Discord app mode ${onOff(s.discordMode)}`, `Games and apps mode ${onOff(s.appsMode)}`];
  if (s.storeApps != null) modes.push(`Microsoft Store apps ${onOff(s.storeApps)}`);
  const adv = s.advanced || {};
  return [
    `Shroudly ${s.version} log, ${verb} ${new Date(s.now || Date.now()).toISOString()}`,
    `System: ${s.os} (${s.arch})`,
    `Protection: ${s.protection}; route: ${s.routeMode === 'listed' ? 'listed sites only' : 'every site'}`,
    `Advanced mode: ${onOff(adv.on)}${adv.available === false ? ' (not available here)' : ''}`,
    `Modes: ${modes.join(', ')}`,
    `Network: ${network}`,
    `Lines: ${lines}`,
  ];
}

const SEP = '-'.repeat(40);

/* The whole log, every line as written (Save logs). */
function buildReport(s, logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  const body = list.map((l) => `${l.timestamp || ''} ${LEVELS[l.level] || String(l.level || '').toUpperCase()} ${String(l.message ?? '').replace(/\r?\n/g, ' ')}`);
  return `${header(s, list, { verb: s.verb || 'copied' }).join('\n')}\n${SEP}\n${body.join('\n')}\n`;
}

/* A log line's text for the short version: on one line, an engine's
 * command line cut to the program, at most LINE_MAX_CHARS. */
function shortMessage(msg) {
  let m = String(msg ?? '').replace(/\s*\r?\n\s*/g, ' ');
  m = m.replace(/^(Starting engine: \S+) .*$/, '$1');
  if (m.length > LINE_MAX_CHARS) m = `${m.slice(0, LINE_MAX_CHARS - 1)}…`;
  return m;
}

function offsetText(min) {
  const a = Math.abs(min);
  return `UTC${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/* The short version for the clipboard (Copy logs). max: its length at most
 * (the header always stays). */
function buildCompact(s, logs = [], { max = COPY_MAX_CHARS } = {}) {
  const list = Array.isArray(logs) ? logs : [];
  const off = Number.isFinite(s.utcOffsetMin) ? s.utcOffsetMin : -new Date(s.now || Date.now()).getTimezoneOffset();
  const local = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? null : new Date(t + off * 60000).toISOString(); };
  // Runs of the same line one after another: the first, with how many and
  // until when.
  const runs = [];
  for (const l of list) {
    const level = SHORT_LEVELS[l.level] ?? `${String(l.level || '').toUpperCase()} `;
    const msg = shortMessage(l.message);
    const at = local(l.timestamp);
    const last = runs[runs.length - 1];
    if (last && last.level === level && last.msg === msg) { last.n++; last.until = at; continue; }
    runs.push({ level, msg, at, n: 1, until: at });
  }
  // A long line said earlier, again later with others between: its start
  // only, the second time on ("again: ...").
  const again = (msg) => (msg.length > AGAIN_FROM ? `again: ${msg.slice(0, AGAIN_KEEP)}...` : msg);
  const entries = runs.map((r) => {
    const time = r.at ? r.at.slice(11, 19) : '--:--:--';
    const more = r.n > 1 ? ` (x${r.n}${r.until ? `, last ${r.until.slice(11, 19)}` : ''})` : '';
    return { day: r.at ? r.at.slice(0, 10) : null, time, level: r.level, msg: r.msg, more, n: r.n };
  });
  // Each day said once, before its first line.
  const render = (kept) => {
    const lines = [];
    const seen = new Set();
    let day;
    for (const e of kept) {
      if (e.day && e.day !== day) lines.push(`[${e.day}]`);
      day = e.day || day;
      lines.push(`${e.time} ${e.level}${seen.has(e.msg) ? again(e.msg) : e.msg}${e.more}`);
      seen.add(e.msg);
    }
    return lines;
  };
  const head = (left) => `${header(s, list, { verb: 'copied', lines: left ? `${list.length} (the newest ${list.length - left} here)` : `${list.length}` }).join('\n')}\nTimes: ${offsetText(off)}\n${SEP}\n`;
  const text = (from) => {
    const left = entries.slice(0, from).reduce((a, e) => a + e.n, 0);
    const note = left ? [`... ${left} earlier lines left out; Save logs keeps the whole log in a file`] : [];
    return `${head(left)}${[...note, ...render(entries.slice(from))].join('\n')}\n`;
  };
  // The newest that fit: counted from the end with each line as short as it
  // can be, then the oldest of them dropped until the whole fits.
  const room = max - head(list.length).length - 80;
  const firstAt = new Map();
  entries.forEach((e, i) => { if (!firstAt.has(e.msg)) firstAt.set(e.msg, i); });
  let from = entries.length;
  let used = 0;
  while (from > 0) {
    const e = entries[from - 1];
    const m = firstAt.get(e.msg) < from - 1 ? again(e.msg) : e.msg;
    const size = e.time.length + e.level.length + m.length + e.more.length + 2 + (e.day ? 13 : 0);
    if (used + size > room) break;
    used += size;
    from--;
  }
  let out = text(from);
  while (out.length > max && from < entries.length) out = text(++from);
  return out;
}

/* The file name for a log saved at `now`: Shroudly-log-2026-10-22-221700.txt
 * (this computer's time). */
function fileName(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `Shroudly-log-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
}

/* Write `text` to a new file in the first of `dirs` (folder paths, or
 * functions that give one and may throw) that exists and takes it; a file
 * of the same name is never overwritten. Windows gets Windows line ends.
 * Returns { ok: true, file } or { ok: false, error }. */
function saveReport(text, dirs, { now = Date.now(), platform = process.platform, fsx = fs } = {}) {
  const body = platform === 'win32' ? String(text).replace(/\r?\n/g, '\r\n') : String(text);
  let error = 'no folder';
  for (const d of dirs) {
    let dir = null;
    try { dir = typeof d === 'function' ? d() : d; } catch { continue; }
    if (!dir) continue;
    try { if (!fsx.statSync(dir).isDirectory()) continue; } catch { continue; }
    const base = fileName(now).replace(/\.txt$/, '');
    for (let i = 1; i <= 20; i++) {
      const file = path.join(dir, i === 1 ? `${base}.txt` : `${base}-${i}.txt`);
      try {
        fsx.writeFileSync(file, body, { flag: 'wx' });
        return { ok: true, file };
      } catch (e) {
        error = e.code || e.message;
        if (e.code !== 'EEXIST') break;
      }
    }
  }
  return { ok: false, error };
}

/* Put text on the clipboard and read it back: true only when it is there.
 * Some desktops (Wayland) take nothing from a program without a focused
 * window, and say nothing about it. */
function toClipboard(text, clipboard) {
  try {
    clipboard.writeText(text);
    return clipboard.readText() === text;
  } catch { return false; }
}

module.exports = { buildReport, buildCompact, saveReport, fileName, toClipboard, COPY_MAX_CHARS };
