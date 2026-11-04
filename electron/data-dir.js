'use strict';

/*
 * Where Shroudly keeps what it saves (issue #72): its settings, logs, lists
 * and the window's storage. By default the system's folder for app data
 * (Windows %APPDATA%\Shroudly, macOS ~/Library/Application Support/Shroudly,
 * Linux ~/.config/Shroudly); or
 *
 *   portable   a folder named "Shroudly Data" next to the program: next to
 *              Shroudly.app on a Mac, next to the AppImage file on Linux,
 *              next to Shroudly.exe in a copy that was not installed on
 *              Windows. Its being there is the whole setting, so the folder
 *              travels with the program (a USB stick, a synced folder).
 *              Never inside an installed Windows copy: every update
 *              empties the install folder (scripts/installer.nsh).
 *   custom     any folder the user picks (Settings → Application), named in
 *              a small file left in the default folder (POINTER).
 *
 * Decided at the very start, before anything is read or written
 * (main.js), the same way for every start: the window's, the login's
 * restore, the watchdog's. A folder that cannot be used now (a USB stick
 * not plugged in, no right to write there) is not waited for: the default
 * one is used for this run, and the log says why.
 *
 * What belongs to this computer rather than to the user's Shroudly stays in
 * the default folder whatever is chosen (SYSTEM_STATE: what the system proxy,
 * Games and apps mode and Discord's line were before Shroudly changed them):
 * a login restore has to find it even when a chosen folder is missing.
 */

const fs = require('fs');
const path = require('path');

