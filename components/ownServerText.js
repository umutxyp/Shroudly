/*
 * "Your own server" in the window (Settings, and the notice under the
 * status when it does not work): why it could not be used, from the codes
 * the background process sends (electron/own-server.js), and what is shown
 * of a link, never its password.
 */

export const OWN_SERVER_WHY = {
  noAnswer: 'ownServerWhyNoAnswer',
  auth: 'ownServerWhyAuth',
  asks: 'ownServerWhyAsks',
  refused: 'ownServerWhyRefused',
  protocol: 'ownServerWhyProtocol',
  silent: 'ownServerWhySilent',
  tls: 'ownServerWhyTls',
};

export const OWN_SERVER_ERRORS = { empty: 'ownServerErrFormat', format: 'ownServerErrFormat', method: 'ownServerErrMethod', user: 'ownServerErrUser' };

const b64 = (s) => {
  try { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); } catch { return ''; }
};

/* "SOCKS5 1.2.3.4:1080", "HTTP proxy.example:3128", "Shadowsocks
 * 5.6.7.8:8388": the kind and the address of a link, or '' . */
export function serverShown(link) {
  const text = String(link || '').trim();
  let m = /^(socks5h?|socks|http):\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(text);
  if (m) return `${/^http$/i.test(m[1]) ? 'HTTP' : 'SOCKS5'} ${m[2]}`;
  m = /^ss:\/\/([^#]+)/i.exec(text);
  if (m) {
    const body = m[1].replace(/\/?\?.*$/, '').replace(/\/$/, '');
    const at = body.lastIndexOf('@');
    const where = at > 0 ? body.slice(at + 1) : (/@([^@]+)$/.exec(b64(body)) || [])[1];
    return where ? `Shadowsocks ${where}` : '';
  }
  return /^[^\s:/@]+:\d{1,5}$|^\[[0-9a-f:.]+\]:\d{1,5}$/i.test(text) ? `SOCKS5 ${text}` : '';
}
