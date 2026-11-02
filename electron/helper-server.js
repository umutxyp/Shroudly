'use strict';

/*
 * Shroudly on a server, only to help ("shroudly --help-others"): a VPS or
 * any always-on machine with an open connection runs "Help people in
 * censored countries" (snowflake.js) and nothing else. No window, no tray,
 * no protection, no system setting touched; its own settings folder, so it
 * never meets a desktop Shroudly on the same machine. What it does goes to
 * standard output (a service's journal): when it starts, when someone is
 * helped, and a summary every hour.
 *
 * Safe for the machine it runs on, for the same reason as on a desktop:
 * the people helped reach only Tor's relays through it, never the machine
 * or its network, and the sites they open see a Tor exit's address, never
 * the server's. It is not an open proxy.
 *
 * On Linux without a display it needs Chromium's headless platform on the
 * command line (--ozone-platform=headless); scripts/server/ sets it up as a
 * systemd service that way.
 */

const path = require('path');

const ARG = '--help-others';
const SUMMARY_MS = 60 * 60 * 1000;

function line(level, message) {
  const out = `${new Date().toISOString()} ${level} ${message}`;
  if (level === 'error' || level === 'warning') console.error(out);
  else console.log(out);
}

/* Its own folder: --data-dir=<folder>, else "Shroudly Helper" beside the
 * desktop app's. */
function dataDir(argv, appData) {
  const given = argv.find((a) => a.startsWith('--data-dir='));
  if (given) return path.resolve(given.slice('--data-dir='.length));
  return path.join(appData, 'Shroudly Helper');
}

function run({ app, Store, Snowflake, version = '', argv = process.argv, env = process.env }) {
  app.disableHardwareAcceleration();
  try { app.setPath('userData', dataDir(argv, app.getPath('appData'))); } catch {}
  if (!app.requestSingleInstanceLock()) {
    line('error', 'Another Shroudly helper already runs with this folder.');
    app.exit(1);
    return;
  }
  // The hidden page's window is the only one, and it is closed and opened
  // again after a crash: that is no reason to quit.
  app.on('window-all-closed', () => {});
  let sf = null;
  let ending = false;
  const end = (code) => {
    if (ending) return;
    ending = true;
    line('info', 'Stopping.');
    Promise.resolve(sf && sf.stop()).catch(() => {}).finally(() => app.exit(code));
  };
  process.on('SIGTERM', () => end(0));
  process.on('SIGINT', () => end(0));

  app.whenReady().then(async () => {
    try { if (app.dock) app.dock.hide(); } catch {}
    let test = null;
    if (env.SHROUDLY_E2E === '1' && env.SHROUDLY_SNOWFLAKE_TEST) { try { test = JSON.parse(env.SHROUDLY_SNOWFLAKE_TEST); } catch {} }
    const store = new Store({ name: 'helper', clearInvalidConfig: true });
    sf = new Snowflake({ store, log: line, test });
    line('info', `Shroudly ${version || app.getVersion()} helping people in censored countries (a Snowflake proxy for Tor), folder ${app.getPath('userData')}`);
    try {
      await sf.start();
    } catch (e) {
      line('error', `Could not start: ${e.message}`);
      app.exit(1);
      return;
    }
    let total = 0;
    const summary = setInterval(() => {
      const s = sf.status();
      line('info', `Helping ${s.now} now, ${s.total} since it started (${s.total - total} in the last hour); ${s.state}`);
      total = s.total;
    }, SUMMARY_MS);
    if (summary.unref) summary.unref();
  }).catch((e) => {
    line('error', `Could not start: ${e.message}`);
    app.exit(1);
  });
}

module.exports = { ARG, run, dataDir };
