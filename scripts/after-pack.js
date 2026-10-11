/*
 * electron-builder afterPack hook.
 *
 * macOS: without a Developer ID, electron-builder leaves Electron's original
 * ad-hoc signature, which no longer matches the renamed and modified bundle.
 * Apple Silicon then refuses to open the app ("is damaged"). Re-sign the whole
 * bundle ad hoc so it opens after the usual unidentified-developer prompt.
 * Skipped off macOS (codesign is unavailable) and when a real identity is set.
 *
 * Windows: stamp Shroudly.exe with our icon and version info. electron-builder
 * normally does this with rcedit, which needs Wine off Windows, so
 * signAndEditExecutable is off and we patch the resources here in pure JS.
 * Without it the exe, taskbar button and shortcuts show Electron's icon and
 * Windows calls the app "Electron".
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LANG_EN_US = 1033;

function adHocSignMac(context) {
  if (process.platform !== 'darwin' || process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  file=${path.basename(app)}`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') return adHocSignMac(context);
  if (context.electronPlatformName !== 'win32') return;

  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit');
  const info = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const icoPath = path.join(context.packager.projectDir, 'public', 'icon.ico');

  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const icons = Data.IconFile.from(fs.readFileSync(icoPath)).icons.map((i) => i.data);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error(`[after-pack] no icon group in ${exePath}`);
  for (const g of groups) Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);

  const [version] = Resource.VersionInfo.fromEntries(res.entries);
  if (!version) throw new Error(`[after-pack] no version info in ${exePath}`);
  const [major, minor, patch] = info.version.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  version.setFileVersion(major, minor, patch, 0, LANG_EN_US);
  version.setProductVersion(major, minor, patch, 0, LANG_EN_US);
  const strings = {
    CompanyName: info.companyName || 'Codeshare Technology Ltd',
    FileDescription: info.productName,
    ProductName: info.productName,
    InternalName: info.productName,
    OriginalFilename: `${info.productFilename}.exe`,
    LegalCopyright: info.copyright,
    FileVersion: info.version,
    ProductVersion: info.version,
  };
  for (const lang of version.getAllLanguagesForStringValues()) version.setStringValues(lang, strings);
  version.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • stamped icon + version info  file=${path.basename(exePath)}`);
};
