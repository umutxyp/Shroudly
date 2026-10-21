'use strict';

/*
 * Microsoft Store apps and Shroudly (Windows; issue #26).
 *
 * Shroudly is the system proxy through a PAC served on 127.0.0.1, which
 * answers "SOCKS5 127.0.0.1:<engine>; SOCKS 127.0.0.1:<engine>" (system-
 * proxy.js). Store apps follow that setting like every WinINET program, but
 * the ones whose code runs in an app container (UWP apps: Microsoft Store,
 * Xbox and its sign-in, Netflix, and the sign-in windows other apps open)
 * are kept away from loopback addresses by Windows' network isolation
 * unless their package has a loopback exemption ("Network communications
 * using an IP loopback address cannot be used for interprocess communication
 * (between two different apps) in a Windows Runtime app since this is
 * restricted by network isolation", Microsoft, How to enable loopback and
 * troubleshoot network isolation; the reason Fiddler's WinConfig and every
 * local-proxy tool ships a loopback exemption utility). Their connection to
 * Shroudly is refused, and as the PAC has no DIRECT after the proxy on
 * Windows, they get nothing: signing in fails, nothing loads.
 *
 * The PAC cannot send them DIRECT: FindProxyForURL gets the URL and the host,
 * never the program asking. A "; DIRECT" after the proxy would let them out
 * around Shroudly, but it would also let Chromium quietly go around it for
 * minutes after any failed connection (system-proxy.js pacProxy). So the
 * fix is the exemption, which only an administrator can add (CheckNetIsolation
 * LoopbackExempt -a -p=<package SID>).
 *
 * Autopilot (autopilot.js): while protection is on and a Store app is in
 * use (openSigns: a program in an app container with a window on screen, or
 * one a desktop Store app opened just now called on, such as the Xbox app's
 * sign-in) whose app container may use the network (internetClient,
 * internetClientServer or privateNetworkClientServer) and has no exemption,
 * the app containers that need one are given one, all of them in one
 * elevated step (one UAC prompt: a PowerShell that runs CheckNetIsolation
 * for each; the sign-in brokers go with the app), and the user is told in
 * one line. With no Store app in use nobody is asked (Windows' own parts,
 * packaged programs running in the background, and desktop programs in a
 * package such as Windows Terminal, which no app container holds, are no
 * sign), and an account that cannot give administrator permission is
 * never asked by itself: the log says so once a session. What Shroudly adds
 * is written down before the prompt (the settings, and HKCU\Software\
 * Shroudly for the uninstaller) and kept once Windows lists it; an exemption
 * that was there before is never Shroudly's, and is never taken out, and one
 * of Shroudly's that is gone (an uninstall, another tool) is asked about
 * again. Turning the switch off, or uninstalling, takes out Shroudly's own
 * only. A declined prompt is not repeated by itself for two weeks, and the
 * user is told which apps cannot go through Shroudly; one left unanswered is
 * asked again next session.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { envFor } = require('./win-powershell');

const RESPECT_MS = 14 * 24 * 60 * 60 * 1000;
const RESCAN_MS = 30 * 60 * 1000;
const ELEVATE_TIMEOUT_MS = 180000;   // includes the time the user spends on the prompt
const STALE_MS = 24 * 60 * 60 * 1000;

const MAPPINGS_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings';
/* The uninstaller's record: one value per SID under RECORD_LIST (any number
 * of them; the uninstaller's NSIS reads no string longer than 8192
 * characters). Up to this version it was one value, RECORD_VALUE, the SIDs
 * joined by ';': still read, and taken out with the rest. */
const RECORD_KEY = 'HKCU\\Software\\Shroudly';
const RECORD_VALUE = 'LoopbackExempt';
const RECORD_LIST = `${RECORD_KEY}\\LoopbackExemptions`;
const ADMINISTRATORS = 'S-1-5-32-544';

/* A package's app container SID: S-1-15-2 and seven sub-authorities. The only
 * form ever handed to the elevated step (child containers have eleven). */
const SID_RE = /^S-1-15-2(-\d{1,10}){7}$/;
const SID_ANY = /S-1-15-2(?:-\d{1,10}){7}(?!-?\d)/gi;
/* A package family name: Name_PublisherId (13 characters). Other app
 * containers (a browser's sandbox) are not apps the user opens. */
const FAMILY_RE = /^([A-Za-z0-9][A-Za-z0-9.-]{0,63})_([a-z0-9]{13})$/i;
/* internetClient, internetClientServer, privateNetworkClientServer. */
const NET_CAPS = new Set(['S-1-15-3-1', 'S-1-15-3-2', 'S-1-15-3-3']);
/* Windows' own components carry this publisher id. */
const WINDOWS_PUBLISHER = 'cw5n1h2txyewy';

/* The app container SID of a package family, as Windows derives it
 * (DeriveAppContainerSidFromAppContainerName): the first 28 bytes of the
 * SHA-256 of the lower-cased name in UTF-16, as seven 32-bit numbers. */
function containerSid(family) {
  const h = crypto.createHash('sha256').update(Buffer.from(String(family).toLowerCase(), 'utf16le')).digest();
  const parts = [];
  for (let i = 0; i < 7; i++) parts.push(h.readUInt32LE(i * 4));
  return `S-1-15-2-${parts.join('-')}`;
}

/* "Microsoft.WindowsStore_22305.1401.6.0_x64__8wekyb3d8bbwe" -> its family. */
function familyOf(fullName) {
  const p = String(fullName || '').split('_');
  if (p.length < 5) return FAMILY_RE.test(String(fullName || '')) ? String(fullName) : null;
  const fam = `${p[0]}_${p[p.length - 1]}`;
  return FAMILY_RE.test(fam) ? fam : null;
}

const isPackage = (name) => FAMILY_RE.test(String(name || ''));
/* Capabilities unknown (read from the registry): counted as using the network. */
const usesNetwork = (caps) => !Array.isArray(caps) || caps.some((c) => NET_CAPS.has(String(c).toUpperCase()));

/* `reg query <Mappings> /s`: one key per app container, named by its SID,
 * with its Moniker (the package family name, lower case) and DisplayName.
 * Child containers (…\Children\…) are not packages of their own. */
