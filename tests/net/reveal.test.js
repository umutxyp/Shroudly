'use strict';

/* Save logs shows the file in the file manager (electron/reveal.js): Explorer
 * and Finder through Electron; on Linux the file manager over D-Bus with the
 * file selected, else xdg-open on the folder, which must not become one of
 * Shroudly's processes nor hold its output open (a browser opened in its
 * place kept the e2e test waiting forever). Where /bin/sh exists, a stand-in
 * xdg-open shows what really happens. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { reveal } = require('../../electron/reveal');
const { sleep, suite } = require('./helpers');

const t = suite('reveal');

(async () => {
  const file = path.join(os.tmpdir(), 'Shroudly Ümit logs', 'shroudly-log.txt');

  /* Windows and macOS: Electron's own. */
  let shown = null;
  t.ok(await reveal(file, { platform: 'win32', shell: { showItemInFolder: (f) => { shown = f; } } }) === 'shell' && shown === file,
    'Windows and macOS: Explorer or Finder, through Electron');

  /* Linux, a file manager on D-Bus: it, with the file selected; nothing else. */
  let call = null;
  let spawned = false;
  const r1 = await reveal(file, {
    platform: 'linux',
    execFile: (cmd, args, opts, cb) => { call = { cmd, args }; cb(null); },
    spawn: () => { spawned = true; return { on() {}, unref() {} }; },
  });
  t.ok(r1 === 'dbus' && call.cmd === 'dbus-send' && call.args.includes('org.freedesktop.FileManager1.ShowItems'), 'Linux: the file manager over D-Bus');
  const uri = call.args.find((a) => a.startsWith('array:string:')) || '';
  t.ok(uri.startsWith('array:string:file:///') && uri.endsWith('/Shroudly%20%C3%9Cmit%20logs/shroudly-log.txt'), `the file itself, as a file URI (${uri})`);
  t.ok(!spawned, 'and no xdg-open');

  /* Linux, none on D-Bus: xdg-open on the folder, detached, nothing inherited. */
  let sp = null;
  const r2 = await reveal(file, {
    platform: 'linux',
    execFile: (cmd, args, opts, cb) => cb(new Error('ServiceUnknown')),
    spawn: (cmd, args, opts) => { sp = { cmd, args, opts }; return { on() {}, unref() {} }; },
  });
  t.ok(r2 === 'xdg-open' && sp.args.at(-1) === path.dirname(file), 'none answering: xdg-open on the folder');
  t.ok(sp.opts.detached === true && sp.opts.stdio === 'ignore', 'detached, with none of our output or input');

  /* For real, with a stand-in xdg-open that stays (as a browser opened for
   * it does): it gets the folder exactly, and it is not ours. */
  if (process.platform !== 'win32' && fs.existsSync('/bin/sh')) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-bin-'));
    const out = path.join(bin, 'seen.txt');
    fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n%s\\n' "$$" "$1" > "${out}"\nsleep 4\n`, { mode: 0o755 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Shroudly Ümit's logs "));
    const pathBefore = process.env.PATH;
    process.env.PATH = `${bin}:${pathBefore}`;
    try {
      const r3 = await reveal(path.join(dir, 'log.txt'), { platform: 'linux', execFile: (c, a, o, cb) => cb(new Error('no file manager')) });
      let seen = null;
      for (let i = 0; i < 40 && !seen; i++) { await sleep(100); try { const s = fs.readFileSync(out, 'utf8').split('\n'); if (s[1]) seen = s; } catch {} }
      t.ok(r3 === 'xdg-open' && seen && seen[1] === dir, `xdg-open got the folder exactly (${seen && seen[1]})`);
      const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', seen[0]], { encoding: 'utf8' }).trim());
      t.ok(ppid !== process.pid, `and is not one of our processes (its parent is ${ppid}, ours ${process.pid})`);
    } finally {
      process.env.PATH = pathBefore;
      try { execFileSync('pkill', ['-f', `${bin}/xdg-open`]); } catch {}
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`reveal: ${t.count} passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
