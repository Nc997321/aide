# Claude Code Desktop - PowerShell Launch Script
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# Find MSVC tools
$msvcBase = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
$msvcVer = (Get-ChildItem $msvcBase -Directory | Select-Object -First 1).Name
$msvcBin = "$msvcBase\$msvcVer\bin\Hostx64\x64"

# Set SDK paths
$sdkBase = "C:\Program Files (x86)\Windows Kits\10"
$sdkVer = "10.0.26100.0"
$sdkLib = "$sdkBase\Lib\$sdkVer"
$sdkInclude = "$sdkBase\Include\$sdkVer"

$env:PATH = "$msvcBin;$env:PATH"
$env:LIB = "$sdkLib\um\x64;$sdkLib\ucrt\x64"
$env:INCLUDE = "$sdkInclude\ucrt;$sdkInclude\um;$sdkInclude\shared"

Write-Host "=== Claude Code Desktop ===" -ForegroundColor Cyan
Write-Host "MSVC: $msvcBin"
Write-Host "SDK:  $sdkVer"

# ── agent-sidecar 构建 ──
Push-Location "$PSScriptRoot\agent-sidecar"
if (-not (Test-Path node_modules)) {
    Write-Host "[aide] 安装 agent-sidecar 依赖..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[aide] npm install 失败——如果是网络问题请开启代理后重试" -ForegroundColor Red
        Pop-Location; exit 1
    }
}
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[aide] sidecar 构建失败" -ForegroundColor Red
    Pop-Location; exit 1
}
Pop-Location

Write-Host "Starting Tauri dev server..." -ForegroundColor Green
Write-Host ""

pnpm tauri dev
