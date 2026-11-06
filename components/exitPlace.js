/* "80.174.118.60 · 🇮🇹 Italy": the address sites see through the user's own
 * server, with the country Cloudflare places it in (issue #60), the
 * country's name in the window's language. Without a country, the address
 * alone. Windows shows a flag as its two letters; the name says it anyway. */
export function exitWithPlace(ip, loc, language) {
  if (!ip) return '';
  if (!/^[A-Z]{2}$/.test(loc || '')) return ip;
  const flag = String.fromCodePoint(...[...loc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  let name = loc;
  try { name = new Intl.DisplayNames([language || 'en', 'en'], { type: 'region' }).of(loc) || loc; } catch {}
  return `${ip} · ${flag} ${name}`;
}
