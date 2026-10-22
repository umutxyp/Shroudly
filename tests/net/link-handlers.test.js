'use strict';

/* Issue #30: Roblox Studio opened from the website's Edit button (a
 * roblox-studio: link the browser starts) went around Shroudly however
 * often it was reopened: a program started by a browser that was running
 * before Shroudly set HTTPS_PROXY gets the browser's environment, without
 * it. While Games and apps mode is on, such links go through Shroudly
 * (electron/link-handlers.js), which starts their program with the setting
 * (electron/link-open.js). What this proves:
 *   - everywhere, over a registry in memory that speaks reg export / reg
 *     import: every link of Roblox's (per-user and per-machine installs, a
 *     bootstrapper that took one over, the class chosen in Windows'
 *     settings) is taken over, and put back exactly (types, a user name
 *     such as Ümit) by Stop, by the watchdog's restore after a crash and by
 *     the uninstaller's macro (scripts/installer.nsh, interpreted here); a
 *     program that wrote its link again meanwhile keeps what it wrote; the
 *     machine's entries are never written;
 *   - everywhere: what the link starts, and with what: the program's own
 *     command with the link for %1, the setting only while Shroudly answers,
 *     a proxy of somebody else's never replaced, a value of ours from
 *     earlier taken out, a program that moved to a new version folder found;
 *   - on Windows CI, for real: a link opened by a program without the setting
 *     (as a browser started before Shroudly) starts its program without it
 *     (the cause), and with it once taken over (the fix); with Shroudly gone
 *     or its port dead the link still opens its program, without it; Stop
 *     and the restore after a crash put the registry back as it was. */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const cp = require('child_process');
const { ROOT, sleep, suite } = require('./helpers');

const t = suite('link-handlers');
const LH = require(path.join(ROOT, 'electron', 'link-handlers.js'));
const LO = require(path.join(ROOT, 'electron', 'link-open.js'));
const AppEnv = require(path.join(ROOT, 'electron', 'app-env.js'));

const HKCU = 'HKEY_CURRENT_USER';
const HKLM = 'HKEY_LOCAL_MACHINE';
const UC = `${HKCU}\\Software\\Classes`;
const MC = `${HKLM}\\Software\\Classes`;

/* ── a registry in memory, read and written as reg export / reg import do ── */
function fakeRegistry() {
  const keys = new Map(); // UPPER path -> { path, values: Map(lower name -> { name, type, data }) }
  const writes = [];
  const add = (p) => {
    const u = p.toUpperCase();
    if (!keys.has(u)) {
      keys.set(u, { path: p, values: new Map() });
      const i = p.lastIndexOf('\\');
      if (i > 0) add(p.slice(0, i));
    }
    return keys.get(u);
  };
  for (const k of [UC, MC, `${HKCU}\\Software`]) add(k);
  const under = (p) => { const u = p.toUpperCase(); return [...keys.keys()].filter((k) => k === u || k.startsWith(`${u}\\`)).sort(); };
  const set = (key, name, data, type = 'REG_SZ') => { add(key).values.set(name.toLowerCase(), { name, type, data }); };
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // As reg export writes it: REG_EXPAND_SZ as hex(2), wrapped with ",\".
  const hexLines = (head, bytes) => {
    const parts = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    const out = []; let line = head;
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i] + (i < parts.length - 1 ? ',' : '');
      if (line.length + piece.length > 77 && i < parts.length - 1) { out.push(`${line}\\`); line = '  '; }
      line += piece;
    }
    out.push(line);
    return out;
  };
  const exportText = (key) => {
    const list = under(key);
    if (!list.length) return null;
    const out = ['Windows Registry Editor Version 5.00', ''];
    for (const u of list) {
      const k = keys.get(u);
      out.push(`[${k.path}]`);
      for (const v of k.values.values()) {
        const n = v.name === '' ? '@' : `"${esc(v.name)}"`;
        if (v.type === 'REG_SZ') out.push(`${n}="${esc(v.data)}"`);
        else if (v.type === 'REG_EXPAND_SZ') out.push(...hexLines(`${n}=hex(2):`, Buffer.from(`${v.data}\0`, 'utf16le')));
        else if (v.type === 'REG_DWORD') out.push(`${n}=dword:${v.data.toString(16).padStart(8, '0')}`);
      }
      out.push('');
    }
    return out.join('\r\n');
  };
  // reg import, written apart from link-handlers.js.
  const unq = (s) => { const m = /^"((?:[^"\\]|\\.)*)"/.exec(s); return m ? [m[1].replace(/\\(.)/g, '$1'), s.slice(m[0].length)] : null; };
  const importText = (text) => {
    let cur = null;
    for (const raw of String(text).split(/\r\n/)) {
      if (!raw || raw.startsWith('Windows Registry')) continue;
      const k = /^\[(-?)(.+)\]$/.exec(raw);
      if (k) {
        if (k[1]) { for (const u of under(k[2])) keys.delete(u); cur = null; } else cur = add(k[2]);
        continue;
      }
      if (!cur) throw new Error(`import: value outside a key: ${raw}`);
      let name; let rest;
      if (raw.startsWith('@=')) { name = ''; rest = raw.slice(2); } else { const q = unq(raw); [name, rest] = [q[0], q[1].slice(1)]; }
      if (rest === '-') { cur.values.delete(name.toLowerCase()); continue; }
      if (rest.startsWith('"')) { cur.values.set(name.toLowerCase(), { name, type: 'REG_SZ', data: unq(rest)[0] }); continue; }
      const h = /^hex\(([12])\):(.*)$/.exec(rest);
      if (!h) throw new Error(`import: not understood: ${raw}`);
      const data = Buffer.from(h[2].split(',').map((x) => parseInt(x, 16))).toString('utf16le').replace(/\0+$/, '');
      cur.values.set(name.toLowerCase(), { name, type: h[1] === '2' ? 'REG_EXPAND_SZ' : 'REG_SZ', data });
    }
  };
  const io = {
    searchSync: (root, word) => [...keys.values()].filter((k) => k.path.toUpperCase().startsWith(`${root.toUpperCase()}\\`))
      .map((k) => k.path.slice(root.length + 1)).filter((n) => !n.includes('\\') && n.toLowerCase().includes(word.toLowerCase())),
    readSync: (key) => { const x = exportText(key); return x == null ? null : LH.parseReg(x); },
    writeSync: (blocks) => { writes.push(blocks); importText(LH.regText(blocks)); },
  };
  io.search = async (...a) => io.searchSync(...a);
  io.read = async (...a) => io.readSync(...a);
  io.write = async (...a) => io.writeSync(...a);
  const snap = (prefix) => JSON.stringify(under(prefix).map((u) => [keys.get(u).path, [...keys.get(u).values.values()].sort((a, b) => a.name.localeCompare(b.name))]));
  const get = (key, name) => { const k = keys.get(key.toUpperCase()); const v = k && k.values.get(name.toLowerCase()); return v || null; };
  const link = (root, scheme, cmd, { type = 'REG_SZ', label = `URL: ${scheme} Protocol` } = {}) => {
    set(`${root}\\${scheme}`, '', label);
    set(`${root}\\${scheme}`, 'URL Protocol', '');
    set(`${root}\\${scheme}\\DefaultIcon`, '', cmd.split('"')[1] || cmd);
    set(`${root}\\${scheme}\\shell\\open\\command`, '', cmd, type);
  };
  return { keys, writes, io, set, get, snap, link, exportText, importText, under };
}

