'use strict';

/* The Protection panel in a short window (components/panelRoom.js,
 * app/globals.css, app/page.js). At the smallest size a problem banner, the
 * update banner and the support card used to stack above it and leave the
 * content area 16 to 85 px: the status and the Start/Stop button were off
 * the screen (also at the default size, with three notices). What it
 * proves:
 *   - one notice at a time above the content, a restart counting down first
 *   - the shield shrinks, then goes, then the support link, never the
 *     status or the button, and the steps never flip back and forth
 *   - the sizes the panel works with are the ones globals.css draws
 * The windows themselves were measured headlessly in every language (the
 * button on screen at 360x560 with a notice above). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const t = suite('panel-room');

// panelRoom.js is an ES module for the web UI; load it as CommonJS here.
function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/export (const|function) /g, '$1 ').replace(/^import .*$/gm, '');
  const names = [...src.matchAll(/^(?:const|function) (\w+)/gm)].map((m) => m[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-pr-'));
  const f = path.join(dir, 'm.js');
  fs.writeFileSync(f, `${src}\nmodule.exports = { ${names.join(', ')} };`);
  try { return require(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const { pickRoom, ROOMS, SUPPORT_ROOM } = load('components/panelRoom.js');
const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'app', 'page.js'), 'utf8');

// Heights measured in the window: the status block and the Start/Stop button.
const STATUS = 54;
const BUTTON = 50;
t.ok(pickRoom(560, STATUS, BUTTON, true) === 'full', 'the default size, nothing above: the whole shield');
t.ok(pickRoom(361, STATUS, BUTTON, true) === 'compact', 'the smallest size, nothing above: a smaller shield');
t.ok(pickRoom(240, STATUS, BUTTON, true) === 'tight', 'a notice above it: no shield, the status and the button stay');
t.ok(pickRoom(160, STATUS, BUTTON, true) === 'min', 'shorter still: the support link goes too');
t.ok(pickRoom(160, STATUS, BUTTON, false) === 'tight', 'no support link to give up: only the shield goes');
let last = 'full';
let monotonic = true;
for (let h = 700; h >= 100; h -= 1) {
  const r = pickRoom(h, STATUS, BUTTON, true);
  if (ROOMS.findIndex(([n]) => n === r) < ROOMS.findIndex(([n]) => n === last) && r !== 'min') monotonic = false;
  if (last === 'min' && r !== 'min') monotonic = false;
  last = r;
}
t.ok(monotonic, 'less room never brings the shield back: one step at a time as the area shrinks');
// "Not working yet": the status carries the reason and the panel the button
// that fixes it; still the first step that fits.
t.ok(pickRoom(361, 54 + 90, BUTTON + 12 + 46, false) === 'tight', 'not working yet at the smallest size: the reason and both buttons, no shield');

// The numbers the panel works with are the ones globals.css draws.
const px = (re) => { const m = css.match(re); return m ? Number(m[1]) : NaN; };
const drawn = {
  full: [px(/\.power-panel \{ gap: (\d+)px; padding-block: \d+px; \}/), px(/\.power-panel \{ gap: \d+px; padding-block: (\d+)px; \}/), px(/\.power-shield \{ --shield: (\d+)px; \}/)],
  compact: [px(/\.power-panel\[data-room='compact'\] \{ gap: (\d+)px;/), px(/\.power-panel\[data-room='compact'\] \{ gap: \d+px; padding-block: (\d+)px;/), px(/\.power-panel\[data-room='compact'\] \.power-shield \{ --shield: (\d+)px; \}/)],
  tight: [px(/\.power-panel:is\(\[data-room='tight'\], \[data-room='min'\]\) \{ gap: (\d+)px;/), px(/\.power-panel:is\(\[data-room='tight'\], \[data-room='min'\]\) \{ gap: \d+px; padding-block: (\d+)px;/), 0],
};
const same = ROOMS.every(([name, pad, gap, shield]) => drawn[name][0] === gap && drawn[name][1] === pad && drawn[name][2] === shield);
t.ok(same, `the panel's steps match globals.css (${JSON.stringify(drawn)})`);
t.ok(/\.power-panel:is\(\[data-room='tight'\], \[data-room='min'\]\) \.power-shield \{ display: none; \}/.test(css)
  && /\.power-panel\[data-room='min'\] \.power-support \{ display: none; \}/.test(css) && SUPPORT_ROOM > 0,
'the shield goes at "tight", the support link at "min"');

// One notice at a time: the slot shows its first child only, in this order.
t.ok(/\.notices > :not\(:first-child\) \{ display: none; \}/.test(css), 'the notice slot shows the first notice that has something to say');
const slot = page.slice(page.indexOf('className="notices'), page.indexOf('</div>', page.indexOf('className="notices')));
const order = ['{updateFirst && <UpdateBanner', '<BlockedNotice', '{!updateFirst', '<SupportBanner'].map((s) => slot.indexOf(s));
t.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])),
  'a restart counting down first (its "Later"), then the problem, then the update, then the support card');
t.ok(/show=\{supportCard\}/.test(slot) && /const supportCard = activeTab === 'control' && active && !notRouting && /.test(page),
  'no request for support while Shroudly is not working yet');
// The quiet link under the button: not beside the card, nor where no way of
// giving works (UXD-30).
t.ok(/const supportLink = support\.canPay && !supportCard;/.test(page) && /onSupport=\{supportLink \? openSupport : null\}/.test(page),
  'one request for support at a time, and none where giving is impossible');

console.log(`panel-room: ${t.count} passed`);
process.exit(0);
