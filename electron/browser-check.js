'use strict';

/*
 * Which open browser does not go through Shroudly, and why if it can be told.
 *
 * Browsers follow the system proxy Shroudly sets, unless something of their
 * own is in the way: a proxy or "no proxy" chosen in the browser's settings
 * (Firefox has its own), a proxy or VPN extension, a VPN built into the
 * browser, a policy. Such a browser opens a blocked site in no way, while
 * another browser on the same computer does — and nothing in Shroudly would
 * show it. So, while protection sends every site through Shroudly, an open
 * browser that talks to the internet directly and holds no connection to
 * Shroudly at all is going around it: the user is told which one, and for
 * Firefox, whose setting is in a file, the setting is put back to "Use system
 * proxy settings" while Firefox is closed (it would write its own back on
 * quitting).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ProcNet = require('./procnet');

/* Each browser by the names of its processes: Windows image names; macOS
 * application names (helpers start with the same name); Linux command names
 * (15 characters at most). */
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', win: ['chrome.exe'], mac: ['Google Chrome'], linux: ['chrome', 'google-chrome'] },
  { id: 'edge', name: 'Microsoft Edge', win: ['msedge.exe'], mac: ['Microsoft Edge'], linux: ['msedge', 'microsoft-edge'] },
  { id: 'firefox', name: 'Firefox', win: ['firefox.exe'], mac: ['firefox'], linux: ['firefox', 'firefox-bin'] },
  { id: 'opera', name: 'Opera', win: ['opera.exe'], mac: ['Opera', 'Opera GX'], linux: ['opera'] },
  { id: 'brave', name: 'Brave', win: ['brave.exe'], mac: ['Brave Browser'], linux: ['brave'] },
  { id: 'vivaldi', name: 'Vivaldi', win: ['vivaldi.exe'], mac: ['Vivaldi'], linux: ['vivaldi-bin'] },
  { id: 'zen', name: 'Zen Browser', win: ['zen.exe'], mac: ['zen'], linux: ['zen'] },
  { id: 'librewolf', name: 'LibreWolf', win: ['librewolf.exe'], mac: ['librewolf'], linux: ['librewolf'] },
  { id: 'waterfox', name: 'Waterfox', win: ['waterfox.exe'], mac: ['waterfox'], linux: ['waterfox'] },
  { id: 'floorp', name: 'Floorp', win: ['floorp.exe'], mac: ['floorp'], linux: ['floorp'] },
];

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => resolve(err && !out ? '' : String(out || ''))));
}

/* Process list -> [{ pid, name }]: tasklist /FO CSV /NH on Windows, ps
 * "pid comm" elsewhere (macOS gives the program's full path). */
function parseProcesses(out, platform = process.platform) {
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (platform === 'win32') {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m) rows.push({ pid: Number(m[2]), name: m[1] });
    } else {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), name: platform === 'darwin' ? path.basename(m[2]) : m[2] });
    }
  }
  return rows;
}

/* Which known browsers run, each with all of its processes (the network
 * work happens in a child process in most of them). */
function browsersIn(procs, platform = process.platform) {
  const key = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const found = [];
  for (const b of BROWSERS) {
    const names = b[key].map((n) => n.toLowerCase());
    const pids = procs.filter((p) => {
      const n = String(p.name).toLowerCase();
      // macOS: "Google Chrome Helper", "Google Chrome Helper (Renderer)".
      return names.includes(n) || (platform === 'darwin' && names.some((x) => n.startsWith(`${x} helper`)));
    }).map((p) => p.pid);
    if (pids.length) found.push({ ...b, pids });
  }
  return found;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/i;
// The local network and this computer: going there directly is right.
const LOCAL = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|f[cd]|fe80|::ffff:(10|127|192\.168)\.)/i;

/* From one browser's connections: is it going around Shroudly? Direct
 * connections to web ports on the internet, and not one to Shroudly. */
