'use strict';

/*
 * Builds the list "Block ads and trackers" uses, on the desktop and on
 * Android alike (the engine's core/src/adblock.c reads it).
 *
 * The blocking is by name, as AdGuard DNS, NextDNS or Pi-hole block, never
 * inside a page. So what is taken from each source is what a name decides:
 *   AdGuard DNS filter        made for blocking by name, from AdGuard's own
 *                             lists, EasyList, EasyPrivacy and others
 *   HaGeZi's Multi PRO        the same, with the trackers of phones and TVs
 *   EasyList, EasyPrivacy     the lists uBlock Origin (Lite) blocks with: each
 *                             rule that names a whole domain with no options
 *                             (one with options is about where a page loads
 *                             it from, which a name cannot tell)
 *   StevenBlack/hosts         adware and malware hosts
 * and the exceptions (@@||name^, no options) the ad-blocker lists carry, so a
 * name they take back from a broader rule stays reachable. Measured against
 * uBlock Origin Lite's own lists, the result covers over 99% of the domains
 * they block (the 2026-10-24 measurement: 3% for the hosts list alone).
 *
 * A source that cannot be fetched, or brings too little, fails the run: the
 * list already published stays as it is. So does a result that would block a
 * site that must stay reachable (NEVER), miss the names every ad list has
 * (MUST), or hold less than half of the previous list.
 *
 *   node scripts/adblock-list/build.js --out <dir> [--previous <file>] [--from <dir>]
 *
 * Writes <dir>/adblock.txt. --from reads the sources from files named by
 * their id (tests, or a run without the network). Runs weekly in
 * .github/workflows/adblock-list.yml; the result is published on the
 * site-list branch, beside the site list.
 */

const fs = require('fs');
const path = require('path');

const SOURCES = [
  { id: 'adguard-dns', name: 'AdGuard DNS filter', licence: 'GPL-3.0', kind: 'abp', min: 100000,
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
    home: 'https://github.com/AdguardTeam/AdGuardSDNSFilter' },
  { id: 'hagezi-pro', name: "HaGeZi's Multi PRO", licence: 'GPL-3.0', kind: 'abp', min: 100000,
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt',
    home: 'https://github.com/hagezi/dns-blocklists' },
  { id: 'easylist', name: 'EasyList', licence: 'GPL-3.0 or CC BY-SA 3.0', kind: 'abp', min: 20000,
    url: 'https://easylist.to/easylist/easylist.txt', home: 'https://easylist.to' },
  { id: 'easyprivacy', name: 'EasyPrivacy', licence: 'GPL-3.0 or CC BY-SA 3.0', kind: 'abp', min: 20000,
    url: 'https://easylist.to/easylist/easyprivacy.txt', home: 'https://easylist.to' },
  { id: 'stevenblack', name: 'StevenBlack/hosts (unified)', licence: 'MIT', kind: 'hosts', min: 50000,
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
    home: 'https://github.com/StevenBlack/hosts' },
];

/* What must stay reachable whatever a source says: the sites everyone uses,
 * with the names their pages and apps cannot work without. One blocked fails
 * the run. (The engine also never blocks Shroudly's own names, KEPT in
 * core/src/adblock.c, nor the ones it checks a list against, MUST_SPARE.) */