/* ── the uninstaller's macro (scripts/installer.nsh), run over that registry ── */
function runNsisLinkCleanup(reg, id = 'u') {
  const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8').replace(/\r\n/g, '\n');
  const m = /!macro shroudlyLinkCleanup _ID\n([\s\S]*?)!macroend/.exec(nsh);
  if (!m) throw new Error('shroudlyLinkCleanup not found in installer.nsh');
  const lines = m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith(';')).map((l) => l.split('${_ID}').join(id));
  const v = {};
  const tok = (l) => l.match(/"[^"]*"|\S+/g);
  const val = (x) => (x.startsWith('"') ? x.slice(1, -1) : x).replace(/\$R\d/g, (r) => v[r] ?? '');
  const key = (root, sub) => `${root === 'HKCU' ? HKCU : HKLM}\\${val(sub)}`;
  const labels = {};
  lines.forEach((l, i) => { if (/^\w+:$/.test(l)) labels[l.slice(0, -1)] = i; });
  // Each ${If} to its ${Else} and ${EndIf}.
  const match = {}; const stack = [];
  lines.forEach((l, i) => {
    const w = tok(l)[0];
    if (w === '${If}') stack.push({ at: i });
    else if (w === '${Else}') stack[stack.length - 1].else = i;
    else if (w === '${EndIf}') { const s = stack.pop(); match[s.at] = { else: s.else, end: i }; if (s.else != null) match[s.else] = { end: i }; }
  });
  const cond = (a) => (a[2] === '==' ? val(a[1]).toLowerCase() === val(a[3]).toLowerCase() : val(a[1]).toLowerCase() !== val(a[3]).toLowerCase());
  let steps = 0;
  const stack2 = [];
  for (const r of ['$R5', '$R6', '$R7', '$R8', '$R9']) v[r] = `kept${r}`;
  for (let pc = 0; pc < lines.length; pc++) {
    if (++steps > 10000) throw new Error('nsis: does not end');
    const a = tok(lines[pc]);
    switch (a[0]) {
      case '${If}': {
        let ok = cond(a);
        let j = pc;
        while (tok(lines[j + 1])[0] === '${AndIf}') { j++; ok = ok && cond(tok(lines[j])); }
        if (!ok) pc = match[pc].else != null ? match[pc].else : match[pc].end;
        else pc = j;
        break;
      }
      case '${Else}': pc = match[pc].end; break;
      case '${EndIf}': break;
      case 'StrCpy': v[a[1]] = val(a[2]); break;
      case 'Push': stack2.push(val(a[1])); break;
      case 'Pop': v[a[1]] = stack2.pop(); break;
      case 'IntOp': v[a[1]] = String(Number(val(a[2])) + (a[3] === '+' ? 1 : -1) * Number(val(a[4]))); break;
      case 'StrCmp': if (val(a[1]).toLowerCase() === val(a[2]).toLowerCase()) pc = labels[a[3]]; break;
      case 'Goto': pc = labels[a[1]]; break;
      case 'EnumRegValue': {
        const k = reg.keys.get(key(a[2], a[3]).toUpperCase());
        const names = k ? [...k.values.values()].map((x) => x.name).filter(Boolean) : [];
        v[a[1]] = names[Number(val(a[4]))] || '';
        break;
      }
      case 'ReadRegStr': { const x = reg.get(key(a[2], a[3]), val(a[4])); v[a[1]] = x && /SZ$/.test(x.type) ? x.data : ''; break; }
      case 'WriteRegStr': reg.set(key(a[1], a[2]), val(a[3]), val(a[4]), 'REG_SZ'); break;
      case 'WriteRegExpandStr': reg.set(key(a[1], a[2]), val(a[3]), val(a[4]), 'REG_EXPAND_SZ'); break;
      case 'DeleteRegValue': { const k = reg.keys.get(key(a[1], a[2]).toUpperCase()); if (k) k.values.delete(val(a[3]).toLowerCase()); break; }
      case 'DeleteRegKey': {
        if (a[1] === '/ifempty') {
          const list = reg.under(key(a[2], a[3]));
          if (list.length === 1 && !reg.keys.get(list[0]).values.size) reg.keys.delete(list[0]);
        } else for (const u of reg.under(key(a[1], a[2]))) reg.keys.delete(u);
        break;
      }
      default: if (!/^\w+:$/.test(lines[pc])) throw new Error(`installer.nsh: not understood here: ${lines[pc]}`);
    }
  }
  // What the rest of the installer keeps in these registers is left as it was.
  if (stack2.length || ['$R5', '$R6', '$R7', '$R8', '$R9'].some((r) => v[r] !== `kept${r}`)) throw new Error('installer.nsh: shroudlyLinkCleanup does not give back the registers it used');
}

