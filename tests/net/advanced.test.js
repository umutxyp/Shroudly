'use strict';

/* The command shown when Advanced mode's library is missing on Linux must be
 * the right one for the distribution: the package name and the installer
 * differ per family. (CI installs exactly these packages on each.) */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const { linuxInstallCommand } = require(path.join(ROOT, 'electron', 'advanced-mode.js'));
const t = suite('advanced');

const CASES = [
  ['ID=arch', 'sudo pacman -S libnetfilter_queue'],
  ['ID=manjaro\nID_LIKE=arch', 'sudo pacman -S libnetfilter_queue'],
  ['ID=endeavouros\nID_LIKE=arch', 'sudo pacman -S libnetfilter_queue'],
  ['ID=fedora', 'sudo dnf install libnetfilter_queue'],
  ['ID="rocky"\nID_LIKE="rhel centos fedora"', 'sudo dnf install libnetfilter_queue'],
  ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"', 'sudo zypper install libnetfilter_queue1'],
  ['ID="opensuse-leap"\nID_LIKE="suse opensuse"', 'sudo zypper install libnetfilter_queue1'],
  ['ID=ubuntu\nID_LIKE=debian', 'sudo apt install libnetfilter-queue1'],
  ['ID=debian', 'sudo apt install libnetfilter-queue1'],
  ['ID=linuxmint\nID_LIKE="ubuntu debian"', 'sudo apt install libnetfilter-queue1'],
  ['', 'sudo apt install libnetfilter-queue1'],
];
for (const [osr, want] of CASES) {
  const got = linuxInstallCommand(osr);
  t.ok(got === want, `${JSON.stringify(osr).slice(0, 44)} -> ${got}`);
}
console.log(`advanced: ${t.count} passed`);
