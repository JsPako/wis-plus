# WIS+ — build the PyInstaller onedir sidecar (Windows).
# Called from tauri.conf.json beforeBuildCommand on Windows.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$Venv      = Join-Path $RepoRoot ".venv"
$OutDir    = Join-Path $RepoRoot "ui\src-tauri\binaries"

# Target triple (Tauri convention for Windows x64).
$Triple   = "x86_64-pc-windows-msvc"
$BinName  = "wisplus-backend-$Triple"
Write-Host "[build_sidecar] Building $BinName ..."

# Ensure PyInstaller is available.
$PyInstaller = Join-Path $Venv "Scripts\pyinstaller.exe"
if (-not (Test-Path $PyInstaller)) {
    Write-Host "[build_sidecar] Installing PyInstaller into venv ..."
    & "$Venv\Scripts\python.exe" -m pip install --quiet pyinstaller
}

# Clean previous output.
$PrevDir = Join-Path $OutDir $BinName
if (Test-Path $PrevDir) { Remove-Item -Recurse -Force $PrevDir }

# Run PyInstaller (onedir mode).
& $PyInstaller `
    --name "wisplus-backend" `
    --distpath $OutDir `
    --workpath "$RepoRoot\.pyinstaller-build" `
    --noconfirm `
    --clean `
    --onedir `
    --hidden-import=fastembed `
    --hidden-import=pymupdf `
    --hidden-import=uvicorn `
    --collect-all fastembed `
    --collect-all pymupdf `
    "$RepoRoot\backend\main.py"

# Rename the onedir folder to include the target triple.
$BuiltDir = Join-Path $OutDir "wisplus-backend"
if (Test-Path $BuiltDir) {
    Move-Item $BuiltDir $PrevDir
}

Write-Host "[build_sidecar] Done: $PrevDir"
