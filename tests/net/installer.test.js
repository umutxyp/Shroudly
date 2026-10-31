'use strict';

/* The Windows installer's hooks into electron-builder (scripts/installer.nsh)
 * that keep an install from being stopped by what an antivirus did to the
 * previous one. Checked:
 *   - an old uninstaller that fails or cannot start no longer stops the
 *     install, and the two hooks keep to the rules of the electron-builder
 *     function they run in (no labels, no stack, none of its variables)
 *   - this version's uninstaller, run by the next update, moves every file it
 *     can instead of giving up at the first it cannot
 *   - Windows 10 is told from the registry, so a compatibility setting on
 *     the installer cannot make it refuse to install
 *   - the uninstaller starts PowerShell only when there is something to
 *     clean up
 *   - electron-builder's template still has the hook points these rely on
 *   - and, wherever NSIS is found (the one electron-builder downloads, or
 *     one installed on Windows), both halves compile with warnings as errors,
 *     around the template's own functions, as the real build does. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, suite } = require('./helpers');

const t = suite('installer');
// Git on Windows checks the files out with CRLF line ends.
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const nsh = read(path.join(ROOT, 'scripts', 'installer.nsh'));
const TPL = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const macro = (name) => { const m = nsh.match(new RegExp(`!macro ${name}(?:[^\\n]*)\\n([\\s\\S]*?)!macroend`)); return m ? m[1] : null; };
const code = (body) => body.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);

// ── an old uninstaller that fails ──
{
  const inner = macro('shroudlyOldUninstallerFailed');
  for (const hook of ['customUnInstallCheck', 'customUnInstallCheckCurrentUser']) {
    const body = macro(hook);
    t.ok(!!body && /!insertmacro shroudlyOldUninstallerFailed/.test(body), `${hook} is defined`);
    const all = code(`${body}\n${inner}`);
    t.ok(!all.some((l) => /^[\w.]+:$/.test(l)), `${hook}: no labels (both run inside one electron-builder function)`);
    t.ok(!all.some((l) => /\$(installationDir|uninstallString)\b/.test(l)), `${hook}: none of electron-builder's later variables (a warning, so a failed build)`);
    t.ok(!all.some((l) => /^(Push|Pop|Exch)\b/.test(l)), `${hook}: the stack left alone`);
    t.ok(!all.some((l) => /^(Quit|Abort|SetErrorLevel|MessageBox)\b/.test(l)), `${hook}: never stops the install, never asks`);
  }
  t.ok(/\$\{If\} \$\{Errors\}/.test(inner) && /\$\{ElseIf\} \$R0 != 0/.test(inner) && /ClearErrors\s*$/.test(inner.trim()),
    'it reads only the error flag (could not start) and $R0 (its exit code), and leaves the flag clear');
}

// ── this uninstaller, as the next update's old one ──
{
  const body = macro('customRemoveFiles');
  const lines = code(body || '');
  t.ok(!!body && /\$\{if\} \$\{isUpdated\}\nCreateDirectory "\$PLUGINSDIR\\old-install"\nPush ""\nCall un\.shroudlyMoveOut\n\$\{endif\}/.test(lines.join('\n')),
    'customRemoveFiles: on an update, every file that can be moved is moved aside');
  t.ok(!lines.some((l) => /^(Abort|Quit)\b|un\.restoreFiles/.test(l)), '…and nothing is put back and given up on');
  t.ok(/SetOutPath \$TEMP\nRMDir \/r \$INSTDIR$/.test(lines.join('\n')), '…then the folder is removed, as electron-builder does');
  const fn = nsh.match(/!ifdef BUILD_UNINSTALLER\n\s*Function un\.shroudlyMoveOut\n([\s\S]*?)FunctionEnd\n!endif/);
  t.ok(!!fn, 'its function exists only in the uninstaller (an unused function would fail the installer build)');
  const f = code(fn ? fn[1] : '');
  t.ok(f.some((l) => /^Rename "\$INSTDIR\$R0\\\$R2" "\$PLUGINSDIR\\old-install\$R0\\\$R2"$/.test(l)) && !f.some((l) => /^(Abort|Quit|Delete)\b/.test(l)),
    '…which moves each file where electron-builder would, skips one it cannot, and deletes nothing itself');
  const pushes = f.filter((l) => /^(Push|Exch)\b/.test(l)).length; const pops = f.filter((l) => /^Pop\b/.test(l)).length;
  t.ok(f[0] === 'Exch $R0' && pushes === pops + 1 && f.filter((l) => l === 'Call un.shroudlyMoveOut').length === 1,
    '…and leaves the stack as it found it (its one argument taken, every register given back)');
}

// ── Windows 10, from the registry ──
{
  const body = macro('customInit');
  t.ok(/ReadRegDWORD \$0 HKLM "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" "CurrentMajorVersionNumber"/.test(body) && /\$\{If\} \$0 < 10/.test(body),
    'Windows 10 or later is read from the registry');
  t.ok(!/AtLeastWin|WinVer/.test(nsh), "…not from Windows' version call, which a compatibility setting changes");
}

// ── PowerShell only when there is something to clean up ──
{
  const discord = macro('shroudlyDiscordCleanup');
  const gate = discord.slice(0, discord.indexOf('nsExec::Exec'));
  t.ok(/ReadEnvStr \$1 APPDATA/.test(gate) && ['discord', 'discordptb', 'discordcanary', 'discorddevelopment'].every((d) => gate.includes(`\${FileExists} "$1\\${d}\\settings.json"`)),
    "Discord: PowerShell only when one of Discord's settings files is there (the user's APPDATA, as PowerShell's)");
  t.ok(/\$\{EndIf\}\s*$/.test(discord.trim()), '…and only then');
  const lb = macro('shroudlyLoopbackCleanup');
  const before = lb.slice(0, lb.indexOf('nsExec::Exec'));
  t.ok(/EnumRegValue \$0 HKCU "Software\\Shroudly\\LoopbackExemptions" 0/.test(before) && /\$\{If\} \$2 == "LoopbackExempt"/.test(before) && /\$\{Else\}\s*$/.test(before.trim()),
    'Store apps: PowerShell only when Shroudly listed an exemption (a value in the list, or the old single value)');
  t.ok(/\$\{If\} \$0 == ""\n\s*DeleteRegKey \/ifempty HKCU "Software\\Shroudly\\LoopbackExemptions"/.test(lb), '…an empty list is just removed');
}

// ── electron-builder's template still works the way these hooks expect ──
if (!fs.existsSync(TPL)) console.log('  --  electron-builder is not installed here (npm ci): its template not checked');
else {
  const util = read(path.join(TPL, 'include', 'installUtil.nsh'));
  const un = read(path.join(TPL, 'uninstaller.nsh'));
  t.ok(/!insertmacro customUnInstallCheck\n\s*Return/.test(util) && /!insertmacro customUnInstallCheckCurrentUser\n\s*Return/.test(util),
    "template: each uninstall-check hook replaces electron-builder's check (Return right after it)");
  t.ok(/!ifmacrodef customRemoveFiles\n\s*!insertmacro customRemoveFiles\n\s*!else/.test(un) && /Function un\.atomicRMDir/.test(un) && /Function un\.restoreFiles/.test(un),
    'template: customRemoveFiles replaces its file removal, and its two functions are there');
  t.ok(/CreateDirectory "\$PLUGINSDIR\\old-install"\n\s*\n\s*Push ""\n\s*Call un\.atomicRMDir/.test(un) && /SetOutPath \$TEMP\n[^\n]*\n\s*RMDir \/r \$INSTDIR/.test(un),
    "template: its own removal is the one customRemoveFiles repeats (moved aside on an update, then the folder removed)");
}

// ── compiled, warnings as errors ──
function findMakensis() {
  const found = [];
  const caches = process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')]
    : process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Caches', 'electron-builder')]
      : [path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-builder')];
  const exe = process.platform === 'win32' ? path.join('Bin', 'makensis.exe') : path.join(process.platform === 'darwin' ? 'mac' : 'linux', 'makensis');
  for (const c of caches) {
    // nsis-3.0.4.1/<extracted>/ (electron-builder 26) or nsis/nsis-3.0.4.1/ (older)
    for (const d of [path.join(c, 'nsis-3.0.4.1'), path.join(c, 'nsis')]) {
      let names = [];
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const n of names) if (fs.existsSync(path.join(d, n, exe))) found.push({ bin: path.join(d, n, exe), dir: path.join(d, n) });
    }
  }
  if (process.platform === 'win32') {
    for (const p of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (p && fs.existsSync(path.join(p, 'NSIS', 'makensis.exe'))) found.push({ bin: path.join(p, 'NSIS', 'makensis.exe'), dir: null });
    }
  }
  return found[0] || null;
}

const nsis = fs.existsSync(TPL) ? findMakensis() : null;
if (!nsis) console.log('  --  no NSIS here (electron-builder downloads it with the first Windows build): not compiled');
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-nsis-'));
  const un = read(path.join(TPL, 'uninstaller.nsh'));
  const util = read(path.join(TPL, 'include', 'installUtil.nsh'));
  const fn = (src, name) => src.match(new RegExp(`Function ${name.replace('.', '\\.')}\\n[\\s\\S]*?FunctionEnd`))[0];
  const head = ['Unicode true', '!define PRODUCT_NAME "Shroudly"', '!define APP_EXECUTABLE_FILENAME "Shroudly.exe"', '!define UNINSTALL_FILENAME "Uninstall Shroudly.exe"',
    '!include LogicLib.nsh',
    // electron-builder's flag test, as it generates it
    '!macro _isUpdated _a _b _t _f', '  StrCmp "$R9" "true" `${_t}` `${_f}`', '!macroend', '!define isUpdated `"" isUpdated ""`'];
  const compile = (name, lines) => {
    const file = path.join(dir, `${name}.nsi`);
    fs.writeFileSync(file, [...lines, ''].join('\n'));
    const r = spawnSync(nsis.bin, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', file],
      { encoding: 'utf8', env: nsis.dir ? { ...process.env, NSISDIR: nsis.dir } : process.env, timeout: 120000, windowsHide: true });
    return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ') };
  };
  const inc = `!include "${path.join(ROOT, 'scripts', 'installer.nsh')}"`;
  const u = compile('uninstaller', ['!define BUILD_UNINSTALLER', ...head, inc, `OutFile "${path.join(dir, 'u.exe')}"`, 'RequestExecutionLevel user', 'SilentInstall silent',
    fn(un, 'un.atomicRMDir'), fn(un, 'un.restoreFiles'),
    'Section', `  WriteUninstaller "${path.join(dir, 'uninstall.exe')}"`, 'SectionEnd',
    'Section "un.Uninstall"', '  !insertmacro customUnInstall', '  !insertmacro customRemoveFiles', 'SectionEnd']);
  t.ok(u.ok, `the uninstaller half compiles around electron-builder's own functions, warnings as errors (${u.out})`);
  const i = compile('installer', [...head, inc, `OutFile "${path.join(dir, 'i.exe')}"`, 'RequestExecutionLevel user', 'SilentInstall silent',
    'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"', 'LangString uninstallFailed ${LANG_ENGLISH} "Failed to uninstall old application files."',
    fn(util, 'handleUninstallResult'),
    'Function .onInit', '  !insertmacro customInit', '  Push "SHELL_CONTEXT"', '  Call handleUninstallResult', '  Push "HKEY_CURRENT_USER"', '  Call handleUninstallResult', 'FunctionEnd',
    'Section', 'SectionEnd']);
  t.ok(i.ok, `the installer half compiles inside electron-builder's own check, warnings as errors (${i.out})`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`installer: ${t.count} passed`);
