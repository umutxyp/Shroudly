'use strict';

/* Microsoft Store apps and Shroudly's loopback proxy, on a real Windows
 * (issue #26). Needs an administrator without a UAC prompt, as CI's Windows
 * runners are; it changes loopback exemptions, so run it on CI only.
 *
 * An app container of our own (the sandbox UWP apps run in, with the
 * internetClient capability, as a Store app has) runs Windows' curl.exe:
 *   1. without a loopback exemption it reaches the internet but not a server
 *      on 127.0.0.1, nor the engine's SOCKS port there: what a Store app gets
 *      from Shroudly's PAC (the cause of issue #26);
 *   2. electron/store-apps.js finds that container among the firewall's,
 *      with its capability, and its SID is the one it derives from the name;
 *      a standard user's token (runas /trustlevel) reads the same lists, as
 *      Shroudly does without administrator rights;
 *   3. its elevated step exempts it, from a TEMP whose path has quotes of
 *      every kind in it, deleting its list as it reads it; CheckNetIsolation
 *      lists it, and the same curl now reaches both: the fix;
 *   4. the autopilot's whole round on this machine: each program in a
 *      package or an app container, from its token, and the decision taken
 *      here now (Windows Terminal, a desktop program in a package, is no
 *      sign); with no Store app in use it asks nothing; a program with a
 *      window in the lab's app container is seen as one, and then
 *      everything it exempts is remembered (settings and HKCU\Software\
 *      Shroudly, one value per SID), an exemption that was there before is
 *      not; the switch turned off takes out its own only, and so does the
 *      uninstaller's script (scripts/installer.nsh), from 32-bit PowerShell
 *      as NSIS starts it, with the record in both forms and longer than NSIS
 *      could read.
 *
 *   node tests/lab/uwp-loopback.js */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const StoreApps = require(path.join(ROOT, 'electron', 'store-apps.js'));
const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
const { startEngine, freePort } = require(path.join(ROOT, 'tests', 'net', 'helpers.js'));

let fails = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); fails++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const SYS = process.env.SystemRoot || 'C:\\Windows';
const CURL = path.join(SYS, 'System32', 'curl.exe');
const CNI = path.join(SYS, 'System32', 'CheckNetIsolation.exe');
// Package-family-shaped names, so the app's own rules treat them as apps.
const OURS = 'Shroudly.LoopbackLab_0123456789abc';
const USERS = 'Shroudly.UsersOwnLab_0123456789abc';

/* A process in an app container: CreateAppContainerProfile (internetClient),
 * then CreateProcess with SECURITY_CAPABILITIES, as Windows starts a UWP
 * app. curl's output comes through our own handles. */