function parseMappings(out) {
  const list = [];
  let cur = null;
  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      const m = line.match(/\\Mappings\\(S-1-15-2(?:-\d+)+)$/i);
      const sid = m ? m[1].toUpperCase() : '';
      cur = SID_RE.test(sid) ? { sid, name: '', display: '' } : null;
      if (cur) list.push(cur);
      continue;
    }
    const v = cur && line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
    if (!v) continue;
    if (/^Moniker$/i.test(v[1])) cur.name = v[2].trim();
    else if (/^DisplayName$/i.test(v[1])) cur.display = v[2].trim();
  }
  return list.filter((c) => c.name);
}

/* `CheckNetIsolation LoopbackExempt -s`: the exempt app containers, each a
 * "Name:" line and a "SID:" line (the labels are translated on other
 * languages of Windows; the SIDs are not). */
function parseExemptList(out) {
  return [...new Set((String(out || '').match(SID_ANY) || []).map((s) => s.toUpperCase()))];
}

/* The enumeration script's lines (scanScript): "C" an app container (SID,
 * name, display name, package full name, capability SIDs), "X" a SID with a
 * loopback exemption, "E" a call that failed. */
function parseScan(out) {
  const containers = [];
  const exempt = [];
  const errors = [];
  const seen = new Set();
  for (const raw of String(out || '').split(/\r?\n/)) {
    const f = raw.replace(/\r$/, '').split('\t');
    if (f[0] === 'C' && f.length >= 6) {
      const sid = f[1].toUpperCase();
      if (!SID_RE.test(sid) || seen.has(sid)) continue;
      seen.add(sid);
      containers.push({ sid, name: f[2], display: f[3], full: f[4], caps: f[5] ? f[5].split(',').filter(Boolean) : [] });
    } else if (f[0] === 'X' && f[1]) {
      exempt.push(f[1].toUpperCase());
    } else if (f[0] === 'E') {
      errors.push(f.slice(1).join(' '));
    }
  }
  return { containers, exempt: [...new Set(exempt)], errors };
}

/* Package family names in a list of package full names (`tasklist /apps`),
 * or of programs' paths (…\WindowsApps\<full name>\…). Windows' own parts
 * (Start, search, the lock screen) always run, so they are left out. */
const FULL_NAME_ANY = /(?:^|[^A-Za-z0-9.-])([A-Za-z0-9][A-Za-z0-9.-]{0,63})_\d+(?:\.\d+){0,3}_[A-Za-z0-9]+_[A-Za-z0-9.~-]*_([a-z0-9]{13})(?![A-Za-z0-9])/gi;
function runningFamilies(out) {
  const fams = new Set();
  for (const m of String(out || '').matchAll(FULL_NAME_ANY)) {
    if (m[2].toLowerCase() !== WINDOWS_PUBLISHER) fams.add(`${m[1]}_${m[2]}`.toLowerCase());
  }
  return [...fams];
}

/* `whoami /groups`: whether the token holds the Administrators group, as a
 * group used for deny only too (an administrator under UAC, who can say Yes
 * to a prompt). A standard user's has none: a prompt would ask them for a
 * password they do not have. */
/* `tasklist /apps /fo csv`: each packaged program running (not Windows'
 * own) as "pid:family", to tell whether anything changed since the last look. */
function packagedProcesses(out) {
  const list = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const pid = line.match(/^"[^"]*","(\d+)"/);
    const fam = pid && runningFamilies(line)[0];
    if (fam) list.push(`${pid[1]}:${fam}`);
  }
  return list.sort();
}

/* PROCS_PS's lines: [{ pid, window, appContainer, sid (the package's app
 * container, a child container's parent), family, start, name }]. */
function parseProcs(out) {
  const list = [];
  for (const raw of String(out || '').split(/\r?\n/)) {
    const f = raw.replace(/\r$/, '').split('\t');
    if (f[0] !== 'P' || f.length < 8) continue;
    const m = String(f[4] || '').toUpperCase().match(/^S-1-15-2(?:-\d{1,10}){7}/);
    list.push({ pid: Number(f[1]), window: f[2] === '1', appContainer: f[3] === '1', sid: f[3] === '1' && m ? m[0] : '',
      family: familyOf(f[5]) ? familyOf(f[5]).toLowerCase() : '', start: Number(f[6]) || 0, name: f[7] });
  }
  return list;
}

/* Signs that a Store app is in use, as the app containers it runs in (a Set
 * of SIDs). Windows keeps only app containers off loopback addresses; a
 * desktop program in a package (Windows Terminal, the Xbox app, Store
 * versions of WhatsApp or Spotify) runs outside one and reaches Shroudly
 * like any program, so it is no sign by itself:
 *  - a program in an app container with a window on screen: a UWP app open
 *    (the Microsoft Store, a game, any app);
 *  - a program in an app container, window or not, started after a desktop
 *    program in a package was opened (a window of it on screen): what that
 *    one called on, such as the Xbox app's sign-in (XboxIdentityProvider).
 * Never Windows' own parts (Start, search, the sign-in broker of Windows,
 * which run whatever anyone opens), nor a program in an app container that
 * was already running before, by itself. */
function openSigns(procs) {
  const own = (p) => p.family && p.family.endsWith(`_${WINDOWS_PUBLISHER}`);
  const opened = procs.filter((p) => p.window && p.family && !p.appContainer && !own(p)).map((p) => p.start);
  const since = opened.length ? Math.min(...opened) : Infinity;
  const sids = new Set();
  for (const p of procs) {
    if (!p.appContainer || !SID_RE.test(p.sid) || own(p)) continue;
    if (p.window || p.start >= since) sids.add(p.sid);
  }
  return sids;
}

function hasAdministrators(out) {
  return new RegExp(`(^|[^0-9-])${ADMINISTRATORS}(?![0-9-])`, 'm').test(String(out || ''));
}

/* `reg query HKCU\Software\Shroudly /s`: the SIDs in the uninstaller's record,
 * in either form. */
function parseRecord(out) {
  const list = RECORD_LIST.toLowerCase();
  const key = RECORD_KEY.toLowerCase();
  const legacy = new RegExp(`^\\s+${RECORD_VALUE}\\s+REG_`, 'i');
  const sids = [];
  let sec = '';
  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^HKEY_/i.test(line)) { sec = line.replace(/^HKEY_CURRENT_USER/i, 'HKCU').toLowerCase(); continue; }
    if (sec === list || (sec === key && legacy.test(line))) sids.push(...parseExemptList(line));
  }
  return [...new Set(sids)];
}

