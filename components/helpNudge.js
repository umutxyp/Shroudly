/*
 * When the Protection panel asks whether the user would like to help people
 * in censored countries (HelpBanner.js; the Android and iPhone apps keep the
 * same numbers): first after a few days of use, then, after each "Not now",
 * a week later, then two weeks, four, eight: every refusal doubles the
 * wait. Kept in Shroudly's settings (helpNudge), so an update or a restart
 * keeps where it was.
 *
 * Not asked where Tor itself is blocked (the home country, national-net.js):
 * there the user is among the people who need the help, a helper there could
 * not reach Tor's side anyway, and taking part could put them at risk.
 */

export const DAY = 24 * 60 * 60 * 1000;
export const FIRST_DAYS = 3;
export const WAIT_DAYS = 7;
// Past ten refusals the wait stops growing (about twenty years).
export const MAX_DOUBLINGS = 10;
export const NOT_FROM = ['BY', 'CN', 'IR', 'MM', 'RU', 'TM'];

/* The state as kept, { first, next, refusals }: started on the first look. */
export function begin(state, now) {
  if (state && Number.isFinite(state.next)) return state;
  return { first: now, next: now + FIRST_DAYS * DAY, refusals: 0 };
}

export function isDue(state, now, country) {
  if (!state || !Number.isFinite(state.next)) return false;
  if (country && NOT_FROM.includes(String(country).toUpperCase())) return false;
  return now >= state.next;
}

function wait(n) {
  return WAIT_DAYS * DAY * 2 ** Math.min(Math.max(n, 0), MAX_DOUBLINGS);
}

/* "Not now": a week after the first, twice as long after each next one. */
export function refuse(state, now) {
  const refusals = ((state && state.refusals) || 0) + 1;
  return { ...state, refusals, next: now + wait(refusals - 1) };
}

/* Turned on: asked again only if it is off once the next wait is over. */
export function accept(state, now) {
  const refusals = (state && state.refusals) || 0;
  return { ...state, accepted: now, next: now + wait(refusals) };
}
