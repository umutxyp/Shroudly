/*
 * Which notice the site test shows for a result (electron/main.js,
 * onProbeResult): the site's own refusal, or what the network test found,
 * never both. A refusal says itself that the network is no longer in the
 * way; a green "opens" under it read as the opposite of the yellow above.
 */
export function probeView(p) {
  if (!p) return { refused: false, works: false, blocked: false };
  return {
    refused: !!p.service,
    works: !!p.ok && !p.service,
    blocked: !p.ok && !p.service,
  };
}
