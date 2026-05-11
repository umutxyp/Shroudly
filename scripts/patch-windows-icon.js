const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const exePath = path.join(root, 'dist', 'win-unpacked', 'Shroudly.exe');
const iconPath = path.join(root, 'public', 'icon.ico');
const packageJson = require(path.join(root, 'package.json'));
const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');

function findRcedit(dir) {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.name === 'rcedit-x64.exe') {
        return fullPath;
      }
    }
  }

  return null;
}

if (!fs.existsSync(exePath)) {
  console.error(`Missing packaged executable: ${exePath}`);
  process.exit(1);
}

if (!fs.existsSync(iconPath)) {
  console.error(`Missing icon: ${iconPath}`);
  process.exit(1);
}

const rceditPath = findRcedit(cacheRoot);
if (!rceditPath) {
  console.error(`rcedit-x64.exe not found in ${cacheRoot}`);
  process.exit(1);
}

execFileSync(rceditPath, [
  exePath,
  '--set-icon',
  iconPath,
  '--set-version-string',
  'FileDescription',
  'Shroudly',
  '--set-version-string',
  'ProductName',
  'Shroudly',
  '--set-version-string',
  'CompanyName',
  'Codeshare Technology Ltd',
  '--set-version-string',
  'LegalCopyright',
  'Copyright (c) 2026 Codeshare Technology Ltd',
  '--set-file-version',
  packageJson.version,
  '--set-product-version',
  packageJson.version,
  '--set-requested-execution-level',
  'requireAdministrator',
], { stdio: 'inherit' });

console.log(`Patched Windows icon and metadata: ${exePath}`);
