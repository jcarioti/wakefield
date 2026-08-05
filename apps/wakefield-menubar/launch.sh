#!/usr/bin/env bash
set -u -o pipefail

# launchd starts this at login. Establish the managed app-server before
# launching Codex so external Wakefield work shares one durable runtime rather
# than racing the Desktop app's per-window stdio server.
MENU_BAR_EXECUTABLE="$1"
CODEX_PATH="$2"
CODEX_APP="$3"

"$CODEX_PATH" app-server daemon start >/dev/null 2>&1 || true

if [[ -d "$CODEX_APP" ]]; then
  /usr/bin/open -gj "$CODEX_APP"
fi

exec "$MENU_BAR_EXECUTABLE"
