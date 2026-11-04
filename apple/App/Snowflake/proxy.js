'use strict';

/*
 * A Snowflake proxy: lets people in censored countries reach Tor through
 * this computer. It runs in a hidden, sandboxed window of its own
 * (electron/snowflake.js), with nothing of the app's and no Node.js.
 *
 *   person using Tor ── WebRTC ── this proxy ── WebSocket ── Tor's Snowflake relay
 *
 * Tor's broker pairs it with someone: the proxy asks it for a person to help
 * ("poll"), takes that person's WebRTC offer, answers it, and carries what
 * comes over the data channel to Tor's relay and back. What is carried is
 * Tor's own encryption: the proxy sees neither who the person is behind Tor
 * nor what they open. The protocol is the one of Tor's browser proxy
 * (snowflake-webext: broker.js, proxypair.js, snowflake.js), written anew
 * here; no code is loaded from anywhere.
 */
(() => {
  const host = window.snowflakeHost;
  if (!host) return;

  const MAX_BUFFER = 10 * 1024 * 1024;       // per direction, as Tor's proxy
  const ANSWER_MS = 3000;                    // answer sent by then (the client waits ~5 s)
  const DATACHANNEL_MS = 20000;              // the person connects within this
  const STALE_MS = 30000;                    // no message from them: closed
  const RELAY_MS = 5000;                     // Tor's relay connects within this
  const NAT_CHECK_MS = 2 * 24 * 3600 * 1000; // NAT type looked at again after two days

  let cfg = null;
  let nat = 'unknown';
  let natAt = 0;
  let maxClients = 1;
  let total = 0;
  let natFailures = 0;
  let unreachable = 0;
  let state = 'starting';
  let timer = null;
  let stopped = false;
  const pairs = new Set();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function report() {
    const now = [...pairs].filter((p) => p.open).length;
    host.report({ state: now > 0 ? 'serving' : state, now, total, nat, natAt });
  }

  /* A session id for the broker: random, as Tor's proxy makes one. */
  function sid() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => (b % 36).toString(36)).join('');
  }

  async function post(url, body, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      // A plain text body: a "simple" request, as the broker expects one.
      const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: ctl.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /* Only Tor's relays: wss, and a host the pattern allows (a leading ^ for
   * exactly that host, else that host or one under it). */
  function relayAllowed(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'wss:' && !(cfg.insecureRelay && u.protocol === 'ws:')) return false;
    const p = String(cfg.relayPattern || '');
    if (!p) return false;
    if (p[0] === '^') return u.hostname === p.slice(1);
    return u.hostname === p || u.hostname.endsWith(`.${p}`);
  }

  /* The person's address as their offer gives it, for Tor's relay's
   * per-country counts (Tor's proxy sends it too); a local one is not. */
  function remoteIp(ip) {
    if (ip.includes(':')) {
      return !(/^(?:0*:)*?:?0*1$/.test(ip) || /^(?:0*:)*?:?0*$/.test(ip) || (parseInt(ip.split(':')[0], 16) & 0xfe00) === 0xfc00
        || (parseInt(ip.split(':')[0], 16) & 0xffc0) === 0xfe80);
    }
    const q = ip.split('.').map(Number);
    if (q.length !== 4 || q.some((n) => !(n >= 0 && n <= 255))) return false;
    return !(q[0] === 10 || q[0] === 127 || q[0] === 0 || (q[0] === 172 && (q[1] & 0xf0) === 16) || (q[0] === 192 && q[1] === 168)
      || (q[0] === 100 && (q[1] & 0xc0) === 64) || (q[0] === 169 && q[1] === 254));
  }
  function ipFromSdp(sdp) {
    const pats = [/^a=candidate:[a-zA-Z0-9+/]+ \d+ udp \d+ ([\d.]+) /mg, /^a=candidate:[a-zA-Z0-9+/]+ \d+ udp \d+ ([0-9A-Fa-f:.]+) /mg,
      /^c=IN IP4 ([\d.]+)(?:(?:\/\d+)?\/\d+)?(:? |$)/mg, /^c=IN IP6 ([0-9A-Fa-f:.]+)(?:\/\d+)?(:? |$)/mg];
    for (const re of pats) {
      let m;
      while ((m = re.exec(sdp)) !== null) if (remoteIp(m[1])) return m[1];
    }
    return null;
  }

  /* One person: their WebRTC data channel to Tor's relay and back.
   * Resolves the answer to send the broker, or null. */
  function serve(offer, relayUrl, clientNat) {
    const pair = { open: false, closed: false };
    pairs.add(pair);
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
    let channel = null;
    let ws = null;
    const c2r = []; const r2c = [];
    let staleTimer = null; let flushTimer = null;

    const close = () => {
      if (pair.closed) return;
      pair.closed = true;
      clearTimeout(staleTimer); clearTimeout(flushTimer);
      try { if (channel) channel.close(); } catch {}
      try { pc.close(); } catch {}
      try { if (ws) ws.close(); } catch {}
      pairs.delete(pair);
      report();
    };
    const refreshStale = () => { clearTimeout(staleTimer); staleTimer = setTimeout(close, STALE_MS); };
    const flush = () => {
      if (pair.closed) return;
      while (c2r.length && ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFER) ws.send(c2r.shift());
      while (r2c.length && channel && channel.readyState === 'open' && channel.bufferedAmount < MAX_BUFFER) channel.send(r2c.shift());
      clearTimeout(flushTimer);
      if (c2r.length || r2c.length) flushTimer = setTimeout(flush, 50);
    };

    pc.ondatachannel = ({ channel: ch }) => {
      channel = ch;
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => {
        pair.open = true;
        // One person, however many channels their side opens (macOS's
        // WebRTC was seen to open a second one): counted once.
        if (!pair.counted) { pair.counted = true; total++; }
        natFailures = 0;
        if (nat === 'unrestricted') maxClients = 2;
        refreshStale();
        flush();
        report();
      };
      ch.onclose = close;
      ch.onmessage = (m) => { c2r.push(m.data); flush(); refreshStale(); };
    };

    // Tor's relay, at once, as Tor's proxy does.
    const url = new URL(relayUrl);
    const ip = ipFromSdp(offer.sdp || '');
    if (ip) url.searchParams.set('client_ip', ip);
    ws = new WebSocket(url.href);
    ws.binaryType = 'arraybuffer';
    const relayTimer = setTimeout(() => { if (!ws || ws.readyState !== WebSocket.OPEN) close(); }, RELAY_MS);
    ws.onopen = () => { clearTimeout(relayTimer); flush(); };
    ws.onmessage = (e) => { r2c.push(e.data); flush(); };
    ws.onclose = close;
    ws.onerror = close;

    // The person connects within DATACHANNEL_MS or the pair is given up; a
    // run of such failures with people behind strict NATs means this side's
    // NAT is not what was thought, so it is looked at again.
    setTimeout(() => {
      if (pair.open || pair.closed) return;
      close();
      if (clientNat === 'restricted' && ++natFailures >= 5) { natFailures = 0; maxClients = 1; natAt = 0; }
    }, DATACHANNEL_MS);

    return new Promise((resolve) => {
      let sent = false;
      const give = () => { if (sent || !pc.localDescription) return; sent = true; resolve(pc.localDescription); };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') give(); };
      setTimeout(give, ANSWER_MS);
      pc.setRemoteDescription(offer)
        .then(() => pc.addIceCandidate({ candidate: '' }).catch(() => {}))
        .then(() => pc.createAnswer())
        .then((a) => pc.setLocalDescription(a))
        .then(() => { if (pc.iceGatheringState === 'complete') give(); })
        .catch(() => { close(); if (!sent) { sent = true; resolve(null); } });
      setTimeout(() => { if (!sent) { sent = true; resolve(null); close(); } }, DATACHANNEL_MS);
    });
  }

  /* Whether people behind strict NATs can reach this computer: Tor's probe
   * plays a person once. "unrestricted" lets the broker send anyone. */
  async function checkNat() {
    if (!cfg.probe) return;
    const pc = new RTCPeerConnection({ iceServers: cfg.natIceServers });
    const ch = pc.createDataChannel('NAT test');
    let opened = false;
    const open = new Promise((r) => { ch.onopen = () => { opened = true; r(); }; });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => {
        if (pc.iceGatheringState === 'complete') { r(); return; }
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); };
        setTimeout(r, 10000);
      });
      const resp = await post(cfg.probe, { Status: 'client match', Offer: JSON.stringify(pc.localDescription) }, 30000);
      await pc.setRemoteDescription(JSON.parse(resp.Answer));
      await Promise.race([open, sleep(DATACHANNEL_MS)]);
      nat = opened ? 'unrestricted' : 'restricted';
      natAt = Date.now();
    } catch {
      // Not known: the broker then sends only people who can reach anyone.
    } finally {
      try { ch.close(); } catch {}
      try { pc.close(); } catch {}
    }
  }

  async function poll() {
    timer = null;
    let next = cfg.pollMs;
    if (!natAt || Date.now() - natAt > NAT_CHECK_MS) { await checkNat(); report(); }
    if (pairs.size < maxClients) {
      // The broker pairs the person with this poll's session id; the answer
      // goes back under the same one.
      const id = sid();
      try {
        const resp = await post(`${cfg.broker}proxy`, {
          Version: '1.3', Sid: id, Type: '', NAT: nat,
          Clients: Math.floor(pairs.size / 8) * 8, AcceptedRelayPattern: cfg.relayPattern,
        }, 60000);
        unreachable = 0;
        state = 'waiting';
        if (resp && resp.Status === 'client match') {
          const relay = resp.RelayURL || cfg.defaultRelay;
          let offer = null;
          try { offer = JSON.parse(resp.Offer); } catch {}
          if (offer && offer.type === 'offer' && relayAllowed(relay)) {
            const answer = await serve(offer, relay, resp.NAT);
            if (answer) post(`${cfg.broker}answer`, { Version: '1.0', Sid: id, Answer: JSON.stringify(answer) }, 30000).catch(() => {});
          }
        }
        if (resp && typeof resp.NextPoll === 'number' && resp.NextPoll > 0) next = Math.max(cfg.minPollMs, resp.NextPoll);
      } catch {
        if (++unreachable >= 3) state = 'unreachable';
      }
    }
    report();
    if (timer === null && !stopped) timer = setTimeout(poll, next);
  }

  host.onStop(() => {
    stopped = true;
    clearTimeout(timer);
    for (const p of [...pairs]) p.closed = true;
  });

  host.config().then((c) => {
    cfg = c;
    if (c.nat) { nat = c.nat; natAt = c.natAt || 0; }
    report();
    poll();
  });
})();
