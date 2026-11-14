/*
 * "Only listed sites": the user's own sites are routed together with the
 * automatic list, never in its place. Until 2.6.78 one edit of the box froze
 * the list at the built-in names, and a site blocked since (LinkedIn on one
 * network: reset at every first try) went straight to the network's filter.
 */
const { suite } = require('./helpers');

const t = suite('site-list-own');
{
  const EngineManager = require('../../electron/engine-manager');
  const mk = (s) => ({ store: { routeMode: 'listed', ...s }, get(k, d) { return k in this.store ? this.store[k] : d; }, set(k, v) { this.store[k] = v; } });
  const auto = ['linkedin.com', 'example-blocked.org'];
  const own = new EngineManager(mk({ siteList: ['my-own-site.net', 'discord.com'] }), { siteList: () => auto });
  const l1 = own._settings().siteList;
  t.ok(l1.includes('linkedin.com') && l1.includes('example-blocked.org') && l1.includes('my-own-site.net'),
    'own sites are added to the automatic list (both routed)');
  t.ok(new Set(l1).size === l1.length, 'no name twice');
  const none = new EngineManager(mk({}), { siteList: () => auto });
  t.ok(none._settings().siteList.includes('linkedin.com'), 'no own sites: the automatic list alone');
  const old = new EngineManager(mk({ siteList: EngineManager.FALLBACK_SITE_LIST.slice() }), { siteList: () => auto });
  t.ok(old._settings().siteList.includes('linkedin.com'), 'a frozen copy of the built-in list (2.6.77) still gets the automatic list');
}
console.log(`site-list-own: ${t.count} passed`);
