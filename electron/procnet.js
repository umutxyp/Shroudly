'use strict';

/*
 * Which programs use Shroudly right now: whether given processes hold a
 * connection to one of Shroudly's local ports (the system proxy, the program
 * proxy, Discord's relay). A program that runs but holds none is not going
 * through Shroudly, whatever its settings say; the autopilot restarts such a
 * program when it is stuck and safe to restart (autopilot.js).
 *
 * One system tool per question, the one each system has: netstat on Windows,
 * lsof on macOS; on Linux the kernel's own tables in /proc, which every
 * distribution has (ss is missing from minimal ones). Each answers in well
 * under a second.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => resolve(err && !out ? '' : String(out || ''))));
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[?::1\]?|\[?::ffff:127\.\d+\.\d+\.\d+\]?)$/i;
function hostPort(s) {
  const m = /^(.*):(\d+)$/.exec(String(s || '').trim());
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
}

/* Lines of each tool, read into { pid, remote: { host, port } }.
 * Windows translates netstat's State column (HERGESTELLT, KURULDU,
 * УСТАНОВЛЕНО...), so it is never compared: a listening socket has no peer
 * (port 0), and a connection already closed belongs to no process (pid 0),
 * so neither can match. */
function parseNetstat(out) {
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 5) continue;
    const remote = hostPort(f[2]);
    const pid = Number(f[f.length - 1]);
    if (remote && remote.port > 0 && pid > 0) rows.push({ pid, remote });
  }
  return rows;
}

function parseLsof(out) {
  const rows = [];
  let pid = 0;
  for (const line of String(out || '').split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && line.includes('->')) {
      const remote = hostPort(line.slice(1).split('->')[1]);
      if (remote) rows.push({ pid, remote });
    }
  }
  return rows;
}

function parseSs(out) {
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    // Recv-Q Send-Q Local Peer users:(("name",pid=1,fd=2),...)
    if (f.length < 5) continue;
    const remote = hostPort(f[3]);
    if (!remote) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) rows.push({ pid: Number(m[1]), remote });
  }
  return rows;
}

/* Linux: /proc/net/tcp and tcp6 list every connection by socket inode, with
 * addresses in the kernel's byte order; /proc/<pid>/fd says which sockets a
 * process holds. Established connections only (state 01). */
function v4(hex) { return hex.match(/../g).map((h) => parseInt(h, 16)).reverse().join('.'); }
function v6(hex) {
  // Four 32-bit words, each in host (little-endian) order.
  const bytes = hex.match(/.{8}/g).flatMap((w) => w.match(/../g).reverse());
  const h = bytes.join('').toLowerCase();
  if (h === '00000000000000000000000000000001') return '::1';
  if (h.startsWith('00000000000000000000ffff')) return `::ffff:${bytes.slice(12).map((b) => parseInt(b, 16)).join('.')}`;
  return h.match(/.{4}/g).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}
function parseProcNet(text) {
  const byInode = new Map();
  for (const line of String(text || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '01') continue;
    const [ip, port] = f[2].split(':');
    if (!ip || !port) continue;
    byInode.set(f[9], { host: ip.length === 8 ? v4(ip) : v6(ip), port: parseInt(port, 16) });
  }
  return byInode;
}
function procConnections(list, root = '/proc') {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const byInode = new Map([...parseProcNet(read(`${root}/net/tcp`)), ...parseProcNet(read(`${root}/net/tcp6`))]);
  const rows = [];
  for (const pid of list) {
    let fds = [];
    try { fds = fs.readdirSync(`${root}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`${root}/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && byInode.has(m[1])) rows.push({ pid, remote: byInode.get(m[1]) });
    }
  }
  return rows;
}

