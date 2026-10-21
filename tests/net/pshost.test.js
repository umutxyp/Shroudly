'use strict';

/* The PowerShell kept running for Roblox's programs (electron/ps-host.js),
 * with a stand-in that speaks its line protocol and starts as slowly as
 * PowerShell does on a slow machine: the start is paid once, questions are
 * matched to answers, and one that hangs, dies or never answers is replaced
 * without anyone waiting on it for ever. The real PowerShell is asked on
 * Windows CI (apps.test.js). */

const path = require('path');
const { spawn } = require('child_process');
const { ROOT, sleep, suite } = require('./helpers');

const PsHost = require(path.join(ROOT, 'electron', 'ps-host.js'));
const RobloxApp = require(path.join(ROOT, 'electron', 'roblox-app.js'));
const t = suite('pshost');

/* Answers each line after `delayMs`, one at a time, once `coldMs` have
 * passed; 'hang' never answers that one, 'die' exits on it, 'mute' never
 * answers anything. */
const FAKE = `
const cold = Number(process.env.COLD), delay = Number(process.env.DELAY), mode = process.env.MODE;
let buf = '', queue = [], busy = false, up = false;
setTimeout(() => { up = true; next(); }, cold);
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { queue.push(buf.slice(0, i)); buf = buf.slice(i + 1); } next(); });
process.stdin.on('end', () => process.exit(0));
function next() {
  if (!up || busy || !queue.length || mode === 'mute') return;
  const [id, op, arg] = queue.shift().split(' ');
  if (arg === 'die') process.exit(3);
  if (arg === 'hang') return;
  busy = true;
  setTimeout(() => { process.stdout.write(id + ' ' + op + ' got:' + arg + '\\r\\n'); busy = false; next(); }, delay);
}`;
function fake({ cold = 300, delay = 20, mode = 'ok', idleMs, once } = {}) {
  const started = [];
  const h = new PsHost({
    script: 'x', idleMs,
    start: () => { const c = spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, COLD: String(cold), DELAY: String(delay), MODE: mode } }); started.push(c); return c; },
    once,
  });
  return { h, started };
}
const timed = async (p) => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 }; };

(async () => {
  {
    const { h, started } = fake({ cold: 400 });
    const a = await timed(h.request('info', '1', 5000));
    const b = await timed(h.request('info', '2', 5000));
    t.ok(a.v === 'got:1' && a.ms >= 380 && b.v === 'got:2' && b.ms < 200 && started.length === 1,
      `a slow start is paid once: first answer after ${a.ms} ms, the next after ${b.ms} ms, one process`);
    const [x, y, z] = await Promise.all([h.request('info', 'a', 5000), h.request('sig', 'b', 5000), h.request('info', 'c', 5000)]);
    t.ok(x === 'got:a' && y === 'got:b' && z === 'got:c', 'questions asked together each get their own answer');
    h.stop();
  }
  {
    const { h } = fake({ cold: 400 });
    h.prepare();
    await sleep(500);
    const a = await timed(h.request('info', '1', 5000));
    t.ok(a.v === 'got:1' && a.ms < 200, `started ahead (prepare): the first question is answered at once (${a.ms} ms)`);
    h.stop();
  }
  {
    const { h, started } = fake({ cold: 50 });
    const a = await timed(h.request('sig', 'hang', 300));
    const b = await h.request('info', '7', 3000);
    t.ok(a.v === null && a.ms < 600 && b === 'got:7' && started.length === 2,
      `a question that gets no answer in time: null after ${a.ms} ms, and the stuck one is replaced for the next (${started.length} started)`);
    h.stop();
  }
  {
    const { h, started } = fake({ cold: 50 });
    const other = h.request('info', 'later', 10000);
    const a = await timed(h.request('info', 'die', 10000));
    const o = await other;
    const b = await h.request('info', '8', 3000);
    t.ok(a.v === null && a.ms < 2000 && (o === null || o === 'got:later') && b === 'got:8' && started.length === 2,
      `one that dies answers its questions with null at once (${a.ms} ms, not the 10 s timeout), and is started again for the next`);
    h.stop();
  }
  {
    const { h, started } = fake({ cold: 50, idleMs: 300 });
    await h.request('info', '1', 3000);
    await sleep(600);
    t.ok(h.child === null && (started[0].killed || started[0].exitCode !== null), 'it leaves after a while without questions (its memory is not kept for nothing)');
    t.ok(await h.request('info', '2', 3000) === 'got:2' && started.length === 2 && h.silent === 0, 'and is started again by the next question (leaving is not a failure)');
    h.stop();
  }
  {
    let onceAsked = 0;
    const { h, started } = fake({ mode: 'mute', once: async (script, line) => { onceAsked++; return `noise\r\n${line.split(' ')[0]} info from-once\r\n`; } });
    const a = await h.request('info', '1', 300);
    const b = await h.request('info', '2', 300);
    const c = await h.request('info', '3', 300);
    h.prepare();
    t.ok(a === null && b === null && c === 'from-once' && onceAsked === 1 && started.length === 2 && !h.child,
      'one that never answers, twice: no longer kept running; each question gets a PowerShell of its own, as before');
  }

  // What is sent to the real one: one argument PowerShell reads whole.
  t.ok(!RobloxApp.PS_SCRIPT.includes('"') && RobloxApp.PS_SCRIPT.length < 4000 && /\$env:SHROUDLY_REQ/.test(RobloxApp.PS_SCRIPT) && /\[Console\]::In\.ReadLine\(\)/.test(RobloxApp.PS_SCRIPT),
    `the PowerShell script is one line without double quotes (${RobloxApp.PS_SCRIPT.length} characters), long-lived or answering one request`);

  console.log(`pshost: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
