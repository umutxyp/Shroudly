'use strict';

/*
 * The logos a user can choose between (Settings, Appearance). They are drawn
 * and written out by scripts/logo/variants.py: public/logos/<id>.png for the
 * pictures in the window, and logos/ (shipped beside the app) for what the
 * main process shows: <id>.png and <id>.ico for the window and the taskbar,
 * <id>-dock.png for the Dock. "classic" is the logo Shroudly has always had;
 * its files are the ones the app ships as its own icon.
 *
 * What a running program may change is its window's icon (Windows, Linux:
 * the taskbar follows it) and its Dock icon (macOS, while it runs). The
 * shortcut on the desktop and the file in Applications keep the icon the
 * installer gave them: no system lets a program change those for itself.
 */
const GROUPS = [
  ['styles', ['classic', 'flat', 'line', 'paper', 'key', 'veil', 'terminal', 'night', 'coral']],
  ['days', ['newyear', 'halloween', 'valentine', 'spring', 'ramadan', 'winter']],
  ['countries', ['tr', 'ir', 'ru', 'cn', 'pk', 'az', 'kz', 'eg', 'vn']],
];
const IDS = GROUPS.flatMap(([, ids]) => ids);

/* The one saved, or the classic one for anything else (an older version's
 * file, a logo that is no longer there). */
function chosen(value) { return IDS.includes(value) ? value : 'classic'; }

/* The file for `kind` ('window', 'dock') of logo `id` in the logos folder,
 * or null for the classic one: the caller keeps what it ships. */
function file(id, kind, platform = process.platform) {
  const v = chosen(id);
  if (v === 'classic') return null;
  if (kind === 'dock') return `${v}-dock.png`;
  return platform === 'win32' ? `${v}.ico` : `${v}.png`;
}

module.exports = { GROUPS, IDS, chosen, file };
