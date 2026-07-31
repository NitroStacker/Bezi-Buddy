param(
    [switch]$BuildCompanion
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$project = Join-Path $workspace "tools\windows-launcher\BeziRemoteLauncher.csproj"
$output = Join-Path $workspace "dist\bezi-buddy"
$companion = Join-Path $workspace "apps\companion\src-tauri\target\release\bezi-remote-companion.exe"

if ($BuildCompanion -or -not (Test-Path -LiteralPath $companion)) {
    & (Join-Path $PSScriptRoot "Companion-Native.ps1") build
    if ($LASTEXITCODE -ne 0) {
        throw "The native companion build failed with exit code $LASTEXITCODE."
    }
}

dotnet publish $project `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:PublishTrimmed=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    --output $output

if ($LASTEXITCODE -ne 0) {
    throw "The Windows launcher build failed with exit code $LASTEXITCODE."
}

$launcher = Join-Path $output "Bezi Buddy.exe"
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "The Windows launcher build completed without producing '$launcher'."
}

Write-Host ""
Write-Host "Windows launcher ready:" -ForegroundColor Green
Write-Host $launcher -ForegroundColor Cyan
