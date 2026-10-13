'use strict';

/*
 * Builds the list of domains that "only listed sites" routing sends through
 * Shroudly, and keeps it current on its own.
 *
 *   families.json  services blocked somewhere, each with every domain it needs
 *                  to work. Curated, always listed.
 *   OONI           what volunteers' measurements in each filtering country saw
 *                  in the last 30 days. A domain from Citizen Lab's test lists,
 *                  in an allowed category (policy.json), that OONI finds
 *                  blocked is added; one that no country has blocked for 90
 *                  days is dropped again. A measured member of a family brings
 *                  nothing extra: the family is already listed whole.
 *
 * A country whose data cannot be fetched changes nothing, and a run that would
 * shrink the list by more than half is refused: an outage at the source must
 * never empty people's routing.
 *
 *   node scripts/site-list/update.js --out <dir> [--state <state.json>]
 *
 * Writes <dir>/sites.json (what the app downloads) and <dir>/state.json (when
 * each measured domain was last seen blocked, and where). Runs weekly in
 * .github/workflows/site-list.yml; the result is published on the site-list
 * branch.
 */

const fs = require('fs');
const path = require('path');

const FAMILIES = require('./families.json');
const POLICY = require('./policy.json');

const DAY = 24 * 60 * 60 * 1000;
const CL_BASE = 'https://raw.githubusercontent.com/citizenlab/test-lists/master/lists';
const OONI_AGG = 'https://api.ooni.io/api/v1/aggregation';

/* The same rule the app applies to every entry (electron/system-proxy.js). */
function isHostname(d) {
  if (typeof d !== 'string' || d.length < 3 || d.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(d)) return false;
  if (/^[\d.]+$/.test(d)) return false;   // an address, not a name
  if (d.startsWith('.') || d.endsWith('.') || d.includes('..')) return false;
  const labels = d.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'));
}

function normHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\d?\./, '');
}

function hostOfUrl(u) {
  try { return normHost(new URL(u).hostname); } catch { return ''; }
}

/* d or a parent of d is in the set. */
function underAny(d, set) {
  for (let s = d; s.includes('.'); s = s.slice(s.indexOf('.') + 1)) if (set.has(s)) return s;
  return null;
}

/* policy(d): never listed, a family included (with everything under it).
 * infra(d):  shared infrastructure. Nothing under it is ever added from
 *            measurements, and it is never listed itself; a family may still
 *            name one exact host on it (a CDN or API host a service needs). */
function makeExcluder(policy) {
  const banned = new Set(policy.excluded.domains.map(normHost));
  const infra = new Set(policy.excluded.infrastructure.map(normHost));
  const patterns = policy.excluded.patterns.map((p) => new RegExp(p, 'i'));
  return {
    policy: (d) => !!underAny(d, banned) || patterns.some((re) => re.test(d)),
    infra: (d) => !!underAny(d, infra),
    isInfra: (d) => infra.has(d),
  };
}

/* Every domain the families need, shared needs (captcha) included. */
function familyDomains(families = FAMILIES) {
  const out = new Set();
  for (const f of families.families) {
    for (const d of f.domains) out.add(normHost(d));
    for (const n of f.needs || []) for (const d of families.shared[n] || []) out.add(normHost(d));
  }
  return out;
}

/* Citizen Lab CSV: url,category_code,... (fields may be quoted). */
function parseCsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/* host -> Set of Citizen Lab category codes. */
function categoriesFrom(csvTexts) {
  const map = new Map();
  for (const text of csvTexts) {
    for (const [url, code] of parseCsv(text).slice(1)) {
      const h = hostOfUrl(url);
      if (!h || !code) continue;
      if (!map.has(h)) map.set(h, new Set());
      map.get(h).add(code.trim().toUpperCase());
    }
  }
  return map;
}

function isBlocked(r, rule) {
  const measured = (r.measurement_count || 0) - (r.failure_count || 0);
  if ((r.confirmed_count || 0) >= rule.minConfirmed) return true;
  return measured >= rule.minMeasured && (r.anomaly_count || 0) / measured >= rule.minAnomalyRate;
}

/*
 * The decision itself, without the network.
 *   now        Date
 *   state      previous state.json ({ v, domains: { d: { first, last, cc } } }) or null
 *   previous   previous sites.json domains, or null
 *   categories Map host -> Set of codes (Citizen Lab)
 *   ooni       { cc: rows[] | null }  null = could not be fetched
 */
