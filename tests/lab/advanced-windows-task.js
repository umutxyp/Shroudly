'use strict';

/* Advanced mode with the administrator permission given once (Windows;
 * core/src/advtask.h, electron/advanced-task.js), on a real Windows with the
 * real Task Scheduler and the real WinDivert driver (CI's Windows runners
 * are Administrator).
 *
 * The app's own code (AdvancedMode) starts Advanced mode a first time: with
 * no copies yet it goes through the prompt's launcher (PowerShell, RunAs),
 * where the engine, which has no console, is handed no streams and must
 * come up all the same, and the engine keeps the permission by itself: it
 * copies itself and WinDivert's files to <Common Files>\Shroudly\advanced
 * and registers its task. The next start must come up through the task
 * (schtasks /Run), not through the launcher, running the copy, with pages
 * loading through it; standby, back
 * and stop work through the user's folder; a request that is not exactly
 * the app's starts nothing; a request used twice never disturbs the engine
 * that runs; and the uninstaller's request removes the task and the copies.
 *
 * The runner has no permission prompt at all (every process is elevated), so
 * a start that fell back to the prompt's way would pass unnoticed: what is
 * checked is that the task's way was the one used.
 *
 *   node tests/lab/advanced-windows-task.js electron/tools/core/win32-x64/shroudly-core-adv.exe
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync, execFile } = require('child_process');
const AdvancedMode = require(path.join(__dirname, '..', '..', 'electron', 'advanced-mode.js'));
const AdvTask = require(path.join(__dirname, '..', '..', 'electron', 'advanced-task.js'));

const engine = path.resolve(process.argv[2] || '');
let fails = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); fails++; };
const note = (m) => console.log(`  ..  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function driverState() {
  try {
    const out = execFileSync('sc', ['query', 'WinDivert'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return ((out.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1]) || out.trim();
  } catch (e) {
    return e.status === 1060 || /1060/.test(String(e.stdout || '')) ? 'missing' : `sc failed (${e.status})`;
  }
}

function get(url, ms = 15000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'user-agent': 'shroudly-lab', connection: 'close' }, agent: false }, (res) => {
      let n = 0;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, complete: res.complete }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.setTimeout(ms, () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

async function loads(label) {
  for (const u of ['https://example.com/', 'https://github.com/']) {
    let r;
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(1000);
      r = await get(u);
      if (!r.error && r.status < 500 && r.complete && r.bytes > 0) break;
    }
    if (!r.error && r.status < 500 && r.complete && r.bytes > 0) ok(`${label}: ${u} -> ${r.status}, ${r.bytes} bytes`);
    else bad(`${label}: ${u} -> ${r.error || `${r.status}, complete=${r.complete}, ${r.bytes} bytes`}`);
  }
}

const runExit = (file, args, ms = 60000) => new Promise((resolve) => {
  execFile(file, args, { timeout: ms, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout || ''}${stderr || ''}`.trim() });
  });
});

function taskXml(name) {
  try { return execFileSync(AdvTask.schtasks(), ['/Query', '/TN', name, '/XML'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return null; }
}

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') { console.log('advanced-windows-task: skipped (Windows x64 only)'); return; }
  if (!fs.existsSync(engine)) { bad(`no engine at ${engine}`); process.exit(1); }
  const bundled = path.dirname(engine);
  const user = AdvTask.userName();
  const admin = AdvTask.adminDir();
  const userDir = AdvTask.userDir();
  if (!user || !admin || !userDir) { bad(`this Windows names no user or folders (user ${user}, ${admin}, ${userDir})`); process.exit(1); }
  const name = AdvTask.taskName(user);
  note(`user ${user}; copies in ${admin}; requests in ${userDir}; task "${name}"`);

  // No console of its own: a task would otherwise show one on the desktop.
  {
    const pe = fs.readFileSync(engine);
    const at = pe.readUInt32LE(0x3c);
    const subsystem = pe.readUInt16LE(at + 24 + 68);
    if (subsystem === 2) ok('the engine opens no console window (windows subsystem)');
    else bad(`the engine is built for subsystem ${subsystem}, not 2: its task would show a console window`);
  }

  // A clean start: nothing of an earlier run.
  try { execFileSync(AdvTask.schtasks(), ['/Delete', '/TN', name, '/F'], { stdio: 'ignore' }); } catch {}
  try { fs.rmSync(admin, { recursive: true, force: true }); } catch {}
  if (!AdvTask.current(bundled, admin) && taskXml(name) === null) ok('before: no copies, no task');
  else bad('before: copies or a task were already there');

  // Asked for another user (an administrator's password typed for a
  // standard user): nothing is installed.
  {
    const r = await runExit(engine, ['--task-install-only', `${user}-someone-else`]);
    if (r.code === 3 && taskXml(name) === null && !fs.existsSync(path.join(admin, 'shroudly-core-adv.exe'))) ok('asked for another user than the one it runs as: nothing installed (exit 3)');
    else bad(`asked for another user: exit ${r.code}, task ${taskXml(name) === null ? 'absent' : 'there'}`);
  }

  // The way of every first start, and of a user's PC after an update: the
  // prompt's launcher (PowerShell, Start-Process -Verb RunAs; here it asks
  // nothing, the runner being elevated already). The engine has no console
  // and is handed no streams this way, and must come up all the same; it
  // also keeps the permission, by itself, for the starts after this one.
  {
    const lines = [];
    const tools0 = [];
    const first = new AdvancedMode((level, m) => { lines.push(m); console.log(`      [${level}] ${m}`); });
    first.bundledDir = () => bundled;
    first.installNoteMs = 3000;
    const run0 = first.runTool;
    first.runTool = (cmd, args, ms) => { tools0.push(path.basename(String(cmd)).toLowerCase()); return run0(cmd, args, ms); };
    let up = null;
    try { up = await first.start(4, {}); } catch (e) { bad(`the first start, through the prompt's launcher, failed: ${e.code} ${e.message}`); }
    if (up && up.success && !first.viaTask && tools0.includes('powershell.exe') && !tools0.includes('schtasks.exe') && lines.includes('Advanced mode: asking for administrator permission')) {
      ok('the first start goes through the prompt\'s launcher (no copies yet, so the task is not even tried), and the engine comes up without a console or streams');
    } else if (up) bad(`the first start: viaTask ${first.viaTask}, tools ${tools0.join(', ')}`);
    if (up) {
      await loads('through the engine started by the launcher');
      for (let i = 0; i < 100 && !(AdvTask.installResult(admin) && AdvTask.current(bundled, admin)); i++) await sleep(100);
      await sleep(3500);
      if (lines.some((m) => /the permission is kept from now on/.test(m))) ok('and it kept the permission by itself: the log says it turns on without asking from now on');
      else bad(`the permission was not kept by the engine started through the launcher: ${JSON.stringify(AdvTask.installResult(admin))}, last lines: ${lines.slice(-2).join(' | ')}`);
      await first.stop();
      for (let i = 0; i < 50 && driverState() !== 'missing'; i++) await sleep(100);
      if (driverState() === 'missing') ok('stopped: the driver is unloaded');
      else bad(`after its stop the driver is ${driverState()}`);
    }
  }

  // What it installed (and the installer once more by hand: doing it again changes nothing).
  {
    const r = await runExit(engine, ['--task-install-only', user]);
    const res = AdvTask.installResult(admin);
    if (r.code === 0 && res && res.ok) ok(`the copies and the task are in place (exit 0, ${JSON.stringify(res)})`);
    else bad(`the installer: exit ${r.code}, result ${JSON.stringify(res)} ${r.out}`);
    if (AdvTask.current(bundled, admin)) ok('the copies are this engine, byte for byte');
    else bad(`the copies differ from the engine: ${fs.existsSync(admin) ? fs.readdirSync(admin).join(', ') : 'no folder'}`);
    const xml = taskXml(name);
    if (!xml) { bad('the task is not registered'); process.exit(1); }
    const want = path.win32.join(admin, 'shroudly-core-adv.exe').toLowerCase();
    const checks = [
      [/<RunLevel>HighestAvailable<\/RunLevel>/.test(xml), 'highest privileges'],
      [/<LogonType>InteractiveToken<\/LogonType>/.test(xml), 'as the user, in their session'],
      [xml.toLowerCase().includes(`<command>"${want}"</command>`) || xml.toLowerCase().includes(`<command>&quot;${want}&quot;</command>`), 'runs the copy only an administrator can write'],
      [/<Arguments>--task<\/Arguments>/.test(xml), 'with no argument but --task'],
      [!/<(TimeTrigger|LogonTrigger|BootTrigger|CalendarTrigger|IdleTrigger|EventTrigger|RegistrationTrigger)/.test(xml), 'on demand only (no trigger)'],
      [/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/.test(xml), 'never ended for running long'],
      [/<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/.test(xml) && /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/.test(xml), 'on battery too'],
      [/<Priority>4<\/Priority>/.test(xml), 'at the usual priority'],
    ];
    const missing = checks.filter((c) => !c[0]).map((c) => c[1]);
    if (!missing.length) ok(`the task: ${checks.map((c) => c[1]).join('; ')}`);
    else bad(`the task lacks: ${missing.join('; ')}\n${xml}`);
    // Who may do what with it (for the log).
    const sd = await runExit('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').GetTask('${name.replace(/'/g, "''")}').GetSecurityDescriptor(0xF)`]);
    note(`the task's access list: ${sd.out || `(not read, exit ${sd.code})`}`);
    // The user: by SID, or by the short name Windows prints for a built-in account (LA).
    const who = '(?:S-1-5-21-[\\d-]+|LA)';
    const mayRun = new RegExp(`\\(A;;(0x1200a9|GRGX|FRFX);;;${who}\\)`).test(sd.out);
    const mayChange = new RegExp(`\\(A;[A-Z]*;(FA|GA|0x1f01ff|0x1f019f);;;${who}\\)`).test(sd.out);
    if (mayRun && !mayChange && !/;;;(WD|AU|BU|IU)\)/.test(sd.out)) ok('this user may read and run it, and nothing more (not change it); no group of users is on its list');
    else bad(`the task's access list is not the one asked for: run ${mayRun}, change ${mayChange}`);
  }

  // The app's own start: through the task, not through the prompt.
  const said = [];
  const tools = [];
  const am = new AdvancedMode((level, m) => { said.push(m); console.log(`      [${level}] ${m}`); });
  am.bundledDir = () => bundled;
  const realRun = am.runTool;
  am.runTool = (cmd, args, ms) => { tools.push(path.basename(String(cmd)).toLowerCase()); return realRun(cmd, args, ms); };
  let started = null;
  try { started = await am.start(4, {}); } catch (e) { bad(`Advanced mode did not start: ${e.code} ${e.message}`); }
  if (started && started.success && am.viaTask && tools.includes('schtasks.exe') && !tools.includes('powershell.exe')
      && said.includes('Advanced mode: starting with the administrator permission given before (no prompt)')) {
    ok(`Advanced mode came up through its task (tools started: ${tools.join(', ')}), the prompt's launcher never used`);
  } else {
    bad(`Advanced mode did not come up through its task: viaTask ${am.viaTask}, tools ${tools.join(', ')}, last lines: ${said.slice(-3).join(' | ')}`);
  }
  if (started && am.viaTask) {
    const status = am.statusFile;
    const firstStatus = status;
    if (path.dirname(status).toLowerCase() === path.win32.join(admin, 'run').toLowerCase() && path.dirname(am.ctl).toLowerCase() === userDir.toLowerCase()) {
      ok('its status is written in the administrator\'s folder, its control files are the user\'s');
    } else bad(`status ${status}, control ${am.ctl}`);
    const where = await runExit('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${am.pid}).Path`]);
    if (where.out.toLowerCase() === path.win32.join(admin, 'shroudly-core-adv.exe').toLowerCase()) ok(`the engine that runs (pid ${am.pid}) is the copy: ${where.out}`);
    else bad(`the engine that runs (pid ${am.pid}) is ${where.out || `unknown (exit ${where.code})`}`);
    if (driverState() === 'RUNNING') ok('the WinDivert driver is loaded');
    else bad(`the WinDivert driver is ${driverState()}`);
    await loads('through the task\'s engine');

    // The same request started once more (by anyone): an id is used once.
    {
      const before = fs.readFileSync(status, 'utf8');
      const r = await runExit(AdvTask.schtasks(), ['/Run', '/TN', name]);
      await sleep(2500);
      const after = fs.readFileSync(status, 'utf8');
      if (r.code === 0 && after.startsWith(before) && /"raw_ready"/.test(after) && am.alive(am.pid)) ok('the same request started a second time: the running engine and its status are untouched');
      else bad(`a second start of the same request: schtasks ${r.code}, status kept ${after.startsWith(before)}`);
    }

    // Standby and back, through the user's folder.
    if (await am.pause()) {
      for (let i = 0; i < 50 && driverState() !== 'missing'; i++) await sleep(100);
      if (driverState() === 'missing') ok('standby: the driver is unloaded, the engine kept');
      else bad(`standby: the driver is ${driverState()}`);
      const back = await am.start(4, {});
      if (back.success && am.active && driverState() === 'RUNNING') ok('back from standby: the hook taken again');
      else bad(`back from standby: ${JSON.stringify(back)}, driver ${driverState()}`);
      await loads('after the standby');
    } else bad('standby was not taken');

    await am.stop();
    for (let i = 0; i < 50 && driverState() !== 'missing'; i++) await sleep(100);
    const text = fs.readFileSync(status, 'utf8');
    if (/"type":"stopped"/.test(text) && driverState() === 'missing') ok('stopped through the user\'s folder: the engine said so, the driver is unloaded');
    else bad(`after the stop: driver ${driverState()}, status ends ${text.slice(-200)}`);
    if (!fs.existsSync(userDir)) ok('the user\'s folder is removed by the app (the engine never deletes there)');
    else bad(`left in the user's folder: ${fs.readdirSync(userDir).join(', ')}`);

    // A request that is not exactly the app's starts nothing.
    {
      const runDir = path.join(admin, 'run');
      const logs = () => fs.readdirSync(runDir).filter((f) => f !== 'install.log').sort().join(',');
      const before = logs();
      const id = AdvTask.newId();
      const evil = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `shroudly-lab-${id}.txt`);
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, 'request'), `shroudly-advanced 1\nid ${id}\n--advanced\n--parent-pid\n${process.pid}\n--status-file\n${evil}\n`);
      const r = await runExit(AdvTask.schtasks(), ['/Run', '/TN', name]);
      await sleep(3000);
      if (r.code === 0 && !fs.existsSync(evil) && logs() === before && driverState() === 'missing') ok('a request naming a file to write: refused whole, nothing started, nothing written');
      else bad(`a request naming a file: schtasks ${r.code}, file ${fs.existsSync(evil) ? 'written' : 'absent'}, logs ${before} -> ${logs()}, driver ${driverState()}`);
      fs.writeFileSync(path.join(userDir, 'request'), `shroudly-advanced 1\nid ..\\..\\..\\x\n--advanced\n--parent-pid\n${process.pid}\n`);
      await runExit(AdvTask.schtasks(), ['/Run', '/TN', name]);
      await sleep(2000);
      if (logs() === before && driverState() === 'missing') ok('a request whose id is a path: refused');
      else bad(`a request whose id is a path: logs ${before} -> ${logs()}`);
      fs.rmSync(userDir, { recursive: true, force: true });
    }

    // A second start of the app's: a new id, and the ended engine's status gone.
    {
      tools.length = 0;
      const again = await am.start(4, {}).catch((e) => ({ success: false, e: e.message }));
      if (again.success && am.viaTask && !tools.includes('powershell.exe') && am.statusFile !== firstStatus && !fs.existsSync(firstStatus)) {
        ok('a second start: through the task again, a new status file, the ended engine\'s removed by the new one');
      } else bad(`a second start: ${JSON.stringify(again)}, viaTask ${am.viaTask}, tools ${tools.join(', ')}, old status ${fs.existsSync(firstStatus) ? 'still there' : 'gone'}`);
      await am.stop();
      for (let i = 0; i < 50 && driverState() !== 'missing'; i++) await sleep(100);
    }

    // Started by a process without administrator rights (what Shroudly is
    // on a user's PC; here every process has them, so one is made without).
    {
      const id = AdvTask.newId();
      const status2 = path.join(admin, 'run', `${id}.log`);
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, 'request'), AdvTask.requestText(id, AdvTask.requestArgs(AdvancedMode.buildArgs({ ttl: 4, statusFile: '', parentPid: process.pid, platform: 'win32' }))));
      const r = await runExit('runas.exe', ['/trustlevel:0x20000', `schtasks.exe /Run /TN "${name}"`], 20000);
      let up = false;
      for (let i = 0; i < 100 && !up; i++) { up = /"raw_ready"/.test((() => { try { return fs.readFileSync(status2, 'utf8'); } catch { return ''; } })()); if (!up) await sleep(100); }
      if (up) ok('started by a process without administrator rights (runas /trustlevel): the engine came up, no prompt');
      else note(`a start from a process made without administrator rights did not come up here (runas: exit ${r.code} ${r.out.slice(0, 200)}); not counted: the runner may not allow such a process`);
      fs.writeFileSync(path.join(userDir, `${id}.stop`), '');
      for (let i = 0; i < 60 && driverState() !== 'missing'; i++) await sleep(100);
      fs.rmSync(userDir, { recursive: true, force: true });
      // Such a process must not be able to change what the task runs.
      const mark = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `shroudly-lab-change-${id}.txt`);
      await runExit('runas.exe', ['/trustlevel:0x20000', `cmd.exe /c schtasks.exe /Change /TN "${name}" /TR "cmd.exe /c echo changed" > "${mark}" 2>&1`], 20000);
      await sleep(3000);
      const xml = taskXml(name) || '';
      const said = (() => { try { return fs.readFileSync(mark, 'utf8').trim().slice(0, 160); } catch { return '(nothing written)'; } })();
      if (/<Arguments>--task<\/Arguments>/.test(xml) && /shroudly-core-adv\.exe/i.test(xml)) ok(`a process without administrator rights cannot change what the task runs (schtasks /Change: ${said})`);
      else bad(`the task was changed by a process without administrator rights: ${xml.slice(-400)}`);
      try { fs.rmSync(mark, { force: true }); } catch {}
    }
  }

  // After an update that changed the engine, the old copy is never started.
  {
    const other = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shroudly-newer-'));
    for (const f of AdvTask.FILES) fs.copyFileSync(path.join(bundled, f), path.join(other, f));
    fs.appendFileSync(path.join(other, 'shroudly-core-adv.exe'), 'newer');
    if (!AdvTask.current(other, admin)) ok('an engine that differs from the copies: not current, so the prompt would be used once');
    else bad('a different engine was taken for current');
    fs.rmSync(other, { recursive: true, force: true });
  }

  // The uninstaller's request: the task and the copies are removed.
  {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'request'), AdvTask.UNINSTALL_TEXT);
    const r = await runExit(AdvTask.schtasks(), ['/Run', '/TN', name]);
    for (let i = 0; i < 100 && taskXml(name) !== null; i++) await sleep(100);
    await sleep(500);
    const left = fs.existsSync(admin) ? fs.readdirSync(admin) : [];
    if (r.code === 0 && taskXml(name) === null) ok('the uninstaller\'s request: the task is gone');
    else bad(`the uninstaller's request: schtasks ${r.code}, the task is ${taskXml(name) === null ? 'gone' : 'still there'}`);
    // The engine cannot delete its own running file: Windows does at its next start.
    if (left.every((f) => f === 'shroudly-core-adv.exe')) ok(`the copies are gone (${left.length ? 'the engine\'s own file goes at the next start of Windows' : 'all of them'})`);
    else bad(`left in ${admin}: ${left.join(', ')}`);
    fs.rmSync(userDir, { recursive: true, force: true });
  }

  if (fails) { console.log(`advanced-windows-task: ${fails} failed`); process.exit(1); }
  console.log('advanced-windows-task: all passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
