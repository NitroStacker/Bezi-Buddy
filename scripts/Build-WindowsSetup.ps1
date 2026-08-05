param(
    [switch]$SkipCompanionBuild
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $workspace "dist"
$launcherOutput = Join-Path $distRoot "bezi-buddy"
$payloadRoot = Join-Path $distRoot "setup-payload"
$payloadDirectory = Join-Path $workspace "tools\windows-setup\payload"
$payloadZip = Join-Path $payloadDirectory "bezi-buddy-payload.zip"
$setupOutput = Join-Path $distRoot "bezi-buddy-setup"
$setupProject = Join-Path $workspace "tools\windows-setup\BeziRemoteSetup.csproj"
$companion = Join-Path $workspace "apps\companion\src-tauri\target\release\bezi-remote-companion.exe"

function Assert-SafeDistPath {
    param([string]$Path)
    $resolvedDist = [System.IO.Path]::GetFullPath($distRoot).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output escaped the workspace dist directory: $resolvedPath"
    }
}

New-Item -ItemType Directory -Force -Path $distRoot, $payloadDirectory | Out-Null
Assert-SafeDistPath -Path $payloadRoot
Assert-SafeDistPath -Path $setupOutput
if (Test-Path -LiteralPath $payloadRoot) {
    Remove-Item -LiteralPath $payloadRoot -Recurse -Force
}
if (Test-Path -LiteralPath $setupOutput) {
    Remove-Item -LiteralPath $setupOutput -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

$launcherArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "Build-WindowsLauncher.ps1"))
if (-not $SkipCompanionBuild) {
    $launcherArguments += "-BuildCompanion"
}
& powershell @launcherArguments
if ($LASTEXITCODE -ne 0) {
    throw "The launcher or companion build failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $companion)) {
    throw "The release companion is missing: $companion"
}

$includePaths = @(
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "scripts",
    "apps/mobile",
    "apps/relay",
    "apps/companion",
    "packages/protocol",
    "packages/unity"
)
Push-Location $workspace
try {
    $sourceFiles = @(git ls-files --cached --others --exclude-standard -- $includePaths)
    if ($LASTEXITCODE -ne 0 -or $sourceFiles.Count -eq 0) {
        throw "Could not enumerate the setup payload sources."
    }
    foreach ($relativePath in $sourceFiles) {
        $sourcePath = Join-Path $workspace $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            continue
        }
        $destination = Join-Path $payloadRoot $relativePath
        New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
    }
}
finally {
    Pop-Location
}

$payloadCompanion = Join-Path $payloadRoot "apps\companion\src-tauri\target\release\bezi-remote-companion.exe"
New-Item -ItemType Directory -Force -Path (Split-Path $payloadCompanion) | Out-Null
Copy-Item -LiteralPath $companion -Destination $payloadCompanion -Force
Copy-Item -LiteralPath (Join-Path $launcherOutput "Bezi Buddy.exe") -Destination (Join-Path $payloadRoot "Bezi Buddy.exe") -Force

if (Test-Path -LiteralPath $payloadZip) {
    Remove-Item -LiteralPath $payloadZip -Force
}
Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $payloadZip -CompressionLevel Optimal

dotnet publish $setupProject `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    --output $setupOutput
if ($LASTEXITCODE -ne 0) {
    throw "The Windows setup build failed with exit code $LASTEXITCODE."
}

$setup = Join-Path $setupOutput "Bezi Buddy Setup.exe"
if (-not (Test-Path -LiteralPath $setup)) {
    throw "Setup build completed without producing '$setup'."
}
& $setup --check
if ($LASTEXITCODE -ne 0) {
    throw "The embedded setup payload check failed."
}

Write-Host ""
Write-Host "Single-file Windows setup ready:" -ForegroundColor Green
Write-Host $setup -ForegroundColor Cyan
