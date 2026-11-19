#!/usr/bin/env bash
# =============================================================================
# WIS+ — Arch Linux setup (deployment / runtime machine)
# Target hardware: i5-1135G7, 8 GB RAM, no discrete GPU.
#
#   1. Installs Tauri v2 system dependencies (webkit2gtk-4.1, libsoup3, ...)
#   2. Creates the root .venv and installs backend/requirements.txt
#   3. Ensures themes/, data/ and pdfs/ exist
#   4. Builds the lightweight release binary (AppImage by default)
#
# Usage:
#   bash scripts/setup_arch.sh
# Override bundle target with: WISPLUS_BUNDLE=deb bash scripts/setup_arch.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLE_TARGET="${WISPLUS_BUNDLE:-appimage}"   # appimage | deb | rpm

step() { printf '\n\033[1;33m== %s ==\033[0m\n' "$*"; }

# --- 1. System packages ------------------------------------------------------
step "Installing system packages (pacman)"
sudo pacman -S --needed --noconfirm \
  base-devel python python-pip nodejs npm rust cargo \
  webkit2gtk-4.1 libsoup3 libappindicator-gtk3

# --- 2. Python venv + lightweight backend -------------------------------------
step "Creating .venv and installing backend requirements"
if [ ! -d .venv ]; then
  python -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r backend/requirements.txt

# --- 3. Runtime data directories ----------------------------------------------
step "Ensuring runtime directories (themes/, data/, pdfs/)"
mkdir -p themes data pdfs

# --- 4. UI dependencies + release build ----------------------------------------
step "Installing npm dependencies"
cd ui
npm install

step "Building Tauri release bundle ($BUNDLE_TARGET)"
npx tauri build --target "$BUNDLE_TARGET"

# --- Summary -------------------------------------------------------------------
printf '\n\033[1;32mWIS+ setup complete.\033[0m\n'
echo "  • Backend:  .venv/bin/python -m backend.main   (serves :8321)"
echo "  • Release:  ui/src-tauri/target/release/bundle/${BUNDLE_TARGET}/"
echo
echo "Next steps:"
echo "  1. Copy the knowledge base from the build machine into data/:"
echo "       cp /path/to/data/w201_kb.sqlite data/"
echo "  2. Launch the sidecar:   .venv/bin/python -m backend.main"
echo "  3. Launch the app:       ./ui/src-tauri/target/release/bundle/${BUNDLE_TARGET}/*.AppImage"
