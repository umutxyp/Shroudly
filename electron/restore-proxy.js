'use strict';

/*
 * "Shroudly --restore-proxy" (main.js): run once at login after a run that
 * never got to restore the system proxy (power loss, forced reboot), and by
 * the watchdog after a crash. Restores and exits. The restore itself never
 * asks for a password and never blocks on a dialog. A macOS setting that
 * still needs the administrator's password is asked for afterwards,
 * asynchronously, and only by one process at a time (SystemProxy.recoverAsAdmin's
 * lock file; the app asks the same way once its window is up), in the
 * user's language — and not at all when Shroudly itself starts at this
 * login with protection on (its own password request covers it), nor once
 * the user has dismissed that dialog (the window's button asks then).
 *
 * The state file of a Shroudly that is running (started at the same login)
 * is its live session and is left alone. What was written for the next
 * login on XFCE or LXQt stays: a crash is not the user switching protection
 * off.
 *
 * Kept out of main.js, with what it needs from Electron passed in, so the
 * tests can run it:
 *   stateFile    the proxy state file
 *   settings()   { autoStart, protectionOn, language } from the settings store
 *   languages()  the system's languages (asked once the app is ready)
 *   ready()      resolves once the app is ready (and hides its Dock icon)
 *   recoverOther()  the other leftovers to clear (Games and apps mode)
 * Resolves to 'done', or 'asked' / 'restored' when the dialog was shown.
 */

const SystemProxy = require('./system-proxy');
const i18n = require('./main-i18n');

async function restoreProxy({ stateFile, platform = process.platform, settings = () => ({}), languages = () => [], ready = async () => {}, recoverOther = () => {} } = {}) {
  let kept = false;
  // HTTPS_PROXY first: a program pointed at a proxy that is gone fails
  // outright, while one whose PAC is gone mostly goes direct. And programs
  // started at login read it the moment it is fixed.
  try { recoverOther(); } catch {}
  try { kept = SystemProxy.recoverSync({ stateFile, platform, skipIfOwnerAlive: true }) === 'kept'; } catch {}
  if (!kept || platform !== 'darwin') return 'done';
  let s = {};
  try { s = settings() || {}; } catch {}
  const pending = SystemProxy.pendingAdminRecovery({ stateFile, platform });
  if (!SystemProxy.restoreProcessAsks({ pending, autoStartWithProtection: !!(s.autoStart && s.protectionOn) })) return 'done';
  await ready();
  let strings = null;
  try { strings = i18n.strings(i18n.resolveLanguage(s.language, languages())); } catch {}
  const adminPrompt = (kind) => (strings ? strings[kind === 'restore' ? 'proxyAdminPromptRestore' : 'proxyAdminPrompt'] : null);
  return (await SystemProxy.recoverAsAdmin({ stateFile, platform, adminPrompt })) ? 'restored' : 'asked';
}

module.exports = { restoreProxy };
