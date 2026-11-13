'use strict';

/*
 * Apps the user can send through Tor as a whole: "Apps always through Tor"
 * in the Connections list (a user in Iran asked for Instagram always
 * through Tor). Picking one is the same as sending each of its names
 * through Tor by hand (TOR <name>, every name under it too), and for an app
 * that connects to its servers by address, as Telegram does, its ranges
 * (TOR <address>/<bits>, core/src/conns.c). Tor carries them whether they
 * are blocked or not: slower, and the app's servers see a Tor address.
 *
 * Every system with Tor offers the same list: the desktop from here,
 * Android and the Mac from the files android/scripts/gen-raw-apps.js writes
 * (TorAppsList.kt, TorAppsList.swift). Kept in Settings as the apps' ids
 * (torApps), apart from the sites typed by hand (torSites).
 *
 * The names are the ones each app's own servers have (its web, its API, its
 * pictures and videos). A name two apps share (fbcdn.net: Instagram's and
 * Facebook's pictures) goes back the usual way only once neither is picked.
 */

const { SERVICES } = require('./raw-apps');

const svc = (id) => SERVICES.find((s) => s.id === id);

const APPS = [
  { id: 'instagram', name: 'Instagram', names: ['instagram.com', 'cdninstagram.com', 'instagr.am', 'ig.me', 'fbcdn.net'] },
  { id: 'telegram', name: 'Telegram', names: svc('telegram').domains, ranges: svc('telegram').cidrs },
  { id: 'whatsapp', name: 'WhatsApp', names: ['whatsapp.net', 'whatsapp.com', 'wa.me'] },
  { id: 'youtube', name: 'YouTube', names: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube-nocookie.com', 'youtubei.googleapis.com', 'yt3.googleusercontent.com'] },
  { id: 'x', name: 'X (Twitter)', names: ['x.com', 'twitter.com', 'twimg.com', 't.co'] },
  { id: 'facebook', name: 'Facebook', names: ['facebook.com', 'fb.com', 'facebook.net', 'fbcdn.net', 'fbsbx.com', 'messenger.com'] },
  { id: 'discord', name: 'Discord', names: ['discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg', 'discord.media', 'discordcdn.com'] },
  { id: 'signal', name: 'Signal', names: ['signal.org', 'whispersystems.org', 'signal.art', 'signal.me'] },
  { id: 'reddit', name: 'Reddit', names: ['reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com'] },
  { id: 'tiktok', name: 'TikTok', names: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'ibytedtos.com', 'byteoversea.com', 'muscdn.com'] },
  { id: 'spotify', name: 'Spotify', names: ['spotify.com', 'scdn.co', 'spotifycdn.com', 'spoti.fi'] },
  { id: 'chatgpt', name: 'ChatGPT', names: ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com'] },
  // Google's AI, turned away in Iran and Russia: the pages and the APIs the
  // prompts go to together (an Iran report: AI Studio opened through Tor, its
  // prompt API did not, and nothing could be written).
  { id: 'gemini', name: 'Gemini & AI Studio', names: ['gemini.google.com', 'aistudio.google.com', 'makersuite.google.com', 'alkalimakersuite-pa.clients6.google.com', 'geminiweb-pa.clients6.google.com', 'generativelanguage.googleapis.com', 'ai.google.dev', 'notebooklm.google.com'] },
  // Turns Iran away itself (drivers and the NVIDIA app's sign-in); its site
  // in a browser, since the app's own services start with Windows and take
  // no proxy (an Iran report: "nvidia app not working, I want to update my
  // driver").
  { id: 'nvidia', name: 'NVIDIA', names: ['nvidia.com', 'geforce.com', 'nvidiagrid.net'] },
];

/* What the engine is given for the picked apps: their names and ranges,
 * each once. Unknown ids are left out. */
function entriesOf(ids) {
  const out = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    const a = APPS.find((x) => x.id === id);
    if (!a) continue;
    for (const n of a.names) out.add(n);
    for (const r of a.ranges || []) out.add(r);
  }
  return [...out];
}

/* The ids kept, known ones only, each once, in the list's order. */
function clean(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  return APPS.filter((a) => want.has(a.id)).map((a) => a.id);
}

/* The app a name belongs to (its own name or one under it), or null: what
 * the Tor question says instead of one of the app's many names ("Open X
 * (Twitter) through Tor?", not abs.twimg.com). */
function appOfName(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  const a = APPS.find((x) => x.names.some((n) => h === n || h.endsWith(`.${n}`)));
  return a ? a.name : null;
}

module.exports = { APPS, entriesOf, clean, appOfName };
