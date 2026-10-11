/*
 * The background process writes log entries in English. Known messages are
 * mapped to translation keys here (with their variable parts as params);
 * anything unrecognised (raw engine output, OS error text) is shown as-is.
 */

const EXACT = {
  'Application started': 'logAppStarted',
  'Auto-started in tray': 'logAutoStartedTray',
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
};

const PATTERNS = [
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
];

export function localizeLog(message, t) {
  if (typeof message !== 'string') return String(message ?? '');
  const msg = message.trim();
  if (EXACT[msg]) return t(EXACT[msg]);
  for (const [re, key, names] of PATTERNS) {
    const m = msg.match(re);
    if (m) {
      const params = {};
      names.forEach((n, i) => { params[n] = m[i + 1]; });
      return t(key, params);
    }
  }
  return message;
}
