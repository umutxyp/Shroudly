'use strict';

/* Riot Games (#76): League of Legends, VALORANT and their installer never use
 * the system proxy, so on a network that blocks Riot the autopilot turns on
 * Games and apps mode for them, as for Roblox. Covered:
 *   - where Riot's client is looked for, per system
 *   - Riot's names are a service of the autopilot's
 *   - a blocked Riot name the engine reports turns the mode on, with no Riot
 *     program installed yet (someone about to run the installer)
 *   - main.js wires it to Games and apps mode with its own words */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');
const RiotApp = require(path.join(ROOT, 'electron', 'riot-app.js'));
const Autopilot = require(path.join(ROOT, 'electron', 'autopilot.js'));

const t = suite('riot-app');

(async () => {
  const mac = RiotApp.places('darwin', {}, '/Users/x');
  t.ok(mac.includes('/Users/Shared/Riot Games/RiotClientInstalls.json') && mac.includes('/Applications/League of Legends.app'),
    'macOS: the Riot Client\'s record of its installs and the apps');
  const win = RiotApp.places('win32', { ProgramData: 'D:\\PD', SystemDrive: 'E:' }, 'C:\\Users\\x');
  t.ok(win.includes('D:\\PD\\Riot Games\\RiotClientInstalls.json') && win.includes('E:\\Riot Games\\Riot Client\\RiotClientServices.exe'),
    'Windows: the same record under ProgramData, and the client in its usual folder');
  t.ok(RiotApp.places('linux').length === 0 && typeof RiotApp.installed('linux') === 'boolean' && RiotApp.installed('linux') === false,
    'Linux: no Riot client to look for');

  for (const h of ['www.leagueoflegends.com', 'xsso.leagueoflegends.com', 'auth.riotgames.com', 'clientconfig.rpg.riotgames.com', 'playvalorant.com', 'lol.secure.dyn.riotcdn.net']) {
    t.ok(Autopilot.familyOf(h) === 'riot', `${h} is Riot's`);
  }
  t.ok(Autopilot.familyOf('notriotgames.com') === null && Autopilot.familyOf('riotgames.com.evil.example') === null, 'look-alike names are not');

  // The engine reports a Riot name no technique opened; the check says it is
  // blocked here: the mode comes on, though no Riot program is installed.
  const store = new Map();
  const st = { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) };
  const enabled = [];
  const told = [];
  const ap = new Autopilot({
    store: st, log: () => {}, tell: (id) => told.push(id), protectionOn: () => true,
    check: async (h) => ({ blocked: /leagueoflegends|riotgames/.test(h), how: 'tls', detail: 'reset' }),
    services: [{
      id: 'riot', name: 'Riot Games', probe: 'www.leagueoflegends.com', mode: 'appMode', needsApp: false,
      present: () => false,
      enable: async () => { enabled.push('riot'); st.set('appMode', true); return { success: true }; },
      logOn: 'on', told: 'autoRiotOn', toldOff: 'autoRiotOffByHand', toldFailed: 'autoRiotFailed',
    }],
    now: () => 1e12, later: () => ({}),
  });
  ap.noteHost('blocked', 'xsso.leagueoflegends.com', {});
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  t.ok(enabled.length === 1 && told.includes('autoRiotOn') && st.get('appMode') === true,
    'a blocked Riot name turns Games and apps mode on, with no Riot program installed yet');

  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  t.ok(/id: 'riot', name: 'Riot Games', probe: 'www\.leagueoflegends\.com', mode: 'appMode', needsApp: false/.test(main)
    && /RiotApp\.installed\(\)/.test(main) && /told: 'autoRiotOn'/.test(main), 'main.js: Riot is a service of Games and apps mode');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
  t.ok(['autoRiotOn', 'logAutoRiotOn', 'autoRiotOffByHand', 'autoRiotFailed'].every((k) => en[k] && /Riot Games/.test(en[k])), 'its own words');

  console.log(`riot-app: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