/* The record as a .reg file for `reg import` (one call, whatever the number
 * of SIDs): the list replaced, the old single value gone. */
function recordReg(list) {
  const root = RECORD_KEY.replace(/^HKCU/, 'HKEY_CURRENT_USER');
  const sub = RECORD_LIST.replace(/^HKCU/, 'HKEY_CURRENT_USER');
  return ['Windows Registry Editor Version 5.00', '',
    `[${root}]`, `"${RECORD_VALUE}"=-`, '',
    `[-${sub}]`, '',
    `[${sub}]`, ...list.filter((s) => SID_RE.test(s)).map((s) => `"${s}"=""`), '', ''].join('\r\n');
}

/* The app containers that need an exemption: packages that may use the
 * network, with none, and not one Windows would not exempt (handled: asked
 * for, Yes given, and still not exempt; a container left from an app since
 * removed). */
function candidates({ containers, exempt, handled }) {
  const ex = new Set([...(exempt || [])].map((s) => String(s).toUpperCase()));
  const done = new Set([...(handled || [])].map((s) => String(s).toUpperCase()));
  const out = [];
  const seen = new Set();
  for (const c of containers || []) {
    const sid = String(c.sid || '').toUpperCase();
    if (!SID_RE.test(sid) || seen.has(sid) || ex.has(sid) || done.has(sid)) continue;
    if (!isPackage(c.name) || !usesNetwork(c.caps)) continue;
    seen.add(sid);
    out.push(c);
  }
  return out;
}

/* Whether to ask now, or why not. */
function decide({ platform, protectionOn, offAt, declinedAt, asked, busy, now, force }) {
  if (platform !== 'win32') return 'unsupported';
  if (!protectionOn && !force) return 'protection_off';
  if (force) return 'ask';
  if (now - (Number(offAt) || 0) < RESPECT_MS) return 'off_by_hand';
  if (now - (Number(declinedAt) || 0) < RESPECT_MS) return 'declined';
  if (asked) return 'asked';
  if (busy) return 'busy';
  return 'ask';
}

/* What the user knows these apps as: brand names, which no language
 * translates. Earlier in the list is named first. */
const KNOWN = [
  ['Microsoft.GamingApp', 'Xbox'], ['Microsoft.XboxApp', 'Xbox'], ['Microsoft.WindowsStore', 'Microsoft Store'],
  ['5319275A.WhatsAppDesktop', 'WhatsApp'], ['4DF9E0F8.Netflix', 'Netflix'], ['SpotifyAB.SpotifyMusic', 'Spotify'],
  ['Facebook.InstagramBeta', 'Instagram'], ['FACEBOOK.317180B0BB486', 'Messenger'], ['BytedancePte.Ltd.TikTok', 'TikTok'],
  ['Disney.37853FC22B2CE', 'Disney+'], ['AmazonVideo.PrimeVideo', 'Prime Video'], ['AppleInc.AppleMusicWin', 'Apple Music'],
  ['AppleInc.AppleTVWin', 'Apple TV'], ['Microsoft.MinecraftUWP', 'Minecraft'], ['TelegramMessengerLLP.TelegramDesktop', 'Telegram'],
  ['Microsoft.SkypeApp', 'Skype'], ['MSTeams', 'Microsoft Teams'], ['Microsoft.OutlookForWindows', 'Outlook'],
];
const KNOWN_RANK = new Map(KNOWN.map(([n], i) => [n.toLowerCase(), i]));
const KNOWN_NAME = new Map(KNOWN.map(([n, d]) => [n.toLowerCase(), d]));

function friendlyName(c) {
  const m = String(c.name || '').match(FAMILY_RE);
  const base = m ? m[1] : String(c.name || '');
  const known = KNOWN_NAME.get(base.toLowerCase());
  if (known) return known;
  const d = String(c.display || '').trim();
  if (d && !/^@|ms-resource:/i.test(d) && d.length <= 40) return d;
  return null;
}

/* Up to `max` names for a line the user reads: the apps people know first,
 * then other apps' own names, never Windows' components. */
function appNames(list, max = 3) {
  const rank = (c) => {
    const m = String(c.name || '').match(FAMILY_RE);
    const r = m ? KNOWN_RANK.get(m[1].toLowerCase()) : undefined;
    if (r !== undefined) return r;
    return m && m[2].toLowerCase() === WINDOWS_PUBLISHER ? 1e6 : 1e3;
  };
  const names = [];
  for (const c of [...(list || [])].sort((a, b) => rank(a) - rank(b))) {
    const m = String(c.name || '').match(FAMILY_RE);
    if (m && m[2].toLowerCase() === WINDOWS_PUBLISHER) continue;
    const n = friendlyName(c);
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= max) break;
  }
  return names.length ? names : ['Microsoft Store'];
}

/* ── PowerShell ─────────────────────────────────────────────────────────── */

/* The firewall's own view (FirewallAPI.dll, the calls CheckNetIsolation and
 * Fiddler's exemption tool make): every app container with its capabilities,
 * and the ones exempt from the loopback restriction. Needs no administrator. */
