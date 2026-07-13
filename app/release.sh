#!/usr/bin/env bash
# Build, sign, and publish a Banger release to GitHub so installed apps auto-update.
#   ./release.sh 0.1.1
set -e
cd "$(dirname "$0")"                        # app/
VERSION="${1:?usage: ./release.sh <version>   e.g. 0.1.1}"
REPO="DJtake2/dj-banger"
KEY="$HOME/.dj-banger-updater.key"

if ! command -v node >/dev/null; then export PATH="$HOME/.local/node/bin:$PATH"; fi
[ -f "$KEY" ] || { echo "signing key missing: $KEY"; exit 1; }

echo "▶ Releasing Banger v$VERSION"

# 1. bump version in package.json + tauri.conf.json
node -e "
for (const f of ['package.json','src-tauri/tauri.conf.json']) {
  const fs=require('fs'); const j=JSON.parse(fs.readFileSync(f,'utf8'));
  j.version='$VERSION'; fs.writeFileSync(f, JSON.stringify(j,null,2)+'\n');
}
console.log('  bumped version → $VERSION');
"

# 2. build with the updater signing key (produces .app.tar.gz + .sig + .dmg)
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build

B="src-tauri/target/release/bundle"
TAR="$B/macos/Banger.app.tar.gz"
SIG="$B/macos/Banger.app.tar.gz.sig"
DMG="$(ls "$B/dmg/"*.dmg | head -1)"
[ -f "$TAR" ] && [ -f "$SIG" ] || { echo "updater artifacts not found (is createUpdaterArtifacts on?)"; exit 1; }

# 3. update manifest the app polls
cat > "$B/latest.json" <<JSON
{
  "version": "$VERSION",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$(cat "$SIG")",
      "url": "https://github.com/$REPO/releases/download/v$VERSION/Banger.app.tar.gz"
    }
  }
}
JSON

# 4. publish to GitHub Releases (repo must exist + be public for the updater to fetch)
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$TAR" "$B/latest.json" "$DMG" --repo "$REPO" --clobber
else
  gh release create "v$VERSION" "$TAR" "$B/latest.json" "$DMG" \
    --repo "$REPO" --title "Banger v$VERSION" --notes "Auto-update release v$VERSION"
fi

echo "✓ Released v$VERSION → https://github.com/$REPO/releases"
