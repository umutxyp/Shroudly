'use strict';

/*
 * Which programs use Shroudly right now: whether given processes hold a
 * connection to one of Shroudly's local ports (the system proxy, the program
 * proxy, Discord's relay). A program that runs but holds none is not going
 * through Shroudly, whatever its settings say; the autopilot restarts such a
 * program when it is stuck and safe to restart (autopilot.js).
 *
 * One system tool per question, the one each system has: netstat on Windows,
 * lsof on macOS, ss on Linux. Each answers in well under a second.
 */

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

async function connections(pids, platform = process.platform) {
  const list = [...new Set((pids || []).map(Number).filter((p) => p > 0))];
  if (!list.length) return [];
  let rows = [];
  if (platform === 'win32') rows = parseNetstat(await run('netstat', ['-ano', '-p', 'TCP']));
  else if (platform === 'darwin') rows = parseLsof(await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:ESTABLISHED', '-Fn', '-p', list.join(',')]));
  else rows = parseSs(await run('ss', ['-Htnp', 'state', 'established']));
  return rows.filter((r) => list.includes(r.pid));
}

/* Does any of these processes hold a connection to one of these ports on
 * this computer? */
async function connectsTo(pids, ports, platform = process.platform) {
  const want = new Set((ports || []).map(Number).filter(Boolean));
  if (!want.size) return false;
  return (await connections(pids, platform)).some((r) => LOOPBACK.test(r.remote.host) && want.has(r.remote.port));
}

module.exports = { connectsTo, connections, parseNetstat, parseLsof, parseSs };
