'use strict';

/*
 * Services that need more names than the one people type. Someone who lists
 * only "roblox.com" in their own site list still needs Roblox's CDN, its
 * sign-in and its captcha to go through Shroudly, or the page loads and then
 * sign-in or the game fails. A custom list that names any part of a family
 * gets the whole family. The automatic list already has them all.
 *
 * Copied from scripts/site-list/families.json (which builds the automatic
 * list; scripts/ is not shipped with the app). tests/net/sitelist.test.js
 * fails if the two drift apart.
 */

const CAPTCHA = ['hcaptcha.com', 'arkoselabs.com', 'funcaptcha.com', 'recaptcha.net', 'challenges.cloudflare.com',
  'px-cloud.net', 'captcha-delivery.com', 'datadome.co', 'awswaf.com'];

const FAMILIES = {
  roblox: ['roblox.com', 'rbxcdn.com', 'rbxinfra.net', 'rbx.com', 'rblx.org', 'blox.com', 'rbxcdn.net', 'robloxcdn.com',
    'simulprod.com', 'withpersona.com', 'rbxtrk.com', 'robloxlabs.com', 'guilded.gg'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordsays.com', 'discord.co',
    'discord.app', 'dis.gd', 'discord.new', 'discord.gift', 'discord.gifts', 'discordstatus.com', 'discord.tools',
    'discordcdn.com', 'discord.store', 'discord.dev', 'discord.design', 'discordmerch.com', 'discordactivities.com',
    'discord-activities.com', 'discordpartygames.com', 'discordsez.com', 'discord-attachments-uploads-prd.storage.googleapis.com',
    'klipy.com', 'tenor.com', 'giphy.com'],
};

const under = (d, parent) => d === parent || d.endsWith(`.${parent}`);

/* The list with every family it touches completed (and that family's
 * captcha services). The original entries come first, in their order. */
function expand(list) {
  const out = [...(list || [])];
  const have = new Set(out.map((d) => String(d).trim().toLowerCase()));
  const lower = [...have];
  let captcha = false;
  for (const domains of Object.values(FAMILIES)) {
    if (!lower.some((d) => domains.some((f) => under(d, f)))) continue;
    captcha = true;
    for (const f of domains) if (!have.has(f)) { have.add(f); out.push(f); }
  }
  if (captcha) for (const c of CAPTCHA) if (!have.has(c)) { have.add(c); out.push(c); }
  return out;
}

module.exports = { FAMILIES, CAPTCHA, expand };
