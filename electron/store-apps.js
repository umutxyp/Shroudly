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
 * Autopilot (autopilot.js): while protection is on, the app containers of
 * packaged apps that may use the network (internetClient, internetClient-
 * Server or privateNetworkClientServer) and have no exemption are given one,
 * all of them in one elevated step (one UAC prompt: a PowerShell that runs
 * CheckNetIsolation for each), and the user is told in one line. What
 * Shroudly added is remembered (the settings, and HKCU\Software\Shroudly for
 * the uninstaller); an exemption that was there before is never Shroudly's,
 * and is never taken out. Turning the switch off, or uninstalling, takes out
 * Shroudly's own only. A declined prompt is not repeated by itself for two
 * weeks, and the user is told which apps cannot go through Shroudly.
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

const MAPPINGS_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings';
const RECORD_KEY = 'HKCU\\Software\\Shroudly';
const RECORD_VALUE = 'LoopbackExempt';

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

/* The app containers that need an exemption: packages that may use the
 * network, with none, and not tried before (handled: what an earlier
 * elevated step asked for; one Windows would not exempt is not asked about
 * again). */
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

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const POWERSHELL = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SYSTEM_TOOL = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);

/* What runs elevated: CheckNetIsolation for each SID in `file`, one per line,
 * each checked again here, so nothing but a package SID ever reaches it. A
 * 32-bit PowerShell (the uninstaller's) reaches the 64-bit tool through
 * Sysnative. It writes nothing. */
