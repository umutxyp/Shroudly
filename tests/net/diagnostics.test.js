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
  r = await D.runningTools({ probe: { processes: '"chrome.exe","1"', interfaces: ETH, route: 'Ethernet' } });
  t.ok(Array.isArray(r) && r.length === 0, 'nothing running: nothing reported (plain list form)');

  t.ok(D.timezoneCountry('Asia/Tehran') === 'IR' && D.timezoneCountry('Europe/Moscow') === 'RU' && D.timezoneCountry('Asia/Shanghai') === 'CN', 'clock zone -> country for the stateful-filter countries');
  t.ok(D.timezoneCountry('Europe/Istanbul') === null && D.timezoneCountry('America/New_York') === null, 'other zones give no hint');
  t.ok(D.regionOf([{ country: 'IR' }, { country: 'IR' }, { country: 'filter' }]) === 'IR' && D.regionOf([]) === null, 'forged answers -> country');
  console.log(`diagnostics: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
