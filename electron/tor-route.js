'use strict';

/*
 * The last way out (Settings → Connection, "When nothing else works: the Tor
 * network"; on unless the user turns it off): Tor, reached through
 * Snowflake, for a connection that nothing else got through. The engine
 * tries every technique first; only a site that none of them opened, or
 * whose addresses do not answer at all, goes through Tor
 * (core/src/engine.c, "the last way out", --fallback-file), and its next
 * connections go straight there for a while.
 *
 *   this computer ── Snowflake: a volunteer's browser or Shroudly
 *                    (WebRTC, looks like a video call) ── Tor's bridge ── Tor
 *
 * Snowflake's volunteers include everyone who turned on "Help people in
 * censored countries" in Shroudly. No server of ours: nobody's address
 * carries anyone's traffic out, Tor's exits do. Where Snowflake does not get
 * through, the other ways Tor's own bundle carries are tried with it: meek
 * (through a CDN) and obfs4 bridges.
 *
 * Tor starts only when the engine first needs it (its "fallback ok:0"
 * line), never by itself, and stops after IDLE_MS without carrying
 * anything: an idle Tor keeps a volunteer's proxy busy for nothing. Tor and
 * lyrebird are the Tor Project's own builds (Tor Expert Bundle), checked
 * against the hashes their signed list gives (tor-files.js); on computers
 * they are fetched the first time a site needs them (tor-download.js, issue
 * #75), not shipped with the installer.
 *
 * What the user gives up there: speed (Tor is slow), and sites see a Tor
 * exit's address (some ask for a captcha). Tor's exit sees the name of the
 * site, never what is inside an https connection.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const STALL_MS = 90 * 1000;          // no progress this long: the next stage
const IDLE_MS = 15 * 60 * 1000;      // nothing carried this long: stopped
const RETRY_MS = 10 * 60 * 1000;     // after it failed: not tried again before this

/* Where Tor's files are: next to the app's code when run from source, in
 * app.asar.unpacked once packaged (as core-path.js). */
