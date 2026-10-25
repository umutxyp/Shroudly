'use strict';

/*
 * Another program already doing Shroudly's job.
 *
 * Shroudly's Advanced mode changes the first packets of a connection, through
 * the one place each system has for it: WinDivert on Windows, NFQUEUE on
 * Linux. Other programs do the same thing the same way. When two of them run
 * at once they undo each other: the first changes a packet, the second changes
 * what the first produced, and the server is sent nonsense. Nothing fails
 * loudly — Advanced mode reports itself active, its counters go up, and the
 * sites still do not open. A user can lose a day to it (a reporter did: with
 * GoodbyeDPI left running, Discord would not open however Shroudly was set;
 * turning GoodbyeDPI off fixed it at once).
 *
 * Worse, Shroudly could then draw the wrong conclusion. When a service's
 * addresses do not answer, it tells the user the network blocks those
 * addresses and only a VPN gets around it — true when the network really does
 * that, and misleading when the real cause is sitting on the same machine.
 *
 * So, before saying anything of the sort, and whenever Advanced mode starts,
 * Shroudly looks for such a program and names it. The check reads the list of
 * running processes, which needs no privileges on any system, and matches
 * names only: it never reads another program's memory, files or traffic. It
 * reports; it never stops or changes anything of theirs — which of the two to
 * keep is the user's choice.
 *
 *   Windows  tasklist
 *   Linux    /proc/<pid>/comm
 *   macOS    ps
 */

const fs = require('fs');
const { execFile } = require('child_process');

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
    (err, out) => resolve(err && !out ? '' : String(out || ''))));
}

/*
 * Programs that change the same packets Shroudly's Advanced mode does, by the
 * same system facility. Matched on the program's own name, exactly, so an
 * unrelated program whose name merely contains one of these is not named.
 * Shroudly's own engines are never in this list.
 */
const PACKET_TOOLS = [
  { re: /^goodbyedpi$/i,            name: 'GoodbyeDPI' },
  { re: /^winws$/i,                 name: 'zapret (winws)' },
  { re: /^nfqws$/i,                 name: 'zapret (nfqws)' },
  { re: /^tpws$/i,                  name: 'zapret (tpws)' },
  { re: /^(byedpi|ciadpi)$/i,       name: 'ByeDPI' },
  { re: /^spoofdpi$/i,              name: 'SpoofDPI' },
  { re: /^greentunnel$/i,           name: 'GreenTunnel' },
  { re: /^powertunnel(-desktop)?$/i, name: 'PowerTunnel' },
  { re: /^zapret$/i,                name: 'zapret' },
  { re: /^dpitunnel(-cli)?$/i,      name: 'DPITunnel' },
  { re: /^geneva$/i,                name: 'Geneva' },
];

/* Our own, never reported as a rival. */
const OURS = /^shroudly(-core(-adv)?)?$/i;

/* A program name as the systems give it, reduced to the bare name: no
 * directory, no .exe, and (macOS) no trailing arguments. */
function bare(s) {
  let n = String(s || '').trim();
  if (!n) return '';
  n = n.split(/[\\/]/).pop();
  return n.replace(/\.exe$/i, '');
}

/* tasklist's CSV, one row per process: "name.exe","pid",... */
function namesFromTasklist(out) {
  const names = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(bare(m[1]));
  }
  return names;
}

/* `ps -axo comm=`: one path or name per line. */
function namesFromPs(out) {
  return String(out || '').split(/\r?\n/).map((l) => bare(l)).filter(Boolean);
}

/* Linux: every /proc/<pid>/comm. Unreadable ones (another user's) are skipped;
 * a rival of ours runs as this user or as root, and root's comm is readable. */
function namesFromProc(root = '/proc') {
  const names = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return names; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try { names.push(bare(fs.readFileSync(`${root}/${d}/comm`, 'utf8'))); } catch {}
  }
  return names;
}

/* The rival names among a list of running program names, each once, in the
 * order the list gives them. */
function match(names, tools = PACKET_TOOLS) {
  const found = [];
  for (const n of names || []) {
    if (!n || OURS.test(n)) continue;
    for (const t of tools) {
      if (t.re.test(n) && !found.includes(t.name)) found.push(t.name);
    }
  }
  return found;
}

/* The names of packet-level tools running beside Shroudly right now, or [].
 * Never throws: a system that will not list its processes simply reports none. */
async function running(platform = process.platform, deps = {}) {
  const exec = deps.run || run;
  try {
    if (platform === 'win32') return match(namesFromTasklist(await exec('tasklist', ['/fo', 'csv', '/nh'])));
    if (platform === 'linux') return match(deps.procNames ? deps.procNames() : namesFromProc(deps.procRoot || '/proc'));
    if (platform === 'darwin') return match(namesFromPs(await exec('ps', ['-axo', 'comm='])));
  } catch {}
  return [];
}

module.exports = { running, match, bare, namesFromTasklist, namesFromPs, namesFromProc, PACKET_TOOLS, OURS };
