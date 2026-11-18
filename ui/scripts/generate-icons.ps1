# WIS+ — generate the full Tauri icon set from the master app icon (Windows).
# Run:  ui\scripts\generate-icons.ps1   (or: cd ui; npm run icon)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ../assets/app-icon.png)) {
    Write-Error "master icon not found at assets/app-icon.png (repo root)"
}

npx tauri icon ../assets/app-icon.png
Write-Host "Icons regenerated into ui/src-tauri/icons/"