const PREFIX = LH.prefixFor('C:\\Users\\Ümit\\AppData\\Local\\Programs\\Shroudly\\Shroudly.exe');
const STUDIO = 'C:\\Users\\Ümit\\AppData\\Local\\Roblox\\Versions\\version-0123456789abcdef\\RobloxStudioBeta.exe';
const PLAYER = 'C:\\Users\\Ümit\\AppData\\Local\\Roblox\\Versions\\version-0123456789abcdef\\RobloxPlayerBeta.exe';

/* A user with Roblox installed for themselves, as Roblox's installers leave it. */
function perUser() {
  const r = fakeRegistry();
  r.link(UC, 'roblox-studio', `"${STUDIO}" %1`);
  r.link(UC, 'roblox-studio-auth', `"${STUDIO}" %1`);
  r.link(UC, 'roblox-player', `"${PLAYER}" %1`);
  r.link(UC, 'roblox', `"${PLAYER}" %1`);
  r.set(`${UC}\\Roblox.Place`, '', 'Roblox Place');                 // a file type, not a link
  r.set(`${UC}\\Roblox.Place\\shell\\open\\command`, '', `"${STUDIO}" "%1"`);
  r.link(UC, 'mailto', '"C:\\Program Files\\Mail\\mail.exe" "%1"');   // not Roblox's
  return r;
}

