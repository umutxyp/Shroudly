'use strict';

/* The background process writes its log in English and the window shows it
 * in the user's language. Every line the network features write must reach a
 * translation, and every language must carry the same placeholders, or a
 * Persian or Russian user sees English or a raw "{host}". */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT, suite } = require('./helpers');

const t = suite('logtext');

// logText.js is an ES module for the web UI; load it as CommonJS here.
function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/export (const|function) /g, '$1 ').replace(/^import .*$/gm, '');
  const names = [...src.matchAll(/^(?:const|function) (\w+)/gm)].map((m) => m[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-lt-'));
  const f = path.join(dir, 'm.js');
  fs.writeFileSync(f, `${src}\nmodule.exports = { ${names.join(', ')} };`);
  try { return require(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const translations = {};
for (const f of fs.readdirSync(path.join(ROOT, 'locales')).filter((x) => x.endsWith('.json'))) {
  translations[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', f), 'utf8'));
}
const { localizeLog } = load('components/logText.js');

const LINES = [
  'discord.com: connects, then the network cuts it (stall after 5 KB). This network filters whole connections; Shroudly is trying other techniques for it.',
  'DNS answers on this network match the filtering used in IR.',
  "Your DNS service filters sites; Shroudly's encrypted DNS goes around it.",
  'Encrypted DNS answering via cloudflare-1 23ms, google-1 31ms',
  'The other VPN or bypass tool is no longer running.',
  'Cloudflare WARP is installed but not connected; that does not interfere.',
  'Port 10808 is in use by another program; Shroudly is using 10809 instead.',
  'discord.com could not be opened with encrypted DNS switched off. It has been switched back on.',
  'Discord app mode on: Discord updates through Shroudly',
  'Discord app mode off: Discord settings restored',
  'Advanced mode also drops injected resets and measures the decoy TTL',
  // Bypass and block lines keep translating when the engine adds that the
  // network dropped the attempts silently, and the auto-mode label still fits.
  'discord.com: blocked here, opened with tlsrec-sni (2 tries, ipv4)',
  'discord.com: blocked here, opened with tlsrec-sni (2 tries, ipv4) — the network drops these connections silently instead of refusing them',
  'discord.com: still blocked after 5 techniques (ipv4) — this network may need Advanced mode',
  'discord.com: no answer after 5 techniques (ipv4) — the network may be dropping these connections silently, or the site is down',
  'Shroudly engine active (strategy: auto, 16 techniques)',
  // 2.5.5: games and apps, the system proxy, DNS, unreachable hosts.
  'System proxy from the previous session could not be restored yet',
  'The system proxy points at Shroudly again',
  'KDE proxy settings are locked by the administrator',
  'System proxy settings could not be restored yet; they will be at the next start',
  'The system proxy did not change, although the administrator password was accepted',
  'The system DNS answered none of the test names. Programs that do not go through Shroudly cannot reach anything; check the DNS program or the network settings.',
  'Games and apps: Roblox is connecting through Shroudly',
  'Autopilot: Discord is blocked on this network; Discord app mode turned on',
  'Autopilot: Roblox is blocked on this network; Games and apps mode turned on',
  'Autopilot: Discord PTB did not get through Shroudly; restarted it',
  'Autopilot: a Roblox installer went around Shroudly; started it again through Shroudly',
  // Left running, the user asked to start it again: why (as main.js says it).
  'Autopilot: a Roblox installer went around Shroudly; it was left running (PowerShell is restricted here (ConstrainedLanguage)) and the user was asked to start it again',
  'Autopilot: a Roblox installer went around Shroudly; it was left running (it could not be stopped) and the user was asked to start it again',
  'Autopilot: Roblox went around Shroudly; it was left running (it runs as another user or as administrator) and the user was asked to open it again',
  'Autopilot: a Roblox installer went around Shroudly and was stopped, but the one to start in its place could not be started',
  'Autopilot: Roblox did not get through Shroudly and was closed, but could not be opened again',
  'Autopilot: Roblox Studio was opened before Shroudly could take it through; the user was asked to reopen it',
  'Autopilot: Roblox still does not get through after being restarted through Shroudly',
  'Autopilot: www.example.org needs Advanced mode; asking for permission',
  'Advanced mode was not allowed; Shroudly will not ask by itself again for two weeks',
  'The downloaded Roblox installer was not signed by Roblox, so it was deleted and not started',
  'Update ready: it waits while Roblox or Discord goes through Shroudly, and installs once they are closed or the computer has not been used for a while',
  'No tray on this desktop: the window is minimised instead of closed',
  'gone.example: could not be reached (DNS)',
  'gone.example: could not be reached (connection)',
  'Another program changed the system proxy (Wi-Fi): that traffic no longer goes through Shroudly',
  // Issue #27: a takeover set back by itself, and a program that keeps taking it.
  'Autopilot: another program changed the system proxy (AutoConfigURL); set it back to Shroudly',
  'Another program keeps changing the system proxy (AutoConfigURL); Shroudly stopped setting it back. Close the other proxy or VPN program, then set Shroudly again.',
  'Another program keeps changing the system proxy (Wi-Fi, Ethernet), probably V2Ray / Clash, Psiphon; Shroudly stopped setting it back. Close it or turn off its proxy setting, then set Shroudly again.',
  // The user's own PAC served by a program that has gone: switched off, not put back.
  'The proxy setting from before Shroudly (http://127.0.0.1:7890/pac) points at a program on this computer that is no longer running; it was switched off instead of put back',
  'System routed through local proxy on port 10808 (administrator)',
  'System DNS is a program on this computer: dnscrypt-proxy',
  'Games and apps: the first program connected through Shroudly (clientsettings.roblox.com)',
  'Roblox installer downloaded through Shroudly and started (version-0123456789abcdef)',
  'Roblox Studio installer downloaded through Shroudly and started (version-0123456789abcdef)',
  'Roblox Studio could not be downloaded (timed out)',
  'Roblox could not be downloaded (timeout)',
  'www.roblox.com: the site itself refuses this connection (it says it does not serve where you are); Shroudly does not change your address, so it cannot change this',
  'www.roblox.com: accepts the connection, then nothing comes back; either the site turns away visitors from where you are, or the network stops the connection after it is made',
  'Discord app mode: Discord Canary added',
  'A system proxy left by an earlier version could not be switched off',
  'Firefox goes through Shroudly now; Chrome and other Chromium browsers will after you log out and back in',
  'Chrome and other Chromium browsers will go through Shroudly after you log out and back in; Firefox has to be set by hand',
  'Chrome and other Chromium browsers go through Shroudly; Firefox has to be set by hand',
  'Firefox goes through Shroudly; Chrome and other Chromium browsers could not be set on this desktop',
  'Browser settings for the next login removed',
  'The address browsers use to reach Shroudly had to change; Chrome and other Chromium browsers follow the new one after you log out and back in',
  'Settings applied (strategy: auto, 16 techniques)',
  // 2.5.5: the system proxy's remaining lines, each with its reason.
  'Administrator password not given; the system proxy was not changed',
  'Could not change the system proxy as administrator: execution error: The administrator user name or password was incorrect. (-60005)',
  'Administrator password not given; the proxy settings were not put back',
  'KDE proxy setting failed: the setting did not take',
  'gsettings failed: the setting did not take',
  'Restart failed: engine start timeout',
  'Could not save proxy state: ENOSPC: no space left on device, write',
  'Proxy watchdog not started',
  'Could not install proxy restore hook: EACCES: permission denied, open \'/home/user/.config/autostart/shroudly-proxy-restore.desktop\'',
  'Could not write /home/user/.xprofile for the next login: ENOSPC: no space left on device, write',
  'Firefox goes through Shroudly; this session does not read the setting Shroudly writes for Chrome and other Chromium browsers, so they have to be set by hand',
  "This macOS account may not change the network settings without an administrator's password. Apps can still use SOCKS5 127.0.0.1:10808 directly (PAC: http://127.0.0.1:10840/proxy.pac).",
  'The desktop proxy setting could not be read. Apps can still use SOCKS5 127.0.0.1:10808 directly (PAC: http://127.0.0.1:10840/proxy.pac).',
  'The desktop refused the proxy setting. Apps can still use SOCKS5 127.0.0.1:10808 directly (PAC: http://127.0.0.1:10840/proxy.pac).',
  'This desktop has no system proxy setting. Apps can still use SOCKS5 127.0.0.1:10808 directly (PAC: http://127.0.0.1:10840/proxy.pac).',
  'This session does not read the setting Shroudly writes for Chrome and other Chromium browsers. Apps can still use SOCKS5 127.0.0.1:10808 directly (PAC: http://127.0.0.1:10840/proxy.pac).',
  'The system proxy was not set. Apps can still use SOCKS5 127.0.0.1:10808 directly (PAC: http://127.0.0.1:10840/proxy.pac).',
  'Could not update proxy routing: timeout',
  'Shroudly engine stopped',
  'Encrypted DNS unavailable: bind EADDRINUSE 127.0.0.1:53',
  'engine error: spawn /opt/Shroudly/resources/app.asar.unpacked/electron/tools/core/linux-x64/shroudly-core ENOENT',
  // Microsoft Store apps and their loopback exemptions (store-apps.js).
  'Store apps: 4 cannot reach Shroudly (Xbox, Microsoft Store, WhatsApp); asking for permission',
  'Store apps: 4 can now reach Shroudly',
  'Store apps: permission was not given; Shroudly will not ask by itself again for two weeks',
  'Store apps: they could not be let through (no exemption was added)',
  'Store apps: Xbox, Microsoft Store cannot go through Shroudly; permission was not given',
  'Store apps: the exemptions Shroudly added were taken out (4)',
  'Store apps: the exemptions Shroudly added could not be taken out',
  'Store apps: the permission prompt was not answered; Shroudly will ask again next time',
  'Store apps: Xbox, Microsoft Store cannot go through Shroudly until an administrator allows it (the Microsoft Store apps switch in Settings)',
];

const langs = Object.keys(translations);
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const line of LINES) {
  const outs = langs.map((l) => localizeLog(line, (k, p) => {
    let v = translations[l][k];
    if (v === undefined) return `MISSING:${k}`;
    for (const [a, b] of Object.entries(p || {})) v = v.split(`{${a}}`).join(b);
    return v;
  }));
  const bad = outs.map((o, i) => [langs[i], o]).filter(([l, o]) => (l !== 'en' && o === line) || /MISSING:|\{\w+\}/.test(o));
  t.ok(!bad.length, bad.length ? `untranslated: "${line.slice(0, 50)}" in ${bad.map((b) => b[0]).join(' ')}` : `translated in all ${langs.length}: ${line.slice(0, 60)}…`);
}
// Placeholders match English in every language, for every key.
const mism = [];
for (const k of Object.keys(translations.en)) for (const l of langs) if (ph(translations[l][k]) !== ph(translations.en[k])) mism.push(`${l}.${k}`);
t.ok(!mism.length, mism.length ? `placeholder mismatch: ${mism.slice(0, 10).join(', ')}` : `placeholders identical across ${langs.length} languages for all ${Object.keys(translations.en).length} keys`);
console.log(`logtext: ${t.count} passed`);
