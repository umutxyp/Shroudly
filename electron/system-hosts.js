'use strict';

/*
 * The names Shroudly itself connects to (issue #74): shown in the
 * Connections list like any other, marked "Shroudly", and blocking one asks
 * first, since it can take away what keeps the internet working here
 * (encrypted DNS) or what Shroudly needs (updates, the live count, Tor's
 * Snowflake, the user's own server). The same list on every platform
 * (android SystemHosts.kt and apple Shared/SystemHosts.swift copy it).
 */
const SYSTEM_HOSTS = [
  // Encrypted DNS (doh-forwarder.js).
  'cloudflare-dns.com', 'one.one.one.one', 'dns.google', 'dns.quad9.net', 'doh.opendns.com', 'dns.opendns.com',
  'doh.sb', 'dns.sb', 'unfiltered.adguard-dns.com', 'dns.adguard-dns.com', 'dns.mullvad.net',
  // Shroudly's own: the live count, downloads and updates, its source.
  'codeshare.me', 'github.com', 'githubusercontent.com', 'api.github.com',
  // Tor: the last way out, and Snowflake.
  'torproject.net', 'torproject.org',
];

/* Whether host is one of them or a name under one; also the user's own
 * server, when given. */
function isSystemHost(host, extra = []) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return [...SYSTEM_HOSTS, ...extra.filter(Boolean)].some((s) => h === s || h.endsWith(`.${s}`));
}

module.exports = { SYSTEM_HOSTS, isSystemHost };
