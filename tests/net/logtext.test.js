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
  // A DNS server of the user's own (issue #34), and proxies left behind.
  'Your DNS server is answering: tls://1.1.1.1:853 23ms',
  "Your DNS server tcp://8.8.8.8:53 does not answer (ECONNREFUSED); Shroudly's built-in encrypted DNS answers until it does",
  'Your DNS server https://dns.google/dns-query answers again',
  'DNS server: udp://9.9.9.9:53',
  'DNS server: automatic',
  "Games and apps: HTTPS_PROXY, ALL_PROXY pointed at http://127.0.0.1:1080, where nothing is running; Shroudly's is used while the mode is on, and the old one comes back when it goes off",
  'Autopilot: Discord Drover sent Discord to 127.0.0.1:1080, where nothing is running; its files (version.dll, drover.ini) were moved to C:\\Users\\A\\AppData\\Roaming\\Shroudly\\Discord Drover\\stable-app-1.0.9215 and it was restarted',
  'Autopilot: Discord Drover (C:\\Users\\A\\AppData\\Local\\Discord\\app-1.0.9215\\drover.ini) sends Discord to 127.0.0.1:1080, where nothing is running; its files could not be moved (EPERM)',
  'Autopilot: Telegram sends every connection to a proxy at 127.0.0.1:2080, where nothing is running; it cannot connect until that proxy runs again or its setting is removed',
  "Windows' WinHTTP proxy points at 127.0.0.1:8888, where nothing is running: Windows Update, the Microsoft Store and some programs cannot connect",
  "Windows' WinHTTP proxy cleared",
  "Windows' WinHTTP proxy could not be cleared (no administrator's permission)",
  "Telegram cannot reach its servers (149.154.167.50:443, 149.154.175.50:443): the network blocks those addresses themselves; only the app's own proxy setting or a VPN gets around that",
  "Telegram: the network stops its connections (149.154.167.50:443) and no technique got through; only the app's own proxy setting or a VPN gets around that",
  '203.0.113.9:5222: could not be reached (not a web connection)',
  '[2001:db8::9]:443: still blocked after 6 techniques (not a web connection)',
  '149.154.167.50: blocked here, opened with raw-split1 (2 tries, ipv4)',
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
  'Autopilot: Roblox Studio went around Shroudly again (started by Google Chrome); the user was told what works',
  'Autopilot: Roblox Studio went around Shroudly again; the user was told what works',
  'Games and apps: links that open roblox-player, roblox-studio go through Shroudly',
  'Games and apps: links could not be set to go through Shroudly (ERROR: Access is denied.)',
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
  // 2.6.3: Advanced mode needed and not asked for, said once with what to
  // do; modes turned off by hand; a wake; what is held back while the
  // engine restarts.
  'Autopilot: c-fra06-61574a2c.discord.media needs Advanced mode (a Discord call is starting; its sound goes over UDP); asking for permission',
  'Autopilot: Discord needs Advanced mode on this network (a Discord call is starting; its sound goes over UDP); it was not allowed on 2026-10-18, so it is not asked for by itself; turn it on in Settings',
  'Autopilot: Discord needs Advanced mode on this network (Discord is open and cannot reach it); it was turned off by hand on 2026-10-20, so it is not turned on by itself; turn it on in Settings',
  'Autopilot: cut.example needs Advanced mode on this network; it could not be started earlier in this session; turn it on in Settings',
  'Autopilot: Discord is blocked on this network, but its mode was turned off by hand on 2026-10-20; turn it on in Settings to use its app',
  'Autopilot: Roblox is blocked on this network, but its mode was turned off by hand on 2026-10-20; turn it on in Settings to use its app',
  'Store apps: Xbox, Microsoft Store cannot go through Shroudly; the switch was turned off by hand on 2026-10-20; turn it on in Settings to let them through',
  'The computer woke up or its clock changed (late); waiting times start afresh',
  'Autopilot: Discord is blocked on this network, but its mode could not be turned on (permission); turn it on in Settings to try again',
  'Autopilot: Roblox is blocked on this network, but its mode could not be turned on (unsupported); turn it on in Settings to try again',
  'Games and apps: could not reach clientsettingscdn.roblox.com (Shroudly is restarting; try again in a moment)',
  'Discord app: could not reach updates.discord.com (Shroudly is restarting; try again in a moment)',
  // Issue #29: no country in the explanation; nothing suggested while
  // Advanced mode is on; what another program changed the system proxy to,
  // and the program when it can be told.
  'DNS on this network answers blocked sites with a known block page.',
  'gateway.discord.gg: still blocked after 19 techniques (ipv4) — Advanced mode is on, and Shroudly keeps trying other ways',
  'Autopilot: another program changed the system proxy (AutoConfigURL) to no proxy (removed); set it back to Shroudly',
  'Autopilot: another program changed the system proxy (AutoConfigURL) to no proxy (removed), probably Psiphon; set it back to Shroudly',
  'Autopilot: another program changed the system proxy (AutoConfigURL) to a PAC on this computer at port 7890, probably V2Ray / Clash; set it back to Shroudly',
  'Autopilot: another program changed the system proxy (Wi-Fi, Ethernet) to a PAC on this computer at port 10999; set it back to Shroudly',
  'Another program changed the system proxy (AutoConfigURL) to a PAC file on this computer: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (AutoConfigURL) to a manual proxy on this computer, probably Fiddler: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (GNOME) to a PAC on another computer: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (KDE) to a PAC found on the network: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (AutoConfigURL) to a manual proxy on this computer at port 8118, probably privoxy: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (Wi-Fi) to a manual proxy on another computer: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (GNOME) to a manual proxy, probably V2Ray / Clash, Psiphon: that traffic no longer goes through Shroudly',
  'Another program changed the system proxy (KDE) to the proxy from the environment variables: that traffic no longer goes through Shroudly',
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
// Issue #29: what the system proxy was changed to is translated inside the
// line too, the program named as it was, and English reads as it is written.
const tr = (l) => (k, p) => {
  let v = translations[l][k];
  if (v === undefined) return `MISSING:${k}`;
  for (const [a, b] of Object.entries(p || {})) v = v.split(`{${a}}`).join(b);
  return v;
};
const NESTED = /no proxy \(removed\)|a PAC (on|at|found|file)|a manual proxy|the proxy from the environment|, probably /;
const takeoverLines = LINES.filter((l) => /changed the system proxy \(.+?\) to /.test(l));
t.ok(takeoverLines.length === 12 && takeoverLines.every((l) => localizeLog(l, tr('en')) === l),
  'issue #29: every "changed the system proxy … to …" line reads in English exactly as the app writes it');
