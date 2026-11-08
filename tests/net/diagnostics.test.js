'use strict';

/* What the diagnostics conclude about a machine, with the process list,
 * interfaces and default route stood in for: a VPN client that is installed
 * but disconnected must not be blamed (Cloudflare WARP's service runs from
 * boot), a connected one must; bypass tools count whenever they run. */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const D = require(path.join(ROOT, 'electron', 'diagnostics.js'));
const t = suite('diagnostics');

const ETH = { Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] };
const WARP_UP = { ...ETH, CloudflareWARP: [{ address: '172.16.0.2', family: 'IPv4', internal: false }] };
const TAIL_UP = { ...ETH, Tailscale: [{ address: '100.64.0.5', family: 'IPv4', internal: false }] };

(async () => {
  // The reported case: Windows, WARP's service running, not connected.
  let r = await D.runningTools({ details: true, probe: { processes: '"warp-svc.exe","4112"\n"chrome.exe","900"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.active.length === 0 && r.idle.join() === 'Cloudflare WARP', 'WARP installed but disconnected: not a conflict, noted as idle');
  r = await D.runningTools({ details: true, probe: { processes: '"warp-svc.exe","4112"', interfaces: WARP_UP, route: 'Ethernet' } });
  t.ok(r.active.join() === 'Cloudflare WARP', 'WARP connected (adapter has an address): a conflict');
  r = await D.runningTools({ details: true, probe: { processes: 'warp-svc', interfaces: ETH, route: 'utun4' } });
  t.ok(r.active.join() === 'Cloudflare WARP', 'WARP carrying the default route (macOS utun): a conflict');
  r = await D.runningTools({ details: true, probe: { processes: 'tailscaled', interfaces: TAIL_UP, route: 'en0' } });
  t.ok(r.active.length === 0, 'Tailscale up without an exit node: not a conflict');
  r = await D.runningTools({ details: true, probe: { processes: 'tailscaled', interfaces: TAIL_UP, route: 'Tailscale' } });
  t.ok(r.active.join() === 'Tailscale', 'Tailscale as an exit node (default route): a conflict');
  r = await D.runningTools({ details: true, probe: { processes: '"goodbyedpi.exe","77"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.active.join() === 'GoodbyeDPI', 'a bypass tool counts whenever it runs');
  r = await D.runningTools({ details: true, probe: { processes: '"ByeDPI.exe","9"\nciadpi', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.active.join() === 'ByeDPI', 'ByeDPI is still recognised on its own');
  r = await D.runningTools({ probe: { processes: '"Monitor.exe","1"\n"IntelGraphicsMonitor.exe","2"\n"Navigator.exe","3"\n"qbittorrent.exe","4"\n/usr/bin/motor', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.length === 0, 'names that merely end in "tor" are not Tor (issue #7)');
  for (const p of ['"tor.exe","5"', '/opt/homebrew/opt/tor/bin/tor', 'tor', '/Applications/Tor Browser.app/Contents/MacOS/firefox']) {
    r = await D.runningTools({ probe: { processes: `"chrome.exe","1"\n${p}`, interfaces: ETH, route: 'Ethernet' } });
    t.ok(r.join() === 'Tor', `Tor itself is still recognised (${p})`);
  }
  r = await D.runningTools({ probe: { processes: '"Clash of Clans.exe","1"\n"ClashRoyale.exe","2"\n"NVXRayHelper.exe","3"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.length === 0, 'games and tools that only contain "clash" or "xray" are not proxy clients');
  for (const p of ['"v2rayN.exe","5"', '"Clash Verge.exe","6"', '"verge-mihomo.exe","7"', '/Applications/ClashX Pro.app/Contents/MacOS/ClashX Pro', 'sing-box', '"Hiddify.exe","8"', '"xray.exe","9"']) {
    r = await D.runningTools({ probe: { processes: `"chrome.exe","1"\n${p}`, interfaces: ETH, route: 'utun3' } });
    t.ok(r.join() === 'V2Ray / Clash', `proxy clients are still recognised, with their tunnel up (${p})`);
  }
  // #69: Clash Verge's service, or a core left behind, with no tunnel up:
  // running, steering nothing. Not a conflict, noted as idle.
  r = await D.runningTools({ details: true, probe: { processes: '"clash-verge-service.exe","4"\n"xray.exe","9"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.active.length === 0 && r.idle.join() === 'V2Ray / Clash', 'a proxy client with no tunnel up: not a conflict, idle (#69)');
  for (const adapter of ['Mihomo', 'Meta', 'singbox_tun', 'FlClash', 'nekoray-tun']) {
    r = await D.runningTools({ probe: { processes: '"verge-mihomo.exe","7"', interfaces: { ...ETH, [adapter]: [{ address: '198.18.0.1', family: 'IPv4', internal: false }] }, route: 'Ethernet' } });
    t.ok(r.join() === 'V2Ray / Clash', `its tunnel adapter up (${adapter}): a conflict`);
  }
  r = await D.runningTools({ probe: { processes: '"chrome.exe","1"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(Array.isArray(r) && r.length === 0, 'nothing running: nothing reported (plain list form)');
  // Clients that were not recognised: connected (their adapter, or the
  // default route through a tunnel) and installed but not connected.
  const UP = (name) => ({ ...ETH, [name]: [{ address: '10.64.0.2', family: 'IPv4', internal: false }] });
  for (const [proc, adapter, name] of [
    ['"WindscribeService.exe","10"', 'Windscribe', 'Windscribe'],
    ['"mullvad-daemon.exe","11"', 'Mullvad', 'Mullvad VPN'],
    ['"Urban VPN.exe","12"', 'Urban VPN', 'Urban VPN'],
    ['"hsscp.exe","13"', 'Hotspot Shield', 'Hotspot Shield'],
    ['"pia-service.exe","14"', 'PIA', 'Private Internet Access'],
    ['"CyberGhost.Service.exe","15"', 'CyberGhost', 'CyberGhost'],
    ['"TunnelBear.exe","16"', 'TunnelBear', 'TunnelBear'],
    ['"AdGuardVpn.exe","17"', 'AdGuard VPN', 'AdGuard VPN'],
    ['"vpnagent.exe","18"', 'Cisco AnyConnect', 'Cisco Secure Client'],
    ['"PanGPS.exe","19"', 'PANGP Virtual Ethernet Adapter', 'GlobalProtect'],
    ['"FortiClient.exe","20"', 'Fortinet SSL VPN', 'FortiClient'],
    ['"Pulse.exe","21"', 'Juniper Networks Virtual Adapter', 'Ivanti Secure Access'],
  ]) {
    r = await D.runningTools({ details: true, probe: { processes: proc, interfaces: UP(adapter), route: 'Ethernet' } });
    const up = r.active.join() === name;
    r = await D.runningTools({ details: true, probe: { processes: proc, interfaces: ETH, route: 'Ethernet' } });
    t.ok(up && r.active.length === 0 && r.idle.join() === name, `${name}: connected is named, installed but not connected is only noted`);
  }
  r = await D.runningTools({ details: true, probe: { processes: '/Applications/Mullvad VPN.app/Contents/Resources/mullvad-daemon', interfaces: ETH, route: 'utun6' } });
  t.ok(r.active.join() === 'Mullvad VPN', 'macOS: Mullvad carrying the default route through a utun: connected');
  {
    // A site a person opens whose addresses the network blocks: said in the
    // window (not only for Discord and Roblox), without a notification, and
    // checked at most once a minute and once per site and network.
    const main = require('fs').readFileSync(require('path').join(ROOT, 'electron', 'main.js'), 'utf8');
    const fn = main.slice(main.indexOf('async function checkServiceReach'), main.indexOf('async function checkServiceReach') + 4500);
    t.ok(/ServiceCheck\.isMainName\(host\)/.test(fn) && /lastSiteReach < 60000/.test(fn) && /autoTell\('autoSiteUnreachable', \{ host: site \}\)/.test(fn)
      && /WINDOW_ONLY = \[[^\]]*'autoSiteUnreachable'/.test(main), 'a blocked site of any kind is explained in the window, without a notification, rate-limited');
  }
  {
    // One name of a service blocked by address while its other names work
    // (Roblox's silver.roblox.com on Turkish networks, with every game
    // server and API open): not told as the whole service blocked.
    const main = require('fs').readFileSync(require('path').join(ROOT, 'electron', 'main.js'), 'utf8');
    const Autopilot = require(require('path').join(ROOT, 'electron', 'autopilot.js'));
    const src = main.match(/function serviceWorks[\s\S]*?\n}\n/)[0];
    const serviceWorks = new Function('Autopilot', `return (${src.replace('function serviceWorks', 'function')})`)(Autopilot);
    const dead = { host: 'silver.roblox.com', down: 0, ago: 1000 };
    t.ok(serviceWorks('roblox', 'silver.roblox.com', [dead, { host: 'c0.rbxcdn.com', down: 900000, ago: 3000 }])
      && !serviceWorks('roblox', 'silver.roblox.com', [dead, { host: 'apis.roblox.com', down: 2000, ago: 3000 }])
      && !serviceWorks('roblox', 'silver.roblox.com', [dead, { host: 'apis.roblox.com', down: 900000, ago: 11 * 60 * 1000 }])
      && !serviceWorks('discord', 'discord.com', [{ host: 'apis.roblox.com', down: 900000, ago: 1 }])
      && /if \(service && serviceWorks\(family, host, await engine\.connsList\(\)/.test(main),
    'a service whose other names work through Shroudly is not told as blocked by address');
  }
  r = await D.runningTools({ details: true, probe: { processes: '"ZSATunnel.exe","30"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.active.join() === 'Zscaler', 'Zscaler steers traffic whenever it runs');
  r = await D.runningTools({ probe: { processes: '"AdGuard.exe","31"\n"vpnkit.exe","32"\n"MyVpnUI.exe","33"\n"pianist.exe","34"\n/usr/bin/pulseaudio', interfaces: ETH, route: 'Ethernet' } });
  t.ok(r.length === 0, 'the AdGuard ad blocker, Docker\'s vpnkit and names that only contain these words are not VPN clients');

  // Issue #27: naming the program that keeps taking the system proxy over.
  // Only tools that set the system proxy count (a DPI tool or a VPN tunnel
  // does not touch it), and a process name reads as the tool people know.
  t.ok((await D.proxyTools({ probe: { processes: '"goodbyedpi.exe","1"\n"warp-svc.exe","2"\n"Psiphon3.exe","3"\n"v2rayN.exe","4"\n"lantern.exe","5"' } })).join() === 'Psiphon,Lantern,V2Ray / Clash'
    && (await D.proxyTools({ probe: { processes: '"goodbyedpi.exe","1"\n"Tailscale.exe","2"\n"chrome.exe","3"' } })).length === 0
    && (await D.proxyTools({ probe: { processes: '' } })).length === 0,
  'issue #27: running tools that set the system proxy are named; DPI tools and VPN tunnels are not');
  t.ok(D.toolName('clash-verge.exe') === 'V2Ray / Clash' && D.toolName('Psiphon3.exe') === 'Psiphon' && D.toolName('SomeProxy.exe') === 'SomeProxy' && D.toolName('mihomo') === 'V2Ray / Clash',
    'issue #27: a process name reads as the tool people know, else without ".exe"');
  t.ok(D.toolName('Lantern Helper.exe') === 'Lantern Helper' && (await D.runningTools({ probe: { processes: '"Lantern.exe","9"', interfaces: ETH, route: 'Ethernet' } })).join() === 'Lantern',
    'Lantern (it sets the system proxy while it runs) is recognised, by its whole name');
  t.ok(D.regionOf([{ country: 'IR' }, { country: 'IR' }, { country: 'filter' }]) === 'IR' && D.regionOf([]) === null, 'forged answers -> country');

  // P18: "the system DNS answers nothing" only with the network up. At login
  // the Wi-Fi often connects after Shroudly has started.
  const LO = { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
  const SELF = { ...LO, en0: [{ address: '169.254.10.2', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }] };
  const none = async () => ({ answered: 0, asked: 6, hits: [] });
  const some = async () => ({ answered: 4, asked: 6, hits: [] });
  let reached = 0;
  const reach = (ok) => async () => { reached++; return ok; };
  t.ok(await D.dnsDead({ probe: { interfaces: LO, dns: none, reach: reach(true) } }) === false && reached === 0, 'P18: no network interface up yet: not dead (nothing is asked)');
  t.ok(await D.dnsDead({ probe: { interfaces: SELF, dns: none, reach: reach(true) } }) === false && reached === 0, 'P18: only a self-assigned address (no network yet): not dead');
  t.ok(await D.dnsDead({ probe: { interfaces: ETH, dns: some, reach: reach(true) } }) === false && reached === 0, 'P18: the DNS answers: not dead');
  t.ok(await D.dnsDead({ probe: { interfaces: ETH, dns: none, reach: reach(false) } }) === false, 'P18: nothing answers and no public address can be reached either (the network is not up): not dead');
  t.ok(await D.dnsDead({ probe: { interfaces: ETH, dns: none, reach: reach(true) } }) === true, 'P18: the network is up and the DNS still answers nothing: dead');

  // The program that answers DNS on this computer: only one listening where
  // the system asks (or everywhere) is named. macOS and Linux show other
  // users' programs without their names, so a DNS program run by the system
  // leaves nothing to name, rather than some other program on port 53.
  const lsof = 'p501\ncdnscrypt-proxy\nf7\nn127.0.0.1:53\np502\ncdevdns\nf9\nn192.168.64.1:53\np503\ncChrome\nf30\nn192.168.1.20:61000->1.1.1.1:53\n';
  t.ok(D.lsofDnsPrograms(lsof, ['127.0.0.1']).join() === 'dnscrypt-proxy', 'macOS: the program on 127.0.0.1:53, not one on another address, not a program asking a DNS server');
  t.ok(D.lsofDnsPrograms('p7\ncdevdns\nf9\nn192.168.64.1:53\n', ['127.0.0.1']).length === 0, 'macOS: the system DNS program cannot be seen, another on port 53 can: nothing named');
  t.ok(D.lsofDnsPrograms('p7\ncadguard\nf9\nn*:53\np8\ncv6dns\nf3\nn[::1]:53\n', ['::1']).join() === 'adguard,v6dns', 'macOS: listening on every address, or on ::1');
  const ss = [
    'UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*',
    'UNCONN 0      0          127.0.0.1:53        0.0.0.0:*',
    'UNCONN 0      0      192.168.122.1:53        0.0.0.0:*    users:(("devdns",pid=900,fd=5))',
    'UNCONN 0      0              [::1]:53           [::]:*    users:(("dnscrypt-proxy",pid=9,fd=7))',
  ].join('\n');
  t.ok(D.ssDnsPrograms(ss, ['127.0.0.1']).length === 0, 'Linux: a DNS program run by the system (no name shown): nothing named, not the user\'s program elsewhere');
  t.ok(D.ssDnsPrograms(ss, ['::1']).join() === 'dnscrypt-proxy' && D.ssDnsPrograms('UNCONN 0 0 *:53 *:* users:(("unbound",pid=3,fd=4),("unbound",pid=4,fd=4))', ['127.0.0.1']).join() === 'unbound,unbound',
    'Linux: the program on the address asked, or on every address');
  console.log(`diagnostics: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