const POINTER = 'data-location.json';
const PORTABLE = 'Shroudly Data';
// Left in a portable folder the user moved away from (its files stay, in use
// by this run until it ends): the folder is no longer the setting.
const LEFT = 'not-in-use.txt';
// This computer's state: kept in the default folder (see above).
const SYSTEM_STATE = ['proxy-state.json', 'app-env.json', 'discord-line.json'];
// Not copied to a new folder: Chromium's caches and locks (made anew), the
// pointer, the computer's own state, and what is fetched again when needed.
const SKIP = new Set([POINTER, ...SYSTEM_STATE, 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Crashpad', 'blob_storage', 'Shared Dictionary', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'update', 'roblox']);

/* The folder the program is in, as a user sees it. */
function programDir({ platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  if (platform === 'darwin') {
    const m = execPath.match(/^(.*)[\\/][^\\/]+\.app[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/);
    if (m) return m[1] || '/';
  }
  if (platform === 'linux' && env.APPIMAGE) return path.dirname(env.APPIMAGE);
  return path.dirname(execPath);
}

/* An installed Windows copy (its uninstaller next to it): its folder is
 * emptied by every update. */
function installedWindows(dir, platform = process.platform) {
  if (platform !== 'win32') return false;
  try { return fs.readdirSync(dir).some((f) => /^Uninstall .*\.exe$/i.test(f)); } catch { return false; }
}

/* A folder Shroudly can keep things in: made if missing, and written to. */
function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.shroudly-write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

function readPointer(defaultDir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(defaultDir, POINTER), 'utf8')).dir;
    return typeof d === 'string' && path.isAbsolute(d) ? d : null;
  } catch { return null; }
}

/* Where this run keeps its data: { dir, how: 'default' | 'portable' |
 * 'custom', problem: null | { kind, dir } }. */
function resolve({ defaultDir, platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const prog = programDir({ platform, execPath, env });
  const portable = path.join(prog, PORTABLE);
  let problem = null;
  let isDir = false;
  try { isDir = fs.statSync(portable).isDirectory() && !fs.existsSync(path.join(portable, LEFT)); } catch {}
  if (isDir) {
    if (installedWindows(prog, platform)) problem = { kind: 'portable-installed', dir: portable };
    else if (usable(portable)) return { dir: portable, how: 'portable', problem: null };
    else problem = { kind: 'unwritable', dir: portable };
  }
  const chosen = readPointer(defaultDir);
  if (chosen && path.resolve(chosen) !== path.resolve(defaultDir)) {
    if (usable(chosen)) return { dir: chosen, how: 'custom', problem };
    problem = { kind: 'unreachable', dir: chosen };
  }
  return { dir: defaultDir, how: 'default', problem };
}

/* What the log says about a folder that could not be used this run. */
function problemLine(p) {
  if (!p) return null;
  if (p.kind === 'portable-installed') return `Data folder: "${p.dir}" is inside the installed program's folder, which every update empties; it is not used (choose a folder in Settings → Application instead)`;
  if (p.kind === 'unwritable') return `Data folder: "${p.dir}" cannot be written to; the default folder is used this time`;
  return `Data folder: "${p.dir}" is not reachable now (a drive not connected?); the default folder is used this time, and the chosen one again once it is there`;
}

/* The choices Settings offers, for the window. */
function choices({ current, defaultDir, platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const prog = programDir({ platform, execPath, env });
  const portable = path.join(prog, PORTABLE);
  let canPortable = !installedWindows(prog, platform);
  // A program folder the user cannot write to (an install for every user,
  // /opt on Linux, /Applications without rights) has no room next to it.
  if (canPortable) {
    try { fs.accessSync(prog, fs.constants.W_OK); } catch { canPortable = false; }
  }
  return { current: current.dir, how: current.how, defaultDir, portable: canPortable ? portable : null };
}

function copyInto(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name === LEFT || e.name.startsWith('.shroudly-write-')) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (fs.existsSync(dst)) continue;   // what is there already is kept
    if (e.isDirectory()) fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}

/* Settings, a new place: 'default', 'portable', or a folder's path. What is
 * kept now is copied there (nothing already there is overwritten, and the
 * old folder is left as it was), then the choice is written down. The caller
 * restarts Shroudly. { ok, dir } or { ok: false, error }. */
function choose(target, { current, defaultDir, platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const c = choices({ current, defaultDir, platform, execPath, env });
  let to;
  if (target === 'default') to = defaultDir;
  else if (target === 'portable') { if (!c.portable) return { ok: false, error: 'portable' }; to = c.portable; }
  else if (typeof target === 'string' && path.isAbsolute(target)) to = path.resolve(target);
  else return { ok: false, error: 'path' };
  // Inside the installed program's folder: emptied by every update.
  const prog = programDir({ platform, execPath, env });
  if (installedWindows(prog, platform) && (to + path.sep).toLowerCase().startsWith((prog + path.sep).toLowerCase())) return { ok: false, error: 'installed' };
  if (!usable(to)) return { ok: false, error: 'unwritable' };
  if (path.resolve(to) === path.resolve(current.dir)) return { ok: true, dir: to, same: true };
  try { copyInto(current.dir, to); } catch (e) { return { ok: false, error: 'copy', detail: e.message }; }
  try {
    const pointer = path.join(defaultDir, POINTER);
    // Leaving a portable folder: it would still win at the next start, so
    // it says it is not in use (its files are this run's until it ends).
    if (current.how === 'portable' && target !== 'portable') {
      fs.writeFileSync(path.join(current.dir, LEFT), 'Shroudly does not use this folder any more: its data was copied to the folder chosen in Settings. Delete this file to use this folder again.\n');
    }
    if (target === 'portable') { try { fs.unlinkSync(path.join(to, LEFT)); } catch {} }
    if (target === 'default' || target === 'portable') { try { fs.unlinkSync(pointer); } catch {} }
    else { fs.mkdirSync(defaultDir, { recursive: true }); fs.writeFileSync(pointer, `${JSON.stringify({ dir: to })}\n`); }
  } catch (e) { return { ok: false, error: 'pointer', detail: e.message }; }
  return { ok: true, dir: to };
}

module.exports = { resolve, choose, choices, problemLine, programDir, installedWindows, POINTER, PORTABLE, LEFT, SYSTEM_STATE };
