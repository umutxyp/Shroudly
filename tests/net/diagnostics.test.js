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
  console.log(`diagnostics: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
