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
    r = await D.runningTools({ probe: { processes: `"chrome.exe","1"\n${p}`, interfaces: ETH, route: 'Ethernet' } });
    t.ok(r.join() === 'V2Ray / Clash', `proxy clients are still recognised (${p})`);
  }
  r = await D.runningTools({ probe: { processes: '"chrome.exe","1"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(Array.isArray(r) && r.length === 0, 'nothing running: nothing reported (plain list form)');

  t.ok(D.regionOf([{ country: 'IR' }, { country: 'IR' }, { country: 'filter' }]) === 'IR' && D.regionOf([]) === null, 'forged answers -> country');
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
