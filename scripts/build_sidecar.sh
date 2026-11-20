#!/usr/bin/env bash
# WIS+ — build the PyInstaller onedir sidecar (Linux / macOS).
# Called from tauri.conf.json beforeBuildCommand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VENV="$REPO_ROOT/.venv"
OUT_DIR="$REPO_ROOT/ui/src-tauri/binaries"

# Target triple for the sidecar binary name (Tauri convention).
case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
    Darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64) TRIPLE="x86_64-apple-darwin" ;;
    *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

BIN_NAME="wisplus-backend-${TRIPLE}"
echo "[build_sidecar] Building ${BIN_NAME} ..."

# Ensure PyInstaller is available.
if [ ! -x "$VENV/bin/pyinstaller" ]; then
    echo "[build_sidecar] Installing PyInstaller into venv ..."
    "$VENV/bin/pip" install --quiet pyinstaller
fi

# Clean previous output.
rm -rf "$OUT_DIR/$BIN_NAME"

# Run PyInstaller (onedir mode, no console window on macOS).
"$VENV/bin/pyinstaller" \
    --name "wisplus-backend" \
    --distpath "$OUT_DIR" \
    --workpath "$REPO_ROOT/.pyinstaller-build" \
    --noconfirm \
    --clean \
    --onedir \
    --hidden-import=fastembed \
    --hidden-import=pymupdf \
    --hidden-import=uvicorn \
    --collect-all fastembed \
    --collect-all pymupdf \
    "$REPO_ROOT/backend/main.py"

# Rename the onedir folder to include the target triple (Tauri externalBin convention).
mv "$OUT_DIR/wisplus-backend" "$OUT_DIR/$BIN_NAME"

echo "[build_sidecar] Done: $OUT_DIR/$BIN_NAME"