const LAB_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AcLab {
  [StructLayout(LayoutKind.Sequential)] public struct SidAttr { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct SecCaps { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct ProcInfo { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, SidAttr[] caps, int count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref StartupInfoEx si, out ProcInfo pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static IntPtr Cap() { IntPtr c; if (!ConvertStringSidToSid("S-1-15-3-1", out c)) throw new Exception("capability sid"); return c; }
  static IntPtr Profile(string name) {
    SidAttr[] caps = new SidAttr[] { new SidAttr { Sid = Cap(), Attributes = 4 } };
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "Shroudly loopback lab", caps, 1, out sid);
    if (hr != 0) { int hr2 = DeriveAppContainerSidFromAppContainerName(name, out sid); if (hr2 != 0) throw new Exception("profile 0x" + hr.ToString("x8") + " / 0x" + hr2.ToString("x8")); }
    return sid;
  }
  public static string Create(string name) {
    IntPtr s; if (!ConvertSidToStringSid(Profile(name), out s)) return "";
    try { return Marshal.PtrToStringUni(s); } finally { LocalFree(s); }
  }
  public static int Delete(string name) { return DeleteAppContainerProfile(name); }
  public static int Run(string name, string exe, string args, int ms) {
    IntPtr sid = Profile(name);
    int saSize = Marshal.SizeOf(typeof(SidAttr));
    IntPtr capPtr = Marshal.AllocHGlobal(saSize);
    Marshal.StructureToPtr(new SidAttr { Sid = Cap(), Attributes = 4 }, capPtr, false);
    SecCaps sc = new SecCaps { AppContainerSid = sid, Capabilities = capPtr, CapabilityCount = 1, Reserved = 0 };
    int scSize = Marshal.SizeOf(typeof(SecCaps));
    IntPtr scPtr = Marshal.AllocHGlobal(scSize);
    Marshal.StructureToPtr(sc, scPtr, false);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Exception("attribute list " + Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020009, scPtr, (IntPtr)scSize, IntPtr.Zero, IntPtr.Zero)) throw new Exception("security capabilities " + Marshal.GetLastWin32Error());
    StartupInfoEx si = new StartupInfoEx();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
    si.StartupInfo.dwFlags = 0x100;
    si.StartupInfo.hStdInput = IntPtr.Zero;
    si.StartupInfo.hStdOutput = GetStdHandle(-11);
    si.StartupInfo.hStdError = GetStdHandle(-12);
    si.lpAttributeList = list;
    ProcInfo pi;
    StringBuilder cmd = new StringBuilder("\\"" + exe + "\\" " + args);
    if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x08000000, IntPtr.Zero, Environment.SystemDirectory, ref si, out pi))
      throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
    try {
      if (WaitForSingleObject(pi.hProcess, (uint)ms) != 0) { TerminateProcess(pi.hProcess, 999); return 999; }
      uint code; GetExitCodeProcess(pi.hProcess, out code); return (int)code;
    } finally {
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(scPtr); Marshal.FreeHGlobal(capPtr);
    }
  }
  // A program with a window in the app container, left running: its process id.
  public static int Start(string name, string exe) {
    IntPtr sid = Profile(name);
    int saSize = Marshal.SizeOf(typeof(SidAttr));
    IntPtr capPtr = Marshal.AllocHGlobal(saSize);
    Marshal.StructureToPtr(new SidAttr { Sid = Cap(), Attributes = 4 }, capPtr, false);
    SecCaps sc = new SecCaps { AppContainerSid = sid, Capabilities = capPtr, CapabilityCount = 1, Reserved = 0 };
    int scSize = Marshal.SizeOf(typeof(SecCaps));
    IntPtr scPtr = Marshal.AllocHGlobal(scSize);
    Marshal.StructureToPtr(sc, scPtr, false);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Exception("attribute list " + Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020009, scPtr, (IntPtr)scSize, IntPtr.Zero, IntPtr.Zero)) throw new Exception("security capabilities " + Marshal.GetLastWin32Error());
    StartupInfoEx si = new StartupInfoEx();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
    si.lpAttributeList = list;
    ProcInfo pi;
    StringBuilder cmd = new StringBuilder("\\"" + exe + "\\"");
    try {
      if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, Environment.SystemDirectory, ref si, out pi))
        throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      return pi.dwProcessId;
    } finally {
      DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(scPtr); Marshal.FreeHGlobal(capPtr);
    }
  }
}`;

/* The server curl fetches from, in a process of its own: this one runs
 * curl and PowerShell synchronously, which stops its own event loop, so a
 * server in it would never answer while curl waits for it. */
function startServer() {
  const code = "const s = require('http').createServer((q, r) => r.end('shroudly-lab'));"
    + "s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));"
    + "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();";
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/PORT (\d+)/);
      if (m) resolve({ port: Number(m[1]), stop: () => { try { p.stdin.end(); } catch {} try { p.kill(); } catch {} } });
    });
    p.on('exit', (c) => reject(new Error(`the server exited (${c})`)));
    setTimeout(() => reject(new Error('the server did not start')), 15000);
  });
}

function ps(script, env = {}, timeout = 120000) {
  const full = `$ErrorActionPreference = 'Stop'\n${script}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout, env: { ...powershellEnv(), ...env } });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/* A script run with a standard user's rights (a Basic User token: the
 * Administrators group deny-only), as Shroudly runs; its output, or null. */
