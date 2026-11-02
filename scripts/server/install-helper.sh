#!/bin/sh
# Shroudly on a Linux server, only to help people in censored countries:
# installs the newest Shroudly and runs "shroudly --help-others" as the
# systemd service shroudly-helper, as a user of its own, so that people where
# Tor is blocked reach it through this server (a Snowflake proxy). The sites
# they open see a Tor exit's address, never this server's, and they reach
# nothing of the server or its network: it is not an open proxy.
#
#   curl -fsSL https://raw.githubusercontent.com/umutxyp/Shroudly/main/scripts/server/install-helper.sh | sudo sh
#
# Run it again to update (a timer also does, once a week). Options:
#   --remove          take it all away again (the service, its user and data,
#                     and the package if this script installed it)
#   --package FILE    install this .deb, .rpm or .AppImage instead of the
#                     newest release (what the release checks use)
#   --update          only if a newer release is out (what the timer runs)
# Debian, Ubuntu, Fedora, RHEL and openSUSE on x86_64 get the release's own
# package (its dependencies come with it); arm64 gets the AppImage, unpacked.
set -eu

REPO=umutxyp/Shroudly
NAME=shroudly-helper
HOME_DIR=/var/lib/shroudly-helper
UNIT=/etc/systemd/system/$NAME.service
UPDATE_UNIT=/etc/systemd/system/$NAME-update.service
TIMER=/etc/systemd/system/$NAME-update.timer
SELF=/usr/local/sbin/$NAME-install
UNPACKED=/opt/shroudly-helper

say() { echo "shroudly-helper: $*"; }
die() { echo "shroudly-helper: $*" >&2; exit 1; }

MODE=install
PACKAGE=
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) MODE=remove ;;
    --update) MODE=update ;;
    --package) [ $# -ge 2 ] || die "--package needs a file"; PACKAGE=$2; shift ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || die "run it as root (sudo)"
[ "$(uname -s)" = Linux ] || die "this is for Linux servers"
command -v systemctl >/dev/null 2>&1 || die "this needs systemd"

if [ "$MODE" = remove ]; then
  systemctl disable --now "$NAME-update.timer" "$NAME.service" >/dev/null 2>&1 || true
  rm -f "$UNIT" "$UPDATE_UNIT" "$TIMER" "$SELF"
  systemctl daemon-reload
  how=$(cat "$HOME_DIR/installed-by-helper" 2>/dev/null || true)
  case "$how" in
    deb) apt-get remove -y shroudly >/dev/null 2>&1 || true ;;
    rpm) if command -v dnf >/dev/null 2>&1; then dnf remove -y shroudly >/dev/null 2>&1 || true
         elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive remove shroudly >/dev/null 2>&1 || true; fi ;;
  esac
  rm -rf "$UNPACKED"
  if id "$NAME" >/dev/null 2>&1; then userdel "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf "$HOME_DIR"
  say "removed"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "no Shroudly build for $(uname -m)" ;;
esac
if [ "$ARCH" = x64 ] && command -v apt-get >/dev/null 2>&1; then KIND=deb; SUFFIX=Linux-amd64.deb
elif [ "$ARCH" = x64 ] && { command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; }; then KIND=rpm; SUFFIX=Linux-x86_64.rpm
elif [ "$ARCH" = x64 ]; then KIND=appimage; SUFFIX=Linux-x86_64.AppImage
else KIND=appimage; SUFFIX=Linux-arm64.AppImage
fi

# The release: the newest, or the file given.
if [ -n "$PACKAGE" ]; then
  [ -f "$PACKAGE" ] || die "no such file: $PACKAGE"
  case "$PACKAGE" in
    *.deb) KIND=deb ;; *.rpm) KIND=rpm ;; *.AppImage) KIND=appimage ;;
    *) die "not a .deb, .rpm or .AppImage: $PACKAGE" ;;
  esac
  FILE=$(cd "$(dirname "$PACKAGE")" && pwd)/$(basename "$PACKAGE")
  VERSION=$(basename "$PACKAGE" | sed -n 's/^Shroudly-\([0-9][0-9.]*\)-.*/\1/p')
