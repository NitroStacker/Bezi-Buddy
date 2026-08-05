param(
    [string]$OutputPath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$mobile = Join-Path $workspace "apps\mobile"
$distDirectory = Join-Path $workspace "dist\bezi-buddy-android"
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $distDirectory "Bezi Buddy Android.apk"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

$whoAmI = & pnpm --dir $mobile exec eas whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "EAS CLI is not signed in. Run 'pnpm --dir apps/mobile exec eas login', then rerun this script."
}
Write-Host "Building Android APK as $whoAmI..." -ForegroundColor Cyan

if (-not $SkipBuild) {
    & pnpm --dir $mobile exec eas build `
        --platform android `
        --profile preview `
        --wait
    if ($LASTEXITCODE -ne 0) {
        throw "The EAS Android APK build failed with exit code $LASTEXITCODE."
    }
}

$buildJson = & pnpm --dir $mobile exec eas build:list `
    --platform android `
    --build-profile preview `
    --status finished `
    --limit 1 `
    --json `
    --non-interactive 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "The completed Android build could not be located."
}
$build = @(($buildJson -join "`n") | ConvertFrom-Json) | Select-Object -First 1
$artifactUrl = [string]$build.artifacts.buildUrl
if ([string]::IsNullOrWhiteSpace($artifactUrl)) {
    throw "The latest completed preview build did not provide an APK download URL."
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $artifactUrl -OutFile $OutputPath
if (-not (Test-Path -LiteralPath $OutputPath) -or (Get-Item $OutputPath).Length -lt 1MB) {
    throw "The downloaded Android APK is missing or unexpectedly small."
}

Write-Host ""
Write-Host "Standalone Android APK ready:" -ForegroundColor Green
Write-Host $OutputPath -ForegroundColor Cyan