async function asStandardUser(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-basic-'));
  const out = path.join(dir, 'out.txt');
  const ps1 = path.join(dir, 'run.ps1');
  fs.writeFileSync(ps1, `try { & {\n${body}\n} *>&1 | Out-File -Encoding utf8 -LiteralPath '${out}' } finally { 'done' | Out-File -LiteralPath '${out}.done' }\n`);
  spawnSync('runas', ['/trustlevel:0x20000', `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${ps1}`], { stdio: 'ignore', timeout: 30000 });
  for (let i = 0; i < 120 && !fs.existsSync(`${out}.done`); i++) await new Promise((r) => setTimeout(r, 1000));
  try { return fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; } finally { setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000).unref(); }
}

const lab = (call, env) => ps(`Add-Type -TypeDefinition @'\n${LAB_CS}\n'@\n${call}`, env);

/* curl in the app container: its exit code (0 fine, 7 could not connect,
 * 28 timed out, 97 the proxy refused, 999 killed). What it fetches goes to
 * our own output (an app container may not open NUL). */
function inContainer(name, args) {
  const r = lab("$c = [AcLab]::Run($env:LAB_NAME, $env:LAB_EXE, $env:LAB_ARGS, 30000); [Console]::Out.WriteLine('EXIT ' + $c)",
    { LAB_NAME: name, LAB_EXE: CURL, LAB_ARGS: args });
  const m = r.out.match(/EXIT (-?\d+)\s*$/);
  if (!m) console.log(`      (lab: ${r.code} ${r.err.trim().slice(0, 300)})`);
  return m ? Number(m[1]) : null;
}

function outside(args) {
  return spawnSync(CURL, args.split(' '), { encoding: 'utf8', timeout: 30000 }).status;
}

function cni(...args) {
  const r = spawnSync(CNI, ['LoopbackExempt', ...args], { encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: String(r.stdout || '') };
}

const exemptNow = () => new Set(StoreApps.parseExemptList(cni('-s').out));

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), m };
}