async function inMemory() {
  // ── per-user install: taken over, put back exactly ──
  {
    const r = perUser();
    const before = r.snap(HKCU);
    const machine = r.snap(HKLM);
    const lh = new LH({ io: r.io, platform: 'win32' });
    const a = await lh.apply(PREFIX);
    t.ok(a.links.join() === 'roblox,roblox-player,roblox-studio,roblox-studio-auth' && a.changed,
      `every Roblox link is taken over, nothing else (${a.links.join(', ')})`);
    const cmd = r.get(`${UC}\\roblox-studio\\shell\\open\\command`, '');
    t.ok(cmd.data === `"C:\\Users\\Ümit\\AppData\\Local\\Programs\\Shroudly\\Shroudly.exe" --open-link=roblox-studio -- "%1"` && cmd.type === 'REG_SZ',
      `roblox-studio: runs Shroudly (${cmd.data})`);
    t.ok(r.get(`${UC}\\roblox-studio\\shell\\open\\command`, LH.V.original).data === `"${STUDIO}" %1`, 'what it ran is kept beside it, exactly (a user name such as Ümit included)');
    t.ok(r.get(`${UC}\\Roblox.Place\\shell\\open\\command`, '').data === `"${STUDIO}" "%1"` && r.get(`${UC}\\mailto\\shell\\open\\command`, '').data.includes('mail.exe'),
      "a file type and another program's link are left alone");
    t.ok(r.snap(HKLM) === machine, "the machine's entries are never written");
    t.ok(r.get(LH.INDEX, 'roblox-studio').data === 'user', 'each one is listed for the restore (and the uninstaller)');
    const n = r.writes.length;
    const again = await lh.apply(PREFIX);
    t.ok(!again.changed && r.writes.length === n && again.links.length === 4, 'applied again while still ours: only read, nothing written');
    const moved = await lh.apply(LH.prefixFor('D:\\Apps\\Shroudly\\Shroudly.exe'));
    t.ok(moved.changed && r.get(`${UC}\\roblox-player\\shell\\open\\command`, '').data.startsWith('"D:\\Apps\\Shroudly\\Shroudly.exe" --open-link=roblox-player') &&
      r.get(`${UC}\\roblox-player\\shell\\open\\command`, LH.V.original).data === `"${PLAYER}" %1`, 'Shroudly installed elsewhere: the command follows it, what it stands for is kept');
    t.ok(lh.restoreSync().length === 4, 'Stop: all four put back');
    t.ok(r.snap(HKCU) === before, "the user's registry is exactly as before (values, types, nothing of ours left)");
    t.ok(lh.restoreSync().length === 0 && r.snap(HKCU) === before, 'a second restore finds nothing to do');
  }

  // ── Shroudly's own key is shared (the Store apps' list): only the list goes ──
  {
    const r = perUser();
    r.set(`${LH.OWN}\\LoopbackExemptions`, 'S-1-15-2-1-2-3-4-5-6-7', '1');
    const before = r.snap(HKCU);
    const lh = new LH({ io: r.io, platform: 'win32' });
    await lh.apply(PREFIX);
    lh.restoreSync();
    t.ok(r.snap(HKCU) === before && r.get(`${LH.OWN}\\LoopbackExemptions`, 'S-1-15-2-1-2-3-4-5-6-7'), "the Store apps' list beside it is kept");
    await lh.apply(PREFIX);
    runNsisLinkCleanup(r, 'i');
    t.ok(r.snap(HKCU) === before, '…by the installer\'s macro too');
  }

  // ── machine-wide install (Roblox installed for every user, or elevated) ──
  {
    const r = fakeRegistry();
    r.link(MC, 'roblox-studio', '"C:\\Program Files\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe" %1');
    const before = r.snap(HKCU); const machine = r.snap(HKLM);
    const lh = new LH({ io: r.io, platform: 'win32' });
    const a = await lh.apply(PREFIX);
    t.ok(a.links.join() === 'roblox-studio' && /--open-link=roblox-studio/.test(r.get(`${UC}\\roblox-studio\\shell\\open\\command`, '').data) &&
      r.get(`${UC}\\roblox-studio`, 'URL Protocol') && r.get(`${UC}\\roblox-studio\\shell\\open\\command`, LH.V.from).data === 'machine',
    "machine-wide: a link of the user's own goes in front of the machine's (a full link: name, URL Protocol, command)");
    t.ok(r.snap(HKLM) === machine, "…the machine's never written");
    lh.restoreSync();
    t.ok(r.snap(HKCU) === before && r.snap(HKLM) === machine, "put back: the user's own entry is gone again, the machine's applies");
  }

  // ── a program that writes its link again (an update) while ours is in place ──
  {
    const r = perUser();
    const lh = new LH({ io: r.io, platform: 'win32' });
    await lh.apply(PREFIX);
    const NEW = STUDIO.replace('0123456789abcdef', 'fedcba9876543210');
    r.set(`${UC}\\roblox-studio\\shell\\open\\command`, '', `"${NEW}" %1`);
    const a = await lh.apply(PREFIX);
    t.ok(a.changed && r.get(`${UC}\\roblox-studio\\shell\\open\\command`, LH.V.original).data === `"${NEW}" %1` &&
      /--open-link=roblox-studio/.test(r.get(`${UC}\\roblox-studio\\shell\\open\\command`, '').data), 'Roblox updated and wrote its link again: taken over again, its new program kept');
    r.set(`${UC}\\roblox-studio\\shell\\open\\command`, '', `"${STUDIO}" %1`);
    lh.restoreSync();
    const c = r.keys.get(`${UC}\\roblox-studio\\shell\\open\\command`.toUpperCase());
    t.ok(c.values.get('').data === `"${STUDIO}" %1` && c.values.size === 1, 'written again just before Stop: what it wrote stays, our values go');
  }

  // ── REG_EXPAND_SZ, a bootstrapper, the class chosen in Windows' settings ──
  {
    const r = fakeRegistry();
    r.link(UC, 'roblox-player', '"%LOCALAPPDATA%\\Bloxstrap\\Bloxstrap.exe" -player "%1"', { type: 'REG_EXPAND_SZ' });
    r.link(MC, 'roblox-studio', '"C:\\Program Files\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe" %1');
    r.set(`${LH.CHOICE}\\roblox-studio\\UserChoice`, 'ProgId', 'Fishstrap.Studio');
    r.set(`${UC}\\Fishstrap.Studio\\shell\\open\\command`, '', '"C:\\Users\\a\\AppData\\Local\\Fishstrap\\Fishstrap.exe" -studio "%1"');
    const before = r.snap(HKCU);
    const lh = new LH({ io: r.io, platform: 'win32' });
    const a = await lh.apply(PREFIX);
    const orig = r.get(`${UC}\\roblox-player\\shell\\open\\command`, LH.V.original);
    t.ok(orig.type === 'REG_EXPAND_SZ' && orig.data.startsWith('"%LOCALAPPDATA%') && r.get(`${UC}\\roblox-player\\shell\\open\\command`, LH.V.from).data === 'user-expand',
      'a bootstrapper that took the player\'s link over is taken over too, its REG_EXPAND_SZ command kept as such');
    t.ok(a.links.includes('roblox-studio') && /--open-link=Fishstrap\.Studio/.test(r.get(`${UC}\\Fishstrap.Studio\\shell\\open\\command`, '').data) &&
      !r.get(`${UC}\\roblox-studio\\shell\\open\\command`, ''), 'a link whose program was chosen in Windows\' settings: that program\'s class is the one taken over');
    lh.restoreSync();
    t.ok(r.snap(HKCU) === before && r.get(`${UC}\\roblox-player\\shell\\open\\command`, '').type === 'REG_EXPAND_SZ', 'put back exactly, REG_EXPAND_SZ included');
    // The user picks another program: the class taken over before is put back at the next apply.
    await lh.apply(PREFIX);
    r.set(`${LH.CHOICE}\\roblox-studio\\UserChoice`, 'ProgId', 'AppXabc123');
    const b = await lh.apply(PREFIX);
    t.ok(!b.links.includes('roblox-studio') && r.get(`${UC}\\Fishstrap.Studio\\shell\\open\\command`, '').data.includes('Fishstrap.exe') && !r.get(LH.INDEX, 'Fishstrap.Studio'),
      'a Store app chosen for it since: left alone, and the class taken over before is put back');
    lh.restoreSync();
  }

  // ── Stop, the watchdog's restore after a crash, the uninstaller ──
  {
    const fakeEnv = () => { const env = new Map(); return { env, names: { proxy: ['HTTPS_PROXY'], noProxy: ['NO_PROXY'] }, get: (k) => env.get(k) || null, set: (k, v) => env.set(k, v), del: (k) => env.delete(k), machine: () => null, persistent: null, commit: () => {} }; };
    const r = perUser();
    const before = r.snap(HKCU);
    const links = new LH({ io: r.io, platform: 'win32' });
    const e = new AppEnv({ backend: fakeEnv(), links });
    e.applySync('http://127.0.0.1:10810');
    await links.apply(PREFIX);
    t.ok(e.clearSync() === 'changed' && r.snap(HKCU) === before, 'mode off (AppEnv.clearSync): links put back with the setting');
    await links.apply(PREFIX);
    const b2 = fakeEnv();
    new AppEnv({ backend: b2, links }).applySync('http://127.0.0.1:10810');
    t.ok(AppEnv.recoverSync({ backend: b2, links }) === true && r.snap(HKCU) === before && !b2.env.size, 'after a crash (the watchdog\'s and the next start\'s restore): put back too');
    await links.apply(PREFIX);
    runNsisLinkCleanup(r, 'u');
    t.ok(r.snap(HKCU) === before, 'uninstalled while on (installer.nsh shroudlyLinkCleanup): put back exactly');
    // The uninstaller, with one link written again by Roblox and one whose
    // original was REG_EXPAND_SZ, and a machine-wide one.
    r.link(MC, 'roblox-machine-test', '"C:\\Program Files\\Roblox\\x.exe" %1');
    r.set(`${UC}\\roblox-player\\shell\\open\\command`, '', '"%LOCALAPPDATA%\\Roblox\\p.exe" %1', 'REG_EXPAND_SZ');
    const before2 = r.snap(HKCU);
    await links.apply(PREFIX);
    r.set(`${UC}\\roblox\\shell\\open\\command`, '', '"C:\\new\\RobloxPlayerBeta.exe" %1');
    runNsisLinkCleanup(r, 'u');
    const now = r.snap(HKCU);
    r.set(`${UC}\\roblox\\shell\\open\\command`, '', `"${PLAYER}" %1`);
    t.ok(r.snap(HKCU) === before2 && /new\\\\RobloxPlayerBeta/.test(now) && !r.keys.has(`${UC}\\roblox-machine-test`.toUpperCase()),
      'the uninstaller: REG_EXPAND_SZ back as such, a link written again since kept, a machine-wide one\'s user entry removed, nothing of ours left');
  }

  // ── what a link starts, and with what (link-open.js) ──
  {
    t.ok(LO.MARK === AppEnv.MARK && LO.NO_PROXY_VALUE === AppEnv.NO_PROXY_VALUE, 'the opener reads the setting by the same names app-env.js writes');
    const ok = LO.parseArgs(['Shroudly.exe', '--open-link=roblox-studio', '--', 'roblox-studio:1+launchmode:edit+task:EditPlace+placeId:1818']);
    t.ok(ok && ok.cls === 'roblox-studio' && ok.link === 'roblox-studio:1+launchmode:edit+task:EditPlace+placeId:1818', 'the link is taken as one argument');
    t.ok(!LO.parseArgs(['x', '--open-link=roblox-studio', '--', 'roblox-studio:" --inspect "']) && !LO.parseArgs(['x', '--open-link=..\\evil', '--', 'a:b']) &&
      !LO.parseArgs(['x', '--open-link=roblox', '--', '--inspect']) && !LO.parseArgs(['x']), 'nothing that is not a plain link of a plain class');
    t.ok(LO.fill('"C:\\R\\RobloxStudioBeta.exe" %1', 'roblox-studio:a%20b') === '"C:\\R\\RobloxStudioBeta.exe" roblox-studio:a%20b' &&
      LO.fill('"x.exe" -player "%1" %2', 'r:1') === '"x.exe" -player "r:1" ', 'the link goes where %1 is, as Windows puts it (its own % signs untouched)');
    t.ok(LO.expandEnv('"%LOCALAPPDATA%\\Bloxstrap\\Bloxstrap.exe" %1', { LocalAppData: 'C:\\Users\\Ümit\\AppData\\Local' }) === '"C:\\Users\\Ümit\\AppData\\Local\\Bloxstrap\\Bloxstrap.exe" %1', 'REG_EXPAND_SZ expanded as Windows does');
    const files = new Set(['C:\\Program Files\\Roblox\\R.exe']);
    const sp = LO.split('C:\\Program Files\\Roblox\\R.exe roblox:1', (p) => files.has(p));
    const sq = LO.split('"C:\\A B\\R.exe" -x "r:1"');
    t.ok(sp.file === 'C:\\Program Files\\Roblox\\R.exe' && sp.rest === 'roblox:1' && sq.file === 'C:\\A B\\R.exe' && sq.rest === '-x "r:1"', 'the program and its arguments read as CreateProcess reads them');
    const fsx = {
      statSync: (p) => { const t0 = { 'C:\\R\\Versions\\version-b\\RobloxStudioBeta.exe': 2, 'C:\\R\\Versions\\version-c\\RobloxStudioBeta.exe': 3 }[p]; if (!t0) throw new Error('ENOENT'); return { isFile: () => true, mtimeMs: t0 }; },
      readdirSync: () => ['version-b', 'version-c', 'version-d'],
    };
    t.ok(LO.current('C:\\R\\Versions\\version-a\\RobloxStudioBeta.exe', fsx) === 'C:\\R\\Versions\\version-c\\RobloxStudioBeta.exe', 'a program that moved to a newer version folder is found there');
    const url = 'http://127.0.0.1:10810';
    const vol = new Map([['SHROUDLY_APP_PROXY', url], ['HTTPS_PROXY', url], ['NO_PROXY', AppEnv.NO_PROXY_VALUE]]);
    const e1 = LO.launchEnv({ Path: 'C:\\x', https_proxy: '' }, vol, true);
    t.ok(e1.HTTPS_PROXY === url && e1.SHROUDLY_APP_PROXY === url && e1.NO_PROXY === AppEnv.NO_PROXY_VALUE && !('https_proxy' in e1) && e1.Path === 'C:\\x',
      'Shroudly answering: the program gets the setting (one name, whatever case the parent used)');
    const e2 = LO.launchEnv({ Path: 'C:\\x' }, vol, false);
    t.ok(!e2.HTTPS_PROXY && !e2.SHROUDLY_APP_PROXY, 'its port not answering (killed, the watchdog not done yet): nothing added, the link opens as it would without Shroudly');
    const e3 = LO.launchEnv({ HTTPS_PROXY: 'http://proxy.corp:8080' }, vol, true);
    t.ok(e3.HTTPS_PROXY === 'http://proxy.corp:8080' && !e3.SHROUDLY_APP_PROXY, "somebody else's proxy is never replaced");
    const e4 = LO.launchEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, vol, true);
    t.ok(e4.HTTPS_PROXY === 'http://127.0.0.1:7890', 'another local proxy (no mark of ours) is not ours either');
    const e5 = LO.launchEnv({ HTTPS_PROXY: 'http://127.0.0.1:1234', SHROUDLY_APP_PROXY: 'http://127.0.0.1:1234', NO_PROXY: AppEnv.NO_PROXY_VALUE }, new Map(), false);
    t.ok(!e5.HTTPS_PROXY && !e5.SHROUDLY_APP_PROXY && !e5.NO_PROXY, 'mode off, the parent still holding a value of ours from earlier: taken out (it would point at nothing)');
    // From the click to the program, with the registry in memory.
    const r = perUser();
    await new LH({ io: r.io, platform: 'win32' }).apply(PREFIX);
    let started = null;
    const deps = (v, live) => ({
      read: r.io.readSync, volatile: () => v, listening: async () => live, env: { Path: 'C:\\Windows', USERNAME: 'Ümit' },
      exists: () => true, fs: { statSync: () => ({ isFile: () => true }) }, start: async (file, rest, env) => { started = { file, rest, env }; return 4242; },
    });
    const code = await LO.main(['Shroudly.exe', '--open-link=roblox-studio', '--', 'roblox-studio:1+launchmode:edit'], deps(vol, true));
    t.ok(code === 0 && started.file === STUDIO && started.rest === 'roblox-studio:1+launchmode:edit' && started.env.HTTPS_PROXY === url && started.env.USERNAME === 'Ümit',
      'a click on Edit: Roblox Studio itself starts, with the link, and with the setting');
    await LO.main(['Shroudly.exe', '--open-link=roblox-studio', '--', 'roblox-studio:1'], deps(new Map(), false));
    t.ok(started.file === STUDIO && !started.env.HTTPS_PROXY, 'Shroudly not running: the same click opens Studio exactly as without Shroudly');
    const m = fakeRegistry();
    m.link(MC, 'roblox-studio', '"C:\\Program Files\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe" %1');
    await new LH({ io: m.io, platform: 'win32' }).apply(PREFIX);
    m.set(`${MC}\\roblox-studio\\shell\\open\\command`, '', '"C:\\Program Files\\Roblox\\Versions\\version-2\\RobloxStudioBeta.exe" %1');
    await LO.main(['Shroudly.exe', '--open-link=roblox-studio', '--', 'roblox-studio:1'], { ...deps(vol, true), read: m.io.readSync });
    t.ok(started.file === 'C:\\Program Files\\Roblox\\Versions\\version-2\\RobloxStudioBeta.exe', "machine-wide: the machine's current entry is run (Roblox updated it since)");
    m.set(`${MC}\\roblox-studio\\shell\\open\\command`, '', `${PREFIX} --open-link=roblox-studio -- "%1"`);
    m.set(`${UC}\\roblox-studio\\shell\\open\\command`, LH.V.original, `${PREFIX} --open-link=roblox-studio -- "%1"`);
    t.ok(await LO.main(['Shroudly.exe', '--open-link=roblox-studio', '--', 'roblox-studio:1'], { ...deps(vol, true), read: m.io.readSync }) === 3,
      'never runs itself again (no loop), whatever the registry says');
  }
}

