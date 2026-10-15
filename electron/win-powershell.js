'use strict';

/* Starting Windows PowerShell (powershell.exe, 5.1) from a process that came
 * from PowerShell 7 (a pwsh window, a CI step) hands it 7's PSModulePath. It
 * then loads 7's Microsoft.PowerShell.Security and Management modules, fails,
 * and cmdlets such as Get-AuthenticodeSignature are "not found". Without the
 * variable, Windows PowerShell uses its own module folders. */

const isPowerShell = (cmd) => /(^|[\\/])powershell(\.exe)?$/i.test(String(cmd || ''));

function powershellEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (k.toUpperCase() !== 'PSMODULEPATH') out[k] = v;
  return out;
}

/* The env option for starting cmd: PowerShell's without PSModulePath, any
 * other program's as given (undefined: the app's own). */
function envFor(cmd, env) { return isPowerShell(cmd) ? powershellEnv(env || process.env) : env; }

module.exports = { envFor, powershellEnv, isPowerShell };
