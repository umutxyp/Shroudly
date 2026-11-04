'use strict';
/* The page's only link to the app on Android (Snowflake.kt), as the desktop's
 * preload and the Apple app's user script give it: its settings, its
 * counts, and the word to stop. */
window.snowflakeHost = {
  config: () => Promise.resolve(JSON.parse(shroudlySnowflake.config())),
  report: (s) => shroudlySnowflake.report(JSON.stringify(s)),
  onStop: (fn) => { window.__shroudlyStop = fn; },
};
