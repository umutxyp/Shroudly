/*
 * What the window says about the system proxy (BlockedNotice shows it): a
 * plain function of the status the background process sends
 * (system-proxy.js), so every case can be checked without a window.
 *
 * Each returns null or { id, icon, title?, body, params?, action?, notRouting? }:
 *   id      what closing the banner hides
 *   icon    'alert' or 'info'
 *   action  the button (PROXY_ACTIONS): 'admin' (an administrator's
 *           password, macOS), 'reapply' (set Shroudly again), 'retry' (try
 *           again after it could not be set) or 'recover' (put back the
 *           settings a restart of the Mac left behind)
 *   notRouting  protection is on, but browsers and most programs are not
 *           going through Shroudly: the window says "Not working yet" in
 *           place of "Protected", with these words and this button under
 *           it, and the banner cannot be closed. The background process
 *           decides the same (SystemProxy.routes) for the tray and its
 *           notification.
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
    return { id, icon: 'alert', title: 'proxyAdminTitle', body: 'proxyAdminBody', action: 'admin', notRouting: true };
  }
  if (proxy.code === 'replaced') {
    // Another program kept taking it back, so Shroudly stopped setting it
    // back by itself: named when it could be told which one.
    const by = proxy.fight && Array.isArray(proxy.fight.by) ? proxy.fight.by.filter(Boolean) : [];
    if (proxy.fight) {
      return by.length
        ? { id: `${id}:fight`, icon: 'alert', title: 'proxyReplacedTitle', body: 'proxyFightBodyNamed', params: { program: by.join(', ') }, action: 'reapply', notRouting: true }
        : { id: `${id}:fight`, icon: 'alert', title: 'proxyReplacedTitle', body: 'proxyFightBody', action: 'reapply', notRouting: true };
    }
    return { id, icon: 'alert', title: 'proxyReplacedTitle', body: 'proxyReplacedBody', action: 'reapply', notRouting: true };
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
  // Could not be set (refused, a command that failed): trying again often
  // works once whatever held the setting lets go.
  return { id, icon: 'alert', body: 'proxyFailedBody', action: 'retry', notRouting: true };
}

/* The buttons: their words, and what they ask the background process for
 * (electron/preload.js). Each resolves to what came of it ({ ok }). */
export const PROXY_ACTIONS = {
  admin: { label: 'proxyAdminButton', run: () => window.electron.proxyApplyAsAdmin() },
  reapply: { label: 'proxyReapply', run: () => window.electron.proxyReapply() },
  retry: { label: 'proxyTryAgain', run: () => window.electron.proxyReapply() },
  recover: { label: 'proxyRecoverButton', run: () => window.electron.proxyRecoverAsAdmin() },
};

/* Further down, once nothing more urgent is showing: on XFCE, LXQt and
 * other desktops each Chromium browser or app read Shroudly's address when
 * it started, and one started before Shroudly answered there may go around
 * it until it is reopened. */
export function chromiumNote(proxy, { active = false } = {}) {
  if (!active || !proxy || !proxy.chromiumRestart) return null;
  return { id: 'proxy:chromiumRestart', icon: 'info', body: 'proxyEnvChromiumRestart' };
}
