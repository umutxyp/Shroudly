'use strict';

/* The Windows uninstaller takes Discord app mode's line out of Discord's
 * settings. This runs the exact command from scripts/installer.nsh — read out
 * of the file, NSIS escapes undone — under real PowerShell against throwaway
 * settings files. Windows only (or wherever `pwsh` is installed). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, suite } = require('./helpers');

const t = suite('uninstall');
const shell = process.platform === 'win32' ? 'powershell'
  : (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!shell) { console.log('uninstall: skipped (no PowerShell here; runs on Windows CI)'); process.exit(0); }

const nsh = fs.readFileSync(path.join(ROOT, 'scripts', 'installer.nsh'), 'utf8');
const m = nsh.match(/nsExec::Exec `powershell (.*?) -Command "(.*?)"`/s);
if (!m) { console.error('FAIL command not found in installer.nsh'); process.exit(1); }
const script = m[2].replace(/\$\$/g, '$');   // NSIS writes a literal $ as $$

const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-appdata-'));
const write = (dir, obj) => { fs.mkdirSync(path.join(appdata, dir), { recursive: true }); fs.writeFileSync(path.join(appdata, dir, 'settings.json'), JSON.stringify(obj, null, 2)); };
const read = (dir) => fs.readFileSync(path.join(appdata, dir, 'settings.json'));
write('discord', { NEW_UPDATE_ENDPOINT: 'http://127.0.0.1:10809/', IS_MAXIMIZED: false, WINDOW_BOUNDS: { x: 1, y: 2, width: 900, height: 600 }, chromiumSwitches: {} });
write('discordptb', { NEW_UPDATE_ENDPOINT: 'https://my.mirror/', X: 1 });
// discordcanary: absent on purpose

const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, APPDATA: appdata }, encoding: 'utf8' });
t.ok(r.status === 0, `PowerShell ran it (${shell})`);
const stable = read('discord');
t.ok(!(stable[0] === 0xef && stable[1] === 0xbb), 'written without a byte-order mark (Discord would reject one)');
const obj = JSON.parse(stable.toString('utf8'));
t.ok(!('NEW_UPDATE_ENDPOINT' in obj), "our line is gone from Discord's settings");
t.ok(obj.IS_MAXIMIZED === false && obj.WINDOW_BOUNDS.width === 900 && typeof obj.chromiumSwitches === 'object', 'every other setting kept');
t.ok(JSON.parse(read('discordptb')).NEW_UPDATE_ENDPOINT === 'https://my.mirror/', "a user's own endpoint is left alone");
t.ok(!fs.existsSync(path.join(appdata, 'discordcanary')), 'a missing Discord build is not created');
fs.rmSync(appdata, { recursive: true, force: true });
console.log(`uninstall: ${t.count} passed`);
