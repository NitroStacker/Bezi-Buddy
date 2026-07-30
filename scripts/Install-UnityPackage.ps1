param(
    [Parameter(Mandatory = $true)]
    [string]$UnityProject,

    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $workspaceRoot 'packages\unity'
$project = [System.IO.Path]::GetFullPath($UnityProject)
$assets = Join-Path $project 'Assets'
$packages = Join-Path $project 'Packages'
$manifest = Join-Path $packages 'manifest.json'
$target = Join-Path $packages 'app.beziremote.unity'
$packageName = 'app.beziremote.unity'
$packageReference = 'file:app.beziremote.unity'

if (-not (Test-Path -LiteralPath $assets -PathType Container) -or
    -not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "The target is not a Unity project with Assets and Packages\manifest.json: $project"
}

if (Test-Path -LiteralPath $target) {
    throw "The embedded package target already exists. Remove it explicitly before reinstalling: $target"
}

$manifestText = [System.IO.File]::ReadAllText($manifest)
if ($manifestText -match ('"' + [regex]::Escape($packageName) + '"')) {
    throw "The Unity manifest already references $packageName. Remove the existing reference explicitly before reinstalling."
}

$resolvedProject = (Resolve-Path -LiteralPath $project).Path
$resolvedPackages = (Resolve-Path -LiteralPath $packages).Path
if (-not $resolvedPackages.StartsWith($resolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved Packages directory escaped the selected Unity project.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$manifest.beziremote-$timestamp.bak"

Write-Host "Unity project: $resolvedProject"
Write-Host "Package source: $source"
Write-Host "Package target: $target"
Write-Host "Manifest backup: $backup"

$confirmation = if ($Confirm) {
    'INSTALL'
} else {
    Read-Host 'Type INSTALL to add the embedded Editor package'
}
if ($confirmation -cne 'INSTALL') {
    Write-Host 'Installation cancelled. No files were changed.'
    exit 0
}

Copy-Item -LiteralPath $manifest -Destination $backup
try {
    Copy-Item -LiteralPath $source -Destination $target -Recurse
    $newline = if ($manifestText.Contains("`r`n")) { "`r`n" } else { "`n" }
    $dependencyLine = '$1    "' + $packageName + '": "' + $packageReference + '",' + $newline
    $updatedManifest = [regex]::Replace(
        $manifestText,
        '("dependencies"\s*:\s*\{\s*)',
        $dependencyLine,
        1)
    if ($updatedManifest -eq $manifestText) {
        throw 'Could not locate the Unity manifest dependency object.'
    }
    [System.IO.File]::WriteAllText(
        $manifest,
        $updatedManifest,
        [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Bezi Remote Unity Integration installed. Return to Unity and allow the package import to finish.'
} catch {
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    Copy-Item -LiteralPath $backup -Destination $manifest -Force
    throw
}