else
  command -v curl >/dev/null 2>&1 || die "this needs curl"
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" -o "$TMP/release.json" || die "could not reach GitHub"
  VERSION=$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$TMP/release.json" | head -n 1)
  [ -n "$VERSION" ] || die "could not read the newest release"
  if [ "$MODE" = update ] && [ "$(cat "$HOME_DIR/version" 2>/dev/null || true)" = "$VERSION" ]; then
    say "$VERSION is the newest; nothing to do"
    exit 0
  fi
  URL=$(grep -o "\"browser_download_url\": *\"[^\"]*-$SUFFIX\"" "$TMP/release.json" | sed 's/.*"\(https[^"]*\)"$/\1/' | head -n 1)
  [ -n "$URL" ] || die "the release has no $SUFFIX"
  FILE="$TMP/$(basename "$URL")"
  say "downloading Shroudly $VERSION ($(basename "$URL"))"
  curl -fsSL "$URL" -o "$FILE" || die "the download failed"
  # The file's SHA-256 as GitHub lists it, where python3 is there to read it.
  if command -v python3 >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1; then
    want=$(python3 -c 'import json,sys
for a in json.load(open(sys.argv[1])).get("assets", []):
    if a.get("browser_download_url") == sys.argv[2]:
        print((a.get("digest") or "").replace("sha256:", ""))' "$TMP/release.json" "$URL")
    if [ -n "$want" ]; then
      [ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$want" ] || die "the download does not match GitHub's checksum"
      say "checksum ok"
    fi
  fi
fi

# Installed: the package and its dependencies, or the AppImage unpacked. A
# Shroudly that was there before (the desktop app) stays at --remove.
before=no
[ -x /opt/Shroudly/shroudly ] && before=yes
case "$KIND" in
  deb)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "$FILE" >/dev/null
    APP=/opt/Shroudly/shroudly ;;
  rpm)
    if command -v dnf >/dev/null 2>&1; then dnf install -y -q "$FILE" >/dev/null
    else zypper --non-interactive --no-gpg-checks install "$FILE" >/dev/null; fi
    APP=/opt/Shroudly/shroudly ;;
  appimage)
    chmod +x "$FILE"
    (cd "$TMP" && "$FILE" --appimage-extract >/dev/null) || die "could not unpack the AppImage"
    rm -rf "$UNPACKED"
    mv "$TMP/squashfs-root" "$UNPACKED"
    # Chromium's sandbox helper, as the packages install it.
    chown root:root "$UNPACKED/chrome-sandbox" && chmod 4755 "$UNPACKED/chrome-sandbox"
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      for p in libnss3 libgbm1 libdrm2 libxkbcommon0 libxtst6 libatspi2.0-0 "libgtk-3-0t64|libgtk-3-0" "libasound2t64|libasound2"; do
        for alt in $(echo "$p" | tr '|' ' '); do apt-get install -y -qq "$alt" >/dev/null 2>&1 && break; done
      done
    fi
    APP=$UNPACKED/shroudly ;;
esac
[ -x "$APP" ] || die "Shroudly is not where it should be ($APP)"

# Its own user, which can log in nowhere.
if ! id "$NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$HOME_DIR" --create-home --shell "$(command -v nologin || echo /bin/false)" "$NAME"
fi
mkdir -p "$HOME_DIR/data"
chown -R "$NAME:$NAME" "$HOME_DIR"
if [ ! -f "$HOME_DIR/installed-by-helper" ] && { [ "$before" = no ] || [ "$KIND" = appimage ]; }; then
  echo "$KIND" > "$HOME_DIR/installed-by-helper"
fi
echo "$VERSION" > "$HOME_DIR/version"

cat > "$UNIT" <<EOF
[Unit]
Description=Shroudly helper: people in censored countries reach Tor through this server
Documentation=https://github.com/umutxyp/Shroudly#on-a-server
After=network-online.target
Wants=network-online.target

[Service]
User=$NAME
Group=$NAME
Environment=HOME=$HOME_DIR
WorkingDirectory=$HOME_DIR
ExecStart=$APP --help-others --ozone-platform=headless --data-dir=$HOME_DIR/data
Restart=always
RestartSec=30
Nice=10
MemoryMax=700M
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

# Kept up to date: this script, once a week.
if [ -f "$0" ] && head -n 1 "$0" 2>/dev/null | grep -q '^#!/bin/sh' && grep -q 'shroudly-helper' "$0" 2>/dev/null; then
  [ "$0" = "$SELF" ] || cp "$0" "$SELF"
else
  curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/server/install-helper.sh" -o "$SELF" || die "could not keep a copy for updates"
fi
chmod 755 "$SELF"
cat > "$UPDATE_UNIT" <<EOF
[Unit]
Description=Update the Shroudly helper to the newest release

[Service]
Type=oneshot
ExecStart=$SELF --update
EOF
cat > "$TIMER" <<EOF
[Unit]
Description=Update the Shroudly helper once a week

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$NAME-update.timer" >/dev/null
systemctl enable "$NAME.service" >/dev/null
systemctl restart "$NAME.service"
sleep 8
if systemctl is-active --quiet "$NAME.service"; then
  say "Shroudly $VERSION is helping people in censored countries from this server"
  say "what it does: journalctl -u $NAME -f    to stop: systemctl stop $NAME    to remove: $SELF --remove"
else
  journalctl -u "$NAME" -n 20 --no-pager || true
  die "the service did not stay up (above: why)"
fi
