#!/usr/bin/env node
'use strict';

/*
 * The polkit action Advanced mode asks under on Linux, installed by the deb,
 * rpm and pacman packages (package.json, their fpm lists) as
 * /usr/share/polkit-1/actions/me.codeshare.shroudly.policy. Without it pkexec
 * uses its own generic action, and the password window names a raw path to
 * the engine and gives no reason; with it, the window says what Shroudly
 * asks for, in the user's language (locales/*.json, polkitAdvanced*).
 *
 * The action covers exactly the engine those packages install
 * (org.freedesktop.policykit.exec.path); an AppImage runs a copy elsewhere,
 * which a file installed for the system cannot name.
 *
 *   node scripts/gen-polkit.js          write it
 *   node scripts/gen-polkit.js --check  fail if it is not what it would write
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'linux', 'me.codeshare.shroudly.policy');
// Where electron-builder's deb, rpm and pacman put the app (/opt/<productName>),
// and where advanced-mode.js (advBinaryPath) finds the engine in it.
const ENGINE = '/opt/Shroudly/resources/app.asar.unpacked/electron/tools/core/linux-x64/shroudly-core-adv';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render() {
  const dir = path.join(ROOT, 'locales');
  const langs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const all = Object.fromEntries(langs.map((l) => [l, JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'))]));
  // polkit matches a translation by the language alone once the locale's
  // country and encoding are cut off (de_DE.UTF-8 -> de), so plain codes.
  const lines = (key, tag) => [
    `    <${tag}>${esc(all.en[key])}</${tag}>`,
    ...langs.filter((l) => l !== 'en' && all[l][key] && all[l][key] !== all.en[key])
      .map((l) => `    <${tag} xml:lang="${l}">${esc(all[l][key])}</${tag}>`),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">',
    '<!-- Written by scripts/gen-polkit.js from locales/*.json: change those. -->',
    '<policyconfig>',
    '  <vendor>Shroudly</vendor>',
    '  <vendor_url>https://github.com/umutxyp/Shroudly</vendor_url>',
    '  <icon_name>shroudly</icon_name>',
    '  <action id="me.codeshare.shroudly.advanced">',
    ...lines('polkitAdvancedDescription', 'description'),
    ...lines('polkitAdvancedMessage', 'message'),
    '    <defaults>',
    '      <allow_any>auth_admin</allow_any>',
    '      <allow_inactive>auth_admin</allow_inactive>',
    '      <allow_active>auth_admin</allow_active>',
    '    </defaults>',
    `    <annotate key="org.freedesktop.policykit.exec.path">${ENGINE}</annotate>`,
    '  </action>',
    '</policyconfig>',
    '',
  ].join('\n');
}

const want = require.main === module ? render() : null;
if (want == null) {
  // required by a test: nothing written
} else if (process.argv.includes('--check')) {
  let have = '';
  // (A checkout that turned the line ends into CRLF reads the same.)
  try { have = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'); } catch {}
  if (have !== want) { console.error(`[polkit] ${path.relative(ROOT, OUT)} is out of date: run node scripts/gen-polkit.js`); process.exit(1); }
  console.log('[polkit] up to date');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, want);
  console.log(`[polkit] wrote ${path.relative(ROOT, OUT)}`);
}

module.exports = { ENGINE, render };
