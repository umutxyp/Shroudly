/*
 * Which notices the site test shows for a result (electron/main.js,
 * onProbeResult): the site's own refusal, what the network test found, or
 * both. A site that refuses this country with a page saying so leaves what
 * the network test found standing; silence after connecting means the site
 * could not be used after all.
 */
export function probeView(p) {
  if (!p) return { refused: false, works: false, blocked: false };
  return {
    refused: !!p.service,
    works: !!p.ok && p.service !== 'stall',
    blocked: !p.ok && !p.service,
  };
}
