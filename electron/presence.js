'use strict';

/*
 * Live user count ("Online now" in Stats), backed by server/stats-worker.
 *
 * Anonymous: a random id made fresh at every launch (never stored), pinged at
 * the interval the server asks for. The server keeps nothing but those ids
 * and when they were last seen. Requests follow the system proxy like any
 * other app traffic, so with protection on they go through Shroudly's engine.
 */

const { net } = require('electron');
const crypto = require('crypto');

const BASE = 'https://shroudly.codeshare.me';
const MIN_INTERVAL_S = 30;
const MAX_INTERVAL_S = 900;
const RETRY_S = 30;

function call(method, path, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url: BASE + path });
    if (body) req.setHeader('content-type', 'application/json');
    const timer = setTimeout(() => { req.abort(); reject(new Error('timeout')); }, timeoutMs);
    let text = '';
    req.on('response', (res) => {
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const post = (path, body, timeoutMs) => call('POST', path, body, timeoutMs);

class Presence {
  constructor({ onCount } = {}) {
    this.id = crypto.randomUUID();
    this.online = null;
    this.onCount = onCount || (() => {});
    this.timer = null;
    this.stopped = false;
  }

  start() { this._ping(); }

  async _ping() {
    if (this.stopped) return;
    let next = RETRY_S;
    try {
      const r = await post('/v1/ping', { id: this.id });
      if (Number.isFinite(r.online)) { this.online = r.online; this.onCount(this.online); }
      next = Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Number(r.interval) || 60));
    } catch { /* offline or blocked: keep the last count, try again soon */ }
    if (!this.stopped) this.timer = setTimeout(() => this._ping(), next * 1000);
  }

  /* Read the current count without pinging (the Stats tab polls this while
   * it is on screen, so the number moves as others come and go). */
  async refresh() {
    if (this.stopped) return this.online;
    try {
      const r = await call('GET', '/v1/online', null, 8000);
      if (Number.isFinite(r.online)) { this.online = r.online; this.onCount(this.online); }
    } catch {}
    return this.online;
  }

  /* Best effort on quit: drop out of the count right away instead of
   * waiting for the server to expire us. */
  leave() {
    this.stopped = true;
    clearTimeout(this.timer);
    return post('/v1/leave', { id: this.id }, 1500).catch(() => {});
  }
}

module.exports = Presence;
