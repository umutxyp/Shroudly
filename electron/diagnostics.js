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
 * blames whichever one they installed last. */
const CONFLICTS = [
  { re: /goodbyedpi/i,              name: 'GoodbyeDPI' },
  { re: /\bwinws2?\b|\bnfqws\b|zapret/i, name: 'zapret' },
  { re: /ciadpi|byedpi/i,           name: 'ByeDPI' },
  { re: /spoofdpi/i,                name: 'SpoofDPI' },
  { re: /greentunnel/i,             name: 'GreenTunnel' },
  { re: /splitwire/i,               name: 'SplitWire' },
  { re: /proxifyre|proxifier/i,     name: 'Proxifier' },
  { re: /openvpn/i,                 name: 'OpenVPN' },
  { re: /wireguard|\bwg-quick\b|wiresock/i, name: 'WireGuard' },
  { re: /nordvpn/i,                 name: 'NordVPN' },
  { re: /expressvpn/i,              name: 'ExpressVPN' },
  { re: /protonvpn/i,               name: 'Proton VPN' },
  { re: /surfshark/i,               name: 'Surfshark' },
  { re: /\bcloudflare ?warp\b|warp-svc/i, name: 'Cloudflare WARP' },
  { re: /tailscale/i,               name: 'Tailscale' },
  { re: /\btor\b.*browser|tor\.exe/i, name: 'Tor' },
  { re: /psiphon/i,                 name: 'Psiphon' },
  { re: /v2ray|xray|clash|sing-box|hiddify/i, name: 'V2Ray / Clash' },
];

/* Programs that read the system proxy once, when they start.
 *
 * This is the single most common reason someone reports "it works in my
 * browser but not in the app": protection was switched on while the program
 * was already running, so it is still using the connection it was given at
 * launch. Nothing we can do from here changes that — the program has to be
 * restarted — so the least we can do is notice and say so, by name, instead
 * of letting them conclude the app is broken. */
const NEEDS_RESTART = [
  { re: /(^|[^a-z])discord/i,              name: 'Discord' },
  { re: /(^|[^a-z])firefox|librewolf|waterfox/i, name: 'Firefox' },
  { re: /roblox/i,                         name: 'Roblox' },
  { re: /(^|[^a-z])steam(webhelper)?/i,    name: 'Steam' },
  { re: /(^|[^a-z])telegram/i,             name: 'Telegram' },
  { re: /(^|[^a-z])spotify/i,              name: 'Spotify' },
  { re: /(^|[^a-z])slack/i,                name: 'Slack' },
  { re: /(^|[^a-z])whatsapp/i,             name: 'WhatsApp' },
  { re: /thunderbird/i,                    name: 'Thunderbird' },
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

async function runningTools() {
  const out = await processList();
  if (!out) return [];
  const found = new Set();
  for (const c of CONFLICTS) if (c.re.test(out)) found.add(c.name);
  // Our own name can appear in the list on some systems; never report it.
  found.delete('Shroudly');
  return [...found];
}

/* The interface that carries the default route, and whether it looks like a
 * tunnel. A VPN that is up changes which path our traffic takes, so it belongs
 * in the log whether or not it is the cause. */
const TUNNEL_RE = /^(utun|tun|tap|ppp|wg|nordlynx|proton|ipsec|gpd|zt)/i;

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
 * name is being tampered with. */
const FORGED = new Set(['195.175.254.2', '0.0.0.0', '127.0.0.1', '10.10.34.34', '10.10.34.35', '10.10.34.36']);
function looksForged(ip) {
  if (FORGED.has(ip)) return true;
  if (/^0\./.test(ip) || /^127\./.test(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

/* Ask the system resolver about names that are widely tampered with. We do not
 * need to know which country we are in: a forged answer is recognisable on its
 * own. */
const CANARIES = ['discord.com', 'www.wikipedia.org', 'x.com'];

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

async function dnsTampering() {
  const hits = [];
  for (const host of CANARIES) {
    const addrs = await systemResolve(host);
    if (!addrs || !addrs.length) continue;
    const bad = addrs.filter(looksForged);
    if (bad.length) hits.push({ host, addrs: bad });
  }
  return hits;
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
  const [tools, servers, forged, restart] = await Promise.all([
    runningTools(), systemDnsServers(), dnsTampering(), appsNeedingRestart(),
  ]);
  return {
    os: `${process.platform} ${os.release()} ${process.arch}`,
    iface,
    dnsServers: servers,
    conflicts: tools,
    forgedDns: forged,
    needRestart: restart,
  };
}

module.exports = { collect, runningTools, appsNeedingRestart, dnsTampering, defaultRoute, describeInterface };
