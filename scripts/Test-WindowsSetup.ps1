param(
    [string]$SetupPath
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "BeziRemoteSetupTest-$([Guid]::NewGuid())"
$unityProject = Join-Path $testRoot "UnityProject"
$manifest = Join-Path $unityProject "Packages\manifest.json"

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $unityProject "Assets"), (Split-Path $manifest) | Out-Null
    [System.IO.File]::WriteAllText(
        $manifest,
        "{`n  `"dependencies`": {`n    `"com.unity.test-framework`": `"1.6.0`"`n  }`n}`n",
        [System.Text.UTF8Encoding]::new($false))

    & (Join-Path $PSScriptRoot "Install-UnityPackage.ps1") `
        -UnityProject $unityProject `
        -PackageSource (Join-Path $workspace "packages\unity") `
        -Confirm
    if (-not $?) { throw "Initial Unity bridge install failed." }
    & (Join-Path $PSScriptRoot "Install-UnityPackage.ps1") `
        -UnityProject $unityProject `
        -PackageSource (Join-Path $workspace "packages\unity") `
        -Confirm `
        -Force
    if (-not $?) { throw "Unity bridge update failed." }

    $manifestText = [System.IO.File]::ReadAllText($manifest)
    if ($manifestText -notmatch '"app\.beziremote\.unity"\s*:\s*"file:app\.beziremote\.unity"') {
        throw "Unity manifest did not receive the embedded package reference."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $unityProject "Packages\app.beziremote.unity\package.json"))) {
        throw "Unity package files were not copied."
    }

    dotnet build (Join-Path $workspace "tools\windows-setup\BeziRemoteSetup.csproj") --configuration Release
    if ($LASTEXITCODE -ne 0) { throw "Windows setup project did not compile." }

    if (-not [string]::IsNullOrWhiteSpace($SetupPath)) {
        $resolvedSetup = (Resolve-Path -LiteralPath $SetupPath).Path
        & $resolvedSetup --check
        if ($LASTEXITCODE -ne 0) { throw "Published setup payload validation failed." }
    }

    Write-Host "Windows setup and Unity bridge tests passed." -ForegroundColor Green
}
finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
    if ($resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTest).StartsWith("BeziRemoteSetupTest-")) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force -ErrorAction SilentlyContinue
    }
}
