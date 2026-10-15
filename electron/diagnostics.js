'use strict';

/*
 * Environment diagnostics.
 *
 * Two jobs, both aimed at the same thing: when someone reports "it doesn't
 * work", the log they send should already contain the answer.
 *
 *  1. Describe the machine and the network once at startup — operating system,
 *     which interface carries the default route, whether that interface looks
 *     like a VPN, and which DNS servers the system is using.
 *  2. Spot the two things that make Shroudly look broken when it isn't:
 *     another bypass tool or VPN fighting it for the same connections, and a
 *     resolver that is handing back forged answers.
 *
 * Nothing here leaves the machine. It is written to the local log, which the
 * user chooses whether to send.
 */

const os = require('os');
const dns = require('dns');
const { execFile } = require('child_process');

/* System tools are addressed absolutely. Launching them by bare name lets
 * anything earlier on PATH answer instead, and this runs at every start. */
function winTool(rel) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return `${root}\\System32\\${rel}`;
}

const run = (cmd, args, ms = 4000) => new Promise((resolve) => {
  try {
    const p = execFile(cmd, args, { timeout: ms, windowsHide: true },
      (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
    p.on('error', () => resolve(''));
  } catch { resolve(''); }
});

/* Other tools that steer the same traffic. Running two of them at once is the
 * most common reason a working setup suddenly stops working, and the user
 * blames whichever one they installed last.
 *
 * Bypass tools act whenever they run. VPN clients do not: most keep a
 * background service running while disconnected (Cloudflare WARP's warp-svc
 * runs from boot), so a VPN counts only while its tunnel is actually up —
 * its adapter has an address, or the default route goes through a tunnel.
 * `tunnel` names the adapter; `routeOnly` VPNs (Tailscale) only matter when
 * they carry the default route, since their adapter is up all the time. */
const CONFLICTS = [
  { re: /goodbyedpi/i,              name: 'GoodbyeDPI' },
  { re: /\bwinws2?\b|\bnfqws\b|zapret/i, name: 'zapret' },
  { re: /ciadpi|(^|[^a-z])byedpi/im, name: 'ByeDPI' },   // not the end of "goodbyedpi"
  { re: /spoofdpi/i,                name: 'SpoofDPI' },
  { re: /greentunnel/i,             name: 'GreenTunnel' },
  { re: /splitwire/i,               name: 'SplitWire' },
  { re: /proxifyre|proxifier/i,     name: 'Proxifier' },
  { re: /openvpn/i,                 name: 'OpenVPN',    tunnel: /openvpn|^tap|^tun/i },
  { re: /wireguard|\bwg-quick\b|wiresock/i, name: 'WireGuard', tunnel: /^wg|wireguard|wiresock/i },
  { re: /nordvpn/i,                 name: 'NordVPN',    tunnel: /nordlynx|nordvpn|nordtun/i },
  { re: /expressvpn/i,              name: 'ExpressVPN', tunnel: /expressvpn/i },
  { re: /protonvpn/i,               name: 'Proton VPN', tunnel: /proton/i },
  { re: /surfshark/i,               name: 'Surfshark',  tunnel: /surfshark/i },
  { re: /\bcloudflare ?warp\b|warp-svc/i, name: 'Cloudflare WARP', tunnel: /cloudflarewarp|^warp/i },
  { re: /tailscale/i,               name: 'Tailscale',  tunnel: /tailscale/i, routeOnly: true },
  // The whole name, not its end: "Monitor.exe", "Navigator.exe" and the
  // like are everywhere on Windows. tasklist quotes names, ps gives a path
  // (macOS) or a bare name (Linux); the browser shows up as "Tor Browser".
  { re: /(^|["\\/])tor(\.exe)?("|$)|tor ?browser/im, name: 'Tor' },
  { re: /psiphon/i,                 name: 'Psiphon' },
  // At the start of a name, so a game called "Clash of Clans" or a tool that
  // merely contains "xray" is not taken for one.
  { re: /(^|["\\/])(v2ray|xray|clash(?! ?of ?clans| ?royale)|flclash|mihomo|verge-mihomo|sing-box|hiddify|nekoray|nekobox)/im, name: 'V2Ray / Clash' },
];

/* Programs that read the system proxy once, when they start.
 *
 * Kept to the ones people actually come here for. Naming every chat and music
 * app that happens to be open turns a useful hint into a list of things that
 * look wrong, and a message about a program the user was not even thinking
 * about reads as a warning that something has gone wrong with it.
 *
 * This is the single most common reason someone reports "it works in my
 * browser but not in the app": protection was switched on while the program
 * was already running, so it is still using the connection it was given at
 * launch. Nothing we can do from here changes that — the program has to be
 * restarted — so the least we can do is notice and say so, by name, instead
 * of letting them conclude the app is broken. */
const NEEDS_RESTART = [
  { re: /(^|[^a-z])discord/i,                     name: 'Discord' },
  { re: /(^|[^a-z])firefox|librewolf|waterfox/i,  name: 'Firefox' },
  { re: /roblox/i,                                name: 'Roblox' },
  { re: /(^|[^a-z])telegram/i,                    name: 'Telegram' },
];

async function processList() {
  return process.platform === 'win32'
    ? await run(winTool('tasklist.exe'), ['/fo', 'csv', '/nh'])
    : await run('/bin/ps', ['-A', '-o', 'comm=']);
}

/* Running programs that will not pick up the protection until restarted. */
async function appsNeedingRestart() {
  const out = await processList();
  if (!out) return [];
  const found = new Set();
  for (const a of NEEDS_RESTART) if (a.re.test(out)) found.add(a.name);
  return [...found];
}

/* Is this VPN's tunnel carrying traffic right now? */
function tunnelUp(c, routeIf, ifs) {
  if (routeIf && (c.tunnel.test(routeIf) || (!c.routeOnly && TUNNEL_RE.test(routeIf)))) return true;
  if (c.routeOnly) return false;
  return Object.entries(ifs).some(([name, addrs]) =>
    c.tunnel.test(name) && (addrs || []).some((a) => !a.internal));
}

/* Tools that are steering traffic right now. With `details`, also the VPN
 * clients that are installed and running but not connected, for the log. */
async function runningTools({ details = false, probe = {} } = {}) {
  // `probe` lets the tests stand in for the process list, interfaces and route.
  const out = probe.processes !== undefined ? probe.processes : await processList();
  const ifs = probe.interfaces || os.networkInterfaces();
  if (!out) return details ? { active: [], idle: [] } : [];
  const active = new Set(); const idle = new Set();
  let routeIf;
  for (const c of CONFLICTS) {
    if (!c.re.test(out)) continue;
    if (!c.tunnel) { active.add(c.name); continue; }
    if (routeIf === undefined) routeIf = probe.route !== undefined ? probe.route : await defaultRoute();
    (tunnelUp(c, routeIf, ifs) ? active : idle).add(c.name);
  }
  // Our own name can appear in the list on some systems; never report it.
  active.delete('Shroudly');
  return details ? { active: [...active], idle: [...idle] } : [...active];
}

/* The interface that carries the default route, and whether it looks like a
 * tunnel. A VPN that is up changes which path our traffic takes, so it belongs
 * in the log whether or not it is the cause. */
const TUNNEL_RE = /^(utun|tun|tap|ppp|wg|nordlynx|proton|ipsec|gpd|zt|cloudflarewarp|warp|tailscale|wintun|wireguard|openvpn|surfshark|expressvpn|mullvad)/i;

async function defaultRoute() {
  try {
    if (process.platform === 'darwin') {
      const o = await run('/sbin/route', ['-n', 'get', 'default']);
      const m = o.match(/interface:\s*(\S+)/);
      return m ? m[1] : '';
    }
    if (process.platform === 'linux') {
      const o = await run('/sbin/ip', ['route', 'show', 'default']) ||
                await run('/usr/sbin/ip', ['route', 'show', 'default']) ||
                await run('/bin/ip', ['route', 'show', 'default']);
      const m = o.match(/\sdev\s+(\S+)/);
      return m ? m[1] : '';
    }
    const o = await run(winTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-Command',
      '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias'], 6000);
    return o.trim();
  } catch { return ''; }
}

function describeInterface(name) {
  const ifs = os.networkInterfaces();
  const addrs = (ifs[name] || []).filter((a) => !a.internal);
  const v4 = addrs.find((a) => a.family === 'IPv4' || a.family === 4);
  const kind = TUNNEL_RE.test(name) ? 'tunnel/VPN'
    : /^(en|eth|eno|enp|ens)/i.test(name) ? 'wired or Wi-Fi'
    : /^(wl|wlan|wlp)/i.test(name) ? 'Wi-Fi'
    : /^(pdp_ip|rmnet|ww)/i.test(name) ? 'mobile'
    : 'unknown';
  return { name, kind, hasIpv4: !!v4, ipv6: addrs.some((a) => a.family === 'IPv6' || a.family === 6) };
}

/* Answers that can only be a forged one. A resolver that hands back the
 * address of a block page, a loopback or an unroutable address for a public
 * name is being tampered with. The block pages of two dozen countries are
 * known (censor-fingerprints.js), which also says whose filtering it is. */
const fingerprints = require('./censor-fingerprints');
function looksForged(ip) {
  if (fingerprints.countryOf(ip)) return true;
  if (/^0\./.test(ip) || /^127\./.test(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

/* Ask the system resolver about names that are widely tampered with. We do not
 * need to know which country we are in: a forged answer is recognisable on its
 * own. */
const CANARIES = ['discord.com', 'www.wikipedia.org', 'x.com', 'www.facebook.com', 'telegram.org', 'www.bbc.com'];

function systemResolve(host, ms = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
    try {
      dns.resolve4(host, (err, addrs) => {
        if (settled) return;
        settled = true; clearTimeout(t);
        resolve(err ? null : addrs);
      });
    } catch { clearTimeout(t); resolve(null); }
  });
}

/* The forged answers, and how many names the system's DNS answered at all:
 * a resolver that answers none (a local DNS program that was removed or
 * stopped) breaks every program that does not go through Shroudly, while the
 * browser keeps working, which is very confusing without this line. */
async function dnsProbe() {
  const hits = [];
  let answered = 0;
  for (const host of CANARIES) {
    const addrs = await systemResolve(host);
    if (!addrs || !addrs.length) continue;
    answered++;
    const bad = addrs.filter(looksForged);
    if (bad.length) hits.push({ host, addrs: bad, country: bad.map(fingerprints.countryOf).find(Boolean) || null });
  }
  return { hits, answered, asked: CANARIES.length };
}

async function dnsTampering() { return (await dnsProbe()).hits; }

/* When the system's DNS is a program on this computer (127.0.0.1, ::1):
 * which one. Many leftovers of other bypass tools (DNSCrypt, YogaDNS,
 * AdGuard, Acrylic, SecureDNSClient) live there, and some also intercept
 * traffic. Linux's own systemd-resolved (127.0.0.53) is the normal case and
 * not looked into. Asked only when the DNS is local. */
const isLoopbackDns = (a) => /^127\./.test(a) || a === '::1';
async function localDnsOwner(servers) {
  const loop = (servers || []).filter(isLoopbackDns);
  if (!loop.length || loop.every((a) => a === '127.0.0.53')) return null;
  let names = [];
  if (process.platform === 'win32') {
    const out = await run(winTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
      'Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Sort-Object -Unique'], 8000);
    names = out.split(/\r?\n/);
  } else if (process.platform === 'darwin') {
    // Programs bound to port 53 here, not the ones merely asking a DNS
    // server (those show as "local->remote:53").
    let cmd = null;
    for (const l of (await run('/usr/sbin/lsof', ['-nP', '-iUDP:53', '-Fcn'])).split('\n')) {
      if (l.startsWith('c')) cmd = l.slice(1);
      else if (l.startsWith('n') && cmd && !l.includes('->') && /:53$/.test(l)) names.push(cmd);
    }
  } else {
    const out = await run('/usr/bin/ss', ['-lunpH', 'sport = :53']);
    names = [...out.matchAll(/\(\("([^"]+)"/g)].map((m) => m[1]);
  }
  names = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 4);
  return { servers: loop, programs: names };
}

/* Whose filtering this is, going by the forged answers: a country code, or
 * 'filter' for a DNS filtering service. null when nothing was forged or the
 * answers match no known block page. */
function regionOf(forged) {
  const tally = {};
  for (const h of forged) if (h.country) tally[h.country] = (tally[h.country] || 0) + 1;
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

async function systemDnsServers() {
  try {
    const s = dns.getServers();
    return Array.isArray(s) ? s.slice(0, 4) : [];
  } catch { return []; }
}

/* One block at startup: everything a support reply would otherwise have to ask
 * for. */
async function collect() {
  const ifName = await defaultRoute();
  const iface = ifName ? describeInterface(ifName) : { name: '?', kind: 'unknown' };
  const [tools, servers, probe, restart] = await Promise.all([
    runningTools({ details: true }), systemDnsServers(), dnsProbe(), appsNeedingRestart(),
  ]);
  const localDns = await localDnsOwner(servers).catch(() => null);
  return {
    os: `${process.platform} ${os.release()} ${process.arch}`,
    iface,
    dnsServers: servers,
    localDns,
    dnsAnswered: probe.answered,
    dnsAsked: probe.asked,
    conflicts: tools.active,
    idleVpns: tools.idle,
    forgedDns: probe.hits,
    region: regionOf(probe.hits),
    needRestart: restart,
  };
}

module.exports = { collect, runningTools, appsNeedingRestart, dnsTampering, dnsProbe, localDnsOwner, defaultRoute, describeInterface, regionOf, looksForged };
