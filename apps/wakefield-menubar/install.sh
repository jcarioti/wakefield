#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE="$ROOT/apps/wakefield-menubar"
APP_NAME="Wakefield Menu"
APP_DIR="$HOME/Applications/${APP_NAME}.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
EXECUTABLE="$MACOS/WakefieldMenuBar"
CLI_PATH="$ROOT/src/cli.mjs"

swift build --package-path "$PACKAGE" -c release

rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"
cp "$PACKAGE/.build/release/WakefieldMenuBar" "$EXECUTABLE"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>WakefieldMenuBar</string>
  <key>CFBundleIdentifier</key>
  <string>dev.wakefield.menubar</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>WakefieldCLIPath</key>
  <string>${CLI_PATH}</string>
</dict>
</plist>
PLIST

open "$APP_DIR"
echo "Installed ${APP_DIR}"