async function connections(pids, platform = process.platform) {
  const list = [...new Set((pids || []).map(Number).filter((p) => p > 0))];
  if (!list.length) return [];
  let rows = [];
  if (platform === 'win32') rows = parseNetstat(await run('netstat', ['-ano', '-p', 'TCP']));
  else if (platform === 'darwin') rows = parseLsof(await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:ESTABLISHED', '-Fn', '-p', list.join(',')]));
  else rows = procConnections(list);
  return rows.filter((r) => list.includes(r.pid));
}

/* The process listening on a TCP port on this computer: { pid, name }, or
 * null. Names the program whose PAC took the place of Shroudly's in the
 * system proxy settings (engine-manager.js, whoTookProxy). netstat and
 * tasklist on Windows, lsof on macOS, the kernel's tables on Linux (only the
 * user's own processes show there, which is where such a program runs). */
function parseNetstatListeners(out, port) {
  const pids = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 5) continue;
    const local = hostPort(f[1]);
    const remote = hostPort(f[2]);
    const pid = Number(f[f.length - 1]);
    // A listening socket has no peer: port 0 (the State column is translated).
    if (local && remote && local.port === port && remote.port === 0 && pid > 0) pids.push(pid);
  }
  return pids;
}

function parseTasklistName(out, pid) {
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1];
  }
  return null;
}

function parseLsofListener(out) {
  let pid = 0;
  for (const line of String(out || '').split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid > 0) return { pid, name: line.slice(1) };
  }
  return null;
}

function procListener(port, root = '/proc') {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const inodes = new Set();
  for (const table of ['tcp', 'tcp6']) {
    for (const line of read(`${root}/net/${table}`).split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A') continue; // listening
      if (parseInt((f[1].split(':')[1] || ''), 16) === port) inodes.add(f[9]);
    }
  }
  if (!inodes.size) return null;
  let pids = [];
  try { pids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`${root}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`${root}/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) return { pid: Number(pid), name: read(`${root}/${pid}/comm`).trim() || null };
    }
  }
  return null;
}

async function listener(port, platform = process.platform) {
  port = Number(port);
  if (!(port > 0 && port < 65536)) return null;
  if (platform === 'win32') {
    const pid = parseNetstatListeners(await run('netstat', ['-ano', '-p', 'TCP']), port)[0];
    if (!pid) return null;
    return { pid, name: parseTasklistName(await run('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']), pid) };
  }
  if (platform === 'darwin') return parseLsofListener(await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']));
  return procListener(port);
}

/* Is any program listening on a TCP port on this computer: true, false, or
 * null when it cannot be told. Whether the user's own PAC from before
 * Shroudly is still served when it is put back (system-proxy.js, _pacGone).
 * Synchronous, for the restores that run while the app exits. Every user's
 * sockets, with no administrator's rights: netstat on Windows and macOS (lsof
 * shows only the user's own there), the kernel's tables on Linux. Any
 * address counts: in doubt, listening. A tool that printed no TCP line at
 * all said nothing. */
function parseBsdListening(out, port) {
  let any = false;
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (!/^tcp/.test(f[0]) || f.length < 6) continue;
    any = true;
    // tcp4  0  0  127.0.0.1.7890  *.*  LISTEN
    if (f[5] === 'LISTEN' && f[3].endsWith(`.${port}`)) return true;
  }
  return any ? false : null;
}

function procListening(port, root = '/proc') {
  let read = false;
  for (const table of ['tcp', 'tcp6']) {
    let text = '';
    try { text = fs.readFileSync(`${root}/net/${table}`, 'utf8'); read = true; } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 4 && f[3] === '0A' && parseInt((f[1].split(':')[1] || ''), 16) === port) return true;
    }
  }
  return read ? false : null;
}

