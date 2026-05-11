const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const exePath = path.join(context.appOutDir, 'Shroudly.exe');
  const iconPath = path.join(context.packager.projectDir, 'public', 'icon.ico');
  const rceditPath = findRcedit(path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign'));
  const version = context.packager.appInfo.version;

  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath) || !rceditPath) {
    console.warn('Skipping Windows icon patch; required file is missing.');
    return;
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
    version,
    '--set-product-version',
    version,
    '--set-requested-execution-level',
    'requireAdministrator',
  ], { stdio: 'inherit' });

  console.log(`Patched Windows executable icon: ${exePath}`);
};