const NEVER = [
  'google.com', 'www.google.com', 'accounts.google.com', 'mail.google.com', 'drive.google.com', 'docs.google.com',
  'play.google.com', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'i.ytimg.com', 'googlevideo.com',
  'gstatic.com', 'fonts.googleapis.com', 'www.gstatic.com', 'maps.google.com', 'translate.google.com',
  'wikipedia.org', 'en.wikipedia.org', 'upload.wikimedia.org', 'github.com', 'objects.githubusercontent.com',
  'raw.githubusercontent.com', 'apple.com', 'www.apple.com', 'icloud.com', 'appleid.apple.com',
  'microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com', 'outlook.live.com',
  'www.office.com', 'teams.microsoft.com', 'windowsupdate.com', 'bing.com', 'www.bing.com',
  'cloudflare.com', 'amazon.com', 'www.amazon.com', 'facebook.com', 'www.facebook.com', 'm.facebook.com',
  'static.xx.fbcdn.net', 'instagram.com', 'www.instagram.com', 'whatsapp.com', 'web.whatsapp.com',
  'whatsapp.net', 'telegram.org', 'web.telegram.org', 'x.com', 'twitter.com', 'abs.twimg.com',
  'netflix.com', 'www.netflix.com', 'reddit.com', 'www.reddit.com', 'tiktok.com', 'www.tiktok.com',
  'spotify.com', 'open.spotify.com', 'yandex.ru', 'vk.com', 'duckduckgo.com', 'mozilla.org',
  'www.mozilla.org', 'discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'roblox.com',
  'www.roblox.com', 'apis.roblox.com', 'twitch.tv', 'www.twitch.tv', 'store.steampowered.com',
  'steamcommunity.com', 'epicgames.com', 'www.epicgames.com', 'paypal.com', 'www.paypal.com',
  'linkedin.com', 'www.linkedin.com', 'zoom.us', 'chatgpt.com', 'openai.com', 'claude.ai',
  'codeshare.me', 'shroudly.codeshare.me', 'jsdelivr.net', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com',
];
/* What any list for ads and trackers blocks: one missing means a source
 * changed into something else. */
const MUST = ['doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'adnxs.com',
  'scorecardresearch.com', 'app-measurement.com'];

const NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.$/, '');
const usable = (d) => d.length <= 253 && NAME.test(d) && !/^[\d.]+$/.test(d);

/* The names the engine skips as an entry (usable_entry in core/src/adblock.c,
 * read from there so the two never differ): a shared parent (blogspot.com), a
 * generic second level under a country (co.uk), a local name. A name under
 * one of these is never dropped as covered by it. */
function engineSkips(file = path.join(__dirname, '..', '..', 'core', 'src', 'adblock.c')) {
  const src = fs.readFileSync(file, 'utf8');
  const array = (name) => {
    const m = new RegExp(`${name}\\[\\] = \\{([\\s\\S]*?)NULL`).exec(src);
    if (!m) throw new Error(`${name} not found in adblock.c`);
    return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  };
  const shared = array('SHARED');
  const sld = array('GENERIC_SLD');
  const local = array('LOCAL_TLD');
  return (d) => {
    const p = d.split('.');
    return shared.has(d) || local.has(p[p.length - 1]) || (p.length === 2 && p[1].length === 2 && sld.has(p[0]));
  };
}

/* Blocks and exceptions of one source's text. */
function parse(text, kind) {
  const block = new Set();
  const allow = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') continue;
    if (kind === 'hosts') {
      const f = line.split('#', 1)[0].trim().split(/\s+/);
      if (f.length < 2 || !['0.0.0.0', '127.0.0.1', '::', '::1'].includes(f[0])) continue;
      for (const h of f.slice(1).map(norm)) if (usable(h) && h !== 'localhost' && !h.startsWith('localhost.')) block.add(h);
      continue;
    }
    // ||name^ and @@||name^, with no options but $important (which only
    // ranks rules inside a browser).
    const m = /^(@@)?\|\|([a-z0-9._-]+)\^(\$important)?$/i.exec(line);
    if (!m) continue;
    const h = norm(m[2]);
    if (!usable(h)) continue;
    (m[1] ? allow : block).add(h);
  }
  return { block, allow };
}

/* name, or a name above it of two labels or more, is in set. */
function under(name, set) {
  const p = name.split('.');
  for (let i = 0; i < p.length - 1; i++) if (set.has(p.slice(i).join('.'))) return true;
  return false;
}
/* A name above it (not itself) is in set. */
function strictlyUnder(name, set) {
  const p = name.split('.');
  for (let i = 1; i < p.length - 1; i++) if (set.has(p.slice(i).join('.'))) return true;
  return false;
}
/* Blocked: an entry at or above it and no exception at or above it. */
const blocked = (name, blocks, allows) => under(name, blocks) && !under(name, allows);

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Shroudly list builder (github.com/umutxyp/Shroudly)' }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* The combined list from the sources' texts ({ id: text }). Throws when a
 * check fails. */
