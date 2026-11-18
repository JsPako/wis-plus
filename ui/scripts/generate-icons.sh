#!/usr/bin/env bash
# WIS+ — generate the full Tauri icon set from the master app icon.
# Run from anywhere; paths are resolved relative to this script.
#
#   ui/scripts/generate-icons.sh
# or simply:  cd ui && npm run icon
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f ../assets/app-icon.png ]; then
  echo "error: master icon not found at assets/app-icon.png (repo root)" >&2
  exit 1
fi

npx tauri icon ../assets/app-icon.png
echo "Icons regenerated into ui/src-tauri/icons/"
