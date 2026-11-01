'use strict';

/*
 * "Share my connection" (Settings, More settings; off until the user turns
 * it on): this computer as a Shadowsocks server for the people the user
 * gives its link to. For someone in a shutdown, a friend whose connection
 * still reaches the world is a way out; the link works in any Shadowsocks
 * app (v2rayNG, Hiddify, Shadowrocket...) and in Shroudly's own "Your own
 * server" (own-server.js), on a phone or a computer.
 *
 * What they open goes through Shroudly's engine here, so it also gets past
 * the filters of this computer's own network (or out through the user's own
 * server). Never to this computer or its network: a target on a private or
 * local address, or a name for one, is refused, so a link cannot reach the
 * router's settings or a printer. Nothing is recorded of who connects or
 * where to; only counts, while it runs. Off, the port is closed and the
 * router's way in taken away.
 *
 * Reachable on this network at once; from the internet only where the
 * router opens a way in (upnp.js) and the connection is not one the
 * provider shares among customers.
 */

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const os = require('os');
const SS = require('./shadowsocks');
const Own = require('./own-server');
const UPnP = require('./upnp');

const METHOD = 'chacha20-ietf-poly1305';
const RENEW_MS = 30 * 60 * 1000;

/* Names for this computer or its network, never for a site. */
function localName(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || /\.(localhost|local|lan|home|internal|intranet|corp|home\.arpa)$/.test(h) || !h.includes('.');
}

function lookupAll(host, timeout = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve([]), timeout);
    dns.lookup(host, { all: true }, (err, list) => { clearTimeout(t); resolve(err ? [] : list.map((x) => x.address)); });
  });
}

function directConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setTimeout(15000, () => s.destroy(new Error('timeout')));
    s.once('error', reject);
    s.once('connect', () => { s.setTimeout(0); s.removeListener('error', reject); resolve(s); });
  });
}

/* This computer's IPv4 addresses: on its local networks, or (public: true)
 * on the internet itself, as a server or a connection without a router has. */
function lanAddresses({ publicOnes = false } = {}) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      if (UPnP.privateAddress(a.address) !== publicOnes) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

class Share {
  /* store: the settings ('share': { port, password }); log(level, text);
   * socksPort(): the engine's port while protection is on, else null. The
   * rest stand in for the network in tests. */
  constructor({
    store, log = () => {}, socksPort = () => null, upnp = UPnP, lan = lanAddresses, own = () => lanAddresses({ publicOnes: true }),
    lookup = lookupAll, connectVia = null, bindHost = '0.0.0.0',
  }) {
    this.store = store;
    this.log = log;
    this.socksPort = socksPort;
    this.upnp = upnp;
    this.lan = lan;
    this.own = own;
    this.lookup = lookup;
    this.connectVia = connectVia || require('./discord-relay').socksConnect;
    this.bindHost = bindHost;
    this.server = null;
    this.mapping = null;
    this.upnpState = null;    // 'trying' | 'ok' | 'private' | 'none'
    this._renew = null;
    this._ops = Promise.resolve();
  }

  _serial(fn) {
    const run = this._ops.then(fn);
    this._ops = run.catch(() => {});
    return run;
  }

  /* The port and password, made once and kept: the link stays the same
   * until the user asks for a new one. */
  _settings() {
    const s = this.store.get('share');
    if (s && Number.isInteger(s.port) && s.port > 1023 && s.port < 65536 && typeof s.password === 'string' && s.password.length >= 16) return s;
    const next = { port: 20000 + crypto.randomInt(40000), password: crypto.randomBytes(18).toString('base64url') };
    this.store.set('share', next);
    return next;
  }

  /* A target for one of the people sharing: a site, never this computer or
   * its network. Through the engine while protection is on. */
  async dial(host, port) {
    if (net.isIP(host) ? UPnP.privateAddress(host) : localName(host)) throw new Error('a local address');
    if (!net.isIP(host)) {
      const addrs = await this.lookup(host);
      if (addrs.some((a) => UPnP.privateAddress(a))) throw new Error('a name for a local address');
    }
    const sp = this.socksPort();
    return sp ? this.connectVia(sp, host, port) : directConnect(host, port);
  }

