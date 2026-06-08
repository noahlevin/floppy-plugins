#!/usr/bin/env bash
# Package the Floppy Cowork plugin into a clean, token-free, installable zip.
# Usage: ./build-dist.sh   →   dist/floppy-cowork-plugin-v<version>.zip
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('plugins/floppy-dd-meeting-notes/.claude-plugin/plugin.json'))['version'])")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p dist "$STAGE/floppy-cowork-plugin"

rsync -a \
  --exclude='.git' --exclude='dist' --exclude='.DS_Store' \
  --exclude='*.token' --exclude='.env' --exclude='build-dist.sh' \
  ./ "$STAGE/floppy-cowork-plugin/"

# Safety gate: never ship a real bearer token.
if grep -rIn 'Bearer atlas_[A-Za-z0-9]' "$STAGE/" ; then
  echo "ABORT: literal token found in tree — clean it before packaging." >&2
  exit 1
fi

ZIP="dist/floppy-cowork-plugin-v${VERSION}.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -rq "$OLDPWD/$ZIP" floppy-cowork-plugin )
echo "Built $ZIP"
unzip -l "$ZIP"