function combine(texts, { previous = 0, min = true } = {}) {
  const blocks = new Set();
  const allows = new Set();
  const counts = {};
  for (const s of SOURCES) {
    if (texts[s.id] == null) throw new Error(`${s.name}: missing`);
    const { block, allow } = parse(texts[s.id], s.kind);
    if (min && block.size < s.min) throw new Error(`${s.name}: ${block.size} entries, fewer than ${s.min}: not the list asked for`);
    counts[s.id] = { block: block.size, allow: allow.size };
    for (const h of block) blocks.add(h);
    for (const h of allow) allows.add(h);
  }
  // An entry an exception takes back is no use; an exception with no entry
  // above it takes nothing back.
  for (const h of blocks) if (under(h, allows)) blocks.delete(h);
  for (const h of allows) if (!strictlyUnder(h, blocks)) allows.delete(h);
  // A name under another entry is blocked with it: left out (a smaller
  // file and table), unless that entry is one the engine skips.
  const skips = engineSkips();
  const parents = new Set([...blocks].filter((h) => !skips(h)));
  for (const h of blocks) if (strictlyUnder(h, parents)) blocks.delete(h);
  const wrong = NEVER.filter((h) => blocked(h, blocks, allows));
  if (wrong.length) throw new Error(`would block ${wrong.join(', ')}`);
  const missing = MUST.filter((h) => !blocked(h, blocks, allows));
  if (missing.length) throw new Error(`does not block ${missing.join(', ')}`);
  if (previous && blocks.size * 2 < previous) throw new Error(`${blocks.size} entries, less than half of the ${previous} before`);
  return { blocks: [...blocks].sort(), allows: [...allows].sort(), counts };
}

function render({ blocks, allows }, date) {
  return [
    '! Title: Shroudly ad and tracker list',
    `! Built: ${date} by .github/workflows/adblock-list.yml (github.com/umutxyp/Shroudly)`,
    '! Read by Shroudly\'s "Block ads and trackers" (core/src/adblock.c): one name per line',
    '! blocks it and every name under it; @@||name^ takes a name and every name under it back.',
    '! Combined from these lists, under their licences; the whole is distributed under GPL-3.0:',
    ...SOURCES.map((s) => `!   ${s.name} (${s.licence}) ${s.home}`),
    `! Entries: ${blocks.length}, exceptions: ${allows.length}`,
    ...allows.map((h) => `@@||${h}^`),
    ...blocks,
    '',
  ].join('\n');
}

/* The entries of a list file this script wrote (its header says). */
function entriesOf(file) {
  try {
    const m = /^! Entries: (\d+)/m.exec(fs.readFileSync(file, 'utf8').slice(0, 4096));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
  const out = arg('--out');
  if (!out) throw new Error('usage: build.js --out <dir> [--previous <file>] [--from <dir>]');
  const from = arg('--from');
  const texts = {};
  for (const s of SOURCES) {
    texts[s.id] = from ? fs.readFileSync(path.join(from, `${s.id}.txt`), 'utf8') : await fetchText(s.url);
  }
  const previous = arg('--previous') ? entriesOf(arg('--previous')) : 0;
  const r = combine(texts, { previous });
  fs.mkdirSync(out, { recursive: true });
  const text = render(r, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(path.join(out, 'adblock.txt'), text);
  console.log(`${r.blocks.length} entries, ${r.allows.length} exceptions, ${(text.length / 1048576).toFixed(1)} MB`
    + `${previous ? ` (was ${previous})` : ''}`);
  for (const s of SOURCES) console.log(`  ${s.name}: ${r.counts[s.id].block} entries, ${r.counts[s.id].allow} exceptions`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(`adblock list: ${e.message}`); process.exit(1); });

module.exports = { SOURCES, NEVER, MUST, parse, combine, render, blocked, entriesOf, engineSkips };
