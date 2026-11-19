
# WISPLUS: model path prompt
$defaultModel = "C:\Users\jacob\.cache\huggingface\hub\models--unsloth--Qwen3.8-27B-GGUF\snapshots\4af51b3542f775b0a8e4b310bfb3f17e01c306c9\Qwen3.8-27B-UD-Q3_K_XL.gguf"

$model = $env:WISPLUS_LLAMA_MODEL
while (-not $model -or -not (Test-Path -LiteralPath $model -PathType Leaf)) {
    if ($model) { Write-Host "File not found: $model" }
    $answer = Read-Host "Path to the .gguf model (Enter for default: $defaultModel)"
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $defaultModel }
    $model = $answer.Trim().Trim('"')
}
$env:WISPLUS_LLAMA_MODEL = $model
Write-Host "Using model: $model"
# =============================================================================
# WIS+ � run the offline ingestion pipeline (Windows build machine)
#
#   1. Resolves llama-server.exe (Vulkan build for the RX 9070 XT):
#        a. $env:LLAMA_SERVER_BIN            (explicit override)
#        b. tools\llama.cpp\llama-server.exe (auto-runs scripts\install_llama.ps1 if missing)
#        c. llama-server on PATH             (Get-Command fallback)
#   2. Resolves the model: $env:WISPLUS_LLAMA_MODEL, falling back to a cached
#      Qwen3.8-27B*.gguf under %USERPROFILE%\.cache\huggingface\hub\.
#   3. Auto-detects *mmproj*.gguf in the model's snapshot directory and passes
#      --mmproj so multimodal PDF vision verification works automatically.
#   4. Starts llama-server on 127.0.0.1:8080 (-ngl 99 -c 8192), polls
#      /health until status == "ok" (up to 120 s), runs forge.build_db, and
#      always stops the server in a finally block (exit, error, or Ctrl+C).
#
# Usage (Windows PowerShell 5.1):
#   powershell -ExecutionPolicy Bypass -File scripts\run_forge.ps1
# =============================================================================
$ErrorActionPreference = "Stop"

$root      = Split-Path -Parent $PSScriptRoot
Set-Location $root

$llamaPort = 8080
$dbPath    = "data/w201_kb.sqlite"
$proc      = $null   # llama-server process handle (stopped in finally)

# --- 1. Resolve llama-server.exe (priority: env var -> tools\ -> PATH) --------------
$localBin = Join-Path $root "tools\llama.cpp\llama-server.exe"
$llamaBin = $null

if ($env:LLAMA_SERVER_BIN) {
    if (-not (Test-Path $env:LLAMA_SERVER_BIN)) {
        throw "LLAMA_SERVER_BIN is set but the file was not found: $env:LLAMA_SERVER_BIN"
    }
    $llamaBin = (Resolve-Path $env:LLAMA_SERVER_BIN).Path
}

if (-not $llamaBin -and (Test-Path $localBin)) {
    $llamaBin = $localBin
}

if (-not $llamaBin) {
    Write-Host "tools\llama.cpp\llama-server.exe not found � running scripts\install_llama.ps1 ..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install_llama.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "scripts\install_llama.ps1 failed with exit code $LASTEXITCODE."
    }
    if (Test-Path $localBin) { $llamaBin = $localBin }
}

if (-not $llamaBin) {
    $cmd = Get-Command llama-server -ErrorAction SilentlyContinue
    if ($cmd) { $llamaBin = $cmd.Source }
}

if (-not $llamaBin) {
    throw "No llama-server.exe found. Set LLAMA_SERVER_BIN, run scripts\install_llama.ps1, or add llama.cpp to PATH."
}
Write-Host "Using llama-server: $llamaBin" -ForegroundColor Cyan

# --- 2. Resolve the model -------------------------------------------------------------
$model = $env:WISPLUS_LLAMA_MODEL
if (-not $model) {
    $cacheRoot = Join-Path $env:USERPROFILE ".cache\huggingface\hub"
    if (Test-Path $cacheRoot) {
        $hits = Get-ChildItem -Path $cacheRoot -Filter "Qwen3.8-27B*.gguf" -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike "*.incomplete" } |
                Sort-Object LastWriteTime -Descending
        if ($hits.Count -gt 0) {
            $model = $hits[0].FullName
            Write-Host "WISPLUS_LLAMA_MODEL not set � using cached model: $model" -ForegroundColor Yellow
        }
    }
}
if (-not $model) {
    throw "No model configured. Set WISPLUS_LLAMA_MODEL to your .gguf path (e.g. Qwen3.8-27B-UD-Q3_K_XL.gguf)."
}
if (-not (Test-Path $model)) {
    throw "Model not found: $model"
}

# --- 3. Auto-detect mmproj (multimodal PDF vision) -------------------------------------
$mmproj   = $null
$modelDir = Split-Path -Parent $model
$mmHit = Get-ChildItem -Path $modelDir -Filter "*mmproj*.gguf" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($mmHit) {
    $mmproj = $mmHit.FullName
    Write-Host "Detected mmproj (vision projector): $mmproj" -ForegroundColor Cyan
}

# --- 4. Start llama-server (Vulkan -> RX 9070 XT) ---------------------------------------
$llamaArgs = @(
    "-m", "`"$model`"",
    "-ngl", "99",
    "--ctx-size", "16384",
    "--host", "127.0.0.1",
    "--port", "$llamaPort"
)
if ($mmproj) { $llamaArgs += @("--mmproj", "`"$mmproj`"") }

Write-Host "Starting llama-server (Vulkan / RX 9070 XT) on http://127.0.0.1:$llamaPort ..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $llamaBin -ArgumentList $llamaArgs -PassThru

try {
    # --- 5. Wait for /health == "ok" (up to 120 s) ---------------------------------------
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        if ($proc.HasExited) {
            throw "llama-server exited early (code $($proc.ExitCode)) � check the Vulkan driver and model path."
        }
        try {
            $resp = Invoke-RestMethod "http://127.0.0.1:$llamaPort/health" -TimeoutSec 3
            if (($resp.status -eq "ok") -or ("$resp" -eq "ok")) { $healthy = $true; break }
        } catch {
            # server not ready yet � keep polling
        }
    }
    if (-not $healthy) { throw "llama-server did not report healthy within 120 s." }
    Write-Host "llama-server is up (status: ok). Starting ingestion ..." -ForegroundColor Cyan

    # --- 6. Ingest PDFs -> SQLite -----------------------------------------------------------
    & "$root\.venv\Scripts\python.exe" -m forge.build_db `
        --pdf-dir "./pdfs" `
        --db-path "./$dbPath" `
        --llama-url "http://127.0.0.1:$llamaPort/v1"
    if ($LASTEXITCODE -ne 0) {
        throw "forge.build_db failed with exit code $LASTEXITCODE."
    }
}
finally {
    # --- 7. Always stop llama-server (exit, error, or Ctrl+C) ---------------------------------
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
        Write-Host "llama-server stopped." -ForegroundColor DarkGray
    }
}

Write-Host "`nIngestion finished. Knowledge base: $dbPath" -ForegroundColor Green
