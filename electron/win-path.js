'use strict';

/*
 * Windows' own folders first on this process's PATH.
 *
 * Shroudly starts Windows' tools by name (reg.exe, powershell.exe, tasklist,
 * ipconfig, netsh...), and Windows finds them through PATH. A PATH without
 * them (rewritten by an installer or a "cleanup" tool, the PowerShell folder
 * taken out by hand, a process started with a cut-down environment) made
 * every such start fail with ENOENT: the system proxy could not be set
 * ("spawnSync reg.exe ENOENT") and Advanced mode failed at once ("PowerShell
 * exited with -1"), issue #61. So the folders Windows itself puts on PATH
 * come first, each once, the rest after them in their own order: a program
 * of the same name elsewhere on PATH is never started in their place either.
 * Only this process's environment changes (and what it starts); the user's
 * PATH setting is left as it is.
 */

const fs = require('fs');
const path = require('path');

const win = path.win32;

/* The Windows folder: the one the environment names, when it is there. */
function windowsDir(env = process.env, exists = fs.existsSync) {
  const named = [env.SystemRoot, env.windir, env.SystemDrive ? `${env.SystemDrive}\\Windows` : '', 'C:\\Windows'];
  for (const d of named) if (d && exists(win.join(d, 'System32'))) return win.normalize(d).replace(/\\+$/, '');
  return null;
}

/* The folders a standard Windows PATH starts with. */
function systemDirs(root) {
  const sys = win.join(root, 'System32');
  return [sys, root, win.join(sys, 'Wbem'), win.join(sys, 'WindowsPowerShell', 'v1.0')];
}

const key = (d) => win.normalize(String(d).trim().replace(/^"|"$/g, '')).replace(/\\+$/, '').toLowerCase();

/* PATH with Windows' folders first, each once; the others after, in order. */
function withSystemDirs(current, root) {
  const first = systemDirs(root);
  const seen = new Set(first.map(key));
  const rest = String(current || '').split(';').filter((d) => d.trim() && !seen.has(key(d)));
  return [...first, ...rest].join(';');
}

/* Puts them there; true when PATH had to change. Also names the Windows
 * folder and cmd.exe when the environment does not. */
function ensureWindowsPath(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (platform !== 'win32') return false;
  const root = windowsDir(env, exists);
  if (!root) return false;
  if (!env.SystemRoot) env.SystemRoot = root;
  if (!env.windir) env.windir = root;
  if (!env.ComSpec) env.ComSpec = win.join(root, 'System32', 'cmd.exe');
  const before = env.PATH || '';
  const after = withSystemDirs(before, root);
  // A PATH that already starts with them, in any case, is left untouched.
  const firstKeys = after.split(';').slice(0, 4).map(key).join(';');
  if (before.split(';').slice(0, 4).map(key).join(';') === firstKeys) return false;
  env.PATH = after;
  return true;
}

module.exports = { ensureWindowsPath, withSystemDirs, windowsDir, systemDirs };
