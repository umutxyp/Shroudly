/*
 * The background process writes log entries in English. Known messages are
 * mapped to translation keys here (with their variable parts as params);
 * anything unrecognised (raw engine output, OS error text) is shown as-is.
 */

const EXACT = {
  'Proxy routing updated': 'logProxyRoutingUpdated',
  'Application started': 'logAppStarted',
  "Your DNS service filters sites; Shroudly's encrypted DNS goes around it.": 'logDnsFilterService',
  'The other VPN or bypass tool is no longer running.': 'logConflictGone',
  'Discord app mode on: Discord updates through Shroudly': 'logDiscordOn',
  'Discord app mode off: Discord settings restored': 'logDiscordOff',
  'Games and apps mode on: Roblox and similar programs go through Shroudly': 'logAppsOn',
  'Games and apps mode off: settings restored': 'logAppsOff',
  'Games and apps: another proxy is already set for programs (HTTPS_PROXY), so it was left as it is': 'logAppsForeign',
  'Games and apps: a setting left by an earlier run was removed': 'logAppsLeftover',
  'Auto-started in tray': 'logAutoStartedTray',
  'System proxy from the previous session could not be restored yet': 'logProxyRecoverPending',
  'The system proxy points at Shroudly again': 'logProxyOursAgain',
  'KDE proxy settings are locked by the administrator': 'logKdeLocked',
  'System proxy settings could not be restored yet; they will be at the next start': 'logProxyRestorePending',
  'The system proxy did not change, although the administrator password was accepted': 'logProxyAdminNoChange',
  'A system proxy left by an earlier version could not be switched off': 'logProxyLegacyOffFailed',
  'Firefox goes through Shroudly now; Chrome and other Chromium browsers will after you log out and back in': 'logProxyEnvFirefoxNow',
  'Chrome and other Chromium browsers will go through Shroudly after you log out and back in; Firefox has to be set by hand': 'logProxyEnvRelogin',
  'Chrome and other Chromium browsers go through Shroudly; Firefox has to be set by hand': 'logProxyEnvChromiumNow',
  'Firefox goes through Shroudly; Chrome and other Chromium browsers could not be set on this desktop': 'logProxyEnvFirefoxOnly',
  'Browser settings for the next login removed': 'logProxyEnvRemoved',
  'The address browsers use to reach Shroudly had to change; Chrome and other Chromium browsers follow the new one after you log out and back in': 'logProxyEnvPortMoved',
  'The system DNS answered none of the test names. Programs that do not go through Shroudly cannot reach anything; check the DNS program or the network settings.': 'logDnsDead',
  'Games and apps: Roblox is connecting through Shroudly': 'logAppsRoblox',
  'Autopilot: Discord is blocked on this network; Discord app mode turned on': 'logAutoDiscordOn',
  'Autopilot: Roblox is blocked on this network; Games and apps mode turned on': 'logAutoRobloxOn',
  'Autopilot: a Roblox installer went around Shroudly; started it again through Shroudly': 'logAutoInstaller',
  'Autopilot: a Roblox installer went around Shroudly and was stopped, but the one to start in its place could not be started': 'logAutoInstallerNotStarted',
  'Autopilot: Roblox did not get through Shroudly and was closed, but could not be opened again': 'logAutoRobloxNotOpened',
  'Firefox is set not to use the system proxy, so it does not go through Shroudly. Close Firefox and Shroudly will set it back.': 'autoFirefoxClose',
  'Firefox was set not to use the system proxy. Shroudly put it back to "Use system proxy settings".': 'autoFirefoxFixed',
  'Autopilot: Roblox Studio was opened before Shroudly could take it through; the user was asked to reopen it': 'logAutoStudio',
  'Autopilot: Roblox still does not get through after being restarted through Shroudly': 'logAutoRobloxStuck',
  'Advanced mode was not allowed; Shroudly will not ask by itself again for two weeks': 'logAutoAdvancedDeclined',
  'The downloaded Roblox installer was not signed by Roblox, so it was deleted and not started': 'logRobloxUnsigned',
  'Update ready: it waits while Roblox or Discord goes through Shroudly, and installs once they are closed or the computer has not been used for a while': 'logUpdateWaiting',
  'No tray on this desktop: the window is minimised instead of closed': 'logNoTray',
  'Logs cleared': 'logCleared',
  'Auto Mode: starting protection': 'logAutoModeStarting',
  'Restoring system before exit...': 'logRestoringBeforeExit',
  'Shroudly engine stopped; system restored': 'logEngineStopped',
  'Engine keeps crashing; giving up. Check logs.': 'logEngineGaveUp',
  'Recovering: restoring proxy from previous session': 'logRecovering',
  'System proxy settings restored': 'logProxyRestored',
  'System proxy from the previous session restored': 'logProxyRecoveredPrevious',
  'System proxy left by an earlier version switched off': 'logProxyLegacyOff',
  'Engine stopped responding; restarting it': 'logEngineHung',
  'Advanced mode enabled': 'logAdvancedEnabled',
  'Advanced mode stopped': 'logAdvancedStopped',
  'Advanced backend exited': 'logAdvancedBackendExited',
  'Advanced mode: asking for administrator permission': 'logAdvancedAskingAdmin',
  'Advanced backend did not confirm stop; it exits on its own when Shroudly quits': 'logAdvancedNoStopConfirm',
  'Advanced mode also drops injected resets and measures the decoy TTL': 'logAdvancedProtections',
  'Administrator password not given; the system proxy was not changed': 'logProxyAdminCancelled',
  'Administrator password not given; the proxy settings were not put back': 'logProxyRestoreDeclined',
  'Proxy watchdog not started': 'logProxyWatchdogFailed',
  'Firefox goes through Shroudly; this session does not read the setting Shroudly writes for Chrome and other Chromium browsers, so they have to be set by hand': 'logProxyEnvNotTakenFirefox',
  'Shroudly engine stopped': 'logEngineStoppedOnly',
  'Store apps: permission was not given; Shroudly will not ask by itself again for two weeks': 'logStoreAppsDeclined',
  'Store apps: the exemptions Shroudly added could not be taken out': 'logStoreAppsRemoveFailed',
  'Store apps: the permission prompt was not answered; Shroudly will ask again next time': 'logStoreAppsNoAnswer',
  // Since 2.6.3 the explanation names no country (the older line below
  // still maps to it).
  'DNS on this network answers blocked sites with a known block page.': 'logRegion',
};

