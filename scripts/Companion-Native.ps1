param(
    [ValidateSet("check", "test", "dev", "build")]
    [string]$Action = "build"
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifest = Join-Path $workspace "apps\companion\src-tauri\Cargo.toml"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$gstreamerCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\gstreamer\1.0\msvc_x86_64"),
    "C:\gstreamer\1.0\msvc_x86_64",
    "C:\Program Files\gstreamer\1.0\msvc_x86_64"
)
$gstreamer = $gstreamerCandidates |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ "bin\gstreamer-1.0-0.dll") } |
    Select-Object -First 1

if (-not $gstreamer) {
    throw "GStreamer 1.x MSVC x64 is required. Install the runtime and development packages first."
}
if (-not (Test-Path -LiteralPath $cargo)) {
    throw "Rust cargo was not found at $cargo."
}

$env:GSTREAMER_1_0_ROOT_MSVC_X86_64 = $gstreamer
$env:PKG_CONFIG_PATH = Join-Path $gstreamer "lib\pkgconfig"
$env:PATH = "$(Join-Path $gstreamer 'bin');$(Split-Path $cargo);$env:PATH"

Push-Location $workspace
try {
    switch ($Action) {
        "check" {
            & $cargo check --manifest-path $manifest --features native-streaming
        }
        "test" {
            & $cargo test --manifest-path $manifest --features native-streaming
        }
        "dev" {
            pnpm --dir apps/companion exec tauri dev --features native-streaming
        }
        "build" {
            pnpm --dir apps/companion exec tauri build --features native-streaming
        }
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Native companion $Action failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
