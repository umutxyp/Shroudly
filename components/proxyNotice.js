/*
 * What the window says about the system proxy (BlockedNotice shows it): a
 * plain function of the status the background process sends
 * (system-proxy.js), so every case can be checked without a window.
 *
 * Each returns null or { id, icon, title?, body, params?, action? }:
 *   id      what closing the banner hides
 *   icon    'alert' or 'info'
 *   action  the button: 'admin' (an administrator's password, macOS),
 *           'reapply' (set Shroudly again) or 'recover' (put back the
 *           settings a restart of the Mac left behind)
 */

/* The banner that comes first: when browsers are not going through
 * Shroudly, nothing else matters. recovery: macOS settings from before a
 * restart, still waiting for an administrator's password after the user
 * dismissed that dialog (shown while protection is off). */
export function proxyNotice(proxy, { active = false, recovery = null } = {}) {
  if (!active && recovery && recovery.declined) {
    return { id: 'proxy:recover', icon: 'alert', title: 'proxyRecoverTitle', body: 'proxyRecoverBody', action: 'recover' };
  }
  if (!active || !proxy || proxy.ok) return null;
  const id = `proxy:${proxy.code}`;
  const pac = proxy.pacUrl || '';
  // A dismissed password dialog keeps its button: the user may want to try again.
  if (proxy.code === 'needs_admin' || proxy.code === 'cancelled') {
    return { id, icon: 'alert', title: 'proxyAdminTitle', body: 'proxyAdminBody', action: 'admin' };
  }
  if (proxy.code === 'replaced') {
    // Another program kept taking it back, so Shroudly stopped setting it
    // back by itself: named when it could be told which one.
    const by = proxy.fight && Array.isArray(proxy.fight.by) ? proxy.fight.by.filter(Boolean) : [];
    if (proxy.fight) {
      return by.length
        ? { id: `${id}:fight`, icon: 'alert', title: 'proxyReplacedTitle', body: 'proxyFightBodyNamed', params: { program: by.join(', ') }, action: 'reapply' }
        : { id: `${id}:fight`, icon: 'alert', title: 'proxyReplacedTitle', body: 'proxyFightBody', action: 'reapply' };
    }
    return { id, icon: 'alert', title: 'proxyReplacedTitle', body: 'proxyReplacedBody', action: 'reapply' };
  }
  /* XFCE, LXQt and other desktops without a proxy setting: Firefox follows
   * GNOME's setting, Chromium browsers the environment they started with. A
   * session that does not read what was written for the login gets the
   * address to set by hand, not a promise about the next login. */
  if (proxy.chromiumNotTaken) {
    return { id, icon: 'info', body: proxy.firefox ? 'proxyEnvNotTakenFirefox' : 'proxyEnvNotTaken', params: { pac } };
  }
  if (proxy.code === 'partial_env') {
    const body = proxy.chromiumNow ? 'proxyEnvChromiumNow'
      : !proxy.chromiumAfterRelogin ? 'proxyEnvFirefoxOnly'
        : proxy.firefox ? 'proxyEnvFirefoxNow'
          : 'proxyEnvRelogin';
    return { id, icon: 'info', body, params: { pac } };
  }
  if (proxy.code === 'no_system_proxy') return { id, icon: 'info', body: 'proxyNoneBody', params: { pac } };
  return { id, icon: 'alert', body: 'proxyFailedBody' };
}

/* Further down, once nothing more urgent is showing: on XFCE, LXQt and
 * other desktops each Chromium browser or app read Shroudly's address when
 * it started, and one started before Shroudly answered there may go around
 * it until it is reopened. */
export function chromiumNote(proxy, { active = false } = {}) {
  if (!active || !proxy || !proxy.chromiumRestart) return null;
  return { id: 'proxy:chromiumRestart', icon: 'info', body: 'proxyEnvChromiumRestart' };
}