const nestedBad = [];
for (const l of langs.filter((x) => x !== 'en')) {
  for (const line of takeoverLines) {
    const out = localizeLog(line, tr(l));
    if (NESTED.test(out) || (/probably (.+?)[:;]/.test(line) && !out.includes(/probably (.+?)(?:: that|; set)/.exec(line)[1]))) nestedBad.push(`${l}: ${out.slice(0, 80)}`);
  }
}
t.ok(!nestedBad.length, nestedBad.length ? `issue #29: what it was changed to is left in English: ${nestedBad.slice(0, 3).join(' | ')}` : `issue #29: what it was changed to, and the program, are translated in all ${langs.length - 1} other languages`);
// Issue #29: the explanation of the DNS answers names no country, in any
// language, and an older line that did is shown without it.
const countryLeft = langs.filter((l) => /\{country\}/.test(translations[l].logRegion) || /\bTR\b/.test(localizeLog('DNS answers on this network match the filtering used in TR.', tr(l))));
t.ok(!countryLeft.length, countryLeft.length ? `issue #29: a country is still named in ${countryLeft.join(' ')}` : 'issue #29: no country in the DNS explanation, in any language, old lines included');
// Placeholders match English in every language, for every key.
const mism = [];
for (const k of Object.keys(translations.en)) for (const l of langs) if (ph(translations[l][k]) !== ph(translations.en[k])) mism.push(`${l}.${k}`);
t.ok(!mism.length, mism.length ? `placeholder mismatch: ${mism.slice(0, 10).join(', ')}` : `placeholders identical across ${langs.length} languages for all ${Object.keys(translations.en).length} keys`);
console.log(`logtext: ${t.count} passed`);
