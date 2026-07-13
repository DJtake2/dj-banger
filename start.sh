#!/usr/bin/env bash
# Launch the Banger app: starts the engine + UI and opens your browser.
#   ./start.sh
set -e
cd "$(dirname "$0")"

# Use the user's Node install if it isn't already on PATH.
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.local/node/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install Node 22+ or add it to your PATH." >&2
  exit 1
fi

echo "Starting Banger…  (Ctrl-C to stop)"
export BANGER_OPEN=1
exec node app/bridge.mjs
