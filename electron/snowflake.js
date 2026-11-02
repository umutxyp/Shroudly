'use strict';

/*
 * "Help people in censored countries" (Settings → Server and sharing; off until
 * the user turns it on): a Snowflake proxy for the Tor network, so that
 * people where Tor is blocked reach it through this computer
 * (electron/snowflake/proxy.js has how). It runs in a hidden window of its
 * own: sandboxed, no Node.js, a session of its own that connects directly
 * (not through Shroudly's protection: it helps others, it needs no
 * techniques), and allowed to reach only Tor's broker, its NAT probe and
 * its relays. Stopping it closes the window and every connection with it.
 *
 * What it costs the user: some upload and download while someone is being
 * helped, and the people helped see this computer's address as a Tor
 * bridge's (never what they open: that is Tor's encryption). It keeps no
 * record of anyone; the window shows only how many are helped now and since
 * it was turned on.
 */

const path = require('path');

const BROKER = 'https://snowflake-broker.torproject.net/';
const PROBE = 'https://snowflake-broker.torproject.net:8443/probe';
const RELAY = 'wss://snowflake.torproject.net/';
const RELAY_PATTERN = 'snowflake.torproject.net';
const STUN = [{ urls: ['stun:stun.l.google.com:19302'] }];
const NAT_STUN = [{ urls: 'stun:stun1.l.google.com:19302' }];
const POLL_MS = 60 * 1000;
const MIN_POLL_MS = 1000;

/* The settings the hidden page runs with. `test` (the end-to-end test only)
 * points it at stand-ins on this computer. */
function pageConfig({ nat = null, natAt = 0, test = null } = {}) {
  const c = {
    broker: BROKER, probe: PROBE, defaultRelay: RELAY, relayPattern: RELAY_PATTERN,
    iceServers: STUN, natIceServers: NAT_STUN, insecureRelay: false, pollMs: POLL_MS, minPollMs: MIN_POLL_MS,
    nat: nat === 'unrestricted' || nat === 'restricted' ? nat : null, natAt: Number(natAt) || 0,
  };
  if (test) {
    Object.assign(c, {
      broker: test.broker, probe: null, defaultRelay: test.relay, relayPattern: test.relayPattern,
      iceServers: [], natIceServers: [], insecureRelay: true, pollMs: test.pollMs || 500, minPollMs: 100, nat: 'unrestricted', natAt: Date.now(),
    });
  }
  return c;
}

/* Only these leave the hidden window: the page's own files, Tor's broker
 * and probe, and its relays (wss). */
function allowedUrl(url, cfg) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') return /[\\/]electron[\\/]snowflake[\\/]proxy\.(html|js)$/.test(decodeURIComponent(u.pathname));
  if (u.protocol === 'devtools:' || u.protocol === 'chrome-extension:') return false;
  const starts = (base) => base && url.startsWith(base);
  if (starts(cfg.broker) || (cfg.probe && starts(cfg.probe))) return true;
  if (u.protocol === 'wss:' || (cfg.insecureRelay && u.protocol === 'ws:')) {
    const p = String(cfg.relayPattern || '');
    if (p[0] === '^') return u.hostname === p.slice(1);
    return !!p && (u.hostname === p || u.hostname.endsWith(`.${p}`));
  }
  return false;
}

class Snowflake {
  /*
   * opts.store   electron-store: where the NAT type found is kept two days
   * opts.log     (level, message)
   * opts.test    stand-ins for the end-to-end test (pageConfig)
   * opts.electron  the electron module (tests pass a stand-in)
   */
  constructor({ store, log, test = null, electron = null } = {}) {
    this.store = store;
    this.log = log || (() => {});
    this.test = test;
    this.electron = electron;
    this.win = null;
    this.on = false;
    this.stats = { state: 'off', now: 0, total: 0, nat: null };
    this._handlers = false;
    this._restartTimer = null;
  }

  _el() { return this.electron || require('electron'); }

  _config() {
    let kept = null;
    try { kept = this.store && this.store.get ? this.store.get('snowflakeNat') : null; } catch {}
    return pageConfig({ nat: kept && kept.type, natAt: kept && kept.at, test: this.test });
  }

  _wire() {
    if (this._handlers) return;
    this._handlers = true;
    const { ipcMain } = this._el();
    ipcMain.handle('snowflake:config', (e) => {
      if (!this.win || e.sender !== this.win.webContents) return null;
      return this._config();
    });
    ipcMain.on('snowflake:report', (e, s) => {
      if (!this.win || e.sender !== this.win.webContents || !s || typeof s !== 'object') return;
      const st = ['starting', 'waiting', 'serving', 'unreachable'].includes(s.state) ? s.state : 'starting';
      const prev = this.stats;
      this.stats = { state: st, now: Math.max(0, Math.floor(Number(s.now) || 0)), total: Math.max(0, Math.floor(Number(s.total) || 0)), nat: s.nat === 'unrestricted' || s.nat === 'restricted' ? s.nat : null };
      if (this.stats.nat && Number(s.natAt) > 0 && !this.test) {
        try { this.store.set('snowflakeNat', { type: this.stats.nat, at: Number(s.natAt) }); } catch {}
      }
      if (prev.state !== 'unreachable' && st === 'unreachable') this.log('warning', 'Helping people in censored countries: Tor\'s Snowflake broker does not answer from this network');
      if (this.stats.total > prev.total) this.log('info', `Helping people in censored countries: someone reached Tor through this computer (${this.stats.total} since it was turned on)`);
    });
  }

  async start() {
    if (this.on && this.win && !this.win.isDestroyed()) return this.status();
    this._wire();
    const { BrowserWindow, session } = this._el();
    const cfg = this._config();
    const ses = session.fromPartition('snowflake');
    // Directly: what is carried is Tor's, and needs none of Shroudly's techniques.
    await ses.setProxy({ mode: 'direct' });
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
    try { ses.setPermissionCheckHandler(() => false); } catch {}
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowedUrl(d.url, cfg) }));
    this.win = new BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: false,
      webPreferences: {
        session: ses, preload: path.join(__dirname, 'snowflake-preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        backgroundThrottling: false, spellcheck: false, devTools: false,
      },
    });
    const wc = this.win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    // The page process gone (out of memory, a crash): back after a while.
    wc.on('render-process-gone', () => {
      if (!this.on) return;
      this._close();
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => { if (this.on) this.start().catch(() => {}); }, 30000);
      if (this._restartTimer.unref) this._restartTimer.unref();
    });
    this.on = true;
    this.stats = { state: 'starting', now: 0, total: 0, nat: cfg.nat };
    await this.win.loadFile(path.join(__dirname, 'snowflake', 'proxy.html'));
    this.log('info', 'Helping people in censored countries: on (a Snowflake proxy for Tor)');
    return this.status();
  }

  _close() {
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('snowflake:stop'); } catch {}
      try { w.destroy(); } catch {}
    }
  }

  async stop() {
    const was = this.on;
    this.on = false;
    clearTimeout(this._restartTimer);
    this._close();
    this.stats = { state: 'off', now: 0, total: 0, nat: this.stats.nat };
    if (was) this.log('info', 'Helping people in censored countries: off');
    return this.status();
  }

  status() {
    return { on: this.on, state: this.on ? this.stats.state : 'off', now: this.on ? this.stats.now : 0, total: this.on ? this.stats.total : 0, nat: this.stats.nat };
  }
}

module.exports = Snowflake;
module.exports.pageConfig = pageConfig;
module.exports.allowedUrl = allowedUrl;
module.exports.BROKER = BROKER;
module.exports.RELAY_PATTERN = RELAY_PATTERN;
