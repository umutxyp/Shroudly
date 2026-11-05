'use strict';

/* The running programs and their TCP connections read by the engine
 * (PROCS, TCP; core/src/winprocs.h) instead of tasklist.exe and netstat.exe,
 * which on a slow PC cost real CPU every few seconds. Covered:
 *   - the engine's rows, turned into tasklist's and netstat's text, read the
 *     same by every reader of those (procnet, browser-check, autopilot's
 *     anti-cheat guard)
 *   - one list shared by every look within a few seconds; the engine first,
 *     tasklist or netstat only when it cannot say
 *   - EngineManager asks the running engine and gathers its rows
 *   - on Windows, the real engine: itself among the programs, by name and
 *     session; a connection made to it among the TCP rows, with its owner;
 *     elsewhere it says it cannot (the app keeps its usual tools) */

const net = require('net');
const H = require('./helpers');
const ProcNet = require('../../electron/procnet');
const BrowserCheck = require('../../electron/browser-check');
const Autopilot = require('../../electron/autopilot');
const EngineManager = require('../../electron/engine-manager');

const t = H.suite('winprocs');

(async () => {
  // Rows as the engine gives them, read as tasklist's and netstat's text.
  const procs = [{ n: 'chrome.exe', p: 4120, s: 1 }, { n: 'svchost.exe', p: 900, s: 0 }, { n: 'EasyAntiCheat.exe', p: 77, s: 1 }, { n: 'Fortnite-Win64-Shipping.exe', p: 78, s: 1 }];
  const csv = ProcNet.procsCsv(procs);
  const names = ProcNet.parseTasklistNames(csv, 1);
  t.ok(names.get(4120) === 'chrome.exe' && !names.has(900), 'tasklist\'s text: names by pid, another session left out');
  const browsers = BrowserCheck.parseProcesses ? BrowserCheck.parseProcesses(csv, 'win32', 1) : null;
  t.ok(!browsers || browsers.some((b) => b.pid === 4120 && b.name === 'chrome.exe'), 'read by browser-check as tasklist\'s');
  t.ok(!!Autopilot.antiCheatIn(csv), `read by the anti-cheat guard as tasklist's (${Autopilot.antiCheatIn(csv)})`);
  const tcp = [
    { l: '127.0.0.1:50000', r: '127.0.0.1:7890', st: 'SYN_SENT', p: 4120 },
    { l: '0.0.0.0:445', r: '0.0.0.0:0', st: 'LISTENING', p: 4 },
    { l: '[::1]:50001', r: '[::1]:1080', st: 'ESTABLISHED', p: 4120 },
    { l: '192.168.1.5:50002', r: '142.250.1.1:443', st: 'ESTABLISHED', p: 5000 },
  ];
  const text = ProcNet.tcpText(tcp);
  const rows = ProcNet.parseNetstat(text);
  t.ok(rows.length === 3 && rows.some((r) => r.pid === 4120 && r.remote.port === 7890) && rows.some((r) => r.remote.host.includes('::1') && r.remote.port === 1080),
    'netstat\'s text: connections with their owners, IPv6 too, listening sockets left out');
  t.ok(ProcNet.parseNetstatAll(text).length === 3, 'read the same by the other netstat reader');
  t.ok(ProcNet.heldLocally(rows, { ours: [] }).get(4120)?.join() === '7890,1080', 'a program held on proxy ports, found as from netstat');

  // Shared, engine first.
  let asked = 0;
  ProcNet.setNative({ procs: async () => { asked++; return procs; }, tcp: async () => tcp });
  const a = await ProcNet.tasklistText(60000);
  const b = await ProcNet.tasklistText(60000);
  t.ok(a === csv && b === csv && asked === 1, 'one list for every look within its time, from the engine');
  await ProcNet.tasklistText(0);
  t.ok(asked === 2, 'asked again when it must be fresh');
  t.ok((await ProcNet.netstatText(0)) === text, 'the TCP rows from the engine too');
  ProcNet.setNative({ procs: async () => null, tcp: async () => null });
  const fallback = await ProcNet.tasklistText(0);
  t.ok(typeof fallback === 'string', 'the engine cannot say: tasklist instead (empty where there is none)');
  ProcNet.setNative(null);

  // EngineManager asks the running engine and gathers its rows.
  {
    const mem = {};
    const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, delete: (k) => { delete mem[k]; } };
    const em = new EngineManager(store, {});
    const sent = [];
    em.active = true;
    em.proc = { stdin: { writable: true, write: (s) => { sent.push(s.trim()); return true; } } };
    const p = em.nativeList('PROCS');
    const p2 = em.nativeList('PROCS');
    em._onLine(JSON.stringify({ type: 'proc', n: 'a.exe', p: 1, s: 1 }));
    em._onLine(JSON.stringify({ type: 'proc', n: 'b.exe', p: 2, s: 1 }));
    em._onLine(JSON.stringify({ type: 'procs_end', n: 2 }));
    const got = await p;
    t.ok(sent.filter((x) => x === 'PROCS').length === 1 && got.length === 2 && (await p2) === got, 'EngineManager: PROCS asked once, its rows gathered');
    const q = em.nativeList('TCP');
    em._onLine(JSON.stringify({ type: 'tcp_end', n: -1 }));
    t.ok((await q) === null, 'an engine that cannot say: null, so the usual tools are used');
    em.active = false;
    t.ok((await em.nativeList('TCP')) === null, 'not running: null at once');
  }

  // The real engine.
  {
    const P = await H.freePort();
    const eng = await H.startEngine(P, []);
    const ask = async (cmd, end) => {
      const before = eng.out.length;
      eng.proc.stdin.write(`${cmd}\n`);
      for (let i = 0; i < 40 && !eng.out.slice(before).includes(`"type":"${end}"`); i++) await H.sleep(50);
      return eng.out.slice(before).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    };
    if (process.platform === 'win32') {
      const list = await ask('PROCS', 'procs_end');
      const me = list.find((r) => r.type === 'proc' && r.p === eng.proc.pid);
      const end = list.find((r) => r.type === 'procs_end');
      t.ok(me && /^shroudly-core\.exe$/i.test(me.n) && Number.isInteger(me.s) && end && end.n === list.filter((r) => r.type === 'proc').length && end.n > 10,
        `Windows: the programs running, the engine among them by name and session (${end && end.n} programs)`);
      const sock = net.connect(P, '127.0.0.1');
      await new Promise((r) => sock.once('connect', r));
      const rowsTcp = (await ask('TCP', 'tcp_end')).filter((r) => r.type === 'tcp');
      const mine = rowsTcp.find((r) => r.r === `127.0.0.1:${P}` && r.p === process.pid && r.st === 'ESTABLISHED');
      const listen = rowsTcp.find((r) => r.l === `127.0.0.1:${P}` && r.st === 'LISTENING' && r.p === eng.proc.pid);
      t.ok(!!mine && !!listen, `Windows: the TCP connections with their owners, as netstat -ano lists them (${rowsTcp.length} rows)`);
      const parsed = ProcNet.parseNetstat(ProcNet.tcpText(rowsTcp));
      t.ok(parsed.some((r) => r.pid === process.pid && r.remote.port === P), 'and read by procnet as from netstat');
      sock.destroy();
    } else {
      const a1 = await ask('PROCS', 'procs_end');
      const a2 = await ask('TCP', 'tcp_end');
      t.ok(a1.some((r) => r.type === 'procs_end' && r.n === -1) && a2.some((r) => r.type === 'tcp_end' && r.n === -1),
        'not Windows: the engine says it cannot, and the app keeps its usual tools');
    }
    eng.stop();
  }

  console.log(`winprocs: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
