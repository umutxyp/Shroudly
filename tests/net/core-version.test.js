'use strict';

/* The engine's Windows programs carry version info (scripts/core-version-
 * info.js): the product, the company and Shroudly's version, so Windows and
 * antivirus programs see whose they are instead of an unsigned program that
 * names no one. Checked: the resource script says exactly that for both
 * programs, the build scripts compile it into every Windows build, and,
 * wherever zig is installed (every CI machine), a program built the way the
 * engine is built really carries it, read back from the file. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, suite } = require('./helpers');

const t = suite('core-version');
const { versionRc, versionRcFile } = require(path.join(ROOT, 'scripts', 'core-version-info.js'));
const pkg = require(path.join(ROOT, 'package.json'));

function zig() {
  if (spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0) return ['zig'];
  const py = process.platform === 'win32' ? 'python' : 'python3';
  if (spawnSync(py, ['-m', 'ziglang', 'version'], { stdio: 'ignore' }).status === 0) return [py, '-m', 'ziglang'];
  return null;
}

(async () => {
  const [major, minor, patch] = pkg.version.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const core = versionRc('shroudly-core.exe');
  t.ok(core.includes(`FILEVERSION ${major},${minor},${patch},0`) && core.includes(`PRODUCTVERSION ${major},${minor},${patch},0`), `the version is Shroudly's (${pkg.version})`);
  for (const [k, v] of [['CompanyName', pkg.author.name], ['ProductName', pkg.build.productName], ['FileDescription', 'Shroudly engine'],
    ['OriginalFilename', 'shroudly-core.exe'], ['FileVersion', pkg.version], ['LegalCopyright', pkg.build.copyright]]) {
    t.ok(core.includes(`VALUE "${k}", "${v}"`), `shroudly-core.exe: ${k} "${v}"`);
  }
  const adv = versionRc('shroudly-core-adv.exe');
  t.ok(adv.includes('VALUE "FileDescription", "Shroudly Advanced mode engine"') && adv.includes('VALUE "OriginalFilename", "shroudly-core-adv.exe"'), 'shroudly-core-adv.exe: its own name and description');
  t.ok(versionRc('x.exe', '3.1.0-beta.2').includes('FILEVERSION 3,1,0,0'), 'a pre-release version gives its numbers');
  t.ok(versionRc('x.exe', '1.0.0').includes('VALUE "FileVersion", "1.0.0"') && /^#pragma code_page\(65001\)/.test(core), 'UTF-8 (the copyright sign)');
  for (const f of ['build-core.js', 'build-core-advanced.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    t.ok(/versionRcFile\(t\.bin\)/.test(src) && /includes\('windows'\)/.test(src), `${f} compiles it into its Windows builds`);
  }
  const rel = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  t.ok(/build-core\.js --cross/.test(rel) && /build-core-advanced\.js --target win32-x64/.test(rel), 'the release builds both Windows engines with zig');

  const z = zig();
  if (!z) { console.log('  --  zig is not installed here: the built program is checked on CI'); }
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-ver-'));
    const src = path.join(dir, 'main.c');
    const out = path.join(dir, 'shroudly-core.exe');
    fs.writeFileSync(src, 'int main(void) { return 0; }\n');
    const rc = versionRcFile('shroudly-core.exe');
    const r = spawnSync(z[0], [...z.slice(1), 'cc', '-target', 'x86_64-windows-gnu', '-std=c11', '-O2', '-o', out, src, rc.file], { encoding: 'utf8', timeout: 240000 });
    rc.remove();
    t.ok(r.status === 0 && fs.existsSync(out), `zig builds a Windows program with it${r.status ? `: ${String(r.stderr).trim().slice(0, 300)}` : ''}`);
    t.ok(!fs.existsSync(path.dirname(rc.file)), 'the resource script is not left behind');
    const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
    const res = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(out), { ignoreCert: true }));
    const [info] = Resource.VersionInfo.fromEntries(res.entries);
    const s = info ? info.getStringValues(info.getAllLanguagesForStringValues()[0]) : {};
    t.ok(!!info && info.fixedInfo.fileVersionMS === ((major << 16) | minor) && info.fixedInfo.fileVersionLS === (patch << 16),
      `the program says version ${major}.${minor}.${patch}.0`);
    t.ok(s.CompanyName === pkg.author.name && s.ProductName === 'Shroudly' && s.FileDescription === 'Shroudly engine' && s.LegalCopyright === pkg.build.copyright,
      `and whose it is: ${s.ProductName} by ${s.CompanyName} (${s.LegalCopyright})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`core-version: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
