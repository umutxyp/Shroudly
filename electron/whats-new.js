'use strict';

/*
 * After an update the main window says once what changed (components/
 * WhatsNew.js, the locales' whatsNewDesktop): the version last started is
 * kept (lastVersionSeen), and a start with another one leaves `whatsNew` set
 * to it until the card is closed, however long the window stays shut. A new
 * install shows nothing; an install from before 2.6.48, which kept no
 * version, counts as updated.
 *
 * Notes already shown are not shown again: a version that changes nothing
 * on the desktop (2.6.61 changed only Android's lite APK) keeps the notes
 * before it, and the card would only repeat them. What was shown is kept as
 * a digest of the English text (whatsNewSeen); the same digest, no card.
 * 2.6.60 kept no digest: SHOWN_BY is what it showed.
 */

const crypto = require('crypto');

const SHOWN_BY = { '2.6.60': '00d448178cc01524' };

function digest(text) {
  return text ? crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16) : null;
}

function note(store, { current, firstRun = false, text = null } = {}) {
  if (!current) return null;
  let last = null;
  let seen = null;
  try { last = store.get('lastVersionSeen') || null; seen = store.get('whatsNewSeen') || null; } catch {}
  if (last === current) return null;
  const d = digest(text);
  const shown = seen || (last && SHOWN_BY[last]) || null;
  const again = !!d && d === shown;
  try {
    store.set('lastVersionSeen', current);
    if (d) store.set('whatsNewSeen', d);
    if (!firstRun && !again && d) store.set('whatsNew', current);
  } catch {}
  // No notes for this system (a version that changes nothing here): no card.
  return firstRun || again || !d ? null : current;
}

module.exports = { note, digest, SHOWN_BY };
