# =============================================================================
# WIS+ — Windows 11 setup (build + ingestion machine)
# Target hardware: Ryzen 9 7900X, RX 9070 XT (Vulkan), 32 GB RAM.
#
#   1. Verifies prerequisites (python / node / npm / cargo on PATH)
#   2. Creates the root .venv and installs backend/ + forge/ requirements
#      (CPU torch wheels first — the RX 9070 XT is AMD, no CUDA needed)
#   3. Generates the full Tauri icon set from assets/app-icon.png
#   4. Builds the release app (MSI installer)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
# =============================================================================
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$msg) { Write-Host "`n== $msg ==" -ForegroundColor Yellow }

# --- 0. Prerequisite checks ----------------------------------------------------
Step "Checking prerequisites"
foreach ($cmd in @("python", "node", "npm", "cargo")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "$cmd not found on PATH. Install Python 3.12, Node.js 20 LTS and Rust stable first."
    }
}

# --- 1. Python venv: backend + forge --------------------------------------------
Step "Creating .venv (backend + forge)"
if (-not (Test-Path "$root\.venv")) { python -m venv "$root\.venv" }
$py  = "$root\.venv\Scripts\python.exe"
$pip = "$root\.venv\Scripts\pip.exe"
& $py -m pip install --upgrade pip
& $pip install -r backend/requirements.txt
# CPU-only torch: avoids multi-GB CUDA wheels on an AMD box (Vulkan handles the GPU).
& $pip install torch --index-url https://download.pytorch.org/whl/cpu
& $pip install -r forge/requirements.txt

# --- 2. Tauri icons from the master asset ----------------------------------------
Step "Installing npm dependencies"
Set-Location "$root\ui"
npm install
if (-not (Test-Path "$root\assets\app-icon.png")) {
    Write-Error "Master icon missing: assets/app-icon.png — add it and re-run."
}
Step "Generating Tauri icons from assets/app-icon.png"
npx tauri icon ../assets/app-icon.png

# --- 3. Release build -------------------------------------------------------------
Step "Building Tauri release app (MSI)"
npm run app:build
Set-Location $root

Write-Host "`nWIS+ setup complete." -ForegroundColor Green
Write-Host "  • Installer: ui\src-tauri\target\release\bundle\msi\"
Write-Host "  • Ingest pipeline: powershell -ExecutionPolicy Bypass -File scripts\run_forge.ps1"
