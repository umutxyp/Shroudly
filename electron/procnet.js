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
const { execFile } = require('child_process');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => resolve(err && !out ? '' : String(out || ''))));
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[?::1\]?|\[?::ffff:127\.\d+\.\d+\.\d+\]?)$/i;
function hostPort(s) {
  const m = /^(.*):(\d+)$/.exec(String(s || '').trim());
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
}

/* Lines of each tool, read into { pid, remote: { host, port } }. */
function parseNetstat(out) {
  const rows = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 5 || f[3] !== 'ESTABLISHED') continue;
    const remote = hostPort(f[2]);
    if (remote) rows.push({ pid: Number(f[4]), remote });
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

/* Does any of these processes hold a connection to one of these ports on
 * this computer? */
async function connectsTo(pids, ports, platform = process.platform) {
  const want = new Set((ports || []).map(Number).filter(Boolean));
  if (!want.size) return false;
  return (await connections(pids, platform)).some((r) => LOOPBACK.test(r.remote.host) && want.has(r.remote.port));
}

module.exports = { connectsTo, connections, parseNetstat, parseLsof, parseSs, parseProcNet, procConnections };