function elevatedScript(verb, file) {
  const flag = verb === 'remove' ? '-d' : '-a';
  return [
    "$n = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { 'Sysnative' } else { 'System32' }",
    "$t = Join-Path $env:SystemRoot ($n + '\\CheckNetIsolation.exe')",
    `foreach ($s in [IO.File]::ReadAllLines(${psQuote(file)})) {`,
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
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: envFor(cmd) }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
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
   * opts.platform, opts.run(cmd, args, timeout), opts.now()   tests
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
    this.record = opts.record || {
      get: () => this._regRecordGet(),
      set: (list) => this._regRecordSet(list),
    };
    this.onChange = opts.onChange || (() => {});
    this.asked = false;          // the prompt was shown this session
    this.toldBlocked = false;    // the declined line was logged this session
    this.lastScanAt = -Infinity;
    this._running = null;
  }

  available() { return this.platform === 'win32'; }

  ours() { return (this.store.get('storeAppsOurs', []) || []).filter((s) => SID_RE.test(s)); }

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

  /* One UAC prompt; CheckNetIsolation for each SID. 'ok', 'declined' or
   * 'failed'. */
  async _elevate(verb, sids) {
    const list = sids.filter((s) => SID_RE.test(s));
    if (!list.length) return { code: 'ok' };
    let dir = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-lb-'));
      const file = path.join(dir, 'sids.txt');
      fs.writeFileSync(file, `${list.join('\r\n')}\r\n`);
      const r = await this.run(POWERSHELL(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        encode(launcherScript(elevatedScript(verb, file)))], ELEVATE_TIMEOUT_MS);
      if (r.code === 2) return { code: 'declined' };
      if (r.code !== 0) return { code: 'failed', detail: (r.stderr || '').trim().split(/\r?\n/)[0] || `exit ${r.code}` };
      return { code: 'ok' };
    } catch (e) {
      return { code: 'failed', detail: e.message };
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
  }

  _setOurs(list) {
    const v = [...new Set(list.filter((s) => SID_RE.test(s)))];
    if (v.length) this.store.set('storeAppsOurs', v); else this.store.delete('storeAppsOurs');
    try { this.record.set(v); } catch {}
  }

  /* When protection comes on, and every so often after: app containers that
   * need an exemption get one. force: the user turned the switch on. One at
   * a time. */
  survey(opts = {}) {
    if (!this._running) this._running = this._survey(opts).finally(() => { this._running = null; });
    return this._running;
  }

  /* Resolves once no survey (and so no permission prompt) is under way. */
  settled() { return this._running ? this._running.then(() => {}, () => {}) : Promise.resolve(); }

  /* The settings may have lost what Shroudly added (a reset profile) while
   * the uninstaller's record still has it: adopted once. */
  async _adopt() {
    if (this._adopted || !this.available()) return;
    this._adopted = true;
    if (this.ours().length) return;
    let rec = [];
    try { rec = await this.record.get(); } catch {}
    if (Array.isArray(rec) && rec.length) this.store.set('storeAppsOurs', rec.filter((s) => SID_RE.test(s)));
  }

  async _survey({ force = false } = {}) {
    await this._adopt();
    const why = decide({
      platform: this.platform, protectionOn: this.protectionOn(), offAt: this.store.get('storeAppsModeOffAt'),
      declinedAt: this.store.get('storeAppsDeclinedAt'), asked: this.asked, busy: this.busy(), now: this.now(), force,
    });
    if (why === 'declined' && !this.toldBlocked) return this._noteBlocked();
    if (why !== 'ask') return { asked: false, why };
    if (!force && this.now() - this.lastScanAt < RESCAN_MS) return { asked: false, why: 'recent' };
    this.lastScanAt = this.now();
    const before = await this.scan();
    if (!before) return { asked: false, why: 'unreadable' };
    const handled = this.store.get('storeAppsHandled', []) || [];
    const need = candidates({ containers: before.containers, exempt: before.exempt, handled });
    if (!need.length) return { asked: false, why: 'none' };
    // Protection may have stopped, or another prompt come up, while it read.
    if (!force && (!this.protectionOn() || this.busy())) return { asked: false, why: 'changed' };

    const apps = appNames(need).join(', ');
    this.asked = true;
    this.log('info', `Store apps: ${need.length} cannot reach Shroudly (${apps}); asking for permission`);
    this.tell('autoStoreAppsAsk', { apps });
    const r = await this._elevate('add', need.map((c) => c.sid));
    if (r.code === 'declined') {
      this.store.set('storeAppsDeclinedAt', this.now());
      this.toldBlocked = true;
      this.log('info', 'Store apps: permission was not given; Shroudly will not ask by itself again for two weeks');
      this.tell('autoStoreAppsDeclined', { apps });
      return { asked: true, result: 'declined', apps };
    }
    // What took: none of these were exempt before, so each one exempt now is
    // Shroudly's. Should the list not be readable now, all of them are
    // remembered; only those still exempt are ever taken out again.
    let added = [];
    if (r.code === 'ok') {
      const after = await this.scan();
      const now = after ? new Set(after.exempt) : null;
      added = need.map((c) => c.sid).filter((s) => !now || now.has(s));
    }
    if (r.code !== 'ok' || !added.length) {
      // Nothing changed (no administrator after all, a locked-down system):
      // the same two weeks as a decline, but said as a failure.
      this.store.set('storeAppsDeclinedAt', this.now());
      this.toldBlocked = true;
      this.log('warning', `Store apps: they could not be let through (${r.detail || 'no exemption was added'})`);
      this.tell('autoStoreAppsFailed', { apps });
      return { asked: true, result: 'failed', apps };
    }
    this._setOurs([...this.ours(), ...added]);
    // One Windows would not exempt (a container left from an app since
    // removed) is not asked about again.
    this.store.set('storeAppsHandled', [...new Set([...handled, ...need.map((c) => c.sid)])]);
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
    const need = s ? candidates({ containers: s.containers, exempt: s.exempt, handled: this.store.get('storeAppsHandled', []) }) : [];
    if (need.length) this.log('warning', `Store apps: ${appNames(need).join(', ')} cannot go through Shroudly; permission was not given`);
    return { asked: false, why: 'declined' };
  }

  /* The switch in Settings. On: ask now (the user's own request). Off: take
   * out Shroudly's own exemptions (one prompt), and leave the switch off for
   * two weeks at least. */
  async setMode(on) {
    if (!this.available()) return { success: false, code: 'unsupported' };
    if (on) {
      this.store.delete('storeAppsModeOffAt');
      this.store.delete('storeAppsDeclinedAt');
      this.store.set('storeAppsMode', true);
      const r = await this.survey({ force: true });
      const bad = r && (r.result === 'declined' || r.result === 'failed' ? r.result : r.why === 'unreadable' ? 'unreadable' : null);
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
    return this.removeOurs();
  }

  /* Take out the exemptions Shroudly added that are still there; the user's
   * own are not in its record. */
  async removeOurs() {
    await this._adopt();
    const ours = this.ours();
    if (!ours.length) { this._setOurs([]); return { success: true, removed: 0 }; }
    const s = await this.scan();
    if (!s) return { success: false, code: 'unreadable' };
    const exempt = new Set(s.exempt);
    const still = ours.filter((sid) => exempt.has(sid));
    if (!still.length) { this._setOurs([]); this.store.delete('storeAppsHandled'); return { success: true, removed: 0 }; }
    const r = await this._elevate('remove', still);
    const after = r.code === 'ok' ? await this.scan() : null;
    const left = after ? still.filter((sid) => new Set(after.exempt).has(sid)) : still;
    if (left.length === still.length) {
      this.log('warning', 'Store apps: the exemptions Shroudly added could not be taken out');
      return { success: false, code: r.code === 'ok' ? 'failed' : r.code };
    }
    this._setOurs(left);
    // Taken out by the user's choice: asked about afresh if it is turned on again.
    this.store.delete('storeAppsHandled');
    this.log('success', `Store apps: the exemptions Shroudly added were taken out (${still.length - left.length})`);
    return { success: true, removed: still.length - left.length };
  }

  _regRecordGet() {
    return this.run(SYSTEM_TOOL('reg.exe'), ['query', RECORD_KEY, '/v', RECORD_VALUE], 10000)
      .then((r) => (r.code === 0 ? parseExemptList(r.stdout) : []));
  }

  _regRecordSet(list) {
    if (this.platform !== 'win32') return Promise.resolve();
    const args = list.length
      ? ['add', RECORD_KEY, '/v', RECORD_VALUE, '/t', 'REG_SZ', '/d', list.join(';'), '/f']
      : ['delete', RECORD_KEY, '/v', RECORD_VALUE, '/f'];
    return this.run(SYSTEM_TOOL('reg.exe'), args, 10000);
  }
}

module.exports = StoreApps;
Object.assign(module.exports, {
  containerSid, familyOf, isPackage, usesNetwork, parseMappings, parseExemptList, parseScan, candidates, decide, appNames,
  elevatedScript, launcherScript, SCAN_PS, SID_RE, RESPECT_MS, RECORD_KEY, RECORD_VALUE, MAPPINGS_KEY,
});
