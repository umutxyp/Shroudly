'use strict';

/* Issue #80: programs started while Games and apps mode was on keep its
 * address in their environment; when Shroudly quits or the mode goes off,
 * the ones still running are named once, to be restarted. */

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const t = suite('app-users');
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

t.ok(/appEnv\.clearSync\(\); \} catch \{\}\r?\n[\s\S]{0,200}tellAppUsers\(\);\r?\n\s+if \(appProxy\) appProxy\.stop\(\);/.test(main), 'on quit: named once the address is taken out, before the proxy stops');
t.ok(/if \(!on\) \{\r?\n\s+try \{ appEnv\.clearSync\(\); \} catch \{\}\r?\n\s+tellAppUsers\(\);/.test(main), 'with the mode turned off: the same');
t.ok(/ProcNet\.owner\(s\.remotePort, appProxy\.port\)/.test(main) && /s\.localPort === appProxy\.port/.test(main), 'the programs are the ones holding connections to the program proxy');
t.ok(/!\/\^shroudly\/i\.test\(name\)/.test(main) && /o\.pid !== process\.pid/.test(main), 'never Shroudly itself');
for (const f of fs.readdirSync(path.join(ROOT, 'locales')).filter((x) => x.endsWith('.json'))) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', f), 'utf8')).appUsersRestart;
  if (!s || !s.includes('{apps}')) t.ok(false, `${f}: appUsersRestart with {apps}`);
}
t.ok(true, 'the notice in every language, naming the programs');
console.log(`app-users: ${t.count} passed`);
