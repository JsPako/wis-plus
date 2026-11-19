# =============================================================================
# WIS+ — run the offline ingestion pipeline (Windows build machine)
#
#   1. Starts llama.cpp `llama-server` with the Vulkan backend so every layer
#      offloads to the RX 9070 XT, on port 8080.
#   2. Waits for the server's /health endpoint (up to 120 s).
#   3. Runs: python -m forge.build_db   (./pdfs -> data/w201_kb.sqlite)
#   4. Shuts llama-server down cleanly, success or failure.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\run_forge.ps1
# Override the model with: $env:WISPLUS_LLAMA_MODEL = "C:\models\my.gguf"
# =============================================================================
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$model     = if ($env:WISPLUS_LLAMA_MODEL) { $env:WISPLUS_LLAMA_MODEL } else { "$root\models\qwen3-27b-instruct-q4_k_m.gguf" }
$llamaPort = 8080
$dbPath    = "data/w201_kb.sqlite"

if (-not (Test-Path $model)) {
    Write-Error "Model not found: $model — set WISPLUS_LLAMA_MODEL to your .gguf path."
}
$llamaBin = Get-Command llama-server -ErrorAction SilentlyContinue
if (-not $llamaBin) {
    if (Test-Path "$root\llama-server.exe") { $llamaBin = "$root\llama-server.exe" }
    else {
        Write-Error "llama-server not found on PATH or in the repo root. Build llama.cpp with Vulkan first: `n  cmake -B build -DGGML_VULKAN=ON && cmake --build build --config Release -j"
    }
}

# --- 1. Start llama-server (Vulkan -> RX 9070 XT) ---------------------------------
Write-Host "Starting llama-server (Vulkan / RX 9070 XT) on port $llamaPort ..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $llamaBin -ArgumentList @(
    "-m", "`"$model`"",
    "--n-gpu-layers", "99",          # offload every layer to the GPU
    "--ctx-size", "8192",
    "--port", "$llamaPort"
) -PassThru

try {
    # --- 2. Wait for health ---------------------------------------------------------
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        try {
            Invoke-RestMethod "http://127.0.0.1:$llamaPort/health" -TimeoutSec 2 | Out-Null
            $healthy = $true
            break
        } catch {
            if ($proc.HasExited) { throw "llama-server exited early (code $($proc.ExitCode)) — check the Vulkan driver." }
        }
    }
    if (-not $healthy) { throw "llama-server did not become healthy within 120s." }
    Write-Host "llama-server is up. Starting ingestion ..." -ForegroundColor Cyan

    # --- 3. Ingest PDFs -> SQLite ------------------------------------------------------
    & "$root\.venv\Scripts\python.exe" -m forge.build_db `
        --pdf-dir ./pdfs `
        --db-path "$dbPath" `
        --llama-url "http://127.0.0.1:$llamaPort"
}
finally {
    # --- 4. Stop llama-server -------------------------------------------------------------
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
        Write-Host "llama-server stopped." -ForegroundColor DarkGray
    }
}

Write-Host "`nIngestion finished. Knowledge base: data/w201_kb.sqlite" -ForegroundColor Green
