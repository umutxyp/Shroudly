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
 *     clean up, and an uninstall removes the downloads only Shroudly kept
 *   - a new install asks nothing (for this user only); a copy installed for
 *     everyone is updated where it is
 *   - Shroudly's own update of a copy installed for everyone asks for
 *     permission before anything is touched, and when it is not given
 *     starts the old Shroudly again with a note the app reads
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

// ── an uninstall: the downloads only Shroudly kept go, nothing of the user's ──
{
  const body = (nsh.match(/!macro customUnInstall\n([\s\S]*?)!macroend/) || [])[1] || '';
  const notUpdate = body.slice(body.indexOf('${ifNot} ${isUpdated}'));
  t.ok(/!insertmacro shroudlyCacheCleanup/.test(notUpdate), "an uninstall (not an update's) clears what only Shroudly's downloads kept");
  const cache = code(macro('shroudlyCacheCleanup'));
  t.ok(cache.includes('RMDir /r "$1\\shroudly-updater"') && cache.some((l) => /adblock-list\.\*/.test(l)) && cache.some((l) => /\\roblox"$/.test(l)),
    "…electron-updater's last installer (100 MB), the ad list, Roblox's installers");
  t.ok(!cache.some((l) => /Discord Drover|config\.json|logs|RMDir \/r "\$1\\\$\{PRODUCT_NAME\}"$/.test(l)) && cache.filter((l) => /^ReadEnvStr \$1 (LOCALAPPDATA|APPDATA)$/.test(l)).length === 2,
    '…not the settings, the logs or the Discord files moved aside; the user\'s own folders, from the environment');
}

// ── who it is installed for ──
{
  const mode = code(macro('customInstallMode'));
  t.ok(mode.join('\n') === '!ifndef BUILD_UNINSTALLER\n${If} $hasPerMachineInstallation == "1"\n${AndIf} $hasPerUserInstallation != "1"\nStrCpy $isForceMachineInstall "1"\n${Else}\nStrCpy $isForceCurrentInstall "1"\n${EndIf}\n!endif',
    'no "Anyone who uses this computer?" page: for this user, unless the one copy there is installed for everyone (updated where it is); the uninstaller\'s choice of copy unchanged');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  t.ok(pkg.build.nsis.oneClick === false && pkg.build.nsis.perMachine === false && pkg.build.nsis.allowToChangeInstallationDirectory === false,
    '…and no folder page: the user\'s own Programs folder, which needs no administrator (an existing copy elsewhere keeps its folder)');
}

// ── an update of a copy installed for everyone ──
{
  const body = macro('shroudlyElevateUpdate');
  const lines = code(body);
  const init = code(macro('customInit'));
  t.ok(init[init.length - 1] === '!insertmacro shroudlyElevateUpdate', 'customInit asks last, after the proxy, the links and the environment are put back for this user');
  t.ok(['${If} ${isUpdated}', '${AndIf} ${Silent}', '${AndIf} $hasPerMachineInstallation == "1"', '${AndIfNot} ${UAC_IsInnerInstance}', '${AndIfNot} ${UAC_IsAdmin}'].every((l) => lines.includes(l)),
    "only Shroudly's own silent update of a copy installed for everyone, not yet elevated: what electron-builder's install section would elevate");
  const asked = lines.indexOf('!insertmacro UAC_RunElevated');
  t.ok(asked > 0 && lines.slice(asked).join('\n').includes('${ElseIf} $0 == 0\n${AndIf} $1 == 1\nQuit'), 'permission given: the elevated copy does the update, this one just ends');
  const updaterSrc = read(path.join(ROOT, 'electron', 'updater.js'));
  t.ok(/\$\{If\} \$0 == 1223\nStrCpy \$R2 "permission"/.test(lines.join('\n')) && /permission: '/.test(updaterSrc) && /elevation: '/.test(updaterSrc),
    'refused (1223): the note says "permission"; anything else "elevation"; both steps the app knows');
  t.ok(lines.some((l) => l === '!insertmacro shroudlyFindApp $R0') && lines.some((l) => /^Sleep \d+$/.test(l)),
    '…the old Shroudly is let finish closing first (a second copy would just hand over to it and go)');
  t.ok(lines.includes('FileOpen $R0 "$R1\\${PRODUCT_NAME}\\update\\failed" w') && lines.includes('FileWrite $R0 "${VERSION} $R2"') && lines.includes('ReadEnvStr $R1 APPDATA')
    && /path\.join\(app\.getPath\('userData'\), 'update'\)/.test(updaterSrc) && /path\.join\(this\.dir, 'failed'\)/.test(updaterSrc),
  "…the note is written where the app reads it (its own folder's update\\failed: \"<version> <step>\")");
  t.ok(lines.includes(`Exec '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${'--update-failed'}'`) && /UPDATE_FAILED_ARG = '--update-failed'/.test(updaterSrc),
    '…and the Shroudly that was there is started again, as after an update that failed (its window as it was)');
  t.ok(lines[lines.length - 4] === 'Quit' && !lines.some((l) => /^(MessageBox|Abort|nsExec|ExecWait)\b|powershell/i.test(l)),
    '…then nothing is installed; no message box after Windows\' own, no PowerShell');
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
  const nsi = read(path.join(TPL, 'installer.nsi'));
  const onInit = nsi.slice(nsi.indexOf('Function .onInit'), nsi.indexOf('FunctionEnd', nsi.indexOf('Function .onInit')));
  t.ok(onInit.indexOf('!insertmacro initMultiUser') > 0 && onInit.indexOf('!insertmacro initMultiUser') < onInit.indexOf('!insertmacro customInit'),
    'template: customInit runs after the install mode is known ($hasPerMachineInstallation)');
  t.ok(/\$\{if\} \$hasPerMachineInstallation == "1"[^\n]*\n\s*\$\{andIf\} \$\{Silent\}[\s\S]{0,200}UAC_RunElevated[\s\S]{0,200}1223[\s\S]{0,300}Quit/.test(nsi),
    "template: its install section's own elevation is still the one asked first in customInit (refused, it just quits)");
  const ui = read(path.join(TPL, 'multiUserUi.nsh'));
  t.ok(/!insertmacro customInstallMode/.test(ui) && /\$isForceCurrentInstall == "1"/.test(ui) && /\$isForceMachineInstall == "1"/.test(ui),
    'template: the install-mode page still takes customInstallMode');
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

/* electron-builder's NSIS plugins (UAC, StdUtils), downloaded beside NSIS. */
function findPlugins(nsisDir) {
  const caches = [nsisDir && path.dirname(path.dirname(nsisDir)), nsisDir && path.dirname(nsisDir)].filter(Boolean);
  for (const c of caches) {
    let names = [];
    try { names = fs.readdirSync(c); } catch { continue; }
    for (const n of names.filter((x) => x.startsWith('nsis-resources'))) {
      for (const d of [path.join(c, n, 'plugins', 'x86-unicode'), ...(() => { try { return fs.readdirSync(path.join(c, n)).map((m) => path.join(c, n, m, 'plugins', 'x86-unicode')); } catch { return []; } })()]) {
        if (fs.existsSync(path.join(d, 'UAC.dll'))) return d;
      }
    }
  }
  return null;
}

const nsis = fs.existsSync(TPL) ? findMakensis() : null;
const plugins = nsis ? findPlugins(nsis.dir) : null;
if (!nsis) console.log('  --  no NSIS here (electron-builder downloads it with the first Windows build): not compiled');
else if (!plugins) console.log("  --  electron-builder's NSIS plugins (UAC) not found beside NSIS: not compiled");
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
    'Var isForceMachineInstall', 'Var isForceCurrentInstall', 'Function un.modePre', '  StrCpy $isForceMachineInstall "0"', '  StrCpy $isForceCurrentInstall "0"', '  !insertmacro customInstallMode', '  StrCpy $0 "$isForceMachineInstall$isForceCurrentInstall"', 'FunctionEnd',
    'Function un.onInit', '  Call un.modePre', 'FunctionEnd',
    'Section "un.Uninstall"', '  !insertmacro customUnInstall', '  !insertmacro customRemoveFiles', 'SectionEnd']);
  t.ok(u.ok, `the uninstaller half compiles around electron-builder's own functions, warnings as errors (${u.out})`);
  // As electron-builder's assisted installer has them: its install-mode
  // variables, the version, and the UAC plugin.
  const i = compile('installer', [...head, '!define VERSION "2.6.45"', `!addincludedir "${path.join(TPL, 'include')}"`, `!addplugindir /x86-unicode "${plugins}"`, '!include UAC.nsh',
    'Var hasPerMachineInstallation', 'Var hasPerUserInstallation', 'Var isForceMachineInstall', 'Var isForceCurrentInstall',
    inc, `OutFile "${path.join(dir, 'i.exe')}"`, 'RequestExecutionLevel user', 'SilentInstall silent',
    'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"', 'LangString uninstallFailed ${LANG_ENGLISH} "Failed to uninstall old application files."',
    fn(util, 'handleUninstallResult'),
    'Function modePre', '  StrCpy $isForceMachineInstall "0"', '  StrCpy $isForceCurrentInstall "0"', '  !insertmacro customInstallMode', 'FunctionEnd',
    'Function .onInit', '  StrCpy $hasPerMachineInstallation "0"', '  StrCpy $hasPerUserInstallation "1"', '  Call modePre', '  !insertmacro customInit',
    '  Push "SHELL_CONTEXT"', '  Call handleUninstallResult', '  Push "HKEY_CURRENT_USER"', '  Call handleUninstallResult', 'FunctionEnd',
    'Section', '  StrCpy $0 "$isForceMachineInstall$isForceCurrentInstall"', 'SectionEnd']);
  t.ok(i.ok, `the installer half compiles inside electron-builder's own check, warnings as errors (${i.out})`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`installer: ${t.count} passed`);
