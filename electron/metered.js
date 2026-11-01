'use strict';

/*
 * Is this computer on a connection that is paid for by the byte: a phone's
 * hotspot, a mobile modem, a network the user marked as metered?
 *
 * An update is then not downloaded by itself (updater.js): about 100 MB each,
 * and on the busiest days of releases there were several a day. The user's
 * own "Download and install" still downloads it.
 *
 * Windows: the cost Windows itself gives the internet connection (a mobile
 * network, or one set as "Metered connection" in Settings), read through one
 * short PowerShell, only when an update is about to be downloaded. macOS: a
 * default route through an iPhone's hotspot (over Wi-Fi, USB or Bluetooth it
 * hands out 172.20.10.0/28) or through the Mac's own mobile modem (pdp_ip).
 * Linux: NetworkManager's own answer. Unknown, and any failure: not metered,
 * so updates never stop on a look that cannot be made.
 */

const { execFile } = require('child_process');
const { envFor } = require('./win-powershell');

const TIMEOUT_MS = 15000;

// One line out, "<cost type> <roaming> <over the data limit>"; nothing when
// there is no internet connection or WinRT cannot be reached (ConstrainedLanguage).
const PS_COST = "$p = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]::GetInternetConnectionProfile(); if ($p) { $c = $p.GetConnectionCost(); [string]$c.NetworkCostType + ' ' + [string]$c.Roaming + ' ' + [string]$c.OverDataLimit }";

/* "Unrestricted False False": metered when the cost is Fixed or Variable
 * (a data plan), or the connection is roaming or over its limit. */
function windowsMetered(out) {
  const m = /^\s*(\w+)\s+(True|False)\s+(True|False)\s*$/i.exec(String(out || ''));
  if (!m) return false;
  return /^(fixed|variable)$/i.test(m[1]) || /^true$/i.test(m[2]) || /^true$/i.test(m[3]);
}

/* `route -n get default`: "gateway: 172.20.10.1", "interface: en0". */
function macMetered(out) {
  const text = String(out || '');
  const gw = /^\s*gateway:\s*172\.20\.10\.(\d+)\s*$/m.exec(text);
  if (gw && Number(gw[1]) < 16) return true;
  return /^\s*interface:\s*pdp_ip\d+\s*$/m.test(text);
}

/* NetworkManager's Metered: 1 yes, 3 guessed yes (a phone's hotspot);
 * 0 unknown, 2 no, 4 guessed no. dbus-send prints "variant  uint32 4". */
function linuxMetered(out) {
  const m = /uint32\s+(\d+)/.exec(String(out || ''));
  return !!m && (m[1] === '1' || m[1] === '3');
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, ...opts }, (err, out) => resolve(err ? '' : String(out || '')));
});

async function metered({ platform = process.platform, exec = run } = {}) {
  try {
    if (platform === 'win32') {
      return windowsMetered(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_COST], { env: envFor('powershell.exe') }));
    }
    if (platform === 'darwin') return macMetered(await exec('/sbin/route', ['-n', 'get', 'default']));
    if (platform === 'linux') {
      return linuxMetered(await exec('dbus-send', ['--system', '--print-reply=literal', '--dest=org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager', 'org.freedesktop.DBus.Properties.Get', 'string:org.freedesktop.NetworkManager', 'string:Metered']));
    }
  } catch {}
  return false;
}

module.exports = { metered, windowsMetered, macMetered, linuxMetered };