function build({ now, state, previous, categories, ooni, policy = POLICY, families = FAMILIES }) {
  const excluded = makeExcluder(policy);
  const allowed = new Set(policy.allowedCategories);
  // A site filed under several categories is judged by the worst of them.
  const disallowed = new Set(policy.disallowedCategories || []);
  const fam = familyDomains(families);
  const next = { v: 1, domains: { ...((state && state.domains) || {}) } };
  const iso = now.toISOString();
  const seen = new Set();

  for (const [cc, rows] of Object.entries(ooni)) {
    if (!rows) continue;                       // unknown this week: change nothing
    const byHost = new Map();
    for (const r of rows) {
      const h = normHost(r.domain);
      const a = byHost.get(h) || { measurement_count: 0, failure_count: 0, anomaly_count: 0, confirmed_count: 0 };
      for (const k of Object.keys(a)) a[k] += r[k] || 0;
      byHost.set(h, a);
    }
    for (const [h, agg] of byHost) {
      if (!isHostname(h) || excluded.policy(h) || excluded.infra(h) || underAny(h, fam)) continue;
      if (!isBlocked(agg, policy.blocked)) continue;
      const cats = categories.get(h);
      if (!cats || ![...cats].some((c) => allowed.has(c)) || [...cats].some((c) => disallowed.has(c))) continue;
      const e = next.domains[h] || { first: iso, cc: [] };
      e.last = iso;
      if (!e.cc.includes(cc)) e.cc = [...e.cc, cc].sort();
      next.domains[h] = e;
      seen.add(h);
    }
  }

  // Not seen blocked anywhere for keepDays: dropped.
  const cutoff = now.getTime() - policy.keepDays * DAY;
  for (const [d, e] of Object.entries(next.domains)) {
    if (Date.parse(e.last) < cutoff || excluded.policy(d) || excluded.infra(d)) delete next.domains[d];
  }

  let auto = Object.keys(next.domains);
  const room = policy.maxDomains - fam.size;
  if (auto.length > room) {
    // Most recently blocked, in the most countries, first.
    auto.sort((a, b) => (next.domains[b].last.localeCompare(next.domains[a].last)) || (next.domains[b].cc.length - next.domains[a].cc.length));
    auto = auto.slice(0, Math.max(0, room));
  }

  const all = new Set([...fam, ...auto].filter((d) => isHostname(d) && !excluded.policy(d) && !excluded.isInfra(d)));
  // A domain already covered by its parent adds nothing.
  const domains = [...all].filter((d) => { const p = underAny(d.slice(d.indexOf('.') + 1), all); return !p; }).sort();

  if (previous && previous.length && domains.length < previous.length * (1 - policy.maxShrink)) {
    throw new Error(`refusing to shrink the list from ${previous.length} to ${domains.length} domains`);
  }
  const prev = new Set(previous || []);
  return {
    sites: { v: 1, generated: iso, count: domains.length, domains },
    state: next,
    added: domains.filter((d) => !prev.has(d)),
    removed: [...prev].filter((d) => !all.has(d)),
    measuredNow: seen.size,
  };
}

// ── network ────────────────────────────────────────────────────────────────
async function get(url, { json = false, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 90000);
      const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'shroudly-site-list (+https://github.com/umutxyp/Shroudly)' } });
      clearTimeout(t);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}

async function fetchSources(now, policy = POLICY, log = console.log) {
  const csv = [];
  for (const cc of ['global', ...policy.countries]) {
    try { const t = await get(`${CL_BASE}/${cc}.csv`); if (t) csv.push(t); } catch (e) { log(`citizenlab ${cc}: ${e.message}`); }
  }
  const since = new Date(now.getTime() - 30 * DAY).toISOString().slice(0, 10);
  const until = now.toISOString().slice(0, 10);
  const ooni = {};
  for (const cc of policy.countries) {
    const q = `probe_cc=${cc.toUpperCase()}&test_name=web_connectivity&since=${since}&until=${until}&axis_x=domain`;
    try {
      const j = await get(`${OONI_AGG}?${q}`, { json: true });
      ooni[cc] = j && Array.isArray(j.result) ? j.result : [];
      log(`ooni ${cc}: ${ooni[cc].length} domains measured`);
    } catch (e) {
      ooni[cc] = null;
      log(`ooni ${cc}: unavailable (${e.message}); left as it was`);
    }
  }
  return { categories: categoriesFrom(csv), ooni };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const out = arg('--out');
  if (!out) { console.error('usage: update.js --out <dir> [--state <state.json>]'); process.exit(2); }
  const stateFile = arg('--state') || path.join(out, 'state.json');
  const prevSites = readJson(path.join(out, 'sites.json'));
  const now = new Date();
  const src = await fetchSources(now);
  if (Object.values(src.ooni).every((r) => r === null)) throw new Error('OONI unreachable for every country; nothing changed');
  const r = build({ now, state: readJson(stateFile), previous: prevSites && prevSites.domains, ...src });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sites.json'), `${JSON.stringify(r.sites, null, 1)}\n`);
  fs.writeFileSync(stateFile, `${JSON.stringify(r.state, null, 1)}\n`);
  console.log(`${r.sites.count} domains (${r.added.length} added, ${r.removed.length} removed; ${r.measuredNow} measured blocked this run)`);
  if (r.added.length) console.log(`added: ${r.added.slice(0, 60).join(' ')}${r.added.length > 60 ? ' …' : ''}`);
  if (r.removed.length) console.log(`removed: ${r.removed.slice(0, 60).join(' ')}${r.removed.length > 60 ? ' …' : ''}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { build, isBlocked, categoriesFrom, parseCsv, familyDomains, makeExcluder, normHost, isHostname };
