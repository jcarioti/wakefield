#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE="$ROOT/apps/wakefield-menubar"
APP_NAME="Wakefield"
APP_DIR="$HOME/Applications/${APP_NAME}.app"
LEGACY_APP_DIR="$HOME/Applications/Wakefield Menu.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
EXECUTABLE="$MACOS/WakefieldMenuBar"
LAUNCHER="$MACOS/WakefieldLaunch"
LAUNCH_AGENT_LABEL="dev.wakefield.menubar"
LAUNCH_AGENT_PATH="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
CLI_PATH="$ROOT/src/cli.mjs"
NODE_PATH="${WAKEFIELD_NODE:-${WAKEFIELD_NODE_PATH:-${npm_node_execpath:-}}}"
if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH="$(command -v node || true)"
fi

pkill -x WakefieldMenuBar >/dev/null 2>&1 || true

swift build --package-path "$PACKAGE" -c release

rm -rf "$APP_DIR"
rm -rf "$LEGACY_APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"
cp "$PACKAGE/.build/release/WakefieldMenuBar" "$EXECUTABLE"
cp "$PACKAGE/launch.sh" "$LAUNCHER"
chmod +x "$LAUNCHER"
if [[ -d "$PACKAGE/Resources" ]]; then
  cp -R "$PACKAGE/Resources/." "$RESOURCES/"
fi

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
  <key>CFBundleIconFile</key>
  <string>Wakefield</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>WakefieldCLIPath</key>
  <string>${CLI_PATH}</string>
  <key>WakefieldNodePath</key>
  <string>${NODE_PATH}</string>
</dict>
</plist>
PLIST

mkdir -p "$HOME/Library/LaunchAgents"
# This is Codex's durable, login-time app-server manager. Keep it enabled so
# Wakefield's controller has its daemon before the Desktop app is opened.
"$HOME/.codex/packages/standalone/current/codex" app-server daemon bootstrap --remote-control
launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
cat > "$LAUNCH_AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCHER}</string>
    <string>${EXECUTABLE}</string>
    <string>${HOME}/.codex/packages/standalone/current/codex</string>
    <string>/Applications/ChatGPT.app</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"

echo "Installed ${APP_DIR} and loaded ${LAUNCH_AGENT_LABEL}"