function listeningSync(port, platform = process.platform) {
  port = Number(port);
  if (!(port > 0 && port < 65536)) return null;
  const runSync = (cmd, args) => String(execFileSync(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
  try {
    if (platform === 'win32') {
      const out = runSync('netstat', ['-ano']);
      if (!/^\s*TCP\s/m.test(out)) return null;
      return parseNetstatListeners(out, port).length > 0;
    }
    if (platform === 'darwin') return parseBsdListening(runSync('netstat', ['-an', '-p', 'tcp']), port);
    return procListening(port);
  } catch { return null; }
}

/* Does any of these processes hold a connection to one of these ports on
 * this computer? */
async function connectsTo(pids, ports, platform = process.platform) {
  const want = new Set((ports || []).map(Number).filter(Boolean));
  if (!want.size) return false;
  return (await connections(pids, platform)).some((r) => LOOPBACK.test(r.remote.host) && want.has(r.remote.port));
}

/* The program at the other end of one of Shroudly's own connections: the
 * process whose connection runs from local port `localPort` to `remotePort`
 * on this computer (an app's connection to the engine, the engine reporting
 * the app's port). { pid, name }, or null. Names the app behind a line about
 * a connection that could not get through (raw-apps.js). */
function parseNetstatOwner(out, localPort, remotePort) {
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 5) continue;
    const local = hostPort(f[1]);
    const remote = hostPort(f[2]);
    const pid = Number(f[f.length - 1]);
    if (local && remote && local.port === localPort && remote.port === remotePort && LOOPBACK.test(remote.host) && pid > 0) return pid;
  }
  return 0;
}

function parseLsofOwner(out, localPort, remotePort) {
  let pid = 0, name = null;
  for (const line of String(out || '').split(/\r?\n/)) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); name = null; }
    else if (line.startsWith('c')) name = line.slice(1);
    else if (line.startsWith('n') && line.includes('->')) {
      const [l, r] = line.slice(1).split('->').map(hostPort);
      if (l && r && l.port === localPort && r.port === remotePort && LOOPBACK.test(r.host) && pid > 0) return { pid, name };
    }
  }
  return null;
}

