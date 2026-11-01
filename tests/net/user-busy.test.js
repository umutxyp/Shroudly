'use strict';

/* A full-screen game, video or presentation in front (electron/user-busy.js):
 * what Shroudly does by itself waits for the user to be out of it, so a
 * permission prompt or a restarted program never throws a game back to the
 * desktop in the middle of a match (a report by e-mail, 2026-10-26). */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const UserBusy = require(path.join(ROOT, 'electron', 'user-busy.js'));
const PsHost = require(path.join(ROOT, 'electron', 'ps-host.js'));
const { windowsFullScreen, x11Active, x11FullScreen } = UserBusy;
const t = suite('user-busy');

// Windows: "<notification state> <covers its monitor> <framed or maximised> <the desktop>".
t.ok(windowsFullScreen('2 0 1 0') && windowsFullScreen('3 1 0 0') && windowsFullScreen('4 0 1 0') && windowsFullScreen('7 0 1 0'),
  'a full-screen program, Direct3D full screen, a presentation, a full-screen Store app: busy');
t.ok(!windowsFullScreen('5 0 1 0') && !windowsFullScreen('6 0 1 0'), 'nothing full screen: free');
t.ok(!windowsFullScreen('1 0 1 0'), 'a locked screen is not a program in front');
t.ok(windowsFullScreen('5 1 0 0'), 'a borderless game over its whole monitor, which the state does not count: busy');
t.ok(!windowsFullScreen('5 1 1 0'), 'a maximised window over the monitor (an auto-hidden taskbar): free');
t.ok(!windowsFullScreen('5 1 0 1'), 'the desktop itself: free');
t.ok(['none', '', null, undefined, 'error|x', '2 0 1'].every((a) => !windowsFullScreen(a)), 'no answer, or one that cannot be read: free (nothing waits on a look that failed)');

// Linux (X11).
t.ok(x11Active('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007') === '0x3a00007', 'the active window read from xprop');
t.ok(x11Active('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0') === null && x11Active('') === null, 'no active window: none');
t.ok(x11FullScreen('_NET_WM_STATE(ATOM) = _NET_WM_STATE_FULLSCREEN, _NET_WM_STATE_FOCUSED'), 'a full-screen window: busy');
t.ok(!x11FullScreen('_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ') && !x11FullScreen(null), 'maximised or unknown: free');

// macOS (ML-7): the app in front full screen, or keeping the display awake
// (a video, a presentation); not another app's assertion (caffeinate), not
// Shroudly's own window, not an answer that cannot be read.
const { macBusy, waylandInhibited } = UserBusy;
const PM = '   pid 2515(Brave Browser): [0x00022f8a0005971a] 00:00:52 NoDisplaySleepAssertion named: "Video Wake Lock"\n'
  + '   pid 900(caffeinate): [0x1] 01:00:00 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"\n';
t.ok(macBusy('2515 1', '') && macBusy('2515 0', PM) && macBusy('77 0', '   pid 77(Keynote): [0x2] 00:01:00 PreventUserIdleDisplaySleep named: "Presentation"'),
  'macOS: full screen in front, or the app in front playing a video or a presentation: busy');
t.ok(!macBusy('2515 0', '') && !macBusy('333 0', PM) && !macBusy(`${process.pid} 1`, '') && !macBusy(null, PM) && !macBusy('garbage', PM),
  'macOS: an ordinary window, another app keeping the display awake, Shroudly itself, or no answer: free');
t.ok(waylandInhibited('(true,)') && waylandInhibited('b true') && !waylandInhibited('(false,)') && !waylandInhibited(null),
  'Wayland (GNOME, KDE): an app keeping the session from going idle: busy');
if (process.platform === 'darwin') {
  // The look itself runs here, without a permission prompt, and says something.
  const { execFileSync } = require('child_process');
  let out = '';
  try { out = execFileSync('osascript', ['-l', 'JavaScript', '-e', UserBusy.MAC_JXA], { encoding: 'utf8', timeout: 15000 }); } catch {}
  // A CI runner may have no app in front (-1), or no window server at all.
  if (!out.trim() && process.env.CI) console.log('  --  no window server on this runner: the look is checked on a Mac with a screen');
  else t.ok(/^-?\d+ [01]$/.test(out.trim()), `macOS: the look at the app in front answers (${out.trim() || 'nothing'})`);
}

(async () => {
  // One look serves everyone asking at once, and for a few seconds after.
  {
    let looks = 0;
    let clock = 0;
    const b = new UserBusy({ look: async () => { looks++; await new Promise((r) => setTimeout(r, 10)); return true; }, now: () => clock });
    const all = await Promise.all([b.fullScreen(), b.fullScreen(), b.fullScreen()]);
    t.ok(all.every(Boolean) && looks === 1, 'three asking at once: one look');
    clock += 1000; await b.fullScreen();
    t.ok(looks === 1, 'asked again a second later: the same answer');
    clock += 10000; await b.fullScreen();
    t.ok(looks === 2, 'asked again later: looked again');
  }
  {
    const b = new UserBusy({ look: async () => { throw new Error('no PowerShell'); } });
    t.ok((await b.fullScreen()) === false, 'a look that fails: free');
  }
  // until(): waits while a full-screen program is in front, says so once.
  {
    let clock = 0;
    let busyFor = 3;
    let waits = 0;
    let told = 0;
    const b = new UserBusy({ look: async () => busyFor-- > 0, now: () => clock, sleep: async (ms) => { waits++; clock += ms; } });
    const waited = await b.until(() => false, { every: 30000, onWait: () => { told++; } });
    t.ok(waited && waits === 3 && told === 1, `three looks in a game, then out of it: waited ${waits} times, told once`);
    const free = new UserBusy({ look: async () => false, sleep: async () => { throw new Error('must not wait'); } });
    t.ok((await free.until(() => false)) === false, 'nothing in front: no wait at all');
    let stopNow = false;
    const stuck = new UserBusy({ look: async () => true, now: () => clock, sleep: async (ms) => { clock += ms; stopNow = true; } });
    t.ok((await stuck.until(() => stopNow)) === true, 'a game that never ends: the wait still ends when told to (protection stopped)');
  }

  // The real look, on this system: never throws, always a yes or no.
  {
    const b = new UserBusy();
    const r = await b.fullScreen();
    t.ok(r === true || r === false, `the look on ${process.platform}: ${r ? 'busy' : 'free'}`);
  }
  // Windows: the PowerShell part compiles and answers in the form read above
  // (a runner's session may have no foreground window: then the desktop).
  if (process.platform === 'win32') {
    const host = new PsHost({ script: UserBusy.PS_SCRIPT });
    const a = await host.request('screen', '', 60000);
    host.stop();
    t.ok(/^\d+ [01] [01] [01]$/.test(String(a || '')), `Windows answers the screen state (${a})`);
  }

  console.log(`user-busy: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