  get on() { return !!this.server; }

  start() { return this._serial(() => this._start()); }

  async _start() {
    if (this.server) return this.status();
    let s = this._settings();
    for (let tries = 0; ; tries++) {
      try {
        this.server = await SS.startServer({ host: this.bindHost, port: s.port, method: METHOD, password: s.password, dial: (h, p) => this.dial(h, p) });
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || tries >= 3) throw e;
        // Another program has the port now: another one, kept from here on.
        s = { ...s, port: 20000 + crypto.randomInt(40000) };
        this.store.set('share', s);
      }
    }
    this.log('info', `Sharing this connection: on (port ${s.port})`);
    this.upnpState = 'trying';
    this._mapLater(s.port);
    return this.status();
  }

  _mapLater(port) {
    Promise.resolve().then(() => this.upnp.map({ port })).then((m) => {
      if (!this.server || this.server.port !== port) { this.upnp.unmap(m); return; }
      this.mapping = m;
      if (!m.ok) {
        this.upnpState = 'none';
        this.log('info', `Sharing: no way in from the internet (${m.why}); people on this network can use it`);
        return;
      }
      this.upnpState = m.reachable ? 'ok' : 'private';
      if (m.reachable) this.log('info', `Sharing: the router forwards port ${port} (internet address ${m.external})`);
      else this.log('info', `Sharing: the router forwards port ${port}, but its address (${m.external || 'unknown'}) is not on the internet; people on this network can use it`);
      clearInterval(this._renew);
      this._renew = setInterval(() => { if (this.server) this.upnp.map({ port }).then((x) => { if (x.ok) this.mapping = x; }).catch(() => {}); }, RENEW_MS);
      if (this._renew.unref) this._renew.unref();
    }).catch(() => { this.upnpState = 'none'; });
  }

  stop() { return this._serial(() => this._stop()); }

  async _stop({ quiet = false } = {}) {
    if (!this.server) return;
    clearInterval(this._renew);
    const m = this.mapping;
    this.mapping = null;
    this.upnpState = null;
    const srv = this.server;
    this.server = null;
    await Promise.all([srv.close(), this.upnp.unmap(m)]);
    if (!quiet) this.log('info', 'Sharing this connection: off');
  }

  /* A new password: the old link stops working at once. */
  newLink() {
    return this._serial(async () => {
      const was = this.on;
      if (was) await this._stop({ quiet: true });
      const s = this._settings();
      this.store.set('share', { ...s, password: crypto.randomBytes(18).toString('base64url') });
      this.log('info', 'Sharing: a new link; the old one no longer works');
      if (was) await this._start();
      return this.status();
    });
  }

  /* What the window shows: the links (one per way in), and counts. */
  status() {
    if (!this.server) return { on: false };
    const s = this._settings();
    const link = (host, name) => Own.ssLink({ method: METHOD, password: s.password, host, port: this.server.port, name });
    const links = this.lan().slice(0, 2).map((a) => ({ where: 'network', address: a, link: link(a, 'Shroudly') }));
    // On the internet: the router's address where it forwards the port, and
    // this computer's own where it has one (no router in between).
    const outside = new Set(this.own().slice(0, 2));
    if (this.mapping && this.mapping.ok && this.mapping.reachable) outside.add(this.mapping.external);
    for (const a of [...outside].reverse()) links.unshift({ where: 'internet', address: a, link: link(a, 'Shroudly') });
    const st = this.server.stats();
    return { on: true, port: this.server.port, links, upnp: this.upnpState, people: st.people, open: st.open, total: st.total, protected: !!this.socksPort() };
  }
}

module.exports = { Share, localName, lanAddresses };