function procOwner(localPort, remotePort, root = '/proc') {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  let inode = null;
  for (const table of ['tcp', 'tcp6']) {
    for (const line of read(`${root}/net/${table}`).split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      if (parseInt((f[1].split(':')[1] || ''), 16) === localPort && parseInt((f[2].split(':')[1] || ''), 16) === remotePort) { inode = f[9]; break; }
    }
    if (inode) break;
  }
  if (!inode || inode === '0') return null;
  let pids = [];
  try { pids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`${root}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`${root}/${pid}/fd/${fd}`); } catch { continue; }
      if (link === `socket:[${inode}]`) return { pid: Number(pid), name: read(`${root}/${pid}/comm`).trim() || null };
    }
  }
  return null;
}

async function owner(localPort, remotePort, platform = process.platform) {
  localPort = Number(localPort); remotePort = Number(remotePort);
  if (!(localPort > 0 && localPort < 65536 && remotePort > 0 && remotePort < 65536)) return null;
  if (platform === 'win32') {
    const pid = parseNetstatOwner(await run('netstat', ['-ano', '-p', 'TCP'], 4000), localPort, remotePort);
    if (!pid) return null;
    return { pid, name: parseTasklistName(await run('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], 4000), pid) };
  }
  if (platform === 'darwin') return parseLsofOwner(await run('lsof', ['-nP', `-iTCP:${localPort}`, '-sTCP:ESTABLISHED', '-Fpcn'], 4000), localPort, remotePort);
  return procOwner(localPort, remotePort);
}

/* Connections from this computer to the addresses `want(host)` picks,
 * whoever holds them: [{ pid, name, remote }]. Programs that go around
 * Shroudly are seen by these (around-watch.js). Every state but listening:
 * a SYN that never got an answer counts, and so does a connection already
 * closed (TIME_WAIT), which a program that failed at once leaves behind for
 * a minute or two; that one belongs to no process any more (pid 0, name
 * null). Windows: netstat. Linux: the kernel's tables, a process for the
 * sockets this user may see (their own, where a bot or a tool runs).
 * macOS: [] (what they are looked for, Advanced mode, is not there). The
 * program's name as the system gives it: tasklist's; on Linux its file's
 * (/proc/<pid>/exe), else its main thread's (comm, which a program may
 * rename: Node.js calls it "node-MainThread"); null when it is gone. */
function parseNetstatAll(out) {
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 5) continue;
    const remote = hostPort(f[2]);
    const pid = Number(f[f.length - 1]);
    // A listening socket has no peer (port 0; the State column is translated).
    if (remote && remote.port > 0 && pid >= 0) rows.push({ pid, remote });
  }
  return rows;
}

function parseTasklistNames(out) {
  const names = new Map();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) names.set(Number(m[2]), m[1]);
  }
  return names;
}

function procOutbound(want, root = '/proc') {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const byInode = new Map();
  const closed = [];
  for (const table of ['tcp', 'tcp6']) {
    for (const line of read(`${root}/net/${table}`).split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      // 0A listening; inode 0: closed, no process holds it (TIME_WAIT)
      if (f.length < 10 || f[3] === '0A') continue;
      const [ip, port] = f[2].split(':');
      if (!ip || !port) continue;
      const remote = { host: ip.length === 8 ? v4(ip) : v6(ip), port: parseInt(port, 16) };
      if (!remote.port || !want(remote.host)) continue;
      if (f[9] === '0') closed.push({ pid: 0, name: null, remote });
      else byInode.set(f[9], remote);
    }
  }
  if (!byInode.size) return closed;
  let pids = [];
  try { pids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)); } catch { return closed; }
  const rows = closed;
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`${root}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`${root}/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m || !byInode.has(m[1])) continue;
      let name = null;
      try { name = path.basename(fs.readlinkSync(`${root}/${pid}/exe`)).replace(/ \(deleted\)$/, ''); } catch {}
      rows.push({ pid: Number(pid), name: name || read(`${root}/${pid}/comm`).trim() || null, remote: byInode.get(m[1]) });
    }
  }
  return rows;
}

async function outbound(want, platform = process.platform) {
  if (platform === 'win32') {
    const rows = parseNetstatAll(await run('netstat', ['-ano'])).filter((r) => want(r.remote.host));
    if (!rows.some((r) => r.pid > 0)) return rows.map((r) => ({ ...r, name: null }));
    const names = parseTasklistNames(await run('tasklist', ['/fo', 'csv', '/nh']));
    return rows.map((r) => ({ ...r, name: (r.pid > 0 && names.get(r.pid)) || null }));
  }
  if (platform === 'linux') return procOutbound(want);
  return [];
}

/* Ports proxy programs listen on by default: ByeDPI and other SOCKS tools
 * (1080, 1081, 1086, 1087), NekoBox (2080, 2081), Squid (3128), Clash and
 * its forks (7890, 7891, 7897), HTTP proxies (8080, 8118 Privoxy, 8888,
 * 8889), Tor (9050, 9150), v2rayN and similar (10808 to 10811), v2rayA
 * (20170 to 20172), Cloudflare WARP's proxy mode (40000). */
const PROXY_PORTS = [1080, 1081, 1086, 1087, 2080, 2081, 3128, 7890, 7891, 7897, 8080, 8118, 8888, 8889, 9050, 9150,
  10808, 10809, 10810, 10811, 20170, 20171, 20172, 40000];

/* Programs held by a proxy on this computer: from connection rows (netstat,
 * any state, so a SYN that never got an answer counts), the processes all of
 * whose connections stay on this computer and some of which go to a proxy
 * port that is not one of `ours`. Map pid -> [ports]. A program that reaches
 * anything elsewhere is not held by one. */
function heldLocally(rows, { ours = [], proxyPorts = PROXY_PORTS } = {}) {
  const want = new Set(proxyPorts);
  const own = new Set(ours.map(Number));
  const outside = new Set();
  const held = new Map();
  for (const r of rows || []) {
    if (!LOOPBACK.test(r.remote.host)) { outside.add(r.pid); continue; }
    if (!want.has(r.remote.port) || own.has(r.remote.port)) continue;
    if (!held.has(r.pid)) held.set(r.pid, new Set());
    held.get(r.pid).add(r.remote.port);
  }
  const out = new Map();
  for (const [pid, ports] of held) if (!outside.has(pid)) out.set(pid, [...ports]);
  return out;
}

module.exports = { LOOPBACK, PROXY_PORTS, heldLocally, owner, outbound, procOutbound, parseNetstatAll, parseTasklistNames, parseNetstatOwner, parseLsofOwner, procOwner, connectsTo, connections, listener, listeningSync, parseNetstat, parseNetstatListeners, parseTasklistName, parseLsofListener, parseBsdListening, procListener, procListening, parseLsof, parseSs, parseProcNet, procConnections };
