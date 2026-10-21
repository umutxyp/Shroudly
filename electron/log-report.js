'use strict';

/*
 * The log as text to paste into a report ("Copy logs" in the Logs panel and
 * the tray): a few lines about this computer and Shroudly's state, then
 * every line of the log as it was written, in English with its time and
 * level, not as the window shows it in the user's language. Nothing beyond
 * what the log already says about the sites visited; and it goes to the
 * clipboard only, never anywhere else.
 */

const LEVELS = { error: 'ERROR', warning: 'WARN', success: 'OK', info: 'INFO' };

const onOff = (v) => (v ? 'on' : 'off');

/*
 * s: { version, os, arch, protection: 'on' | 'off' | 'starting',
 *      routeMode, advanced: { on, available }, discordMode, appsMode,
 *      storeApps (Windows: true/false; elsewhere null), now }
 * logs: [{ timestamp, level, message }]
 */
function buildReport(s, logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  // What the log said last about this computer's network (the engine writes
  // it at each start): "System: <os> — network <iface>, DNS <servers>".
  const sys = [...list].reverse().find((l) => typeof l.message === 'string' && l.message.startsWith('System: '));
  const network = sys ? sys.message.replace(/^System: .*? — network /, '') : 'not logged yet';
  const modes = [`Discord app mode ${onOff(s.discordMode)}`, `Games and apps mode ${onOff(s.appsMode)}`];
  if (s.storeApps != null) modes.push(`Microsoft Store apps ${onOff(s.storeApps)}`);
  const adv = s.advanced || {};
  const head = [
    `Shroudly ${s.version} log, copied ${new Date(s.now || Date.now()).toISOString()}`,
    `System: ${s.os} (${s.arch})`,
    `Protection: ${s.protection}; route: ${s.routeMode === 'listed' ? 'listed sites only' : 'every site'}`,
    `Advanced mode: ${onOff(adv.on)}${adv.available === false ? ' (not available here)' : ''}`,
    `Modes: ${modes.join(', ')}`,
    `Network: ${network}`,
    `Lines: ${list.length}`,
  ];
  const body = list.map((l) => `${l.timestamp || ''} ${LEVELS[l.level] || String(l.level || '').toUpperCase()} ${String(l.message ?? '').replace(/\r?\n/g, ' ')}`);
  return `${head.join('\n')}\n${'-'.repeat(40)}\n${body.join('\n')}\n`;
}

module.exports = { buildReport };
