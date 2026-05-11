const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const targets = [
  '.next',
  'out',
  'dist',
  path.join('electron', 'tools', 'shroudly-engine', 'ShroudlyEngine.exe'),
];

for (const target of targets) {
  const fullPath = path.join(root, target);

  if (!fs.existsSync(fullPath)) {
    continue;
  }

  try {
    fs.chmodSync(fullPath, 0o666);
  } catch {
    // Directories and locked files may reject chmod on Windows.
  }

  try {
    fs.rmSync(fullPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    });
    console.log(`Removed ${target}`);
  } catch (error) {
    console.warn(`Could not remove ${target}: ${error.message}`);
  }
}
