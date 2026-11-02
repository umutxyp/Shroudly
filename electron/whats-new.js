'use strict';

/*
 * After an update the main window says once what changed (components/
 * WhatsNew.js, the locales' whatsNewDesktop): the version last started is
 * kept (lastVersionSeen), and a start with another one leaves `whatsNew` set
 * to it until the card is closed, however long the window stays shut. A new
 * install shows nothing; an install from before 2.6.48, which kept no
 * version, counts as updated.
 */

function note(store, { current, firstRun = false } = {}) {
  if (!current) return null;
  let last = null;
  try { last = store.get('lastVersionSeen') || null; } catch {}
  if (last === current) return null;
  try {
    store.set('lastVersionSeen', current);
    if (!firstRun) store.set('whatsNew', current);
  } catch {}
  return firstRun ? null : current;
}

module.exports = { note };
