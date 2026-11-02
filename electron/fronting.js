'use strict';

/*
 * CDN fronting, for Shroudly's own downloads from GitHub (the site list, the
 * ad list) where GitHub's address or name is blocked. raw.githubusercontent.com
 * is served by Fastly, and Fastly still hands a request to the site its Host
 * header names whatever name the connection was opened with: a connection to
 * www.python.org, with that name in the ClientHello and that site's own
 * certificate checked, asked for raw.githubusercontent.com's file, gets it.
 * The network sees only a connection to python.org, at python.org's address.
 *
 * Measured from the start of 2.6.47 (and checked by tests/net/fronting.test.js
 * against the real CDN): Fastly does this; Google, Cloudflare, Akamai,
 * CloudFront and Azure refuse a Host that is not the connection's name (404,
 * 403, 421), so nothing else here is fronted. It is a fallback only: the
 * direct request goes first, and what comes back is checked as before (the
 * site list's dates and size, the engine's check of the ad list).
 *
 * Browsers cannot use this for the sites people open: the name a browser puts
 * in its ClientHello is the one it checks the certificate against, and
 * Shroudly never opens anyone's encrypted connections to change that.
 */

/* Large sites on Fastly, unlikely to be blocked where GitHub is, and with
 * no bot wall in front (PayPal's turned a request away now and then). */
const FRONTS = {
  'raw.githubusercontent.com': ['www.python.org', 'pypi.org', 'www.fastly.com', 'www.ted.com'],
};

function frontsFor(host) {
  return FRONTS[String(host || '').toLowerCase()] || [];
}

/* fn(front) for each front of `host` in turn until one resolves: { value,
 * front }, or null when there are none or every one failed. */
async function viaFronts(host, fn) {
  for (const front of frontsFor(host)) {
    try { return { value: await fn(front), front }; } catch {}
  }
  return null;
}

module.exports = { FRONTS, frontsFor, viaFronts };
