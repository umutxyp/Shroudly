/*
 * Version info for the engine's Windows programs (shroudly-core.exe,
 * shroudly-core-adv.exe), compiled in by zig when it builds them.
 *
 * Without it they are unsigned programs that name no product, no company and
 * no version, which antivirus programs score as suspicious on its own: a
 * user's antivirus quarantined shroudly-core.exe along with Shroudly.exe.
 * With it, Windows, Task Manager and the antivirus show "Shroudly" by
 * "Codeshare Technology Ltd", in the same version as Shroudly.exe
 * (after-pack.js stamps that one). zig compiles the resource script itself,
 * with no Windows SDK, from any OS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');

// What each program is, as Task Manager names it.
const DESCRIPTIONS = {
  'shroudly-core.exe': 'Shroudly engine',
  'shroudly-core-adv.exe': 'Shroudly Advanced mode engine',
};

// A string inside the script: a quote is written twice.
const rcString = (s) => `"${String(s).replace(/"/g, '""')}"`;

/* The resource script (a VERSIONINFO block) for the program `bin`. */
function versionRc(bin, version = pkg.version) {
  const [major, minor, patch] = String(version).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const nums = `${major},${minor},${patch},0`;
  const company = (pkg.author && pkg.author.name) || 'Codeshare Technology Ltd';
  const product = (pkg.build && pkg.build.productName) || 'Shroudly';
  const strings = {
    CompanyName: company,
    FileDescription: DESCRIPTIONS[bin] || product,
    FileVersion: version,
    InternalName: bin.replace(/\.exe$/i, ''),
    LegalCopyright: (pkg.build && pkg.build.copyright) || `Copyright © ${company}`,
    OriginalFilename: bin,
    ProductName: product,
    ProductVersion: version,
  };
  return [
    // The copyright sign: the script is UTF-8.
    '#pragma code_page(65001)',
    '1 VERSIONINFO',
    `FILEVERSION ${nums}`,
    `PRODUCTVERSION ${nums}`,
    'FILEFLAGSMASK 0x3f',
    'FILEFLAGS 0x0',
    'FILEOS 0x40004',     // VOS_NT_WINDOWS32
    'FILETYPE 0x1',       // VFT_APP
    'FILESUBTYPE 0x0',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904b0"',  // US English, Unicode
    '    BEGIN',
    ...Object.entries(strings).map(([k, v]) => `      VALUE ${rcString(k)}, ${rcString(v)}`),
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END',
    '',
  ].join('\r\n');
}

/* Writes the script for `bin` into a temporary folder (never next to the
 * program: that folder is packaged) and returns its path, for zig's command
 * line; remove() deletes it afterwards. */
function versionRcFile(bin, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-rc-'));
  const file = path.join(dir, `${bin.replace(/\.exe$/i, '')}.rc`);
  fs.writeFileSync(file, versionRc(bin, version));
  return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { versionRc, versionRcFile, DESCRIPTIONS };