const SCAN_CS = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'public static class ShroudlyNetIso {',
  '  [StructLayout(LayoutKind.Sequential)] struct SidAttr { public IntPtr Sid; public uint Attributes; }',
  '  [StructLayout(LayoutKind.Sequential)] struct Caps { public uint count; public IntPtr caps; }',
  '  [StructLayout(LayoutKind.Sequential)] struct Bins { public uint count; public IntPtr bins; }',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct AppContainer {',
  '    public IntPtr appContainerSid; public IntPtr userSid;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string appContainerName;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string displayName;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string description;',
  '    public Caps capabilities; public Bins binaries;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string workingDirectory;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string packageFullName;',
  '  }',
  '  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationEnumAppContainers(uint flags, out uint count, out IntPtr list);',
  '  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationFreeAppContainers(IntPtr list);',
  '  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationGetAppContainerConfig(out uint count, out IntPtr sids);',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);',
  '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);',
  '  static string Sid(IntPtr p) {',
  '    if (p == IntPtr.Zero) return "";',
  '    IntPtr s;',
  '    if (!ConvertSidToStringSid(p, out s)) return "";',
  '    try { return Marshal.PtrToStringUni(s); } finally { LocalFree(s); }',
  '  }',
  '  static string Clean(string s) { return (s ?? "").Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " "); }',
  '  public static string[] Run() {',
  '    List<string> lines = new List<string>();',
  '    int sa = Marshal.SizeOf(typeof(SidAttr));',
  '    uint n; IntPtr list;',
  '    uint r = NetworkIsolationEnumAppContainers(0, out n, out list);',
  '    if (r != 0) lines.Add("E\\tenum\\t" + r);',
  '    else if (list != IntPtr.Zero) {',
  '      try {',
  '        int size = Marshal.SizeOf(typeof(AppContainer));',
  '        for (long i = 0; i < n; i++) {',
  '          AppContainer ac = (AppContainer)Marshal.PtrToStructure(new IntPtr(list.ToInt64() + i * size), typeof(AppContainer));',
  '          List<string> caps = new List<string>();',
  '          for (long j = 0; j < ac.capabilities.count && ac.capabilities.caps != IntPtr.Zero; j++) {',
  '            SidAttr c = (SidAttr)Marshal.PtrToStructure(new IntPtr(ac.capabilities.caps.ToInt64() + j * sa), typeof(SidAttr));',
  '            caps.Add(Sid(c.Sid));',
  '          }',
  '          lines.Add("C\\t" + Sid(ac.appContainerSid) + "\\t" + Clean(ac.appContainerName) + "\\t" + Clean(ac.displayName) + "\\t" + Clean(ac.packageFullName) + "\\t" + String.Join(",", caps.ToArray()));',
  '        }',
  '      } finally { NetworkIsolationFreeAppContainers(list); }',
  '    }',
  '    IntPtr sids;',
  '    r = NetworkIsolationGetAppContainerConfig(out n, out sids);',
  '    if (r != 0) lines.Add("E\\tconfig\\t" + r);',
  '    else if (sids != IntPtr.Zero) {',
  '      for (long i = 0; i < n; i++) {',
  '        SidAttr c = (SidAttr)Marshal.PtrToStructure(new IntPtr(sids.ToInt64() + i * sa), typeof(SidAttr));',
  '        lines.Add("X\\t" + Sid(c.Sid));',
  '      }',
  '    }',
  '    return lines.ToArray();',
  '  }',
  '}',
].join('\n');

const SCAN_PS = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "Add-Type -TypeDefinition @'",
  SCAN_CS,
  "'@",
  'foreach ($l in [ShroudlyNetIso]::Run()) { [Console]::Out.WriteLine($l) }',
].join('\n');

/* The programs of this session that matter here, each a "P" line: process
 * id, a window of it on screen (1/0: visible and not cloaked; a UWP app's
 * window sits inside ApplicationFrameHost's frame and is found through its
 * CoreWindow), whether it runs in an app container (1/0, from its token),
 * that app container's SID, its package's full name, when it started (a
 * FILETIME) and its name. Programs with neither a package nor an app
 * container are left out. Needs no administrator. */
const PROCS_CS = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class ShroudlyProcs {',
  '  delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);',
  '  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr p, ref uint len, StringBuilder name);',
  '  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr p, out long create, out long exit, out long kernel, out long user);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);',
  '  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);',
  '  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int ret);',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);',
  '  static bool Shown(IntPtr h) {',
  '    if (!IsWindowVisible(h)) return false;',
  '    int cloaked;',
  '    return DwmGetWindowAttribute(h, 14, out cloaked, 4) != 0 || cloaked == 0;',
  '  }',
  '  static string Clean(string s) { return (s ?? "").Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " "); }',
  '  public static string[] Run() {',
  '    HashSet<uint> shown = new HashSet<uint>();',
  '    EnumWindows(delegate (IntPtr h, IntPtr l) {',
  '      if (!Shown(h)) return true;',
  '      uint wp;',
  '      GetWindowThreadProcessId(h, out wp);',
  '      shown.Add(wp);',
  '      StringBuilder cls = new StringBuilder(64);',
  '      GetClassName(h, cls, 64);',
  '      if (cls.ToString() == "ApplicationFrameWindow") {',
  '        IntPtr c = IntPtr.Zero;',
  '        while ((c = FindWindowEx(h, c, "Windows.UI.Core.CoreWindow", null)) != IntPtr.Zero) { uint cp; GetWindowThreadProcessId(c, out cp); shown.Add(cp); }',
  '      }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    int session = Process.GetCurrentProcess().SessionId;',
  '    List<string> lines = new List<string>();',
  '    IntPtr buf = Marshal.AllocHGlobal(256);',
  '    try {',
  '      foreach (Process proc in Process.GetProcesses()) {',
  '        uint pid = (uint)proc.Id;',
  '        string name = "";',
  '        try { if (proc.SessionId != session) continue; name = proc.ProcessName; } catch { continue; } finally { proc.Dispose(); }',
  '        IntPtr p = OpenProcess(0x1000, false, pid);',
  '        if (p == IntPtr.Zero) continue;',
  '        try {',
  '          string pkg = "";',
  '          uint len = 0;',
  '          if (GetPackageFullName(p, ref len, null) == 122 && len > 0) {',
  '            StringBuilder sb = new StringBuilder((int)len);',
  '            if (GetPackageFullName(p, ref len, sb) == 0) pkg = sb.ToString();',
  '          }',
  '          bool ac = false;',
  '          string sid = "";',
  '          IntPtr tok;',
  '          if (OpenProcessToken(p, 8, out tok)) {',
  '            try {',
  '              int ret;',
  '              if (GetTokenInformation(tok, 29, buf, 4, out ret)) ac = Marshal.ReadInt32(buf) != 0;',
  '              if (ac && GetTokenInformation(tok, 31, buf, 256, out ret)) {',
  '                IntPtr s;',
  '                if (ConvertSidToStringSid(Marshal.ReadIntPtr(buf), out s)) { sid = Marshal.PtrToStringUni(s); LocalFree(s); }',
  '              }',
  '            } finally { CloseHandle(tok); }',
  '          }',
  '          if (pkg == "" && !ac) continue;',
  '          long created, exited, kt, ut;',
  '          if (!GetProcessTimes(p, out created, out exited, out kt, out ut)) created = 0;',
  '          lines.Add("P\\t" + pid + "\\t" + (shown.Contains(pid) ? "1" : "0") + "\\t" + (ac ? "1" : "0") + "\\t" + sid + "\\t" + Clean(pkg) + "\\t" + created + "\\t" + Clean(name));',
  '        } finally { CloseHandle(p); }',
  '      }',
  '    } finally { Marshal.FreeHGlobal(buf); }',
  '    return lines.ToArray();',
  '  }',
  '}',
].join('\n');

