#!/usr/bin/env bash
# Symlink all pi extensions to ~/.pi/agent/extensions/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/.pi/agent/extensions"

mkdir -p "$TARGET_DIR"

for ext in "$SCRIPT_DIR"/pi-*/; do
  name="$(basename "$ext")"
  [ ! -f "$ext/package.json" ] && continue

  if [ -L "$TARGET_DIR/$name" ]; then
    echo "  update $name"
    rm "$TARGET_DIR/$name"
  elif [ -d "$TARGET_DIR/$name" ]; then
    echo "  replace $name (was a copy)"
    rm -rf "$TARGET_DIR/$name"
  else
    echo "  link $name"
  fi

  ln -s "$ext" "$TARGET_DIR/$name"
done

echo "done. extensions linked to $TARGET_DIR"
