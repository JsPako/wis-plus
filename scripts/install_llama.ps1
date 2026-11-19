param(
    [string]$Tag = $env:WISPLUS_LLAMA_TAG,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Split-Path -Parent $PSScriptRoot
$dest     = Join-Path $repoRoot 'tools\llama.cpp'
$server   = Join-Path $dest 'llama-server.exe'

if ((Test-Path $server) -and -not $Force) {
    Write-Host "llama-server.exe already present: $server"
    exit 0
}

$headers = @{ 'User-Agent' = 'wisplus-installer' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

$pattern = '*bin-win-vulkan-x64.zip'
$asset = $null
$foundTag = $null
$api = 'https://api.github.com/repos/ggml-org/llama.cpp/releases'

if ($Tag) {
    Write-Host "Querying release $Tag ..."
    $r = Invoke-RestMethod -Headers $headers -Uri "$api/tags/$Tag"
    $asset = $r.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
    $foundTag = $r.tag_name
}
else {
    Write-Host "Querying recent llama.cpp releases ..."
    $releases = Invoke-RestMethod -Headers $headers -Uri "$api`?per_page=20"
    foreach ($r in $releases) {
        if ($r.draft) { continue }
        if ($r.tag_name -notmatch '^b\d+$') { continue }
        $match = $r.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
        if ($match) { $asset = $match; $foundTag = $r.tag_name; break }
    }
    if (-not $asset) {
        $newest = $releases | Where-Object { $_.tag_name -match '^b\d+$' } | Select-Object -First 1
        if ($newest) {
            Write-Host "Asset names in newest build release ($($newest.tag_name)):"
            $newest.assets | ForEach-Object { Write-Host "  $($_.name)" }
        }
    }
}

if (-not $asset) { throw "No asset matching $pattern found. Check the GitHub releases page." }

Write-Host "Using $foundTag : $($asset.name)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("llama_" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $extract = Join-Path $tmp 'x'
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

    $exe = Get-ChildItem -Path $extract -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
    if (-not $exe) { throw "llama-server.exe not found inside $($asset.name)." }

    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -Path (Join-Path $exe.DirectoryName '*') -Destination $dest -Recurse -Force
    Set-Content -Path (Join-Path $dest '.installed-tag') -Value $foundTag
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if (-not (Test-Path $server)) { throw "Install finished but $server is missing." }
Write-Host "Installed llama.cpp $foundTag to $dest"
