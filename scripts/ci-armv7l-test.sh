#!/bin/sh
# 32-bit ARM Linux (release.yml appimage-armv7l), inside a linux/arm/v7
# Debian under QEMU: the armv7l AppImage unpacks with its own runtime, its
# app and engine are 32-bit ARM, the engine starts and answers; the .deb is
# for armhf.
set -eu
cd dist
f=$(ls ./*-Linux-armv7l.AppImage)
d=$(ls ./*-Linux-armv7l.deb)
uname -m
chmod +x "$f"
"$f" --appimage-extract >/dev/null
test -x squashfs-root/shroudly
eng=squashfs-root/resources/app.asar.unpacked/electron/tools/core/linux-armv7l/shroudly-core
test -x "$eng"
apt-get update -qq >/dev/null && apt-get install -y -qq file binutils >/dev/null
file squashfs-root/shroudly | grep -q 'ARM, EABI5'
file "$eng" | grep -q 'ARM, EABI5'
out=$( (sleep 3; echo STOP) | "$eng" --listen 127.0.0.1 --port 18765 --strategy 'split(sni)' 2>&1 | head -n 1 )
echo "$out" | grep -q '"ready"'
echo "ok  $f: 32-bit ARM app and engine, the engine starts ($out)"
dpkg-deb -f "$d" Architecture | grep -qx armhf
dpkg-deb -c "$d" | grep -q 'linux-armv7l/shroudly-core'
echo "ok  $d: armhf, with the 32-bit ARM engine"