/* What another program put in place of Shroudly's system proxy setting
 * (system-proxy.js, describeTakeover), translated inside the line that
 * carries it; ", probably <program>" when the program could be told. */
const PROXY_TO = [
  [/^no proxy \(removed\)$/, 'logProxyToNone', []],
  [/^a PAC on this computer at port (\d+)$/, 'logProxyToLocalPac', ['port']],
  [/^a PAC on another computer$/, 'logProxyToPacOther', []],
  [/^a PAC file on this computer$/, 'logProxyToPacFile', []],
  [/^a PAC found on the network$/, 'logProxyToWpad', []],
  [/^a manual proxy on this computer at port (\d+)$/, 'logProxyToLocalManual', ['port']],
  [/^a manual proxy on this computer$/, 'logProxyToLocalManualAny', []],
  [/^a manual proxy on another computer$/, 'logProxyToRemoteManual', []],
  [/^a manual proxy$/, 'logProxyToManual', []],
  [/^the proxy from the environment variables$/, 'logProxyToEnv', []],
];

function proxyTo(value, t) {
  const m = /^(.+?)(?:, probably (.+))?$/.exec(String(value));
  if (!m) return value;
  const to = translateWith(PROXY_TO, m[1], t) ?? m[1];
  return m[2] ? t('logProxyProbably', { to, program: m[2] }) : to;
}

