'use strict';

/* Memory of a process and everything it started, the way each OS itself
 * reports what a program costs: the physical footprint on macOS (Activity
 * Monitor's "Memory"), the private working set on Windows (Task Manager's
 * "Memory"). Linux has no single figure; the closest is the process's own
 * memory, PSS without the file-backed part (the Electron binary and shared
 * libraries, which the other two leave out as well). */

const fs = require('fs');
const { execFile } = require('child_process');

// Asynchronous on purpose: a measurement can take a minute on a slow machine
// (Windows on ARM) and the test's own timers must keep running meanwhile.
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 }, (err, stdout) => resolve(stdout || ''));
  });
}

async function processTable() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"]);
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, ...c] = l.split('\t'); return { pid: +pid, ppid: +ppid, cmd: c.join('\t') }; });
  }
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  return out.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null;
  }).filter(Boolean);
}

async function tree(rootPid) {
  const all = await processTable();
  const keep = new Map();
  const add = (pid) => {
    const p = all.find((x) => x.pid === pid);
    if (!p || keep.has(pid)) return;
    keep.set(pid, p);
    for (const c of all) if (c.ppid === pid) add(c.pid);
  };
  add(rootPid);
  return [...keep.values()];
}

function kindOf(cmd) {
  const t = /--type=([a-z-]+)/.exec(cmd);
  const sub = /--utility-sub-type=([\w.]+)/.exec(cmd);
  if (t) return sub ? `${t[1]}:${sub[1].split('.').slice(-2).join('.')}` : t[1];
  if (/--watchdog/.test(cmd)) return 'watchdog';
  if (/shroudly-core/.test(cmd)) return 'engine';
  return 'main';
}

async function memoryMB(pids) {
  const out = {};
  if (process.platform === 'darwin') {
    for (const pid of pids) {
      const m = /Footprint:\s*([\d.]+)\s*([KMG])B/.exec(await run('footprint', ['-p', String(pid)]));
      if (m) out[pid] = Number(m[1]) * (m[2] === 'K' ? 1 / 1024 : m[2] === 'G' ? 1024 : 1);
    }
  } else if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const txt = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
        const kb = (k) => Number((new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(txt) || [])[1] || 0);
        const own = txt.includes('Pss_Anon:') ? kb('Pss_Anon') + kb('Pss_Shmem') : kb('Pss') - kb('Pss_File');
        if (txt.includes('Pss:')) out[pid] = (own + kb('SwapPss')) / 1024;
      } catch {}
    }
  } else {
    const list = pids.join(',');
    const txt = await run('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { @(${list}) -contains $_.IDProcess } | ForEach-Object { "$($_.IDProcess)\`t$($_.WorkingSetPrivate)" }`]);
    for (const l of txt.split(/\r?\n/)) {
      const [pid, bytes] = l.split('\t');
      if (pid && bytes) out[+pid] = Number(bytes) / (1024 * 1024);
    }
  }
  return out;
}

/* What Chromium itself says each of its processes is (app.getAppMetrics()):
 * a sandboxed process's command line cannot always be read (Windows on ARM). */
const TYPES = { Browser: 'main', Tab: 'renderer', GPU: 'gpu-process', Zygote: 'zygote', Utility: 'utility' };
function chromiumKind(m) {
  const base = TYPES[m.type] || String(m.type || '').toLowerCase();
  return base === 'utility' && m.name ? `utility:${m.name.split('.').slice(-2).join('.')}` : base;
}

/* { total, parts: [{ kind, mb }], kinds: Set } for rootPid and its children.
 * metrics: app.getAppMetrics() as [{ pid, type, name }], when available. */
async function measure(rootPid, metrics = []) {
  const procs = await tree(rootPid);
  const known = new Map(metrics.map((m) => [m.pid, chromiumKind(m)]));
  for (const m of metrics) if (!procs.some((p) => p.pid === m.pid)) procs.push({ pid: m.pid, cmd: '' });
  const mem = await memoryMB(procs.map((p) => p.pid));
  const parts = procs.map((p) => ({ pid: p.pid, kind: known.get(p.pid) || kindOf(p.cmd), mb: mem[p.pid] || 0 }));
  const total = parts.reduce((s, p) => s + p.mb, 0);
  return { total, parts, kinds: new Set(parts.map((p) => p.kind)) };
}

function describe(label, m) {
  const parts = m.parts.filter((p) => p.mb > 0).sort((a, b) => b.mb - a.mb)
    .map((p) => `${p.kind} ${p.mb.toFixed(1)}`).join(', ');
  return `${label}: ${m.total.toFixed(1)} MB  (${parts})`;
}

module.exports = { measure, describe, tree };
