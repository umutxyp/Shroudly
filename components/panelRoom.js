/*
 * How much of the Protection panel fits in the content area (ControlPanel):
 * a plain function of measured heights, so it can be checked without a
 * window. A notice above, the smallest window, large text or a long
 * language can leave the area short; the shield shrinks, then goes, and the
 * support link after it, so the status and the Start/Stop button stay on
 * screen without scrolling.
 */

/* The steps, roomiest first, as globals.css draws them
 * (.power-panel[data-room]): padding above and below, the gap between the
 * blocks, the shield's size. */
export const ROOMS = [['full', 24, 28, 150], ['compact', 16, 16, 96], ['tight', 12, 12, 0]];
// The support link and the gap above it.
export const SUPPORT_ROOM = 42;

/* The first step whose whole panel fits in `area` px, given the status
 * block's and the buttons' heights; 'min' (no support link either) when
 * none does. The heights do not depend on the step, so the answer never
 * flips back and forth as the panel is redrawn. */
export function pickRoom(area, statusH, buttonsH, support) {
  for (const [name, pad, gap, shield] of ROOMS) {
    const need = 2 * pad + (shield ? shield + gap : 0) + statusH + gap + buttonsH + (support ? SUPPORT_ROOM : 0);
    if (need <= area) return name;
  }
  return 'min';
}
