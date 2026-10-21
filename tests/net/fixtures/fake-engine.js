'use strict';

/* Stands in for shroudly-core in the tests of the app's side of it
 * (engine-wake.test.js): says it is ready on the port it was given, answers
 * STATS, and stops on STOP or when stdin closes. Told HANG, it stops
 * answering (a hung engine); READY_DELAY_MS in the environment holds its
 * "ready" back that long. */

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 0;
let hung = false;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
setTimeout(() => say({ type: 'ready', port, techniques: 3 }), Number(process.env.READY_DELAY_MS) || 0);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const cmd = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (cmd === 'HANG') hung = true;
    else if (cmd === 'STOP') { say({ type: 'stopped' }); process.exit(0); }
    else if (cmd === 'STATS' && !hung) say({ type: 'stats', conns_total: 0, conns_active: 0, bytes_up: 0, bytes_down: 0 });
  }
});
process.stdin.on('end', () => process.exit(0));
// Keeps running while hung (the timer holds the process).
setInterval(() => {}, 60000);
