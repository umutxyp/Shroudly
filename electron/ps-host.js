'use strict';

/*
 * One Windows PowerShell kept running while Shroudly may need it, answering
 * one-line requests on its stdin with one-line answers on its stdout.
 *
 * Starting PowerShell is the slow part: a fraction of a second on most PCs,
 * 20 s on an ARM machine or on a PC still busy starting up (an internet
 * cafe's, at the moment its script starts Roblox's installer). So it is paid
 * once, ahead of time (prepare), not for every question. It leaves after a
 * few idle minutes (its memory is not kept for nothing) and is started again
 * on the next question. One that dies, or does not answer in time, is
 * replaced; one that never answers at all (twice) is not used again this
 * session: each question then starts a PowerShell of its own, as before.
 *
 * Requests "<id> <op> <arg>", answers "<id> <op> <payload>": ASCII only
 * (text goes as its character codes), so no console code page can garble a
 * path such as C:\Users\Ümit. What it writes as errors is kept (errors),
 * never mistaken for an answer.
 */

const { spawn, execFile } = require('child_process');
const { envFor } = require('./win-powershell');

const IDLE_MS = 3 * 60 * 1000;

const defaultStart = (script) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: envFor('powershell.exe') });

/* The same script answering a single request given in SHROUDLY_REQ: what
 * is used once the long-lived one has proved not to work here. */
const defaultOnce = (script, line, timeoutMs) => new Promise((resolve) => {
  const c = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: timeoutMs, env: envFor('powershell.exe', { ...process.env, SHROUDLY_REQ: line }) },
    (err, out) => resolve(String(out || '')));
  try { if (c && c.stdin) c.stdin.end(); } catch {}
});

class PsHost {
  /*
   * opts.script                   the PowerShell (see roblox-app.js)
   * opts.start(script)            starts it, a child process (tests: a stand-in)
   * opts.once(script, line, ms)   one request in a PowerShell of its own: its output
   * opts.idleMs                   how long it stays without a question
   */
  constructor(opts = {}) {
    this.script = opts.script || '';
    this.startFn = opts.start || defaultStart;
    this.onceFn = opts.once || defaultOnce;
    this.idleMs = opts.idleMs || IDLE_MS;
    this.child = null;
    this.buf = '';
    this.pending = new Map();   // id -> { resolve, timeoutMs, timer }, in the order asked
    this.seq = 0;
    this.idleTimer = null;
    this.answered = false;      // the running one has answered something
    this.silent = 0;            // ones that ended without answering anything
    this.starts = 0;
    this.errors = '';           // the end of what PowerShell wrote as errors (tests, support)
  }

  /* Started now, so that the first real question does not wait for it. */
  prepare() {
    if (this.silent >= 2) return;
    if (!this.child) this._start();
    this._idle();
  }

  /* The answer's payload, or null (no answer in time, or it died). The time
   * counts from when PowerShell gets to the question: it answers one at a
   * time, in order, so a question waiting behind a slow signature check (up
   * to two minutes, asking about revocation online) is not taken for one
   * that hangs, and never brings down the check it waits behind. */
  request(op, arg, timeoutMs) {
    const id = ++this.seq;
    const line = `${id} ${op} ${arg}`;
    if (this.silent >= 2) return this._once(id, line, timeoutMs);
    return new Promise((resolve) => {
      const c = this.child || this._start();
      if (!c) { resolve(null); return; }
      this.pending.set(id, { resolve, timeoutMs, timer: null });
      this._hold(c, true);
      this._arm(c);
      try { c.stdin.write(`${line}\n`); } catch { this._end(c, true); }
      this._idle();
    });
  }

  stop() { if (this.child) this._end(this.child, true); }

  async _once(id, line, timeoutMs) {
    const out = await this.onceFn(this.script, line, timeoutMs);
    for (const l of String(out || '').split(/\r?\n/)) {
      const m = /^(\d+) (\S+) ?(.*)$/.exec(l.trim());
      if (m && Number(m[1]) === id) return m[3];
    }
    return null;
  }

  _start() {
    let c;
    try { c = this.startFn(this.script); } catch { return null; }
    if (!c || !c.stdout || !c.stdin) return null;
    this.starts++;
    this.child = c;
    this.buf = '';
    this.answered = false;
    c.on('error', () => this._end(c, false));
    c.on('exit', () => this._end(c, false));
    c.stdin.on('error', () => {});
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => this._data(c, d));
    if (c.stderr) {
      c.stderr.setEncoding('utf8');
      c.stderr.on('data', (d) => { this.errors = (this.errors + d).slice(-2000); });
    }
    this._hold(c, false);
    return c;
  }

  _data(c, d) {
    if (c !== this.child) return;
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d+) (\S+) ?(.*)$/.exec(line);
      if (!m) continue;
      this.answered = true;
      const p = this.pending.get(Number(m[1]));
      if (!p) continue;
      this.pending.delete(Number(m[1]));
      clearTimeout(p.timer);
      p.resolve(m[3]);
    }
    if (!this.pending.size) this._hold(c, false);
    else this._arm(c);
  }

  /* The question PowerShell is on now (the oldest one open) is timed; the
   * ones behind it are timed once they come up. One that runs out of time
   * means this PowerShell is stuck: it and what waits on it get no answer,
   * and the next question starts another. */
  _arm(c) {
    const first = this.pending.entries().next().value;
    if (!first || first[1].timer) return;
    const [id, p] = first;
    p.timer = setTimeout(() => { if (this.pending.get(id) === p) this._end(c, true); }, p.timeoutMs);
  }

  /* Waited on while a question is open; otherwise it never keeps the app
   * (or a test) from ending. */
  _hold(c, on) {
    for (const h of [c, c.stdout, c.stdin, c.stderr]) {
      try { if (h && (on ? h.ref : h.unref)) (on ? h.ref : h.unref).call(h); } catch {}
    }
  }

  /* It ended (or is ended): whatever it was asked gets no answer. */
  _end(c, kill) {
    if (c !== this.child) return;
    this.child = null;
    if (!this.answered) this.silent++;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (kill) { try { c.stdin.end(); } catch {} try { c.kill(); } catch {} }
  }

  _idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.child) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size) { this._idle(); return; }
      const c = this.child;
      if (!c) return;
      // Leaving on its own is not a failure.
      this.answered = true;
      this._end(c, true);
    }, this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }
}

module.exports = PsHost;
module.exports.IDLE_MS = IDLE_MS;
