'use strict';

/* The logos a user can choose between (Settings, Appearance), on every
 * system: the same list in the same order in the desktop's window
 * (components/Appearance.js) and main process (electron/logos.js), on
 * Android (Logos.kt) and in the Apple apps (Logos.swift), as the drawing
 * script makes them (scripts/logo/variants.py); every file each of them
 * needs is there; the desktop puts the choice on the window, the taskbar
 * and the Dock, and ships the files for it. */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');
const Logos = require('../../electron/logos');

const t = suite('logos');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const has = (...p) => fs.existsSync(path.join(ROOT, ...p));

const groups = Logos.GROUPS;
t.ok(Logos.IDS.length === 24 && new Set(Logos.IDS).size === 24 && Logos.IDS[0] === 'classic', `24 logos, the classic one first (${Logos.IDS.length})`);

const list = (ids, q) => ids.map((i) => `${q}${i}${q}`).join(', ');
const renderer = read('components', 'Appearance.js');
const script = read('scripts', 'logo', 'variants.py');
const kotlin = read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'Logos.kt');
const swift = read('apple', 'App', 'Logos.swift');
for (const [g, ids] of groups) {
  t.ok(renderer.includes(`['${g}', [${list(ids, "'")}]]`), `the window has the ${g} as the main process does`);
  t.ok(script.includes(`('${g}', [${list(ids, "'")}])`), `the drawing script has the ${g}`);
  t.ok(kotlin.includes(`"${g}" to listOf(${list(ids, '"')})`), `Android has the ${g}`);
  t.ok(swift.includes(`("${g}", [${list(ids, '"')}])`), `the Apple apps have the ${g}`);
}

const missing = [];
for (const id of Logos.IDS) {
  const need = [['public', 'logos', `${id}.png`], ['android', 'app', 'src', 'main', 'res', 'drawable-nodpi', `logo_${id}.png`],
    ['apple', 'App', 'Assets.xcassets', `LogoPick-${id}.imageset`, 'logo.png']];
  if (id !== 'classic') {
    need.push(['logos', `${id}.png`], ['logos', `${id}.ico`], ['logos', `${id}-dock.png`],
      ['android', 'app', 'src', 'main', 'res', 'mipmap-anydpi', `ic_logo_${id}.xml`], ['android', 'app', 'src', 'main', 'res', 'drawable-nodpi', `logo_${id}_fg.png`],
      ['apple', 'App', 'Assets.xcassets', `Logo-${id}.appiconset`, 'logo.png'], ['apple', 'App', 'Assets.xcassets', `LogoDock-${id}.imageset`, 'logo.png']);
  }
  for (const p of need) if (!has(...p)) missing.push(p.join('/'));
}
t.ok(missing.length === 0, `every file every system needs is there (missing: ${missing.slice(0, 5).join(', ') || 'none'})`);

t.ok(Logos.chosen('nope') === 'classic' && Logos.chosen('tr') === 'tr', 'an unknown logo (an older version\'s, say) is the classic one');
t.ok(Logos.file('classic', 'window') === null && Logos.file('tr', 'window', 'win32') === 'tr.ico' && Logos.file('tr', 'window', 'linux') === 'tr.png' && Logos.file('tr', 'dock') === 'tr-dock.png',
  'the classic one keeps the files the app ships; another has its own for the window and the Dock');

const main = read('electron', 'main.js');
t.ok(/if \(key === 'logo'\) applyLogo\(\);/.test(main) && /mainWindow\.setIcon\(trayIconPath\(\)\)/.test(main) && /app\.dock\.setIcon\(dockImage\.img\)/.test(main),
  'a choice goes on the window, the taskbar and the Dock at once');
t.ok(/app\.dock\.setIcon\(null\)/.test(main) && !/'icon\.icns'/.test(main.slice(main.indexOf('function applyLogo'), main.indexOf('function reapplyLogoSoon'))),
  'the classic one hands the Dock the app\'s own icon at once (icon.icns, which nativeImage cannot read, left it until a restart)');
t.ok(/app\.dock\.show\(\)\)\.then\(\(\) => reapplyLogoSoon\(\)\)/.test(main) && /'did-become-active', \(\) => reapplyLogoSoon\(\)/.test(main),
  'and back on the Dock each time it shows or the app comes to the front');
t.ok(/tray\.setImage\(makeTrayIcon\(!!trayLook\)\)/.test(main) && /function trayLogo\(/.test(main), 'the tray and the menu bar show the chosen logo too, dimmed while off');

// "Colour follows the icon": one table on every system.
const accentOf = (src, re) => { const o = {}; for (const m of src.matchAll(re)) o[m[1]] = m[2]; return o; };
const js = accentOf(read('components', 'Appearance.js').split('LOGO_ACCENT = {')[1].split('};')[0], /'?(\w+)'?: '(\w+)'/g);
const kt = accentOf(read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'Accent.kt').split('LOGO_ACCENT = mapOf(')[1].split(')\n')[0], /"(\w+)" to "(\w+)"/g);
const sw = accentOf(read('apple', 'App', 'Accent.swift').split('logoAccent: [String: String] = [')[1].split(']')[0], /"(\w+)": "(\w+)"/g);
t.ok(Logos.IDS.every((id) => js[id] && js[id] === kt[id] && js[id] === sw[id]), 'every logo has its accent, the same on the desktop, Android and the Apple apps');
const cp = read('components', 'ControlPanel.js');
t.ok(/logoSrc\(logo\)/.test(cp) && /power-logo/.test(cp), 'the power button shows the chosen logo');
t.ok(/Logos\.picture\(Logos\.id\(a\)\)/.test(read('android', 'app', 'src', 'main', 'java', 'me', 'codeshare', 'shroudly', 'Chrome.kt')), 'Android\'s header shows the chosen logo');
const pkg = JSON.parse(read('package.json'));
t.ok(pkg.build.extraResources.some((x) => x && x.from === 'logos' && x.to === 'logos'), 'the files ship with the app');

const ios = read('apple', 'Shroudly.xcodeproj', 'project.pbxproj');
const alt = Logos.IDS.filter((i) => i !== 'classic').map((i) => `Logo-${i}`).join(' ');
t.ok((ios.match(new RegExp(`"ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES\\[sdk=iphone\\*\\]" = "${alt}"`, 'g')) || []).length === 2,
  'iPhone and iPad get every logo as an alternate icon, in both builds');

console.log(`logos: ${t.count} passed`);
