'use strict';

/* Where the engine binary is: next to the app's code when run from source,
 * in app.asar.unpacked once packaged. Apart from engine-manager.js so the
 * modules it requires (win-reg.js through system-proxy.js) can find it too. */

const path = require('path');

function coreBinaryPath() {
  const plat = process.platform;              // win32 | darwin | linux
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dir = `${plat}-${arch}`;
  const bin = plat === 'win32' ? 'shroudly-core.exe' : 'shroudly-core';

  // Packaged: resources/app.asar.unpacked/electron/tools/core/<dir>/bin
  const rel = path.join('electron', 'tools', 'core', dir, bin);
  const packaged = __dirname.includes('app.asar');
  if (packaged) {
    const res = process.resourcesPath || path.join(__dirname, '..', '..', '..');
    return path.join(res, 'app.asar.unpacked', rel);
  }
  return path.join(__dirname, 'tools', 'core', dir, bin);
}

module.exports = { coreBinaryPath };
