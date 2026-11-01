'use strict';

/*
 * Is the user in a full-screen program: a game, a video, a presentation?
 *
 * What Shroudly does by itself then waits until they are out of it. A
 * permission prompt switches Windows to its secure desktop, and a program
 * started again opens its window, and either throws a full-screen game back
 * to the desktop in the middle of a match. So the autopilot's ask for
 * Advanced mode, Advanced mode coming back, the Store apps' prompt, Discord's
 * restart and an update's restart all wait (main.js). Shroudly's own window
 * never comes up by itself at all.
 *
 * Windows: the state Windows itself holds its notifications back by
 * (SHQueryUserNotificationState: a full-screen program, Direct3D or not, a
 * presentation, a full-screen Store app), and a borderless window over its
 * whole monitor that is not a maximised one or the desktop: what games in
 * "borderless" or "windowed full screen" are, which that state may not
 * count. Asked of a PowerShell kept running (ps-host.js), so a look every
 * half minute through a long game costs next to nothing. Linux (X11): the
 * active window's _NET_WM_STATE_FULLSCREEN. macOS: a window of the app in
 * front covering a whole screen (CGWindowListCopyWindowInfo through
 * JavaScript for Automation, which needs no permission for the bounds and
 * owners of windows), or that app keeping the display awake (a video
 * playing, a presentation: pmset's assertions). Wayland, where no window
 * can be looked at: an app keeping the session from going idle (GNOME's and
 * KDE's own inhibitors, which video players and games set). Elsewhere (a
 * PowerShell in ConstrainedLanguage mode), and on any failure: not busy, so
 * nothing ever waits on a look that cannot be made.
 */

const { execFile } = require('child_process');
const PsHost = require('./ps-host');

const CHECK_TIMEOUT_MS = 15000;
const KEEP_MS = 5000;              // one look serves everyone asking meanwhile
const WAIT_EVERY_MS = 30000;

// No newlines and no single quotes: it goes into PowerShell as one quoted string.
const CS = 'using System; using System.Runtime.InteropServices; using System.Text; ' +
  'public static class ShroudlyScreen { ' +
  '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } ' +
  '[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; } ' +
  '[DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state); ' +
  '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow(); ' +
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w, out RECT r); ' +
  '[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr w); ' +
  '[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr w, int i); ' +
  '[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr w, uint flags); ' +
  '[DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi); ' +
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr w, StringBuilder s, int n); ' +
  'public static string Now() { ' +
  'int state = 0; if (SHQueryUserNotificationState(out state) != 0) state = 0; ' +
  'IntPtr w = GetForegroundWindow(); bool covers = false, framed = true, desktop = true; ' +
  'if (w != IntPtr.Zero) { ' +
  'StringBuilder c = new StringBuilder(256); GetClassName(w, c, 256); string n = c.ToString(); ' +
  'desktop = n == "Progman" || n == "WorkerW" || n == "Shell_TrayWnd" || n == ""; ' +
  'RECT r; MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO)); ' +
  'if (GetWindowRect(w, out r) && GetMonitorInfo(MonitorFromWindow(w, 2), ref mi)) ' +
  'covers = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B; ' +
  'framed = IsZoomed(w) || (GetWindowLong(w, -16) & 0x00C00000) == 0x00C00000; } ' +
  'return state + " " + (covers ? 1 : 0) + " " + (framed ? 1 : 0) + " " + (desktop ? 1 : 0); } }';

/* Requests "<id> screen", answers "<id> screen <state> <covers> <framed> <desktop>",
 * or "<id> screen none" where the type cannot be made (ConstrainedLanguage). */
const PS_SCRIPT = [
  `$ok = $true; try { Add-Type -TypeDefinition '${CS}' -ErrorAction Stop } catch { $ok = $false }`,
  "function Get-ShroudlyAnswer([string]$l) { $f = $l -split ' '; $o = 'none'; if ($ok) { try { $o = [ShroudlyScreen]::Now() } catch {} }; $f[0] + ' ' + $f[1] + ' ' + $o }",
  'if ($env:SHROUDLY_REQ) { Get-ShroudlyAnswer $env:SHROUDLY_REQ } else { foreach ($l in $input) { Get-ShroudlyAnswer $l } }',
].join('; ');

// SHQueryUserNotificationState: 2 busy (a full-screen program), 3 Direct3D
// full screen, 4 presentation mode, 7 a full-screen Store app. 1 (locked, a
// screen saver), 5 (free) and 6 (quiet hours after setup) are not a program
// in front.
const FULL_SCREEN_STATES = new Set([2, 3, 4, 7]);

function windowsFullScreen(answer) {
  const m = /^(\d+) ([01]) ([01]) ([01])$/.exec(String(answer || '').trim());
  if (!m) return false;
  if (FULL_SCREEN_STATES.has(Number(m[1]))) return true;
  // Over the whole monitor, with no frame, not maximised, not the desktop.
  return m[2] === '1' && m[3] === '0' && m[4] === '0';
}