function goesAround(rows, ports) {
  const ours = new Set((ports || []).map(Number).filter(Boolean));
  let direct = 0; let via = 0;
  for (const r of rows || []) {
    const h = String(r.remote && r.remote.host || '');
    const port = Number(r.remote && r.remote.port);
    if (LOOPBACK.test(h)) { if (ours.has(port)) via++; continue; }
    if (!LOCAL.test(h) && (port === 443 || port === 80)) direct++;
  }
  return via === 0 && direct >= 3;
}

/* Firefox's own proxy choice, from a profile's prefs.js: the value of
 * network.proxy.type, or 5 ("Use system proxy settings", the default, which
 * Firefox does not write down). */
function firefoxProxyType(prefs) {
  const m = /^user_pref\("network\.proxy\.type",\s*(\d+)\);\s*$/m.exec(String(prefs || ''));
  return m ? Number(m[1]) : 5;
}

/* prefs.js without the line, when it says 0 ("No proxy") or 4 ("Auto-detect
 * proxy settings for this network"): both send Firefox around the system
 * proxy, and neither is somebody else's proxy that should be kept. A manual
 * proxy (1) or a configuration address (2) is the user's own: never changed. */
function firefoxFixed(prefs) {
  const t = firefoxProxyType(prefs);
  if (t !== 0 && t !== 4) return null;
  return String(prefs).replace(/^user_pref\("network\.proxy\.type",\s*\d+\);\s*\r?\n?/m, '');
}

function firefoxProfileDirs(platform = process.platform, home = os.homedir(), env = process.env) {
  const roots = platform === 'win32'
    ? [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox', 'Profiles')]
    : platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')]
      : [path.join(home, '.mozilla', 'firefox'), path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')];
  const dirs = [];
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names) if (fs.existsSync(path.join(r, n, 'prefs.js'))) dirs.push(path.join(r, n));
  }
  return dirs;
}

/* The proxy types Firefox's profiles on this computer use: [{ dir, type }]. */
function firefoxProfiles(opts) {
  return firefoxProfileDirs(opts && opts.platform, opts && opts.home, opts && opts.env).map((dir) => {
    let type = 5;
    try { type = firefoxProxyType(fs.readFileSync(path.join(dir, 'prefs.js'), 'utf8')); } catch {}
    return { dir, type };
  });
}

/* Put "Use system proxy settings" back in every profile that turned it off,
 * written whole through a temporary file. Only while Firefox is closed: it
 * writes prefs.js back from memory when it quits. Returns the profiles changed. */
function fixFirefox(opts, skip = []) {
  const done = [];
  for (const p of firefoxProfiles(opts)) {
    // Set back once per profile: chosen again after that, it is the user's
    // choice, and they are told instead.
    if (skip.includes(p.dir)) continue;
    const file = path.join(p.dir, 'prefs.js');
    try {
      const fixed = firefoxFixed(fs.readFileSync(file, 'utf8'));
      if (fixed == null) continue;
      const tmp = `${file}.shroudly-${process.pid}`;
      fs.writeFileSync(tmp, fixed);
      fs.renameSync(tmp, file);
      done.push(p.dir);
    } catch {}
  }
  return done;
}

async function runningBrowsers(platform = process.platform) {
  const out = platform === 'win32' ? await run('tasklist', ['/FO', 'CSV', '/NH']) : await run('ps', ['-axo', 'pid=,comm=']);
  return browsersIn(parseProcesses(out, platform), platform);
}

/* The open browsers that go around Shroudly right now. */
async function around(ports, platform = process.platform) {
  const list = await runningBrowsers(platform);
  if (!list.length) return [];
  const rows = await ProcNet.connections(list.flatMap((b) => b.pids), platform);
  return list.filter((b) => goesAround(rows.filter((r) => b.pids.includes(r.pid)), ports));
}

module.exports = {
  BROWSERS, parseProcesses, browsersIn, goesAround, firefoxProxyType, firefoxFixed,
  firefoxProfileDirs, firefoxProfiles, fixFirefox, runningBrowsers, around,
};
