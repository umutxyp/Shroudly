const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'ShroudlyEngine.cs');
const outputDir = path.join(root, 'electron', 'tools', 'shroudly-engine');
const output = path.join(outputDir, 'ShroudlyEngine.exe');
const cscCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

if (!fs.existsSync(source)) {
  console.error(`Missing engine source: ${source}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const csc = cscCandidates.find((candidate) => fs.existsSync(candidate));
if (!csc) {
  console.error('Could not find csc.exe. Install .NET Framework build tools or Windows SDK.');
  process.exit(1);
}

console.log('Building first-party Shroudly engine...');
execFileSync(csc, [
  '/nologo',
  '/optimize+',
  '/platform:x64',
  '/target:exe',
  `/out:${output}`,
  source,
], { stdio: 'inherit' });

if (!fs.existsSync(path.join(outputDir, 'WinDivert.dll')) || !fs.existsSync(path.join(outputDir, 'WinDivert64.sys'))) {
  console.error('Missing WinDivert runtime files. Place WinDivert.dll and WinDivert64.sys in electron/tools/shroudly-engine.');
  process.exit(1);
}

console.log(`Engine built: ${output}`);