function torDir(platform = process.platform, arch = process.arch) {
  const dir = `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  const rel = path.join('electron', 'tools', 'tor', dir);
  if (__dirname.includes('app.asar')) {
    const res = process.resourcesPath || path.join(__dirname, '..', '..', '..');
    return path.join(res, 'app.asar.unpacked', rel);
  }
  return path.join(__dirname, 'tools', 'tor', dir);
}

function files(dir, platform = process.platform) {
  const exe = platform === 'win32' ? '.exe' : '';
  return { tor: path.join(dir, `tor${exe}`), lyrebird: path.join(dir, `lyrebird${exe}`), config: path.join(dir, 'pt_config.json') };
}

/* The bridges Tor's bundle ships, by transport, from its pt_config.json;
 * only lines of the transports lyrebird carries here. */
function bridgesOf(configText) {
  let c = null;
  try { c = JSON.parse(configText); } catch { return {}; }
  const out = {};
  for (const kind of ['snowflake', 'meek', 'obfs4', 'webtunnel']) {
    const lines = c && c.bridges && Array.isArray(c.bridges[kind]) ? c.bridges[kind] : [];
    const ok = lines.filter((l) => typeof l === 'string' && /^[a-z_0-9]+ [^\r\n]+$/.test(l) && l.length < 2000);
    if (ok.length) out[kind] = ok;
  }
  return out;
}

/* The torrc for a stage: 'snowflake' alone first, then 'all' (Snowflake,
 * meek and obfs4 together: Tor uses whichever gets through). */
/* A Snowflake bridge line with one volunteer kept ready beside the one in
 * use (max=2, issue #73): when that volunteer goes away, which they do (a
 * browser tab closed, a laptop asleep), the connection moves to the ready
 * one at once instead of waiting for the broker to pair it again. Not more:
 * every volunteer held ready is a place someone else cannot have. */
const SNOWFLAKE_PEERS = 2;
function withPeers(line) {
  return /^snowflake /.test(line) && !/ max=\d+/.test(line) ? `${line} max=${SNOWFLAKE_PEERS}` : line;
}

function torrc({ port, dataDir, lyrebird, bridges, stage, ownerPid }) {
  const kinds = stage === 'snowflake' ? ['snowflake'] : ['snowflake', 'meek', 'obfs4', 'webtunnel'];
  const lines = bridges ? kinds.flatMap((k) => bridges[k] || []).map(withPeers) : [];
  const transports = [...new Set(lines.map((l) => l.split(' ')[0]))];
  const q = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const out = [
    `SocksPort 127.0.0.1:${port}`,
    `DataDirectory ${q(dataDir)}`,
    'Log notice stdout',
    'AvoidDiskWrites 1',
    'ClientOnly 1',
    // Tor ends with Shroudly, even if Shroudly could not end it.
    `__OwningControllerProcess ${ownerPid}`,
    'UseBridges 1',
    // Tor reads this line's path up to the first space and keeps quotes as
    // part of it; a user folder with a space in it (Windows) would break it.
    // So lyrebird by its name alone: Tor runs in its own folder (cwd), which
    // is lyrebird's.
    `ClientTransportPlugin ${transports.join(',')} exec ${lyrebird}`,
    ...lines.map((l) => `Bridge ${l}`),
  ];
  return `${out.join('\n')}\n`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

class TorRoute {
  /*
   * opts.dataDir   this user's folder: Tor's data and the engine's file
   * opts.log       (level, message)
   * opts.onChange  (status) whenever the state or the progress changes
   * opts.dir, opts.platform, opts.spawn, opts.ownerPid   (tests)
   */
  /*
   * opts.fetch     async (dir, onProgress) => dir: puts Tor in dir (computers
   *                fetch it the first time it is needed, tor-download.js);
   *                without it, only a Tor already in place is used
   */
  constructor({ dataDir, log, onChange, dir = null, platform = process.platform, spawn: sp = spawn, ownerPid = process.pid,
    stallMs = STALL_MS, idleMs = IDLE_MS, retryMs = RETRY_MS, fetch = null } = {}) {
    this.dataDir = dataDir;
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});
    this.platform = platform;
    // Tor that came with the app (a run from source, or a build that ships
    // it), else the one fetched into this user's folder (issue #75).
    this.fetch = fetch;
    const shipped = dir || torDir(platform);
    this.dir = fs.existsSync(files(shipped, platform).tor) || !fetch ? shipped : path.join(dataDir || '.', 'tor-bin', require('./tor-files').VERSION);
    this._fetching = null;
    this.spawn = sp;
    this.ownerPid = ownerPid;
    this.stallMs = stallMs; this.idleMs = idleMs; this.retryMs = retryMs;
    this.port = 0;
    this.proc = null;
    this.state = 'off';          // off | starting | ready | failed
    this.progress = 0;
    this.stage = null;
    this.failedAt = 0;
    this.used = 0;               // connections carried (the engine's count)
    this._usedAt = 0;
    this._timers = {};
    this._gen = 0;
  }

  /* Tor is here. */
  present() {
    const f = files(this.dir, this.platform);
    return fs.existsSync(f.tor) && fs.existsSync(f.lyrebird) && fs.existsSync(f.config);
  }

  /* Tor is here, or can be fetched when needed. */
  available() {
    return this.present() || !!this.fetch;
  }

  /* Fetched now (Settings, "Prepare it now"; or a site needs it): true once
   * Tor is here. Said in the window while it downloads. */
  async getReady() {
    if (this.present()) return true;
    if (!this.fetch) return false;
    if (!this._fetching) {
      this._fetching = (async () => {
        const was = this.state;
        this.state = 'downloading'; this.progress = 0; this._changed();
        this.log('info', 'The last way out: fetching Tor (about 20 MB, once) from the Tor Project');
        try {
          await this.fetch(this.dir, (pct) => { if (pct > this.progress) { this.progress = pct; this._changed(); } });
          this.log('info', 'The last way out: Tor fetched and checked');
          this.state = was === 'downloading' ? 'off' : was; this.progress = 0; this._changed();
          return true;
        } catch (e) {
          this._fail(`Tor could not be fetched (${e.message})`);
          return false;
        } finally { this._fetching = null; }
      })();
    }
    return this._fetching;
  }

  /* Before each engine start: the file that names Tor to the engine
   * (--fallback-file), on a port chosen now; Tor itself starts later, when
   * first needed. null where Tor is not part of this build. */
  async prepare() {
    if (!this.available()) return null;
    if (!this.port) this.port = await freePort();
    const file = path.join(this.dataDir, 'tor-route.txt');
    fs.writeFileSync(file, `socks5://127.0.0.1:${this.port}\n`, { mode: 0o600 });
    return file;
  }

  /* The engine had a connection for it and found nothing listening. */
  need() {
    if (this.proc || !this.port || !this.available() || this._fetching) return;
    if (this.state === 'failed' && Date.now() - this.failedAt < this.retryMs) return;
    if (this.present()) { this._start('snowflake'); return; }
    this.getReady().then((ok) => { if (ok && !this.proc && this.port) this._start('snowflake'); });
  }

  _start(stage) {
    this._kill();
    const gen = ++this._gen;
    const f = files(this.dir, this.platform);
    let bridges = {};
    try { bridges = bridgesOf(fs.readFileSync(f.config, 'utf8')); } catch {}
    if (!bridges.snowflake && stage === 'snowflake') stage = 'all';
    const data = path.join(this.dataDir, 'tor');
    try { fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.chmodSync(data, 0o700); } catch {}
    const rc = path.join(this.dataDir, 'torrc');
    const pt = this.platform === 'win32' ? path.basename(f.lyrebird) : `./${path.basename(f.lyrebird)}`;
    fs.writeFileSync(rc, torrc({ port: this.port, dataDir: data, lyrebird: pt, bridges, stage, ownerPid: this.ownerPid }), { mode: 0o600 });
    // An empty defaults file: nothing of a Tor installed on this computer.
    fs.writeFileSync(path.join(this.dataDir, 'torrc-defaults-none'), '', { mode: 0o600 });
    const env = { ...process.env };
    // Linux: Tor's own OpenSSL and libevent, next to it.
    if (this.platform === 'linux') env.LD_LIBRARY_PATH = [this.dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    // The pluggable transport's own state, in Tor's folder.
    env.TOR_PT_STATE_LOCATION = path.join(data, 'pt_state');
    let p;
    try {
      p = this.spawn(f.tor, ['-f', rc, '--defaults-torrc', path.join(this.dataDir, 'torrc-defaults-none')],
        { cwd: this.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this._fail(`Tor could not start: ${e.message}`);
      return;
    }
    this.proc = p;
    this.stage = stage;
    this.state = 'starting';
    this.progress = 0;
    this.log('info', stage === 'snowflake'
      ? 'The last way out: starting Tor through Snowflake, for sites nothing else opened'
      : 'The last way out: Snowflake did not get through; trying Tor\'s other ways (meek, obfs4) with it');
    this._changed();
    let buf = '';
    const onData = (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { this._line(buf.slice(0, i), gen); buf = buf.slice(i + 1); }
      if (buf.length > 8192) buf = '';
    };
    if (p.stdout) p.stdout.on('data', onData);
    if (p.stderr) p.stderr.on('data', onData);
    p.on('error', (e) => { if (gen === this._gen) this._fail(`Tor could not start: ${e.message}`); });
    p.on('exit', (code) => {
      if (gen !== this._gen) return;
      this.proc = null;
      if (this.state === 'off') return;
      this._fail(`Tor ended (${code})`);
    });
    this._armStall(gen);
  }

  _line(line, gen) {
    if (gen !== this._gen) return;
    const m = line.match(/Bootstrapped (\d+)%/);
    if (m) {
      const pct = Number(m[1]);
      if (pct > this.progress) {
        this.progress = pct;
        this._armStall(gen);
        if (pct >= 100 && this.state !== 'ready') {
          this.state = 'ready';
          clearTimeout(this._timers.stall);
          this._usedAt = Date.now();
          this._armIdle();
          this.log('info', `The last way out is ready: Tor through ${this.stage === 'snowflake' ? 'Snowflake' : 'its bridges'}`);
        }
        this._changed();
      }
      return;
    }
    if (/Could not bind to|Failed to bind one of the listener ports/.test(line)) {
      // Taken since it was chosen: a new one at the next engine start.
      this.port = 0;
      this._fail('Tor could not open its port');
    }
  }

  _armStall(gen) {
    clearTimeout(this._timers.stall);
    this._timers.stall = setTimeout(() => {
      if (gen !== this._gen || this.state !== 'starting') return;
      if (this.stage === 'snowflake') this._start('all');
      else this._fail(`Tor did not get through (${this.progress}%)`);
    }, this.stallMs);
    if (this._timers.stall.unref) this._timers.stall.unref();
  }

  /* The engine's count of connections it carried (its STATS line). */
  noteUse(count) {
    const n = Number(count) || 0;
    if (n > this.used) { this.used = n; this._usedAt = Date.now(); this._changed(); }
    else if (n < this.used) this.used = n;   // a new engine counts from 0
  }

  _armIdle() {
    clearTimeout(this._timers.idle);
    const check = () => {
      if (this.state !== 'ready') return;
      const idle = Date.now() - this._usedAt;
      if (idle >= this.idleMs) {
        this.log('info', 'The last way out: nothing has needed Tor for a while; stopped until a site needs it again');
        this.stop();
        return;
      }
      this._timers.idle = setTimeout(check, Math.min(60000, this.idleMs - idle + 50));
      if (this._timers.idle.unref) this._timers.idle.unref();
    };
    this._timers.idle = setTimeout(check, Math.min(60000, this.idleMs));
    if (this._timers.idle.unref) this._timers.idle.unref();
  }

  _fail(why) {
    this._kill();
    this.state = 'failed';
    this.failedAt = Date.now();
    this.log('warning', `The last way out: ${why}; tried again when a site needs it, in ${Math.round(this.retryMs / 60000)} minutes at the earliest`);
    this._changed();
  }

  _kill() {
    this._gen++;
    clearTimeout(this._timers.stall);
    clearTimeout(this._timers.idle);
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch {} }
  }

  /* With protection: Tor too. The port is kept for the next start. */
  stop() {
    const was = this.state !== 'off';
    this._kill();
    this.state = 'off';
    this.progress = 0;
    this.stage = null;
    this.used = 0;
    if (was) this._changed();
  }

  status() {
    return { state: this.state, progress: this.progress, stage: this.stage, used: this.used };
  }

  _changed() { try { this.onChange(this.status()); } catch {} }
}

module.exports = TorRoute;
module.exports.torDir = torDir;
module.exports.files = files;
module.exports.bridgesOf = bridgesOf;
module.exports.torrc = torrc;
module.exports.withPeers = withPeers;
module.exports.SNOWFLAKE_PEERS = SNOWFLAKE_PEERS;
