param(
    [Parameter(Mandatory = $true)]
    [string]$UnityProject,

    [string]$PackageSource,

    [switch]$Confirm,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$source = if ([string]::IsNullOrWhiteSpace($PackageSource)) {
    Join-Path $workspaceRoot 'packages\unity'
} else {
    [System.IO.Path]::GetFullPath($PackageSource)
}
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

if (-not (Test-Path -LiteralPath $source -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $source 'package.json') -PathType Leaf)) {
    throw "The Bezi Remote Unity package source is invalid: $source"
}

$targetExists = Test-Path -LiteralPath $target
$manifestHasReference = $false
if ($targetExists -and -not $Force) {
    throw "The embedded package target already exists. Remove it explicitly before reinstalling: $target"
}

$manifestText = [System.IO.File]::ReadAllText($manifest)
$manifestHasReference = $manifestText -match ('"' + [regex]::Escape($packageName) + '"')
if ($manifestHasReference -and -not $Force) {
    throw "The Unity manifest already references $packageName. Remove the existing reference explicitly before reinstalling."
}

$resolvedProject = (Resolve-Path -LiteralPath $project).Path
$resolvedPackages = (Resolve-Path -LiteralPath $packages).Path
if (-not $resolvedPackages.StartsWith($resolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved Packages directory escaped the selected Unity project.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$manifest.beziremote-$timestamp.bak"
$packageBackupRoot = Join-Path $project '.bezi-remote-backups'
$packageBackup = Join-Path $packageBackupRoot "app.beziremote.unity-$timestamp"

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
    if ($targetExists) {
        New-Item -ItemType Directory -Force -Path $packageBackupRoot | Out-Null
        Move-Item -LiteralPath $target -Destination $packageBackup
    }
    Copy-Item -LiteralPath $source -Destination $target -Recurse
    if ($manifestHasReference) {
        $updatedManifest = [regex]::Replace(
            $manifestText,
            '("' + [regex]::Escape($packageName) + '"\s*:\s*)"[^"]*"',
            '$1"' + $packageReference + '"',
            1)
        if ($updatedManifest -ne $manifestText) {
            [System.IO.File]::WriteAllText(
                $manifest,
                $updatedManifest,
                [System.Text.UTF8Encoding]::new($false))
        }
    } else {
        $newline = if ($manifestText.Contains("`r`n")) { "`r`n" } else { "`n" }
        $dependencyLine = '$1' + $newline + '    "' + $packageName + '": "' + $packageReference + '",'
        $updatedManifest = [regex]::Replace(
            $manifestText,
            '("dependencies"\s*:\s*\{)',
            $dependencyLine,
            1)
        if ($updatedManifest -eq $manifestText) {
            throw 'Could not locate the Unity manifest dependency object.'
        }
        [System.IO.File]::WriteAllText(
            $manifest,
            $updatedManifest,
            [System.Text.UTF8Encoding]::new($false))
    }
    if ($targetExists) {
        Write-Host 'Bezi Remote Unity Integration updated. Return to Unity and allow the package import to finish.'
        Write-Host "Previous package backup: $packageBackup"
    } else {
        Write-Host 'Bezi Remote Unity Integration installed. Return to Unity and allow the package import to finish.'
    }
} catch {
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    if (Test-Path -LiteralPath $packageBackup) {
        Move-Item -LiteralPath $packageBackup -Destination $target
    }
    Copy-Item -LiteralPath $backup -Destination $manifest -Force
    throw
}
