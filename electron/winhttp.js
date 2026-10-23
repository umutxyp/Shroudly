'use strict';

/*
 * Windows' WinHTTP proxy (netsh winhttp): the machine-wide proxy Windows
 * Update, the Microsoft Store, the system's own services and some programs
 * use, apart from the user's proxy settings. A proxy tool that set it
 * ("netsh winhttp import proxy source=ie") and has gone since leaves it
 * pointing at nothing on this computer, and all of those stop connecting.
 * Read from the registry, where netsh keeps it, without an administrator;
 * clearing it needs one ("netsh winhttp reset proxy", see main.js).
 *
 * WinHttpSettings (REG_BINARY): a little-endian DWORD at 8 holds the flags
 * (2: a proxy is set), the one at 12 the length of the proxy list that
 * follows at 16, ASCII ("127.0.0.1:1080", or one per scheme,
 * "http=127.0.0.1:8080;https=127.0.0.1:8080").
 */

const path = require('path');
const { execFile } = require('child_process');

const KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections';

/* "reg query" output -> the proxy list, '' for none, null when unreadable. */
function parse(out) {
  const m = /WinHttpSettings\s+REG_BINARY\s+([0-9a-f]+)/i.exec(String(out || ''));
  if (!m || m[1].length % 2) return null;
  const b = Buffer.from(m[1], 'hex');
  if (b.length < 16) return null;
  if (!(b.readUInt32LE(8) & 2)) return '';
  const len = b.readUInt32LE(12);
  if (len > 4096 || 16 + len > b.length) return null;
  return b.slice(16, 16 + len).toString('latin1').trim();
}

/* "127.0.0.1:1080" or "http=127.0.0.1:8080;https=..." -> [{ host, port }]. */
function servers(list) {
  return String(list || '').split(';').map((p) => p.trim().replace(/^[a-z]+=/i, '')).filter(Boolean).map((hp) => {
    const m = /^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^:\s]+):(\d+)$/i.exec(hp);
    return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : { host: hp, port: 0 };
  });
}

const LOOP = (h) => /^127\./.test(h) || h === 'localhost' || h === '::1';

/* The proxy list when every server in it is on this computer and none is
 * listening (listening: port -> true / false / null when unknown), else
 * null. */
function goneList(list, listening) {
  const all = servers(list);
  if (!all.length || !all.every((s) => LOOP(String(s.host).toLowerCase()) && s.port > 0)) return null;
  for (const s of all) {
    let on = null;
    try { on = listening(s.port); } catch {}
    if (on !== false) return null;
  }
  return list;
}

function regExe() { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'); }

/* The proxy list as Windows has it now ('' none), or null. */
function read() {
  return new Promise((resolve) => execFile(regExe(), ['query', KEY, '/v', 'WinHttpSettings'], { windowsHide: true, timeout: 8000 },
    (err, out) => resolve(err ? null : parse(out))));
}

/* "netsh winhttp reset proxy" as an administrator: Windows asks the user.
 * Resolves true once the setting reads as none again. */
async function reset() {
  const ps = "Start-Process -FilePath netsh.exe -ArgumentList 'winhttp','reset','proxy' -Verb RunAs -WindowStyle Hidden -Wait";
  await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 120000 }, () => resolve()));
  return (await read()) === '';
}

module.exports = { KEY, parse, servers, goneList, read, reset };
