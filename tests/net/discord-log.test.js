'use strict';

/* A report's Discord part carries Discord's own last log lines (a build stuck
 * on its "Starting" screen says why there): the newest .log of the last day
 * in its settings folder, its logs folder or next to Update.exe, the last
 * lines only, the home folder and the user's name taken out; nothing when
 * there is no fresh log. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers');
const DiscordApp = require('../../electron/discord-app');

const t = H.suite('discord-log');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-dlog-'));
const v = { settingsDir: path.join(root, 'discord'), updateExe: path.join(root, 'Local', 'Discord', 'Update.exe') };
fs.mkdirSync(path.join(v.settingsDir, 'logs'), { recursive: true });
fs.mkdirSync(path.dirname(v.updateExe), { recursive: true });

t.ok(DiscordApp.logTail(v) === null, 'no log: nothing');

const home = os.homedir();
const user = path.basename(home);
const old = path.join(v.settingsDir, 'old.log');
fs.writeFileSync(old, 'old line\n');
const twoDays = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
fs.utimesSync(old, twoDays, twoDays);
t.ok(DiscordApp.logTail(v) === null, 'a log older than a day is not taken');

const lines = Array.from({ length: 40 }, (_, i) => `[2026-11-08] line ${i}`);
lines.push(`Updater: could not write ${path.join(home, 'AppData', 'Local', 'Discord', 'app-1.0.9')} for ${user}`);
fs.writeFileSync(path.join(v.settingsDir, 'logs', 'discord_updater.log'), lines.join('\r\n') + '\r\n');
const r = DiscordApp.logTail(v, 15);
t.ok(r && r.lines.length === 15 && r.lines[0] === '[2026-11-08] line 26', `the last 15 lines (${r && r.lines[0]})`);
const last = r.lines[r.lines.length - 1];
t.ok(!last.includes(home) && last.includes('~') && (user.length <= 2 || !last.includes(user)), `the home folder and the user's name taken out (${last})`);
t.ok(!r.file.includes(home) && r.ageMin === 0, `the file named without the home folder (${r.file})`);

fs.writeFileSync(path.join(path.dirname(v.updateExe), 'SquirrelSetup.log'), 'newest\n');
const later = (Date.now() + 5000) / 1000;
fs.utimesSync(path.join(path.dirname(v.updateExe), 'SquirrelSetup.log'), later, later);
t.ok(DiscordApp.logTail(v).lines[0] === 'newest', 'the newest log of the three places is taken');

console.log(`discord-log: ${t.count} passed`);
