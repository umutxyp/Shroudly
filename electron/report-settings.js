'use strict';

/*
 * The settings in a report ("Something not working?"), as they act, not
 * only as stored: a setting left at its default is not in the settings file
 * at all, so a report that listed the file alone could not say whether, say,
 * the last way out (Tor) was on. Here every setting that changes what
 * Shroudly does has its value, its default where it was never changed, and
 * `changed` lists those the user (or the autopilot) moved off the default.
 * Never a link, an address, a password or a list's contents: a server of
 * one's own or a DNS of one's own is said as set or not, lists as a count.
 */

const DEFAULTS = {
  protectionOn: false,
  autoStart: false,
  routeMode: 'all',
  strategy: 'split(sni)',
  autoMode: true,
  dnsProtection: true,
  preferIpv6: false,
  listenPort: 10808,
  adBlock: false,
  torLastResort: true,
  torApproved: false,
  discordMode: false,
  appMode: false,
  storeAppsMode: false,
  advancedAtLaunch: false,
  advancedQuicBlock: true,
  advancedTlsRec: false,
  advancedUdpFake: true,
  fakeTtl: 4,
  askByItself: true,
  autoUpdate: true,
  minimizeToTray: true,
  showNotifications: true,
  showTrayIcon: true,
  shareOnlineCount: true,
  snowflakeOn: false,
  language: 'system',
};

/* Lists and texts that are the user's own: how many, or whether set. */
const COUNTED = ['siteList', 'userBlocked', 'torSites', 'adBlockAllow', 'storeAppsOurs', 'learnedTechniques', 'learnedRawTechniques', 'avoidTechniques'];
const SET_OR_NOT = ['ownServer', 'customDns'];

const PRIVATE = /server|pass|token|auth|key|secret|link|url|dns|proxy|host|ip|addr|path|dir|file|id$|ids$|reports/i;

function count(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

/* all: the settings file's contents. Returns { settings, changed }. */
function effective(all) {
  const s = all && typeof all === 'object' ? all : {};
  const settings = {};
  const changed = [];
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const has = Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined && s[k] !== null && s[k] !== '';
    let v = has ? s[k] : def;
    if (typeof v === 'string' && (v.length > 24 || /[/@:]/.test(v)) && k !== 'strategy') v = '(set)';
    if (k === 'strategy' && typeof v === 'string') v = v.slice(0, 40);
    settings[k] = v;
    if (has && v !== def) changed.push(k);
  }
  for (const k of SET_OR_NOT) {
    const v = s[k];
    const set = !!(v && (typeof v !== 'object' || count(v) > 0));
    settings[k] = set ? 'set' : 'not set';
    if (set) changed.push(k);
  }
  for (const k of COUNTED) {
    if (k === 'siteList') {
      settings.siteList = Array.isArray(s.siteList) ? `own list of ${s.siteList.length}` : 'automatic';
      if (Array.isArray(s.siteList)) changed.push('siteList');
      continue;
    }
    settings[k] = count(s[k]);
  }
  // Everything else the file holds that is a switch, a number or a short
  // choice (what Shroudly noted for itself: ports, times, answers given).
  for (const [k, v] of Object.entries(s)) {
    if (k in settings) continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) settings[k] = v;
    else if (Array.isArray(v)) settings[k] = `[${v.length}]`;
    else if (typeof v === 'string' && v.length <= 24 && !PRIVATE.test(k) && !/[/@:]/.test(v)) settings[k] = v;
  }
  return { settings, changed };
}

module.exports = { DEFAULTS, effective };
