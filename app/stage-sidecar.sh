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

# Seed caches so a fresh install ships with data instead of re-fetching everything:
# world popularity (Deezer ranks) + artist-similarity neighborhoods. Both are runtime-topped-up.
mkdir -p "$ST/.cache"
for f in popularity.json deezer-artists.json; do
  [ -f "../.cache/$f" ] && cp "../.cache/$f" "$ST/.cache/$f" && echo "  bundled cache: $f"
done

echo "staged sidecar → $ST (node $($NODE_BIN --version))"