const PROCS_PS = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  PROCS_CS,
  "'@",
  'foreach ($l in [ShroudlyProcs]::Run()) { [Console]::Out.WriteLine($l) }',
].join('\n');

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
// PowerShell takes ‘ ’ ‚ ‛ for a single quote too; each is doubled like '.
const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
const POWERSHELL = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SYSTEM_TOOL = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);

/* What runs elevated: CheckNetIsolation for each SID in `file`, one per line,
 * each checked again here, so nothing but a package SID ever reaches it. The
 * file's path comes as base64, never inside quotes, so any character in the
 * user's TEMP works; the file is deleted as soon as it is read, so a prompt
 * answered after Shroudly stopped waiting (or after it quit) still works and
 * leaves nothing behind. A 32-bit PowerShell (the uninstaller's) reaches the
 * 64-bit tool through Sysnative. It writes nothing else. */
function elevatedScript(verb, file) {
  const flag = verb === 'remove' ? '-d' : '-a';
  return [
    `$f = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(String(file), 'utf16le').toString('base64')}'))`,
    '$l = [IO.File]::ReadAllLines($f)',
    'Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue',
    "$n = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { 'Sysnative' } else { 'System32' }",
    "$t = Join-Path $env:SystemRoot ($n + '\\CheckNetIsolation.exe')",
    'foreach ($s in $l) {',
    `  if ($s -match '^S-1-15-2(-\\d{1,10}){7}$') { & $t LoopbackExempt ${flag} ('-p=' + $s) | Out-Null }`,
    '}',
  ].join('\n');
}

/* The unelevated side: one UAC prompt for that script, waiting for it to
 * finish. Exit 2 when the prompt was declined (ERROR_CANCELLED, 1223). */
