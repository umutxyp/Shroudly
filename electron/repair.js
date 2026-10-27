'use strict';

/*
 * Repair, and Reset all settings (Settings → Application, issue #46).
 *
 * Repair puts right what can go wrong on a computer over time, without
 * touching the user's choices:
 *   - Shroudly's own files (the engine, and Advanced mode's where this
 *     system has it): one missing or empty is named, with the way to get it
 *     back (installing Shroudly again over itself keeps every setting); the
 *     app cannot fetch a part of itself on its own;
 *   - the techniques it learned for each site are forgotten, and the engine
 *     started anew (its DNS answers and its place in each site's search go
 *     with it), with the system proxy set again;
 *   - the system's DNS cache is emptied (answers a network forged before
 *     Shroudly was on stay there otherwise), where that needs no password;
 *   - the ad and tracker list is fetched again (when that is on), and
 *     Windows' WinHTTP proxy looked at.
 *
 * Reset all settings puts every setting back to how a new install has it,
 * the language excepted: the modes are turned off the way their own
 * switches do it first (Discord's settings, HTTPS_PROXY, the links,
 * the Store apps' exemptions, Advanced mode put back), the autopilot
 * forgets what the user turned off by hand, and the app starts again. What
 * Shroudly keeps for itself (its ports, whether protection was on, which
 * exemptions are its own) is not a setting and stays.
 */

const fs = require('fs');
const { execFile } = require('child_process');

/* The settings a new install does not have, or has at their default. */
const RESET_KEYS = [
  // Settings
  'autoMode', 'strategy', 'strategyId', 'dnsProtection', 'customDns', 'routeMode', 'siteList',
  'adBlock', 'adBlockAllow', 'autoStart', 'minimizeToTray', 'showTrayIcon', 'showNotifications', 'askByItself',
  'shareOnlineCount', 'autoUpdate', 'fakeTtl', 'advancedQuicBlock', 'advancedUdpFake', 'preferIpv6',
  // what the autopilot respects: a switch turned off by hand, a prompt declined
  'discordModeOffAt', 'appModeOffAt', 'advancedModeOffAt', 'advancedDeclinedAt', 'storeAppsModeOffAt',
  'storeAppsDeclinedAt', 'discordOfferDeclinedAt', 'appOfferDeclinedAt',
  // what it learned
  'learnedTechniques',
  // the modes, once turned off by their own switches (turnOffModes)
  'discordMode', 'appMode', 'storeAppsMode',
];

/* The files of { name, path } that are missing or empty: their names. */
function missingFiles(files) {
  const out = [];
  for (const f of files || []) {
    let ok = false;
    try { const st = fs.statSync(f.path); ok = st.isFile() && st.size > 0; } catch {}
    if (!ok) out.push(f.name);
  }
  return out;
}

/* The system's DNS cache emptied where no password is asked: Windows
 * (ipconfig), macOS (dscacheutil), Linux with systemd-resolved (resolvectl,
 * which some systems refuse without one: then nothing). Resolves whether
 * it was done. */
function flushDnsCache(platform = process.platform, run = execFile) {
  const cmd = platform === 'win32' ? ['ipconfig', ['/flushdns']]
    : platform === 'darwin' ? ['dscacheutil', ['-flushcache']]
      : ['resolvectl', ['flush-caches']];
  return new Promise((resolve) => {
    try {
      run(cmd[0], cmd[1], { windowsHide: true, timeout: 10000 }, (err) => resolve(!err));
    } catch { resolve(false); }
  });
}

/*
 * deps.files()          [{ name, path }] of Shroudly's own files here
 * deps.forgetLearned()  the learned techniques forgotten
 * deps.engineOn()       whether protection is on
 * deps.restartEngine()  the engine started anew, the system proxy set again
 * deps.flushDns()       -> whether the system's DNS cache was emptied
 * deps.adblock()        the ad and tracker list fetched again, when it is on
 * deps.winHttp()        Windows' WinHTTP proxy looked at
 * deps.log(level, msg)
 * Resolves { missing: [names], flushed, restarted }.
 */
async function repair(deps) {
  const log = deps.log || (() => {});
  log('info', 'Repair (Settings): checking Shroudly\'s files, forgetting learned techniques, setting the network settings again');
  const missing = missingFiles(deps.files());
  try { deps.forgetLearned(); } catch {}
  let restarted = false;
  if (deps.engineOn()) {
    try { await deps.restartEngine(); restarted = true; } catch (e) { log('warning', `Repair: the engine did not start again (${e.message})`); }
  }
  let flushed = false;
  try { flushed = await deps.flushDns(); } catch {}
  try { await deps.adblock(); } catch {}
  try { await deps.winHttp(); } catch {}
  if (missing.length) log('warning', `Repair: Shroudly's files are missing or damaged (${missing.join(', ')}); install Shroudly again over this one`);
  else log('success', 'Repair done: Shroudly\'s files are all there, and its network settings were set again');
  return { missing, flushed, restarted };
}

/*
 * deps.store            settings (get, set, delete)
 * deps.turnOffModes()   the modes turned off by their own switches
 * deps.relaunch()       the app started again
 * deps.log(level, msg)
 */
async function resetSettings(deps) {
  const log = deps.log || (() => {});
  log('info', 'Reset all settings (Settings): the modes turned off, every setting back to a new install\'s; restarting');
  try { await deps.turnOffModes(); } catch (e) { log('warning', `Reset: a mode could not be turned off (${e.message})`); }
  for (const k of RESET_KEYS) { try { deps.store.delete(k); } catch {} }
  deps.relaunch();
  return { success: true };
}

module.exports = { repair, resetSettings, missingFiles, flushDnsCache, RESET_KEYS };