const PATTERNS = [
  // An app's own connections (not TLS or HTTP) that cannot get through (raw-apps.js).
  [/^(.+?) cannot reach its servers \((.+?)\): the network blocks those addresses themselves;/, 'logRawUnreachable', ['app', 'addrs']],
  [/^(.+?): the network stops its connections \((.+?)\) and no technique got through;/, 'logRawBlocked', ['app', 'addrs']],
  [/^(\S+): could not be reached \(not a web connection\)$/, 'logRawUnreachableAddr', ['addr']],
  [/^(\S+): still blocked after (\d+) techniques \(not a web connection\)$/, 'logRawStillBlockedAddr', ['addr', 'tries']],
  [/^([A-Za-z0-9.:_-]+): could not be reached \(DNS\)$/, 'logUnreachableDns', ['host']],
  [/^([A-Za-z0-9.:_-]+): could not be reached \(connection\)$/, 'logUnreachableConnect', ['host']],
  // Issue #29: what it was changed to, and by which program when that can
  // be told. Before the older, shorter lines, which they would also match.
  [/^Another program changed the system proxy \((.+?)\) to (.+): that traffic no longer goes through Shroudly$/, 'logProxyReplacedTo', ['what', 'to'], { to: proxyTo }],
  [/^Autopilot: another program changed the system proxy \((.+?)\) to (.+); set it back to Shroudly$/, 'logProxyRetakenTo', ['what', 'to'], { to: proxyTo }],
  [/^Another program changed the system proxy \((.+?)\)/, 'logProxyReplaced', ['what']],
  [/^Autopilot: another program changed the system proxy \((.+?)\); set it back to Shroudly$/, 'logProxyRetaken', ['what']],
  [/^Another program keeps changing the system proxy \((.+?)\), probably (.+?); Shroudly stopped setting it back/, 'logProxyFightNamed', ['what', 'program']],
  [/^Another program keeps changing the system proxy \((.+?)\); Shroudly stopped setting it back/, 'logProxyFight', ['what']],
  [/^The proxy setting from before Shroudly \((.+?)\) points at a program on this computer that is no longer running; it was switched off instead of put back$/, 'logProxyOriginalGone', ['pac']],
  [/^System routed through local proxy on port (\d+) \(administrator\)$/, 'logProxyApplied', ['port']],
  [/^System DNS is a program on this computer: (.+)$/, 'logLocalDns', ['programs']],
  [/^Games and apps: the first program connected through Shroudly \((.+)\)$/, 'logAppsFirst', ['host']],
  [/^Roblox installer downloaded through Shroudly and started \((.+)\)$/, 'logRobloxInstalled', ['version']],
  [/^Roblox could not be downloaded \((.+)\)$/, 'logRobloxDownloadFailed', ['detail']],
  [/^Roblox Studio installer downloaded through Shroudly and started \((.+)\)$/, 'logStudioInstalled', ['version']],
  [/^Roblox Studio could not be downloaded \((.+)\)$/, 'logStudioDownloadFailed', ['detail']],
  [/^Autopilot: (.+) did not get through Shroudly; restarted it$/, 'logAutoRestarted', ['app']],
  [/^Autopilot: a Roblox installer went around Shroudly; it was left running \((.+)\) and the user was asked to start it again$/, 'logAutoInstallerLeft', ['why']],
  [/^Autopilot: Roblox went around Shroudly; it was left running \((.+)\) and the user was asked to open it again$/, 'logAutoRobloxLeft', ['why']],
  [/^Autopilot: (.+?) needs Advanced mode(?: \(.+\))?; asking for permission$/, 'logAutoAdvancedAsk', ['host']],
  // Advanced mode needed and not asked for by itself: the same words as the
  // line in the window.
  [/^Autopilot: (.+?) needs Advanced mode on this network(?: \(.*\))?; it was turned off by hand on (\S+), so it is not turned on by itself; turn it on in Settings$/, 'autoAdvancedOffBefore', ['host', 'date']],
  [/^Autopilot: (.+?) needs Advanced mode on this network(?: \(.*\))?; it was not allowed on (\S+), so it is not asked for by itself; turn it on in Settings$/, 'autoAdvancedDeclinedBefore', ['host', 'date']],
  [/^Autopilot: (.+?) needs Advanced mode on this network(?: \(.*\))?; it could not be started earlier in this session; turn it on in Settings$/, 'autoAdvancedFailedBefore', ['host']],
  [/^Autopilot: Discord is blocked on this network, but its mode was turned off by hand on (\S+); turn it on in Settings to use its app$/, 'autoDiscordOffByHand', ['date']],
  [/^Autopilot: Discord is blocked on this network, but its mode could not be turned on \((.+)\); turn it on in Settings to try again$/, 'autoDiscordFailed', []],
  [/^Autopilot: Roblox is blocked on this network, but its mode could not be turned on \((.+)\); turn it on in Settings to try again$/, 'autoRobloxFailed', []],
  [/^Autopilot: Roblox is blocked on this network, but its mode was turned off by hand on (\S+); turn it on in Settings to use its app$/, 'autoRobloxOffByHand', ['date']],
  [/^Store apps: (.+) cannot go through Shroudly; the switch was turned off by hand on (\S+); turn it on in Settings to let them through$/, 'autoStoreAppsOffBefore', ['apps', 'date']],
  [/^The computer woke up or its clock changed \(\w+\); waiting times start afresh$/, 'logWake', []],
  [/^(?:Games and apps|Discord app): could not reach (\S+) \(Shroudly is restarting; try again in a moment\)$/, 'logHeldRestart', ['host']],
  [/^Autopilot: (.+) needs Advanced mode, but a game's anti-cheat is running \((.+)\); not started by itself$/, 'logAutoAdvancedAntiCheat', ['host', 'program']],
  [/^Store apps: (\d+) cannot reach Shroudly \((.+)\); asking for permission$/, 'logStoreAppsAsk', ['count', 'apps']],
  [/^Store apps: (\d+) can now reach Shroudly$/, 'logStoreAppsOn', ['count']],
  [/^Store apps: (.+) cannot go through Shroudly; permission was not given$/, 'logStoreAppsBlocked', ['apps']],
  [/^Store apps: (.+) cannot go through Shroudly until an administrator allows it \(the Microsoft Store apps switch in Settings\)$/, 'logStoreAppsNoAdmin', ['apps']],
  [/^Store apps: they could not be let through \((.+)\)$/, 'logStoreAppsFailed', ['detail']],
  [/^Store apps: the exemptions Shroudly added were taken out \((\d+)\)$/, 'logStoreAppsRemoved', ['count']],
  [/^([A-Za-z0-9.:_-]+): the site itself refuses this connection/, 'logServiceRefused', ['host']],
  [/^([A-Za-z0-9.:_-]+): accepts the connection, then nothing comes back;/, 'logServiceStall', ['host']],
  [/^Discord app mode: (.+) added$/, 'logDiscordAdded', ['builds']],
  [/^(.+) is not going through Shroudly: a proxy or VPN setting of its own, or an extension, is in the way\. Turn it off in \1, or use another browser\.$/, 'autoBrowserAround', ['browser']],
  [/^Port (\d+) is in use by another program; Shroudly is using (\d+) instead\.$/, 'logPortMoved', ['from', 'to']],
  [/^(.+?) is installed but not connected; that does not interfere\.$/, 'logIdleVpn', ['tools']],
  [/^(\S+): connects, then the network cuts it \((\w+) after (\d+) KB\)\./, 'logCut', ['host', 'reason', 'kb']],
  [/^DNS answers on this network match the filtering used in (\w+)\.$/, 'logRegion', ['country']],
  [/^Encrypted DNS answering via (.+)$/, 'logDohRoutes', ['routes']],
  [/^(\S+) could not be opened with encrypted DNS switched off\./, 'logDnsReenabledForBlock', ['host']],
  [/^(.+?) was already running when protection started\./, 'logAppsNeedRestart', ['apps']],
  [/^Encrypted DNS is not reachable on this network/, 'logDohDown', []],
  [/^([A-Za-z0-9.:_-]+): blocked here, opened with (\S+) \((\d+) tries, (\S+)\)(?: — .*)?$/, 'logSiteBypassed', ['host', 'strategy', 'tries', 'family']],
  // Advanced mode already on: nothing to suggest (issue #29).
  [/^([A-Za-z0-9.:_-]+): still blocked after (\d+) techniques \((\S+)\) — Advanced mode is on, and Shroudly keeps trying other ways$/, 'logSiteStillBlockedAdvancedOn', ['host', 'tries', 'family']],
  [/^([A-Za-z0-9.:_-]+): still blocked after (\d+) techniques \((\S+)\)/, 'logSiteStillBlocked', ['host', 'tries', 'family']],
  [/^([A-Za-z0-9.:_-]+): no answer after (\d+) techniques \((\S+)\)/, 'logSiteNoAnswer', ['host', 'tries', 'family']],
  [/^([A-Za-z0-9.:_-]+): the server refused the connection itself \(a TLS alert to the unchanged request\); not a block$/, 'logSiteServerRefused', ['host']],
  [/^([A-Za-z0-9.:_-]+): does not answer, while the rest of the site works through Shroudly; not a block$/, 'logSiteOthersWork', ['host']],
  [/^Techniques remembered for (\d+) sites restored$/, 'logTechniquesRestored', ['count']],
  [/^([A-Za-z0-9.:_-]+): connection dropped while sending \((\S+)\)$/, 'logSiteDropped', ['host', 'family']],
  [/^System: (.+?) — network (.+?), DNS (.+)$/, 'logEnvironment', ['os', 'network', 'dns']],
  [/^Also running: (.+?)\. Another bypass tool/, 'logConflict', ['tools']],
  [/^Your DNS is being tampered with \((.+?)\)\./, 'logDnsForgedFixed', ['hosts']],
  [/^Your provider's DNS returns forged answers for (.+?);/, 'logDnsForgedHandled', ['hosts']],
  [/^Shroudly engine active \(strategy: (.+)\)$/, 'logEngineActive', ['strategy']],
  [/^Engine listening on (\S+)$/, 'logEngineListening', ['address']],
  [/^Starting engine: (.+)$/, 'logEngineStarting', ['detail']],
  [/^Engine exited unexpectedly \(code (.+?)\)\.?$/, 'logEngineCrashed', ['code']],
  [/^Restarting engine in (\d+)\s*ms \(attempt (\d+)\/(\d+)\)$/, 'logEngineRestarting', ['delay', 'attempt', 'max']],
  [/^Auto: (\S+) is not blocked here$/, 'logProbeNotBlocked', ['host']],
  [/^Auto: (\S+) works with (.+)$/, 'logProbeWorks', ['host', 'strategy']],
  [/^Auto: (\S+) stays blocked\b/, 'logProbeBlocked', ['host']],
  [/^System routed through local proxy on port (\d+)$/, 'logProxyApplied', ['port']],
  [/^Could not set system proxy: (.+)$/, 'logProxyFailed', ['detail']],
  [/^Proxy restore issue: (.+)$/, 'logProxyRestoreIssue', ['detail']],
  [/^Start failed: (.+)$/, 'logStartFailed', ['detail']],
  [/^Stop failed: (.+)$/, 'logStopFailed', ['detail']],
  [/^Advanced mode failed: (.+)$/, 'logAdvancedFailed', ['detail']],
  [/^Advanced backend active \(fake TTL (\d+)\)$/, 'logAdvancedBackendActive', ['ttl']],
  [/^Update available: version (\S+)$/, 'logUpdateAvailable', ['version']],
  [/^Update downloaded: version (\S+)$/, 'logUpdateDownloaded', ['version']],
  [/^Update failed: (.+)$/, 'logUpdateFailed', ['detail']],
  [/^Installing update (\S+)$/, 'logUpdateInstalling', ['version']],
  [/^Settings applied \(strategy: (.+)\)$/, 'logSettingsApplied', ['strategy']],
  [/^Site list updated: (\d+) sites \((\d+) added, (-?\d+) removed\)$/, 'logSiteListUpdated', ['count', 'added', 'removed']],
  [/^Site list: the downloaded list was refused \((.+)\)$/, 'logSiteListRefused', ['detail']],
  [/^Site list: could not check for a newer list \((.+)\)$/, 'logSiteListUnreachable', ['detail']],
  [/^Could not change the system proxy as administrator: (.+)$/, 'logProxyAdminFailed', ['detail']],
  [/^KDE proxy setting failed: (.+)$/, 'logKdeProxyFailed', ['detail']],
  [/^gsettings failed: (.+)$/, 'logGsettingsFailed', ['detail']],
  [/^Restart failed: (.+)$/, 'logRestartFailed', ['detail']],
  [/^Could not save proxy state: (.+)$/, 'logProxyStateSaveFailed', ['detail']],
  [/^Could not install proxy restore hook: (.+)$/, 'logProxyHookFailed', ['detail']],
  [/^Could not write (.+?) for the next login: (.+)$/, 'logEnvWriteFailed', ['file', 'detail']],
  [/^Could not update proxy routing: (.+)$/, 'logProxyRoutingFailed', ['detail']],
  [/^Encrypted DNS unavailable: (.+)$/, 'logDohUnavailable', ['detail']],
  [/^engine error: (.+)$/, 'logEngineError', ['detail']],
  // The system proxy not set, why, and the address apps can still be given.
  [/^This macOS account may not change the network settings without an administrator's password\. Apps can still use SOCKS5 (\S+) directly \(PAC: (\S+)\)\.$/, 'logProxyManualNeedsAdmin', ['socks', 'pac']],
  [/^The desktop proxy setting could not be read\. Apps can still use SOCKS5 (\S+) directly \(PAC: (\S+)\)\.$/, 'logProxyManualUnreadable', ['socks', 'pac']],
  [/^The desktop refused the proxy setting\. Apps can still use SOCKS5 (\S+) directly \(PAC: (\S+)\)\.$/, 'logProxyManualRefused', ['socks', 'pac']],
  [/^This desktop has no system proxy setting\. Apps can still use SOCKS5 (\S+) directly \(PAC: (\S+)\)\.$/, 'logProxyManualNoSystem', ['socks', 'pac']],
  [/^This session does not read the setting Shroudly writes for Chrome and other Chromium browsers\. Apps can still use SOCKS5 (\S+) directly \(PAC: (\S+)\)\.$/, 'logProxyManualNotTaken', ['socks', 'pac']],
  [/^The system proxy was not set\. Apps can still use SOCKS5 (\S+) directly \(PAC: (\S+)\)\.$/, 'logProxyManualNotSet', ['socks', 'pac']],
];

/* The first of `table` that matches `msg`, translated; undefined when none
 * does. An entry may name params that are themselves translated (sub). */
function translateWith(table, msg, t) {
  for (const [re, key, names, sub] of table) {
    const m = msg.match(re);
    if (m) {
      const params = {};
      names.forEach((n, i) => { params[n] = m[i + 1]; });
      for (const [n, fn] of Object.entries(sub || {})) params[n] = fn(params[n], t);
      return t(key, params);
    }
  }
  return undefined;
}

export function localizeLog(message, t) {
  if (typeof message !== 'string') return String(message ?? '');
  const msg = message.trim();
  if (EXACT[msg]) return t(EXACT[msg]);
  const out = translateWith(PATTERNS, msg, t);
  return out === undefined ? message : out;
}
