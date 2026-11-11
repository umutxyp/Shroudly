'use strict';

/*
 * Tor for the last way out, fetched on a computer the first time a site
 * needs it (issue #75: Shroudly stays the size it was for everyone who never
 * needs Tor), or when the user asks for it ahead of time (Settings, "Prepare
 * it now"). The Tor Project's own Expert Bundle for this computer
 * (tor-files.js), through Shroudly's engine (so a network that blocks
 * torproject.org does not stop it), checked against its pinned SHA-256 before
 * a single file of it is used; then only what is needed is unpacked, into
 * this user's folder.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');
const T = require('./tor-files');

function target(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'ia32' : arch === 'arm' ? 'armv7l' : 'x64';
  return `${platform}-${a}`;
}

/* GET url through the engine (SOCKS on 127.0.0.1:socksPort), following up
 * to five redirects, into file; onProgress(received, total). */
async function fetchTo(url, file, { socksPort, connect, onProgress = () => {}, timeoutMs = 120000, tlsOptions = {} }) {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (u.protocol !== 'https:') throw new Error(`not https: ${u.href}`);
    const raw = await connect(socksPort, u.hostname, 443);
    const res = await new Promise((resolve, reject) => {
      const s = tls.connect({ ...tlsOptions, socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
      let head = Buffer.alloc(0); let out = null; let total = 0; let got = 0; let done = false;
      const timer = setTimeout(() => { s.destroy(); reject(new Error('timed out')); }, timeoutMs);
      // Settled once the file is closed: everything written is on disk.
      const finish = (v, e) => {
        if (done) return;
        done = true; clearTimeout(timer);
        const settle = () => (e ? reject(e) : resolve(v));
        if (out) out.end(settle); else settle();
      };
      s.on('secureConnect', () => s.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: Shroudly\r\nConnection: close\r\n\r\n`));
      s.on('data', (d) => {
        if (out) { got += d.length; out.write(d); onProgress(got, total); return; }
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) { if (head.length > 65536) finish(null, new Error('bad answer')); return; }
        const lines = head.subarray(0, end).toString('latin1').split('\r\n');
        const status = Number((lines[0].match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
        const hdr = (n) => { const l = lines.find((x) => x.toLowerCase().startsWith(`${n}:`)); return l ? l.slice(n.length + 1).trim() : null; };
        if (status >= 300 && status < 400 && hdr('location')) { finish({ redirect: hdr('location') }); s.destroy(); return; }
        if (status !== 200) { finish(null, new Error(`HTTP ${status}`)); s.destroy(); return; }
        if (/chunked/i.test(hdr('transfer-encoding') || '')) { finish(null, new Error('chunked answer')); s.destroy(); return; }
        total = Number(hdr('content-length')) || 0;
        out = fs.createWriteStream(file);
        const rest = head.subarray(end + 4);
        got = rest.length; out.write(rest); onProgress(got, total);
      });
      // Ended before an answer (a network that cuts the name): said so, not
      // taken for an empty file ("ENOENT bundle.tar.gz" in a Russian report).
      const ended = () => (out ? finish({ done: true, got, total }) : finish(null, new Error('the connection was cut before any answer')));
      s.on('end', ended);
      s.on('close', ended);
      s.on('error', (e) => finish(null, e));
    });
    if (res.redirect) { u = new URL(res.redirect, u); continue; }
    if (res.total && res.got !== res.total) throw new Error('download cut short');
    return;
  }
  throw new Error('too many redirects');
}

function untar(tgz, dest) {
  // Windows' own bsdtar by its full path (another "tar" may read "C:" as a host).
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', tgz, '-C', dest], { stdio: 'ignore', windowsHide: true });
}

/*
 * Tor and its transports for this computer, in dir (made complete or not at
 * all). opts: socksPort, connect (the engine's SOCKS), onProgress(0..100),
 * log; sources, sha256, tlsOptions, unsigned (tests). Resolves dir.
 */
async function ensure(dir, opts = {}) {
  const t = T.DESKTOP[opts.target || target()];
  if (!t) throw new Error('no Tor build for this computer');
  const want = [...Object.values(t.files), ...Object.values(T.COMMON)];
  if (want.every((f) => fs.existsSync(path.join(dir, f)))) return dir;
  const sha = (opts.sha256 || T.SHA256)[t.bundle];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-tor-'));
  try {
    const tgz = path.join(work, 'bundle.tar.gz');
    let last = null;
    for (const base of opts.sources || T.SOURCES) {
      try {
        await fetchTo(base + T.fileName(t.bundle), tgz, {
          socksPort: opts.socksPort, connect: opts.connect, tlsOptions: opts.tlsOptions,
          onProgress: (got, total) => { if (total && opts.onProgress) opts.onProgress(Math.floor((got / total) * 100)); },
        });
        const got = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
        if (got !== sha) throw new Error('the download is not the Tor Project\'s file (SHA-256 differs)');
        last = null;
        break;
      } catch (e) { last = e; if (opts.log) opts.log('warning', `The last way out: Tor could not be fetched from ${new URL(base).hostname} (${e.message})`); }
    }
    if (last) throw last;
    const x = path.join(work, 'x');
    fs.mkdirSync(x);
    untar(tgz, x);
    const next = `${dir}.part`;
    fs.rmSync(next, { recursive: true, force: true });
    fs.mkdirSync(next, { recursive: true });
    for (const [from, to] of Object.entries({ ...t.files, ...T.COMMON })) {
      fs.copyFileSync(path.join(x, from), path.join(next, to));
      fs.chmodSync(path.join(next, to), from.endsWith('.json') || from.endsWith('.txt') ? 0o644 : 0o755);
    }
    // macOS: the bundle's signatures do not survive being copied out of it
    // (Apple silicon ends the program at once); signed again, ad hoc.
    if (process.platform === 'darwin' && !opts.unsigned) {
      for (const f of Object.values(t.files)) execFileSync('codesign', ['--force', '-s', '-', path.join(next, f)], { stdio: 'ignore' });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(next, dir);
    return dir;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { ensure, fetchTo, target };