function launcherScript(inner) {
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encode(inner)}`;
  return [
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `try { Start-Process -FilePath $ps -ArgumentList ${psQuote(args)} -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop; exit 0 }`,
    'catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 2 }; $e = $e.InnerException }; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
}

function realRun(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      // timedOut: stopped after `timeout` (for the prompt: nobody answered it).
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: envFor(cmd) }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, timedOut: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); }
  });
}

/* ── the autopilot's part ───────────────────────────────────────────────── */

class StoreApps {
  /*
   * opts.store          settings (get, set, delete)
   * opts.log(level, msg)
   * opts.tell(id, params)  a notification and a line in the window
   * opts.protectionOn()
   * opts.busy()         another permission prompt is on screen (Advanced mode)
   * opts.platform, opts.run(cmd, args, timeout), opts.now(), opts.tmpdir   tests
   * opts.record         { get() -> [sid], set([sid]) }: what the uninstaller
   *                     reads (default HKCU\Software\Shroudly)
   */
  constructor(opts = {}) {
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.tell = opts.tell || (() => {});
    this.protectionOn = opts.protectionOn || (() => false);
    this.busy = opts.busy || (() => false);
    this.platform = opts.platform || process.platform;
    this.run = opts.run || realRun;
    this.now = opts.now || Date.now;
    this.tmpdir = opts.tmpdir || os.tmpdir();
    this.record = opts.record || {
      get: () => this._regRecordGet(),
      set: (list) => this._regRecordSet(list),
    };
    this.onChange = opts.onChange || (() => {});
    this.asked = false;          // the prompt was shown this session
    this.toldBlocked = false;    // the declined line was logged this session
    this.toldNoAdmin = false;    // the no-administrator line was logged this session
    this.admin = null;           // this account can say Yes to a prompt (null: not known yet)
    this.lastScanAt = -Infinity;
    this._readFor = null;        // the open apps the last read (no prompt after it) was made for
    this._procsFor = null;       // the packaged programs the processes were last looked at for, and what they showed
    this._running = null;        // a survey under way
    this._removing = null;       // the switch's removal under way
    this._gen = 0;               // the switch turned: a survey under way stands down
  }

  available() { return this.platform === 'win32'; }

  ours() { return (this.store.get('storeAppsOurs', []) || []).filter((s) => SID_RE.test(s)); }

  /* Asked for at a prompt whose end Shroudly has not seen (nobody answered
   * in time, a quit or a crash): Shroudly's once Windows lists them. */
  _pending() { return (this.store.get('storeAppsPending', []) || []).filter((s) => SID_RE.test(s)); }

  /* Those Windows would not exempt. Never one of Shroudly's own: up to this
   * version every SID asked for was kept here. */
  _handled() {
    const own = new Set(this.ours());
    return (this.store.get('storeAppsHandled', []) || []).map((s) => String(s).toUpperCase()).filter((s) => SID_RE.test(s) && !own.has(s));
  }

  status() {
    return { available: this.available(), on: this.store.get('storeAppsMode') === true, ours: this.ours().length };
  }

  /* Every app container, its capabilities, and which are exempt. The
   * firewall's own list first; where that cannot be had (PowerShell locked
   * down), the user's app container registry and CheckNetIsolation's list,
   * with no capabilities (every package counts). */
  async scan() {
    if (!this.available()) return null;
    const r = await this.run(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(SCAN_PS)], 60000);
    const api = parseScan(r.stdout);
    const failed = (what) => r.code !== 0 || api.errors.some((e) => e.startsWith(what));
    let containers = api.containers;
    let source = 'firewall';
    if (failed('enum')) {
      const reg = await this.run(SYSTEM_TOOL('reg.exe'), ['query', MAPPINGS_KEY, '/s'], 20000);
      // No key at all: no app container was ever made for this user.
      if (reg.code !== 0 && reg.code !== 1) return null;
      containers = parseMappings(reg.stdout).map((c) => ({ ...c, caps: null }));
      source = 'registry';
    }
    const exempt = failed('config') ? await this._exemptViaTool() : api.exempt;
    if (exempt === null) return null;
    return { containers, exempt, source };
  }

  async _exemptViaTool() {
    const r = await this.run(SYSTEM_TOOL('CheckNetIsolation.exe'), ['LoopbackExempt', '-s'], 20000);
    return r.code === 0 ? parseExemptList(r.stdout) : null;
  }

  /* The programs of this session in a package or an app container
   * (parseProcs), or null when they cannot be looked at (a locked-down
   * PowerShell: then nothing is asked by itself; the switch still asks).
   * Cheap first: with no packaged program of this account's running
   * (tasklist /apps), nothing to look at; with the same ones as at the last
   * look less than half an hour ago, that look stands. */
  async processes() {
    if (!this.available()) return null;
    let user = process.env.USERNAME || '';
    try { user = user || os.userInfo().username; } catch {}
    const t = user
      ? await this.run(SYSTEM_TOOL('tasklist.exe'), ['/apps', '/fi', `USERNAME eq ${user}`, '/fo', 'csv', '/nh'], 15000)
      : { code: -1 };
    let sig = '?';
    if (t.code === 0) {
      const procs = packagedProcesses(t.stdout);
      if (!procs.length) { this._procsFor = null; return []; }
      sig = procs.join(' ');
    }
    const last = this._procsFor;
    // Without tasklist /apps, looked at again every ten minutes.
    if (last && last.sig === sig && this.now() - last.at < (sig === '?' ? 10 * 60 * 1000 : RESCAN_MS)) return last.procs;
    const r = await this.run(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(PROCS_PS)], 60000);
    if (r.code !== 0) return null;
    const procs = parseProcs(r.stdout);
    this._procsFor = { sig, at: this.now(), procs };
    return procs;
  }

  /* The app containers that show a Store app in use (openSigns), or null. */
  async runningApps() {
    const p = await this.processes();
    return p ? openSigns(p) : null;
  }

  /* Whether this account can say Yes to a permission prompt: true, false,
   * or null (whoami could not tell). */
  async canConsent() {
    const r = await this.run(SYSTEM_TOOL('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], 15000);
    return r.code === 0 ? hasAdministrators(r.stdout) : null;
  }

  _tempFile(ext) { return path.join(this.tmpdir, `shroudly-lb-${crypto.randomBytes(8).toString('hex')}${ext}`); }

  /* Lists of prompts nobody ever answered (the elevated script deletes its
   * own as it starts), and the uninstaller's. */
  _sweep() {
    let names = [];
    try { names = fs.readdirSync(this.tmpdir); } catch { return; }
    for (const name of names) {
      if (!/^shroudly-lb-[0-9a-f]{16,32}\.(txt|reg)$/.test(name)) continue;
      const f = path.join(this.tmpdir, name);
      try { if (Date.now() - fs.statSync(f).mtimeMs > STALE_MS) fs.rmSync(f, { force: true }); } catch {}
    }
  }

  /* One UAC prompt; CheckNetIsolation for each SID. 'ok', 'declined',
   * 'noanswer' (nobody answered before ELEVATE_TIMEOUT_MS: the list stays
   * for a Yes that comes later, and the elevated script deletes it) or
   * 'failed'. */
  async _elevate(verb, sids) {
    const list = sids.filter((s) => SID_RE.test(s));
    if (!list.length) return { code: 'ok' };
    let file = null;
    let keep = false;
    try {
      file = this._tempFile('.txt');
      fs.writeFileSync(file, `${list.join('\r\n')}\r\n`, { flag: 'wx' });
      const r = await this.run(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        encode(launcherScript(elevatedScript(verb, file)))], ELEVATE_TIMEOUT_MS);
      if (r.timedOut) { keep = true; return { code: 'noanswer' }; }
      if (r.code === 2) return { code: 'declined' };
      if (r.code !== 0) return { code: 'failed', detail: (r.stderr || '').trim().split(/\r?\n/)[0] || `exit ${r.code}` };
      return { code: 'ok' };
    } catch (e) {
      return { code: 'failed', detail: e.message };
    } finally {
      if (file && !keep) { try { fs.rmSync(file, { force: true }); } catch {} }
    }
  }

  /* What Shroudly added, in the settings and in the uninstaller's record;
   * the record also holds what is pending (a Yes may still come, and an
   * uninstall before Shroudly sees it must take that out too). Waited for:
   * the record is written by reg.exe, and a survey or a removal is only done
   * once it is there (and two writes never cross). */
  async _setOurs(list) {
    const v = [...new Set(list.filter((s) => SID_RE.test(s)))];
    if (v.length) this.store.set('storeAppsOurs', v); else this.store.delete('storeAppsOurs');
    try { await this.record.set([...new Set([...v, ...this._pending()])]); } catch {}
  }

  /* The pending SIDs Windows now lists as exempt are Shroudly's (a Yes it
   * did not see). final: the others are forgotten, in the record too. */
  async _takePending(exempt, final) {
    const pending = this._pending();
    if (!pending.length) return [];
    const took = pending.filter((s) => exempt.has(s));
    const rest = pending.filter((s) => !exempt.has(s));
    if (final || !rest.length) this.store.delete('storeAppsPending'); else this.store.set('storeAppsPending', rest);
    if (took.length || final) await this._setOurs([...this.ours(), ...took]);
    return took;
  }

  /* Said once taken in; the switch shows on, unless it was turned off by
   * hand meanwhile (the removal that follows takes them out). */
  _tookLate(took) {
    if (!took.length) return;
    this.log('success', `Store apps: ${took.length} can now reach Shroudly`);
    if (this.now() - (Number(this.store.get('storeAppsModeOffAt')) || 0) < RESPECT_MS) return;
    this.store.set('storeAppsMode', true);
    this.onChange();
  }

  /* After a read: one of Shroudly's that is no longer exempt (an uninstall,
   * another tool, these settings on another PC) is not its own any more, and
   * is a candidate again. None left: the switch shows off, as it is, until
   * they are added again (not while the user is turning it on: keep). */
  async _tidy(exempt, keep = false) {
    const kept = this.store.get('storeAppsHandled', []) || [];
    const refused = this._handled();
    if (refused.length !== kept.length) {
      if (refused.length) this.store.set('storeAppsHandled', refused); else this.store.delete('storeAppsHandled');
    }
    const ours = this.ours();
    const live = ours.filter((s) => exempt.has(s));
    if (live.length === ours.length) return;
    await this._setOurs(live);
    if (!live.length && !keep && this.store.get('storeAppsMode') === true) {
      this.store.set('storeAppsMode', false);
      this.onChange();
    }
  }

  /* When protection comes on, and every so often after: app containers that
   * need an exemption get one. force: the user turned the switch on. One at
   * a time. */
  survey(opts = {}) {
    if (!this._running) this._running = this._survey(opts).finally(() => { this._running = null; });
    return this._running;
  }

  /* Resolves once no survey and no removal (and so no permission prompt)
   * is under way. */
  settled() {
    return Promise.all([this._running, this._removing].filter(Boolean).map((p) => p.then(() => {}, () => {}))).then(() => {});
  }

  /* Once a session, before anything else: the settings may have lost what
   * Shroudly added (a reset profile) while the uninstaller's record still has
   * it; a prompt of an earlier session may have been answered after Shroudly
   * stopped waiting for it, or Shroudly quit or crashed after a Yes. */
  async _adopt(keep = false) {
    if (this._adopted || !this.available()) return;
    this._adopted = true;
    this._sweep();
    const pending = new Set(this._pending());
    if (!this.ours().length) {
      // The record holds what is pending too: that is not Shroudly's yet.
      let rec = [];
      try { rec = await this.record.get(); } catch {}
      const own = Array.isArray(rec) ? rec.filter((s) => SID_RE.test(s) && !pending.has(s)) : [];
      if (own.length) this.store.set('storeAppsOurs', own);
    }
    if (pending.size) {
      const s = await this.scan();
      if (s) {
        const exempt = new Set(s.exempt);
        const took = await this._takePending(exempt, true);
        await this._tidy(exempt, keep);
        this._tookLate(took);
      }
    }
  }

  async _survey({ force = false } = {}) {
    const gen = this._gen;
    await this._adopt(force);
    const why = decide({
      platform: this.platform, protectionOn: this.protectionOn(), offAt: this.store.get('storeAppsModeOffAt'),
      declinedAt: this.store.get('storeAppsDeclinedAt'), asked: this.asked, busy: this.busy(), now: this.now(), force,
    });
    if (why === 'declined' && !this.toldBlocked) return this._noteBlocked();
    if (why !== 'ask') return { asked: false, why };
    if (!force && this.admin === false && this.toldNoAdmin) return { asked: false, why: 'not_admin' };
    // By itself only on a sign of need: a Store app open now. The list is
    // read again for one not seen open before, or every half hour.
    let open = null;
    if (!force) {
      open = await this.runningApps();
      if (!open || !open.size) return { asked: false, why: 'idle' };
      if (this._readFor && this.now() - this.lastScanAt < RESCAN_MS && [...open].every((s) => this._readFor.has(s))) return { asked: false, why: 'idle' };
    }
    this.lastScanAt = this.now();
    const before = await this.scan();
    if (!before) { this._readFor = open; return { asked: false, why: 'unreadable' }; }
    // The switch turned while it read: that decides now.
    if (gen !== this._gen) return { asked: false, why: 'changed' };
    const exempt = new Set(before.exempt);
    this._tookLate(await this._takePending(exempt, false));
    await this._tidy(exempt, force);
    const need = candidates({ containers: before.containers, exempt: before.exempt, handled: this._handled() });
    if (!force && !need.some((c) => open.has(c.sid))) {
      this._readFor = open;
      return { asked: false, why: need.length ? 'idle' : 'none' };
    }
    if (!need.length) return { asked: false, why: 'none' };
    // Protection may have stopped, or another prompt come up, while it read.
    if (!force && (!this.protectionOn() || this.busy())) return { asked: false, why: 'changed' };

    const apps = appNames(need).join(', ');
    // A standard user would be asked for a password they do not have: the
    // log says once a session what an administrator can do.
    if (!force) {
      if (this.admin !== true) this.admin = await this.canConsent();
      if (this.admin !== true) {
        if (!this.toldNoAdmin) {
          this.toldNoAdmin = true;
          this.log('warning', `Store apps: ${apps} cannot go through Shroudly until an administrator allows it (the Microsoft Store apps switch in Settings)`);
        }
        return { asked: false, why: 'not_admin' };
      }
    }

    // Every app that needs it in the one prompt: the sign-in brokers
    // (XboxIdentityProvider, AAD.BrokerPlugin) with the app that is open.
    const sids = need.map((c) => c.sid);
    this.asked = true;
    this.log('info', `Store apps: ${need.length} cannot reach Shroudly (${apps}); asking for permission`);
    this.tell('autoStoreAppsAsk', { apps });
    // Written down before the prompt: should Shroudly stop waiting, quit or
    // crash after a Yes, what Windows adds is still known to be Shroudly's
    // (taken in later; the uninstaller takes it out meanwhile).
    this.store.set('storeAppsPending', sids);
    await this._setOurs(this.ours());
    const r = await this._elevate('add', sids);
    if (r.code === 'declined') {
      this.store.delete('storeAppsPending');
      await this._setOurs(this.ours());
      if (gen !== this._gen) return { asked: true, result: 'changed', apps };
      this.store.set('storeAppsDeclinedAt', this.now());
      this.toldBlocked = true;
      this.log('info', 'Store apps: permission was not given; Shroudly will not ask by itself again for two weeks');
      this.tell('autoStoreAppsDeclined', { apps });
      return { asked: true, result: 'declined', apps };
    }
    // What took: none of these were exempt before, so each one exempt now is
    // Shroudly's. Should the list not be readable after a Yes, all of them
    // are remembered; only those still exempt are ever taken out again.
    const after = await this.scan();
    const nowExempt = after ? new Set(after.exempt) : null;
    const added = sids.filter((s) => (nowExempt ? nowExempt.has(s) : r.code === 'ok'));
    const rest = sids.filter((s) => !added.includes(s));
    // Not answered yet: a Yes may still come, and is taken in later (the
    // record keeps those meanwhile).
    if (r.code === 'noanswer' && rest.length) this.store.set('storeAppsPending', rest); else this.store.delete('storeAppsPending');
    await this._setOurs([...this.ours(), ...added]);
    // One Windows would not exempt (a container left from an app since
    // removed) is not asked about again.
    if (r.code === 'ok' && added.length && rest.length) this.store.set('storeAppsHandled', [...new Set([...this._handled(), ...rest])]);
    // The switch turned off meanwhile: what was added is recorded, for the
    // removal that follows, and nothing else is changed or said.
    if (gen !== this._gen) return { asked: true, result: 'changed', apps, added };
    if (!added.length && r.code === 'noanswer') {
      this.log('info', 'Store apps: the permission prompt was not answered; Shroudly will ask again next time');
      return { asked: true, result: 'noanswer', apps };
    }
    if (!added.length) {
      // Nothing changed (no administrator after all, a locked-down system):
      // the same two weeks as a decline, but said as a failure.
      this.store.set('storeAppsDeclinedAt', this.now());
      this.toldBlocked = true;
      this.log('warning', `Store apps: they could not be let through (${r.detail || 'no exemption was added'})`);
      this.tell('autoStoreAppsFailed', { apps });
      return { asked: true, result: 'failed', apps };
    }
    this.store.set('storeAppsMode', true);
    this.store.delete('storeAppsDeclinedAt');
    this.log('success', `Store apps: ${added.length} can now reach Shroudly`);
    this.tell('autoStoreAppsOn', { apps });
    this.onChange();
    return { asked: true, result: 'on', apps, added };
  }

  /* After a declined prompt, once a session: which apps cannot go through
   * Shroudly, in the log (the notification was the decline itself). */
  async _noteBlocked() {
    this.toldBlocked = true;
    if (this.now() - this.lastScanAt < RESCAN_MS) return { asked: false, why: 'declined' };
    this.lastScanAt = this.now();
    const s = await this.scan();
    const need = s ? candidates({ containers: s.containers, exempt: s.exempt, handled: this._handled() }) : [];
    if (need.length) this.log('warning', `Store apps: ${appNames(need).join(', ')} cannot go through Shroudly; permission was not given`);
    return { asked: false, why: 'declined' };
  }

  /* The switch in Settings. On: ask now (the user's own request), whatever
   * a survey already under way decides. Off: take out Shroudly's own
   * exemptions (one prompt), after a survey under way, so nothing it adds
   * stays, and leave the switch off for two weeks at least. The last turn
   * wins: an earlier one still waiting stands down ('changed'). */
  async setMode(on) {
    if (!this.available()) return { success: false, code: 'unsupported' };
    const gen = ++this._gen;
    if (on) {
      this.store.delete('storeAppsModeOffAt');
      this.store.delete('storeAppsDeclinedAt');
      this.store.set('storeAppsMode', true);
      while (this._running || this._removing) await this.settled();
      if (gen !== this._gen) return { success: false, code: 'changed' };
      const r = await this.survey({ force: true });
      if (gen !== this._gen) return { success: false, code: 'changed' };
      const bad = r && (['declined', 'failed', 'noanswer'].includes(r.result) ? r.result : r.why === 'unreadable' ? 'unreadable' : null);
      if (bad) {
        this.store.set('storeAppsMode', false);
        this.onChange();
        return { success: false, code: bad };
      }
      this.onChange();
      return { success: true };
    }
    this.store.set('storeAppsModeOffAt', this.now());
    this.store.set('storeAppsMode', false);
    this.onChange();
    while (this._running || this._removing) await this.settled();
    if (gen !== this._gen) return { success: false, code: 'changed' };
    this._removing = this.removeOurs().finally(() => { this._removing = null; });
    return this._removing;
  }

  /* Take out the exemptions Shroudly added that are still there; the user's
   * own are not in its record. */
  async removeOurs() {
    await this._adopt(true);
    if (!this.ours().length && !this._pending().length) { await this._setOurs([]); return { success: true, removed: 0 }; }
    const s = await this.scan();
    if (!s) return { success: false, code: 'unreadable' };
    const exempt = new Set(s.exempt);
    // A Yes Shroudly did not see the end of: those are its own too.
    await this._takePending(exempt, true);
    const ours = this.ours();
    const still = ours.filter((sid) => exempt.has(sid));
    if (!still.length) { await this._setOurs([]); this.store.delete('storeAppsHandled'); return { success: true, removed: 0 }; }
    const r = await this._elevate('remove', still);
    const after = r.code === 'ok' ? await this.scan() : null;
    const left = after ? still.filter((sid) => new Set(after.exempt).has(sid)) : still;
    if (left.length === still.length) {
      this.log('warning', 'Store apps: the exemptions Shroudly added could not be taken out');
      return { success: false, code: r.code === 'ok' ? 'failed' : r.code };
    }
    await this._setOurs(left);
    // Taken out by the user's choice: asked about afresh if it is turned on again.
    this.store.delete('storeAppsHandled');
    this.log('success', `Store apps: the exemptions Shroudly added were taken out (${still.length - left.length})`);
    return { success: true, removed: still.length - left.length };
  }

  _regRecordGet() {
    return this.run(SYSTEM_TOOL('reg.exe'), ['query', RECORD_KEY, '/s'], 10000)
      .then((r) => (r.code === 0 ? parseRecord(r.stdout) : []));
  }

  /* One `reg import` for the whole list, however long; an empty one: the
   * list and the old single value deleted. */
  async _regRecordSet(list) {
    if (this.platform !== 'win32') return;
    const reg = SYSTEM_TOOL('reg.exe');
    if (!list.length) {
      await this.run(reg, ['delete', RECORD_LIST, '/f'], 10000);
      await this.run(reg, ['delete', RECORD_KEY, '/v', RECORD_VALUE, '/f'], 10000);
      return;
    }
    const file = this._tempFile('.reg');
    try {
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(recordReg(list), 'utf16le')]), { flag: 'wx' });
      await this.run(reg, ['import', file], 10000);
    } catch {
      // Not written: the settings still have the list, and the next write tries again.
    } finally {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
}

module.exports = StoreApps;
Object.assign(module.exports, {
  containerSid, familyOf, isPackage, usesNetwork, parseMappings, parseExemptList, parseScan, candidates, decide, appNames,
  runningFamilies, packagedProcesses, parseProcs, openSigns, hasAdministrators, parseRecord, recordReg, elevatedScript, launcherScript, psQuote, SCAN_PS, PROCS_PS, SID_RE, RESPECT_MS,
  RESCAN_MS, ELEVATE_TIMEOUT_MS, RECORD_KEY, RECORD_VALUE, RECORD_LIST, MAPPINGS_KEY,
});