/* xprop -root _NET_ACTIVE_WINDOW: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007". */
function x11Active(out) {
  const m = /window id # (0x[0-9a-f]+)/i.exec(String(out || ''));
  return m && !/^0x0+$/i.test(m[1]) ? m[1] : null;
}
function x11FullScreen(out) { return /_NET_WM_STATE_FULLSCREEN/.test(String(out || '')); }

/* macOS: "<pid of the app in front> <1 when one of its windows covers a
 * whole screen, else 0>". */
const MAC_JXA = [
  "ObjC.import('AppKit'); ObjC.import('CoreGraphics');",
  'var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
  'var pid = front ? front.processIdentifier : -1;',
  'var wins = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];',
  'var screens = []; var ss = $.NSScreen.screens; for (var i = 0; i < ss.count; i++) { var f = ss.objectAtIndex(i).frame; screens.push([f.size.width, f.size.height]); }',
  'var full = wins.some(function (w) { return w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowBounds && screens.some(function (s) { return Math.abs(w.kCGWindowBounds.Width - s[0]) < 2 && Math.abs(w.kCGWindowBounds.Height - s[1]) < 2; }); });',
  "pid + ' ' + (full ? 1 : 0);",
].join(' ');

/* Whether the app in front (by the answer to MAC_JXA) is full screen or,
 * by `pmset -g assertions`, keeps the display awake. Shroudly's own window
 * in front is never a reason to wait. */
function macBusy(front, assertions, self = process.pid) {
  const m = /^(\d+) ([01])$/.exec(String(front || '').trim());
  if (!m || Number(m[1]) === self || Number(m[1]) <= 0) return false;
  if (m[2] === '1') return true;
  const re = new RegExp(`^\\s*pid ${m[1]}\\([^)]*\\):.*\\b(PreventUserIdleDisplaySleep|NoDisplaySleepAssertion)\\b`, 'm');
  return re.test(String(assertions || ''));
}

/* GNOME (IsInhibited, idle = 8) and KDE (HasInhibit) answers: "(true,)",
 * "true". */
function waylandInhibited(out) { return /\btrue\b/i.test(String(out || '')); }

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : String(out || '')));
});

function defaultLook(platform) {
  if (platform === 'win32') {
    const host = new PsHost({ script: PS_SCRIPT });
    return async () => windowsFullScreen(await host.request('screen', '', CHECK_TIMEOUT_MS));
  }
  if (platform === 'darwin') {
    return async () => macBusy(await run('osascript', ['-l', 'JavaScript', '-e', MAC_JXA]), await run('pmset', ['-g', 'assertions']));
  }
  if (platform === 'linux') {
    return async () => {
      // Wayland: no window can be looked at; an app keeping the session
      // from going idle is the sign (a native Wayland game or player).
      if (process.env.WAYLAND_DISPLAY && /gnome/i.test(process.env.XDG_CURRENT_DESKTOP || '')) {
        return waylandInhibited(await run('gdbus', ['call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', 'org.gnome.SessionManager.IsInhibited', '8']));
      }
      if (process.env.WAYLAND_DISPLAY && /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '')) {
        return waylandInhibited(await run('busctl', ['--user', 'call', 'org.freedesktop.PowerManagement', '/org/freedesktop/PowerManagement/Inhibit', 'org.freedesktop.PowerManagement.Inhibit', 'HasInhibit']));
      }
      if (!process.env.DISPLAY) return false;
      const id = x11Active(await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']));
      return !!id && x11FullScreen(await run('xprop', ['-id', id, '_NET_WM_STATE']));
    };
  }
  return async () => false;
}

class UserBusy {
  /*
   * opts.platform
   * opts.look()        whether a full-screen program is in front (tests: a stand-in)
   * opts.now()         the clock
   * opts.sleep(ms)     waits (tests: at once)
   */
  constructor(opts = {}) {
    this.look = opts.look || defaultLook(opts.platform || process.platform);
    this.now = opts.now || Date.now;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }));
    this.last = null;      // { at, busy }
    this.looking = null;
  }

  /* Whether a full-screen program is in front now. */
  fullScreen() {
    if (this.last && this.now() - this.last.at < KEEP_MS) return Promise.resolve(this.last.busy);
    if (!this.looking) {
      this.looking = (async () => {
        let busy = false;
        try { busy = !!(await this.look()); } catch {}
        this.last = { at: this.now(), busy };
        this.looking = null;
        return busy;
      })();
    }
    return this.looking;
  }

  /* Resolves once no full-screen program is in front, or once stop() is
   * true; whether it waited. onWait() is called the first time it has to. */
  async until(stop, { every = WAIT_EVERY_MS, onWait } = {}) {
    let waited = false;
    while (!stop() && await this.fullScreen()) {
      if (!waited) { waited = true; if (onWait) { try { onWait(); } catch {} } }
      await this.sleep(every);
    }
    return waited;
  }
}

module.exports = UserBusy;
module.exports.windowsFullScreen = windowsFullScreen;
module.exports.x11Active = x11Active;
module.exports.x11FullScreen = x11FullScreen;
module.exports.macBusy = macBusy;
module.exports.waylandInhibited = waylandInhibited;
module.exports.MAC_JXA = MAC_JXA;
module.exports.PS_SCRIPT = PS_SCRIPT;