/* ── for real, on Windows CI ── */
async function realWindows() {
  if (process.platform !== 'win32') { console.log('  --  real Windows part skipped: not Windows'); return; }
  if (!process.env.CI) { console.log('  --  real Windows part skipped outside CI (it changes this user\'s links)'); return; }
  const regExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const reg = (args) => cp.spawnSync(regExe, args, { windowsHide: true, encoding: 'utf8' });
  const VOL = 'HKCU\\Volatile Environment';
  if (reg(['query', VOL]).status !== 0) { console.log('  --  SKIPPED: this session has no HKCU\\Volatile Environment key'); return; }
  let electronExe = null;
  try { electronExe = require(path.join(ROOT, 'node_modules', 'electron')); } catch {}
  if (!electronExe || !fs.existsSync(electronExe)) { console.log('  --  SKIPPED: Electron is not installed here'); return; }

  const be = AppEnv.backend('win32');
  if (be.get('HTTPS_PROXY') || be.machine('HTTPS_PROXY') || be.persistent.get('HTTPS_PROXY')) { console.log('  --  SKIPPED: this machine has an HTTPS_PROXY of its own'); return; }

  const hex = Math.random().toString(16).slice(2, 10);
  const scheme = `shroudlytest-${hex}`;
  const mscheme = `shroudlytest-m-${hex}`;
  // A folder with a name no console code page holds: the command must come
  // back exactly from reg export / reg import.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-Ümit-ş-'));
  const rec = path.join(dir, 'rec.js');
  fs.writeFileSync(rec, `const fs = require('fs'); const path = require('path');
const link = process.argv[2] || ''; const n = (/run-(\\w+)/.exec(link) || [])[1] || 'x';
const env = {}; for (const k of Object.keys(process.env)) if (/^(https?_proxy|no_proxy|shroudly_app_proxy)$/i.test(k)) env[k.toUpperCase()] = process.env[k];
fs.writeFileSync(path.join(__dirname, 'run-' + n + '.json.tmp'), JSON.stringify({ link, env, argv: process.argv.slice(2) }));
fs.renameSync(path.join(__dirname, 'run-' + n + '.json.tmp'), path.join(__dirname, 'run-' + n + '.json'));
`);
  const command = `"${process.execPath}" "${rec}" "%1"`;
  const addLink = (root, s) => {
    const k = `${root}\\Software\\Classes\\${s}`;
    return reg(['add', k, '/ve', '/d', `URL:${s}`, '/f']).status === 0 && reg(['add', k, '/v', 'URL Protocol', '/d', '', '/f']).status === 0 &&
      reg(['add', `${k}\\shell\\open\\command`, '/ve', '/d', command, '/f']).status === 0;
  };
  const dropKeys = () => {
    reg(['delete', `HKCU\\Software\\Classes\\${scheme}`, '/f']);
    reg(['delete', `HKCU\\Software\\Classes\\${mscheme}`, '/f']);
    reg(['delete', `HKLM\\Software\\Classes\\${mscheme}`, '/f']);
  };
  try {
    t.ok(addLink('HKCU', scheme), `a link of the user's own, ${scheme}:, runs a program from ${dir}`);
    const machineToo = addLink('HKLM', mscheme);
    console.log(machineToo ? `  --  and a machine-wide one, ${mscheme}:` : '  --  no machine-wide link (not an administrator here)');
    const lh = new LH({ words: ['shroudlytest'] });
    const exp = (k) => JSON.stringify([...(LH.realIo.readSync(k) || new Map()).values()].map((x) => [x.path, [...x.values.values()]]));
    const beforeU = exp(`${UC}\\${scheme}`);
    const beforeM = machineToo ? exp(`${MC}\\${mscheme}`) : null;
    t.ok(beforeU.includes('shroudly-Ümit-ş-'), 'reg export reads it back exactly (UTF-16), the user name included');

    // Stands in for Shroudly's local proxy: its port answers.
    const server = await new Promise((resolve) => { const s = net.createServer((c) => c.destroy()); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const proxyUrl = `http://127.0.0.1:${server.address().port}`;
    // A parent without the setting, as a browser started before Shroudly.
    const parentEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(https?_proxy|no_proxy|shroudly_app_proxy)$/i.test(k)) parentEnv[k] = v;
    const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
    const open = async (s, n) => {
      const out = path.join(dir, `run-${n}.json`);
      cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${s}:run-${n}'`],
        { windowsHide: true, timeout: 60000, env: powershellEnv(parentEnv) });
      const end = Date.now() + 60000;
      while (Date.now() < end) { if (fs.existsSync(out)) return JSON.parse(fs.readFileSync(out, 'utf8')); await sleep(200); }
      return null;
    };
    const volSet = () => { for (const [k, v] of [['SHROUDLY_APP_PROXY', proxyUrl], ['HTTPS_PROXY', proxyUrl], ['NO_PROXY', AppEnv.NO_PROXY_VALUE]]) reg(['add', VOL, '/v', k, '/t', 'REG_SZ', '/d', v, '/f']); };
    const volClear = () => { for (const k of ['SHROUDLY_APP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) reg(['delete', VOL, '/v', k, '/f']); };
    const env = new AppEnv({ links: lh });
    try {
      t.ok(env.applySync(proxyUrl) === 'changed', `Games and apps mode's setting is in this session (${proxyUrl})`);
      const r1 = await open(scheme, 1);
      t.ok(r1 && r1.link === `${scheme}:run-1` && !r1.env.HTTPS_PROXY,
        `the cause: a link opened by a program without the setting starts its program without it, although the session has it (${r1 ? r1.env.HTTPS_PROXY || 'no HTTPS_PROXY' : 'nothing started'})`);
      const prefix = LH.prefixFor(electronExe, ROOT);
      const a = await lh.apply(prefix);
      t.ok(a.links.includes(scheme) && (!machineToo || a.links.includes(mscheme)), `taken over: ${a.links.join(', ')}`);
      const hkcr = reg(['query', `HKCR\\${scheme}\\shell\\open\\command`, '/ve']).stdout;
      t.ok(/--open-link=/.test(hkcr), 'Windows now runs Shroudly for it');
      const t0 = Date.now();
      const r2 = await open(scheme, 2);
      t.ok(r2 && r2.link === `${scheme}:run-2` && r2.env.HTTPS_PROXY === proxyUrl && r2.env.NO_PROXY === AppEnv.NO_PROXY_VALUE,
        `the fix: the same link, from the same parent, starts its program with the setting (${r2 ? r2.env.HTTPS_PROXY : 'nothing started'}; ${Date.now() - t0} ms from the click)`);
      if (machineToo) {
        const r2m = await open(mscheme, '2m');
        t.ok(r2m && r2m.env.HTTPS_PROXY === proxyUrl, 'a machine-wide link too');
      }
      volClear();
      const r3 = await open(scheme, 3);
      t.ok(r3 && r3.link === `${scheme}:run-3` && !r3.env.HTTPS_PROXY, 'Shroudly gone (no setting in the session): the link still opens its program, without it');
      volSet();
      await new Promise((r) => server.close(r));
      const r4 = await open(scheme, 4);
      t.ok(r4 && !r4.env.HTTPS_PROXY, 'Shroudly killed (its port dead): the link still opens its program, without the setting');
      t.ok(env.clearSync() === 'changed' && exp(`${UC}\\${scheme}`) === beforeU && (!machineToo || (exp(`${MC}\\${mscheme}`) === beforeM && !LH.realIo.readSync(`${UC}\\${mscheme}`))) &&
        !LH.realIo.readSync(LH.INDEX), 'mode off: every link exactly as before, nothing of ours left');
      const r5 = await open(scheme, 5);
      t.ok(r5 && !r5.env.HTTPS_PROXY && r5.link === `${scheme}:run-5`, 'and it opens its program directly again');
      await lh.apply(prefix);
      t.ok(AppEnv.recoverSync({ links: lh }) === true && exp(`${UC}\\${scheme}`) === beforeU, "a crash: the watchdog's restore (AppEnv.recoverSync) puts them back too");
      // The uninstaller's macro, compiled by NSIS and run for real.
      const makensis = [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NSIS', 'makensis.exe')].find((f) => fs.existsSync(f));
      if (!makensis) console.log('  --  NSIS is not installed here: the uninstaller\'s macro is checked only as interpreted above');
      else {
        await lh.apply(prefix);
        const nsi = path.join(dir, 'cleanup.nsi');
        const exe = path.join(dir, 'cleanup.exe');
        fs.writeFileSync(nsi, '\uFEFF' + ['Unicode true', '!include LogicLib.nsh', '!include WinVer.nsh', '!include WinMessages.nsh',
          `!include "${path.join(ROOT, 'scripts', 'installer.nsh')}"`, `OutFile "${exe}"`, 'RequestExecutionLevel user', 'SilentInstall silent',
          'Function .onInit', '  StrCpy $R5 "kept"', '  !insertmacro shroudlyLinkCleanup "i"', '  StrCmp $R5 "kept" +2', '  Abort', 'FunctionEnd',
          'Section', '  !insertmacro shroudlyLinkCleanup "u"', 'SectionEnd', ''].join('\r\n'));
        const c = cp.spawnSync(makensis, ['/V2', nsi], { windowsHide: true, encoding: 'utf8' });
        t.ok(c.status === 0, `installer.nsh's macro compiles with NSIS (${(c.stdout || '').split(/\r?\n/).filter(Boolean).pop() || c.status})`);
        const ran = cp.spawnSync(exe, [], { windowsHide: true, timeout: 60000 });
        t.ok(ran.status === 0 && exp(`${UC}\\${scheme}`) === beforeU && (!machineToo || !LH.realIo.readSync(`${UC}\\${mscheme}`)) && !LH.realIo.readSync(LH.INDEX),
          'and run, it puts every link back exactly (the uninstaller with Shroudly gone)');
      }
    } finally {
      try { env.clearSync(); } catch {}
      volClear();
      try { server.close(); } catch {}
      reg(['delete', `HKCU\\Software\\Classes\\${scheme}`, '/f']);
      reg(['delete', `HKCU\\Software\\Classes\\${mscheme}`, '/f']);
      if (machineToo) reg(['delete', `HKLM\\Software\\Classes\\${mscheme}`, '/f']);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  } finally {
    dropKeys();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  await inMemory();
  await realWindows();
  console.log(`link-handlers: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
