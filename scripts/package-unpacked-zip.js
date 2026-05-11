const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const sourceDir = path.join(root, 'dist', 'win-unpacked');
const outputPath = path.join(root, 'dist', `Shroudly-${packageJson.version}-win-unpacked.zip`);

if (!fs.existsSync(sourceDir)) {
  console.error(`Missing unpacked build: ${sourceDir}`);
  process.exit(1);
}

if (fs.existsSync(outputPath)) {
  fs.rmSync(outputPath, { force: true });
}

execFileSync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${outputPath.replace(/'/g, "''")}' -Force`,
], { stdio: 'inherit' });

console.log(`Created ${outputPath}`);
