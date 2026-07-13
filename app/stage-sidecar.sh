#!/usr/bin/env bash
# Stage the Node engine (bridge + src + a self-contained node binary) as a Tauri sidecar,
# so the packaged .app can launch the engine on its own. Run before `tauri build`.
set -e
cd "$(dirname "$0")"                       # app/
ST="src-tauri/sidecar"

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$HOME/.local/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then echo "node not found (looked at PATH + ~/.local/node)"; exit 1; fi

mkdir -p "$ST/bin" "$ST/app"

# node binary is ~115MB — only recopy if it changed
if [ ! -f "$ST/bin/node" ] || [ "$NODE_BIN" -nt "$ST/bin/node" ]; then
  cp "$NODE_BIN" "$ST/bin/node"
  chmod +x "$ST/bin/node"
fi

# engine source + bridge + frontend
rm -rf "$ST/src" "$ST/app/public" "$ST/app/bridge.mjs"
cp -R ../src "$ST/src"
cp -R public "$ST/app/public"
cp bridge.mjs "$ST/app/bridge.mjs"

echo "staged sidecar → $ST (node $($NODE_BIN --version))"
