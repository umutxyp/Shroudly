'use strict';

/*
 * Riot Games' programs (League of Legends, VALORANT, the Riot Client, and the
 * installer from leagueoflegends.com) bring their own HTTP and never use the
 * system proxy: on a network that blocks Riot (#76) the website opens
 * through Shroudly while the installer says "no internet connection". The
 * autopilot turns Games and apps mode on for them as it does for Roblox
 * (main.js, autopilot.js): blocked here and Riot's client installed, or any
 * of Riot's names reported by the engine.
 *
 * Installed: the Riot Client's own record of its installs, or its usual
 * folders. Only looked at, never changed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/* The places that say Riot's client is on this computer, per system. */
function places(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    return [
      '/Users/Shared/Riot Games/RiotClientInstalls.json',
      '/Applications/Riot Client.app',
      '/Applications/League of Legends.app',
      path.join(home, 'Applications', 'Riot Client.app'),
      path.join(home, 'Applications', 'League of Legends.app'),
    ];
  }
  if (platform === 'win32') {
    const data = env.ProgramData || 'C:\\ProgramData';
    const drive = (env.SystemDrive || 'C:') + '\\';
    return [
      path.win32.join(data, 'Riot Games', 'RiotClientInstalls.json'),
      path.win32.join(drive, 'Riot Games', 'Riot Client', 'RiotClientServices.exe'),
    ];
  }
  return [];
}

function installed(platform = process.platform) { return places(platform).some(exists); }

module.exports = { places, installed };
