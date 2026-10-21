'use strict';

/* The system proxy on a real Windows, against WinINET's own saves. It
 * changes this user's proxy setting and puts it back, so run it on CI only.
 *
 * WinINET keeps the proxy setting in a record of its own
 * (HKCU\...\Internet Settings\Connections\DefaultConnectionSettings) next to
 * the plain values Shroudly writes (AutoConfigURL), and writes both whenever
 * a program saves a proxy option through it (here: the flags, written back
 * as they are; Windows does the same on a network change). Whether such a
 * save could be what took Shroudly's PAC away seconds after a program
 * started or after a wake ("another program changed the system proxy
 * (AutoConfigURL)", issue #27): it is not. On this machine:
 *   1. Shroudly's PAC, set by electron/system-proxy.js: a save keeps it, and
 *      takes it into WinINET's record; the ownership check sees nothing
 *      taken over;
 *   2. Stop: the user's own setting back, and a save after it brings nothing
 *      of ours back (no dead PAC);
 *   3. a PAC address written by itself, then a save: kept, the same way.
 *
 *   node tests/lab/wininet-save.js */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const SystemProxy = require(path.join(ROOT, 'electron', 'system-proxy.js'));
const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));

if (process.platform !== 'win32') { console.log('wininet: Windows only'); process.exit(0); }

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
let n = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL wininet: ${m}`); throw new Error(m); } n++; console.log(`  ok  ${m}`); };
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8' });
const pac = () => { const m = /AutoConfigURL\s+REG_SZ\s+(\S*)/.exec(reg(['query', KEY, '/v', 'AutoConfigURL']).stdout || ''); return m ? m[1] : null; };
const blob = () => { const m = /DefaultConnectionSettings\s+REG_BINARY\s+([0-9A-F]*)/i.exec(reg(['query', `${KEY}\\Connections`, '/v', 'DefaultConnectionSettings']).stdout || ''); return m ? m[1] : null; };
/* The flags in WinINET's record (4: a PAC address in use). */
const recordFlags = (hex) => (hex ? Buffer.from(hex, 'hex').readUInt32LE(8) : 0);
/* The PAC address in WinINET's record: after the version, the counter, the
 * flags, the proxy server and the bypass list, each a length and its bytes.
 * WinINET keeps the text of an address that is no longer in use; only the
 * flag says whether it is. */
function recordPac(hex) {
  if (!hex) return null;
  const b = Buffer.from(hex, 'hex');
  try {
    let at = 12;
    const str = () => { const len = b.readUInt32LE(at); at += 4; const v = b.subarray(at, at + len).toString('latin1'); at += len; return v; };
    str(); str();
    return str();
  } catch { return null; }
}

/* A program saving the proxy setting through WinINET, changing nothing: the
 * flags read and written back, then the change announced. */
const SAVE = `
$src = @'
using System; using System.Runtime.InteropServices;
public static class WinInetSave {
  [StructLayout(LayoutKind.Sequential)] public struct Opt { public int dwOption; public IntPtr value; }
  [StructLayout(LayoutKind.Sequential)] public struct List { public int dwSize; public IntPtr pszConnection; public int dwOptionCount; public int dwOptionError; public IntPtr pOptions; }
  [DllImport("wininet.dll", SetLastError = true, EntryPoint = "InternetQueryOptionW")] static extern bool Query(IntPtr h, int o, ref List b, ref int l);
  [DllImport("wininet.dll", SetLastError = true, EntryPoint = "InternetSetOptionW")] static extern bool Set(IntPtr h, int o, ref List b, int l);
  [DllImport("wininet.dll", SetLastError = true, EntryPoint = "InternetSetOptionW")] static extern bool Notify(IntPtr h, int o, IntPtr b, int l);
  public static string Run() {
    IntPtr opts = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(Opt)));
    Opt o = new Opt(); o.dwOption = 1;
    Marshal.StructureToPtr(o, opts, false);
    List l = new List(); l.dwSize = Marshal.SizeOf(typeof(List)); l.dwOptionCount = 1; l.pOptions = opts;
    int len = l.dwSize;
    if (!Query(IntPtr.Zero, 75, ref l, ref len)) return "query failed " + Marshal.GetLastWin32Error();
    o = (Opt)Marshal.PtrToStructure(opts, typeof(Opt));
    if (!Set(IntPtr.Zero, 75, ref l, l.dwSize)) return "set failed " + Marshal.GetLastWin32Error();
    Notify(IntPtr.Zero, 39, IntPtr.Zero, 0);
    Notify(IntPtr.Zero, 37, IntPtr.Zero, 0);
    Marshal.FreeCoTaskMem(opts);
    return "saved, flags " + o.value.ToInt64();
  }
}
'@
Add-Type -TypeDefinition $src
[WinInetSave]::Run()`;
function winInetSave() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SAVE], { encoding: 'utf8', timeout: 120000, env: powershellEnv() });
  const out = `${r.stdout || ''}`.trim();
  if (!/^saved/m.test(out)) throw new Error(`WinINET save did not run: ${out} ${r.stderr || ''}`.slice(0, 400));
  return out;
}

(async () => {
  const before = { pac: pac(), blob: blob() };
  console.log(`  --  before: AutoConfigURL ${before.pac || '(none)'}; WinINET's record ${before.blob ? `${before.blob.length / 2} bytes` : '(none)'}`);
  const putBack = () => {
    if (before.blob) reg(['add', `${KEY}\\Connections`, '/v', 'DefaultConnectionSettings', '/t', 'REG_BINARY', '/d', before.blob, '/f']);
    if (before.pac) reg(['add', KEY, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', before.pac, '/f']);
    else reg(['delete', KEY, '/v', 'AutoConfigURL', '/f']);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-wininet-'));
  try {
    // A save first, so WinINET has a record of its own on a fresh runner.
    console.log(`  --  ${winInetSave()}`);
    ok(!!blob(), "WinINET has its record");

    // 1. Shroudly's PAC.
    const lines = [];
    const sp = new SystemProxy((l, m) => lines.push(`${l}: ${m}`), { platform: 'win32', stateFile: path.join(dir, 'proxy-state.json'), takeoverConfirmMs: 0, retakeLooksMs: [], ownershipIntervalMs: 600000 });
    const st = await sp.apply(10808, 'all');
    ok(st && st.ok && pac() === sp.pacUrl, `Shroudly's PAC is set (${sp.pacUrl})`);
    console.log(`  --  ${winInetSave()}`);
    ok(pac() === sp.pacUrl && recordPac(blob()) === sp.pacUrl && (recordFlags(blob()) & 4), 'a WinINET save (another program, a network change) keeps it, and takes it into its own record');
    const lost = await sp.checkOwnership();
    ok(Array.isArray(lost) && !lost.length && !lines.some((l) => /changed the system proxy/.test(l)), 'and nothing is taken for a takeover');
    // 2. Stop.
    await sp.restore();
    ok(pac() === before.pac, "Stop: the user's own setting back");
    console.log(`  --  ${winInetSave()}`);
    const flags = recordFlags(blob());
    ok(pac() === before.pac && (before.pac ? !SystemProxy.OUR_PAC.test(recordPac(blob()) || '') : !(flags & 4)),
      `and a WinINET save after it brings nothing of ours back: no PAC in use (flags ${flags}), no dead PAC`);
    // 3. Any PAC address written by itself.
    const other = 'http://127.0.0.1:1/another.pac';
    reg(['add', KEY, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', other, '/f']);
    console.log(`  --  ${winInetSave()}`);
    ok(pac() === other, 'a PAC address written by itself is kept by a save the same way: a save is not what takes it');
  } finally {
    putBack();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`wininet: ${n} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