/* The uninstaller's record, both forms (one value per SID; the single value of before). */
function regRecord() {
  const r = spawnSync('reg.exe', ['query', StoreApps.RECORD_KEY, '/s'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? StoreApps.parseRecord(r.stdout) : [];
}

const regHas = (...args) => spawnSync('reg.exe', ['query', ...args], { stdio: 'ignore' }).status === 0;

/* The uninstaller's command, out of scripts/installer.nsh as NSIS runs it. */
function uninstallerScript() {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8');
  const m = [...nsh.matchAll(/nsExec::Exec `powershell (.*?) -Command "(.*?)"`/gs)].find((x) => /LoopbackExempt/.test(x[2]));
  return m ? m[2].replace(/\$\$/g, '$') : null;
}

(async () => {
  if (process.platform !== 'win32') { console.log('uwp-loopback: skipped (Windows only)'); return; }
  if (spawnSync('net', ['session'], { stdio: 'ignore' }).status !== 0) { console.log('uwp-loopback: skipped (needs an administrator)'); return; }
  if (!fs.existsSync(CURL)) { console.log('uwp-loopback: skipped (no curl.exe in System32)'); return; }

  const fw = ps("Get-NetFirewallProfile | ForEach-Object { $_.Name + '=' + $_.Enabled }");
  console.log(`  ..  Windows ${os.release()}, firewall: ${fw.out.trim().split(/\r?\n/).join(' ') || fw.err.trim().slice(0, 120)}`);

  const server = await startServer();
  const port = server.port;
  let engine = null;
  const socksPort = await freePort();
  try { engine = await startEngine(socksPort); } catch (e) { console.log(`  ..  engine not started (${e.message}); the SOCKS checks are left out`); }

  const sidOurs = lab('[Console]::Out.WriteLine([AcLab]::Create($env:LAB_NAME))', { LAB_NAME: OURS }).out.trim();
  const sidUsers = lab('[Console]::Out.WriteLine([AcLab]::Create($env:LAB_NAME))', { LAB_NAME: USERS }).out.trim();
  try {
    check(StoreApps.SID_RE.test(sidOurs) && sidOurs === StoreApps.containerSid(OURS),
      `the app container SID Windows gives is the one store-apps.js derives from the name (${sidOurs})`);
    cni('-d', `-p=${sidOurs}`);
    cni('-d', `-p=${sidUsers}`);

    // ── 1. the cause ──
    const url = `http://127.0.0.1:${port}/`;
    check(outside(`-s -o NUL -m 10 ${url}`) === 0, 'outside a container, curl reaches the server on 127.0.0.1');
    const inet = inContainer(OURS, '-s -S -m 20 http://www.msftconnecttest.com/connecttest.txt');
    check(inet === 0, `in the app container, curl reaches the internet (exit ${inet})`);
    const loop = inContainer(OURS, `-s -S -m 10 --connect-timeout 8 ${url}`);
    if (loop === 0) {
      // Network isolation off on this machine: nothing here can show it.
      console.log('  ..  loopback is not blocked for app containers on this machine; the rest cannot be shown here');
      return;
    }
    check(loop !== null && loop !== 0, `without an exemption it cannot reach 127.0.0.1 (curl exit ${loop}): the cause of #26`);
    if (engine) {
      const viaSocks = inContainer(OURS, `-s -S -m 15 --connect-timeout 8 --socks5-hostname 127.0.0.1:${socksPort} http://example.com/`);
      check(viaSocks !== 0, `…nor Shroudly's SOCKS port, which the PAC hands it (curl exit ${viaSocks})`);
    }

    // ── 2. what store-apps.js reads ──
    const sa = new StoreApps({ store: memStore(), platform: 'win32', protectionOn: () => true });
    const scan = await sa.scan();
    check(!!scan && scan.source === 'firewall', `the firewall's list is read (${scan && scan.source}, ${scan && scan.containers.length} app containers, ${scan && scan.exempt.length} exempt)`);
    const mine = scan && scan.containers.find((c) => c.sid === sidOurs);
    check(!!mine && /^shroudly\.loopbacklab_/i.test(mine.name) && mine.caps.includes('S-1-15-3-1'), `the lab's container is in it, with internetClient (${mine && mine.caps.join(',')})`);
    check(!!mine && StoreApps.candidates(scan).some((c) => c.sid === sidOurs), '…and it is one that needs an exemption');
    const reg = spawnSync('reg.exe', ['query', StoreApps.MAPPINGS_KEY, '/s'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const mapped = StoreApps.parseMappings(reg.stdout);
    check(mapped.some((c) => c.sid === sidOurs), `the registry fallback finds it too (${mapped.length} mappings)`);
    const wrong = mapped.filter((c) => StoreApps.isPackage(c.name) && StoreApps.containerSid(c.name) !== c.sid);
    check(!wrong.length, `every package's SID in the registry is the derived one (${mapped.length - wrong.length} checked${wrong.length ? `; not: ${wrong.slice(0, 2).map((c) => c.name).join(', ')}` : ''})`);

    // ── 3. the fix ──
    // From a TEMP with every kind of quote in its path (a user named
    // D’Angelo O'Brien): the path reaches the elevated script as base64.
    const oddTmp = fs.mkdtempSync(path.join(os.tmpdir(), "shroudly lab D\u2019Angelo O'Brien $x \u2018y\u201B "));
    let listLeft = null;
    const realRun = sa.run;
    const fix = new StoreApps({ store: memStore(), platform: 'win32', protectionOn: () => true, tmpdir: oddTmp,
      run: async (c, a, ms) => {
        const x = await realRun(c, a, ms);
        // Right after the prompt, before Shroudly's own clean-up: the elevated script deleted it.
        if (ms === StoreApps.ELEVATE_TIMEOUT_MS) listLeft = fs.readdirSync(oddTmp).filter((n) => n.endsWith('.txt'));
        return x;
      } });
    const r = await fix._elevate('add', [sidOurs]);
    check(r.code === 'ok', `the elevated step ran, its list in ${oddTmp} (${JSON.stringify(r)})`);
    check(exemptNow().has(sidOurs), 'CheckNetIsolation lists the lab container as exempt');
    check(Array.isArray(listLeft) && !listLeft.length, `the elevated script deleted its list as it read it (${listLeft && listLeft.join(', ')})`);
    fs.rmSync(oddTmp, { recursive: true, force: true });
    const after = await sa.scan();
    check(!!after && after.exempt.includes(sidOurs), 'the firewall list says so too');
    // The same lists, read the way Shroudly reads them: without administrator rights.
    const plain = await asStandardUser([
      "'ADMIN=' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')",
      StoreApps.SCAN_PS.replace(/foreach \(\$l in \[ShroudlyNetIso\]::Run\(\)\) \{[^\n]*\}/, '[ShroudlyNetIso]::Run()'),
      "'---'",
      "& (Join-Path $env:SystemRoot 'System32\\CheckNetIsolation.exe') LoopbackExempt -s",
      "'---'",
      "& (Join-Path $env:SystemRoot 'System32\\whoami.exe') /groups /fo csv /nh",
    ].join('\n'));
    if (plain === null || !/ADMIN=False/.test(plain)) {
      console.log(`  ..  a standard user's token could not be had here (${plain === null ? 'no output' : plain.split(/\r?\n/)[0]}); left out`);
    } else {
      const [apiPart, cniPart, whoPart] = plain.split(/^---\s*$/m);
      const std = StoreApps.parseScan(apiPart);
      check(!std.errors.length && std.containers.some((c) => c.sid === sidOurs) && std.exempt.includes(sidOurs),
        `without administrator rights the firewall's lists read the same (${std.containers.length} app containers, ${std.exempt.length} exempt${std.errors.length ? `; errors: ${std.errors.join(', ')}` : ''})`);
      check(StoreApps.parseExemptList(cniPart).includes(sidOurs), '…and so does CheckNetIsolation\'s');
      // An administrator under UAC (the group for deny only, as here) can
      // say Yes to a prompt: asked by itself like any administrator.
      check(StoreApps.hasAdministrators(whoPart || ''), 'whoami with that token still shows the Administrators group (deny only): such an account is asked');
      if (std.errors.length || !std.containers.length) console.log(`      ${apiPart.trim().split(/\r?\n/).slice(0, 6).join('\n      ')}`);
    }
    const loop2 = inContainer(OURS, `-s -S -m 10 --connect-timeout 8 ${url}`);
    check(loop2 === 0, `with the exemption it reaches 127.0.0.1 (curl exit ${loop2})`);
    if (engine) {
      const viaSocks2 = inContainer(OURS, `-s -S -m 20 --connect-timeout 8 --socks5-hostname 127.0.0.1:${socksPort} http://example.com/`);
      check(viaSocks2 === 0, `…and goes through Shroudly's SOCKS port (curl exit ${viaSocks2})`);
    }
    cni('-d', `-p=${sidOurs}`);

    // ── 4. the autopilot's round ──
    cni('-a', `-p=${sidUsers}`);     // the user's own, from before
    // What it reads to know a Store app is in use: the programs of this
    // session in a package or an app container, each from its own token.
    const tl = spawnSync(path.join(SYS, 'System32', 'tasklist.exe'), ['/apps', '/fi', `USERNAME eq ${process.env.USERNAME}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 30000 });
    console.log(`  ..  tasklist /apps for this account: exit ${tl.status}, packaged programs running besides Windows' own: ${StoreApps.runningFamilies(tl.stdout).join(', ') || 'none'}${tl.status ? ` (${String(tl.stderr || tl.stdout).trim().slice(0, 120)})` : ''}`);
    const procsNow = () => {
      const r = ps(StoreApps.PROCS_PS.replace(/^\$ErrorActionPreference = 'Stop'\n/, ''));
      return r.code === 0 ? StoreApps.parseProcs(r.out) : null;
    };
    const showProcs = (list) => {
      for (const p of list) console.log(`      ${p.name} (${p.pid}): window ${p.window ? 'yes' : 'no'}, app container ${p.appContainer ? `yes ${p.sid}` : 'no'}, package ${p.family || '-'}`);
    };
    const procs0 = procsNow();
    check(Array.isArray(procs0), `the programs in a package or an app container are read from their tokens (${procs0 ? procs0.length : 'could not be'})`);
    if (procs0) showProcs(procs0);
    // The decision Shroudly makes on this runner right now, with what it
    // really detects (nothing stood in).
    const real = new StoreApps({ store: memStore(), platform: 'win32', protectionOn: () => true });
    const signs = await real.runningApps();
    const nowScan = await real.scan();
    const needNow = nowScan ? StoreApps.candidates(nowScan) : [];
    const hit = signs ? needNow.filter((c) => signs.has(c.sid)) : [];
    const decision = !signs ? 'not asked: the programs could not be looked at'
      : hit.length ? `ask: ${hit.map((c) => c.name).join(', ')} in use and without an exemption`
        : signs.size ? `not asked: what is in use (${[...signs].join(', ')}) needs no exemption` : 'not asked: no Store app in use (no program in an app container with a window, none called on by a desktop Store app)';
    console.log(`  ..  the decision here now: ${decision}; ${needNow.length} app containers would need an exemption`);
    const term = (procs0 || []).find((p) => /^microsoft\.windowsterminal/.test(p.family));
    if (term) {
      const tsid = StoreApps.containerSid(term.family);
      console.log(`  ..  Windows Terminal: app container ${term.appContainer ? 'yes' : 'no'}; its package's container ${tsid} ${needNow.some((c) => c.sid === tsid) ? 'is' : 'is not'} among those that need an exemption`);
      check(!term.appContainer && !(signs && signs.has(tsid)), 'Windows Terminal, a desktop program in a package, is no sign of a Store app in use');
    }
    const probe = new StoreApps({ store: memStore(), platform: 'win32' });
    check((await probe.canConsent()) === true, 'this administrator can say Yes');
    const store = memStore();
    const told = [];
    const ap = new StoreApps({ store, platform: 'win32', protectionOn: () => true, tell: (id) => told.push(id), log: (l, m) => console.log(`      [${l}] ${m}`) });
    const before = exemptNow();
    if (signs && !hit.length) {
      const idle = await ap.survey();
      const same = exemptNow();
      check(idle.why === 'idle' && !idle.asked && !told.length && same.size === before.size && [...before].every((s) => same.has(s)), `no Store app in use: nothing asked, nothing changed (${idle.why})`);
      // Looked at afresh below: the lab's program has no package, so
      // tasklist /apps, which a real Store app shows up in, does not show it.
      ap.asked = false; ap.lastScanAt = -Infinity; ap._readFor = null; ap._procsFor = null;
    } else {
      console.log(`  ..  a Store app is in use on this runner (${hit.map((c) => c.name).join(', ')}); the no-app case is left out`);
    }
    // A program with a window in the lab's own app container: what a UWP
    // app is. Shroudly sees it for itself; where Windows will not show such
    // a window here, the lab's container stands in.
    let labPid = 0;
    let shown = null;
    for (const exe of ['charmap.exe', 'notepad.exe']) {
      const full = path.join(SYS, 'System32', exe);
      if (!fs.existsSync(full)) continue;
      const st = lab('[Console]::Out.WriteLine([AcLab]::Start($env:LAB_NAME, $env:LAB_EXE))', { LAB_NAME: OURS, LAB_EXE: full });
      labPid = Number((st.out.match(/(\d+)\s*$/) || [])[1]) || 0;
      for (let i = 0; i < 10 && labPid && !shown; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        shown = (procsNow() || []).find((p) => p.pid === labPid && p.window) || null;
      }
      console.log(`  ..  ${exe} in the lab's app container: ${labPid ? `process ${labPid}` : `not started (${st.err.trim().slice(0, 160)})`}, ${shown ? `window on screen, app container ${shown.appContainer ? shown.sid : 'no'}` : 'no window seen'}`);
      if (shown) break;
      if (labPid) { try { process.kill(labPid); } catch {} labPid = 0; }
    }
    if (shown) {
      check(shown.appContainer && shown.sid === sidOurs && StoreApps.openSigns([shown]).has(sidOurs), 'a program with a window in an app container is a sign of a Store app in use, by its own token');
    } else {
      ap.runningApps = async () => new Set([sidOurs]);
    }
    const s1 = await ap.survey();
    const ours = ap.ours();
    if (labPid) { try { process.kill(labPid); } catch {} }
    check(s1.result === 'on' && told.join() === 'autoStoreAppsAsk,autoStoreAppsOn', `a Store app in use${shown ? ' (seen for real)' : ' (stood in)'}: asked once and told (${s1.result || s1.why}; ${told.join(', ')})`);
    check(ours.includes(sidOurs) && !ours.includes(sidUsers), `the lab's container is Shroudly's now; the user's own is not (${ours.length} added)`);
    check(ours.every((s) => !before.has(s)), 'nothing that was exempt before is counted as Shroudly\'s');
    check(!store.get('storeAppsPending'), 'nothing is left pending');
    const rec = regRecord();
    check(rec.length === ours.length && ours.every((s) => rec.includes(s)), `the uninstaller's record has exactly those, one value each (${rec.length})`);
    check(regHas(StoreApps.RECORD_LIST) && !regHas(StoreApps.RECORD_KEY, '/v', StoreApps.RECORD_VALUE), '…under its own key, no single long value');
    const s2 = await ap.survey({});
    check(!s2.asked, `asked at most once a session (${s2.why})`);

    const off = await ap.setMode(false);
    const now1 = exemptNow();
    check(off.success && !now1.has(sidOurs) && now1.has(sidUsers), `switched off: Shroudly's taken out, the user's own kept (${JSON.stringify(off)})`);
    check(!regRecord().length && !ap.ours().length && !regHas(StoreApps.RECORD_LIST), '…and nothing is left in the record');
    check(ours.every((s) => !now1.has(s)), 'every exemption Shroudly added is gone');

    // Taken out behind Shroudly's back (here by the switch above, as an
    // uninstall would) while the settings still count them as its own, and
    // as handled (as before this version): the next session asks again.
    const store2 = memStore({ storeAppsOurs: ours, storeAppsHandled: ours, storeAppsMode: true });
    const ap2 = new StoreApps({ store: store2, platform: 'win32', protectionOn: () => true });
    ap2.runningApps = async () => new Set([sidOurs]);
    const s3 = await ap2.survey();
    check(s3.result === 'on' && exemptNow().has(sidOurs), `settings that still count them as Shroudly's: asked again, exempt again (${s3.result || s3.why})`);
    check(ap2.ours().includes(sidOurs) && regRecord().includes(sidOurs), '…and recorded again');
    const off2 = await ap2.setMode(false);
    check(off2.success && !exemptNow().has(sidOurs) && !regRecord().length, `…and taken out again by the switch (${JSON.stringify(off2)})`);

    // A Yes Shroudly did not see the end of (it stopped waiting, quit or
    // crashed): what was pending and is exempt now is its own at the next start.
    cni('-a', `-p=${sidOurs}`);
    const late = new StoreApps({ store: memStore({ storeAppsPending: [sidOurs] }), platform: 'win32', protectionOn: () => true });
    await late._adopt();
    check(late.ours().includes(sidOurs) && !late._pending().length && regRecord().includes(sidOurs), `a late Yes is taken in as Shroudly's, recorded, nothing left pending (${late.ours().length})`);
    await late._setOurs([]);
    cni('-d', `-p=${sidOurs}`);

    // The switch in Settings asks at once, with no Store app open, whatever
    // stale settings say (counted as Shroudly's and as handled, but gone).
    const ap3 = new StoreApps({ store: memStore({ storeAppsOurs: ours, storeAppsHandled: ours, storeAppsModeOffAt: Date.now() }), platform: 'win32', protectionOn: () => true });
    const on3 = await ap3.setMode(true);
    check(on3.success && exemptNow().has(sidOurs) && exemptNow().has(sidUsers) && ap3.ours().includes(sidOurs) && !ap3.ours().includes(sidUsers),
      `switched on: asked at once, exempt again, only Shroudly's own recorded (${JSON.stringify(on3)}, ${ap3.ours().length})`);

    // The record, any length, written and read back for real.
    const many = Array.from({ length: 300 }, (_, i) => StoreApps.containerSid(`shroudly.labrecord${i}_0123456789abc`));
    const keep = ap3.ours();
    await ap3._regRecordSet(many);
    const back = await ap3._regRecordGet();
    check(back.length === many.length && many.every((s) => back.includes(s)), `a record of ${many.length} SIDs (${many.join(';').length} characters) is written in one go and read back whole`);
    // The uninstaller: the record in both forms, the old single value longer
    // than NSIS could read, and the lab's container only in that one.
    await ap3._regRecordSet(keep.filter((s) => s !== sidOurs));
    const legacy = [...many.slice(0, 120), sidOurs].join(';');
    spawnSync('reg.exe', ['add', StoreApps.RECORD_KEY, '/v', StoreApps.RECORD_VALUE, '/t', 'REG_SZ', '/d', legacy, '/f'], { stdio: 'ignore' });
    check(legacy.length > 8192 && regRecord().includes(sidOurs), `the old single value, ${legacy.length} characters, holds the lab's container`);
    const script = uninstallerScript();
    check(!!script, 'the uninstaller\'s command is in scripts/installer.nsh');
    if (script) {
      // As NSIS starts it: the 32-bit PowerShell where there is one.
      const ps32 = path.join(SYS, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const exe = fs.existsSync(ps32) ? ps32 : 'powershell.exe';
      const u = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 300000, env: powershellEnv() });
      const now2 = exemptNow();
      check(u.status === 0, `it ran (${exe === ps32 ? '32-bit' : 'this'} PowerShell: ${u.status} ${String(u.stderr || '').trim().slice(0, 200)})`);
      check(!now2.has(sidOurs) && now2.has(sidUsers), 'uninstalled: Shroudly\'s exemptions gone (the one only in the long old value too), the user\'s own kept');
      check(keep.every((s) => !now2.has(s)), '…all of Shroudly\'s');
      check(!regRecord().length && !regHas(StoreApps.RECORD_LIST) && !regHas(StoreApps.RECORD_KEY, '/v', StoreApps.RECORD_VALUE), '…and its record removed, both forms');
      const leftLists = fs.readdirSync(os.tmpdir()).filter((n) => /^shroudly-lb-[0-9a-f]{32}\.txt$/.test(n));
      check(!leftLists.length, `…and no list left in TEMP (${leftLists.join(', ')})`);
    }
  } finally {
    cni('-d', `-p=${sidOurs}`);
    cni('-d', `-p=${sidUsers}`);
    lab('[void][AcLab]::Delete($env:LAB_NAME)', { LAB_NAME: OURS });
    lab('[void][AcLab]::Delete($env:LAB_NAME)', { LAB_NAME: USERS });
    spawnSync('reg.exe', ['delete', StoreApps.RECORD_KEY, '/v', StoreApps.RECORD_VALUE, '/f'], { stdio: 'ignore' });
    spawnSync('reg.exe', ['delete', StoreApps.RECORD_LIST, '/f'], { stdio: 'ignore' });
    if (engine) engine.stop();
    server.stop();
  }
  console.log(fails ? `\nuwp-loopback: ${fails} failed` : '\nuwp-loopback: all passed');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
