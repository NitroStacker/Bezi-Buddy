param(
    [switch]$SkipCompanion,
    [switch]$ExitAfterReady
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $workspace ".proof"
$relayPort = 8787
$metroPort = 8081
$muxPort = 8090
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function New-ProofToken {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-ProofIdentifier {
    param([string]$Name, [string]$Prefix)
    $path = Join-Path $runtime $Name
    if (Test-Path -LiteralPath $path) {
        $existing = (Get-Content -Raw -LiteralPath $path).Trim()
        if ($existing.StartsWith($Prefix) -and $existing.Length -ge 20) {
            return $existing
        }
    }
    $value = "$Prefix$([Guid]::NewGuid())"
    [IO.File]::WriteAllText($path, $value, [Text.UTF8Encoding]::new($false))
    return $value
}

function Get-Sha256Base64Url {
    param([string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $algorithm.ComputeHash($bytes)
        return [Convert]::ToBase64String($hash).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-AvailablePort {
    param([int]$PreferredPort)
    for ($port = $PreferredPort; $port -lt ($PreferredPort + 100); $port++) {
        $existingListener = Get-NetTCPConnection `
            -State Listen `
            -LocalPort $port `
            -ErrorAction SilentlyContinue
        if ($null -ne $existingListener) {
            continue
        }

        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try {
            $listener.Start()
            return $port
        }
        catch {
            continue
        }
        finally {
            $listener.Stop()
        }
    }
    throw "No available local port was found near $PreferredPort."
}

function Start-ProofProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = $workspace
    )
    $stdout = Join-Path $runtime "$Name.stdout.log"
    $stderr = Join-Path $runtime "$Name.stderr.log"
    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    $processes.Add($process)
    return $process
}

function Wait-LocalEndpoint {
    param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 45)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "A proof service exited before $Url became ready."
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 350
        }
    }
    throw "Timed out waiting for $Url."
}

function Wait-TunnelUrl {
    param([string]$Name, [System.Diagnostics.Process]$Process, [int]$Seconds = 45)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $stdout = Join-Path $runtime "$Name.stdout.log"
    $stderr = Join-Path $runtime "$Name.stderr.log"
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "Cloudflare Quick Tunnel '$Name' exited before publishing a URL."
        }
        $content = ""
        if (Test-Path -LiteralPath $stdout) {
            $stream = [IO.File]::Open($stdout, "Open", "Read", "ReadWrite")
            try {
                $reader = [IO.StreamReader]::new($stream)
                $content += $reader.ReadToEnd()
                $reader.Dispose()
            }
            finally {
                $stream.Dispose()
            }
        }
        if (Test-Path -LiteralPath $stderr) {
            $stream = [IO.File]::Open($stderr, "Open", "Read", "ReadWrite")
            try {
                $reader = [IO.StreamReader]::new($stream)
                $content += $reader.ReadToEnd()
                $reader.Dispose()
            }
            finally {
                $stream.Dispose()
            }
        }
        $match = [regex]::Match($content, "https://[a-z0-9-]+\.trycloudflare\.com")
        if ($match.Success) {
            return $match.Value
        }
        Start-Sleep -Milliseconds 350
    }
    throw "Timed out waiting for Cloudflare Quick Tunnel '$Name'."
}

function Wait-PublicEndpoint {
    param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "The Quick Tunnel exited before $Url became reachable."
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 750
        }
    }
    throw "Timed out waiting for the public endpoint $Url."
}

function Stop-ProofProcessTree {
    param([int]$ProcessId)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProofProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$relayPort = Get-AvailablePort -PreferredPort $relayPort
$metroPort = Get-AvailablePort -PreferredPort $metroPort
$muxPort = Get-AvailablePort -PreferredPort $muxPort
$cloudflared = (Get-Command cloudflared -ErrorAction Stop).Source
$pnpmCommand = (Get-Command pnpm -ErrorAction Stop).Source
$pnpm = Join-Path (Split-Path $pnpmCommand) "pnpm.cmd"
if (-not (Test-Path -LiteralPath $pnpm)) {
    throw "pnpm.cmd was not found beside $pnpmCommand."
}
$proofToken = New-ProofToken
$proofHostId = Get-ProofIdentifier -Name "proof-host-id" -Prefix "host-proof-"
$proofMobileDeviceId = Get-ProofIdentifier -Name "proof-mobile-id" -Prefix "mobile-proof-"
$proofPairingId = [Guid]::NewGuid().ToString()
$proofClaimCode = New-ProofToken
$proofPairSecret = New-ProofToken
$relayVars = "DEV_OWNER_TOKEN=$proofToken`n"
[IO.File]::WriteAllText(
    (Join-Path $workspace "apps\relay\.dev.vars"),
    $relayVars,
    [Text.UTF8Encoding]::new($false)
)

try {
    Push-Location $workspace
    try {
        pnpm --dir apps/relay exec wrangler d1 migrations apply DB --local --persist-to ../../.wrangler/state
        if ($LASTEXITCODE -ne 0) {
            throw "The local relay database migration failed."
        }
    }
    finally {
        Pop-Location
    }

    $relay = Start-ProofProcess `
        -Name "relay" `
        -FilePath $pnpm `
        -Arguments @(
            "--dir", "apps/relay", "exec", "wrangler", "dev", "--local",
            "--persist-to", "../../.wrangler/state", "--port", "$relayPort"
        )
    Wait-LocalEndpoint -Url "http://127.0.0.1:$relayPort/health" -Process $relay

    $proofExpiresAt = [DateTime]::UtcNow.AddMinutes(5).ToString("o")
    $proofHeaders = @{
        Authorization = "Bearer $proofToken"
        Accept = "application/json"
    }
    $pairingBody = @{
        pairingId = $proofPairingId
        hostId = $proofHostId
        hostName = "$env:COMPUTERNAME (Expo proof)"
        codeHash = Get-Sha256Base64Url -Value $proofClaimCode
        expiresAt = $proofExpiresAt
        companionVersion = "0.1.0"
    } | ConvertTo-Json -Compress
    Invoke-RestMethod `
        -Uri "http://127.0.0.1:$relayPort/v1/pairings" `
        -Method Post `
        -Headers $proofHeaders `
        -ContentType "application/json" `
        -Body $pairingBody |
        Out-Null
    $claimBody = @{
        claimCode = $proofClaimCode
        mobileDeviceId = $proofMobileDeviceId
        deviceName = "Expo Go proof iPhone"
        keyFingerprint = Get-Sha256Base64Url -Value $proofPairSecret
    } | ConvertTo-Json -Compress
    Invoke-RestMethod `
        -Uri "http://127.0.0.1:$relayPort/v1/pairings/$proofPairingId/claim" `
        -Method Post `
        -Headers $proofHeaders `
        -ContentType "application/json" `
        -Body $claimBody |
        Out-Null

    $mux = Start-ProofProcess `
        -Name "proof-mux" `
        -FilePath (Get-Command node -ErrorAction Stop).Source `
        -Arguments @(
            "scripts/proof-mux.mjs", "--listen", "$muxPort",
            "--metro", "$metroPort", "--relay", "$relayPort"
        )
    Wait-LocalEndpoint -Url "http://127.0.0.1:$muxPort/health" -Process $mux

    $proofTunnel = Start-ProofProcess `
        -Name "proof-tunnel" `
        -FilePath $cloudflared `
        -Arguments @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$muxPort")
    $proofUrl = Wait-TunnelUrl -Name "proof-tunnel" -Process $proofTunnel
    Wait-PublicEndpoint -Url "$proofUrl/health" -Process $proofTunnel

    $mobileEnvironment = @"
EXPO_PUBLIC_RELAY_URL=$proofUrl
EXPO_PUBLIC_DEV_OWNER_TOKEN=$proofToken
EXPO_PUBLIC_DEV_HOST_ID=$proofHostId
EXPO_PUBLIC_DEV_MOBILE_DEVICE_ID=$proofMobileDeviceId
EXPO_PUBLIC_DEV_PAIR_SECRET=$proofPairSecret
"@
    [IO.File]::WriteAllText(
        (Join-Path $workspace "apps\mobile\.env.local"),
        $mobileEnvironment,
        [Text.UTF8Encoding]::new($false)
    )

    # Metro otherwise appends its local listening port to the public Host header.
    # Tell Expo that Cloudflare is the public packager proxy so manifests and
    # bundle/WebSocket URLs point back through the HTTPS Quick Tunnel.
    $env:EXPO_PACKAGER_PROXY_URL = $proofUrl

    $metro = Start-ProofProcess `
        -Name "metro" `
        -FilePath $pnpm `
        -Arguments @(
            "--dir", "apps/mobile", "exec", "expo", "start",
            "--go", "--offline", "--port", "$metroPort", "--clear"
        )
    Wait-LocalEndpoint -Url "http://127.0.0.1:$metroPort/status" -Process $metro -Seconds 60

    Wait-PublicEndpoint -Url "$proofUrl/status" -Process $proofTunnel
    $expoUrl = $proofUrl.Replace("https://", "exp://")

    $session = [ordered]@{
        startedAt = [DateTime]::UtcNow.ToString("o")
        expoUrl = $expoUrl
        relayUrl = $proofUrl
        ownerToken = $proofToken
    }
    [IO.File]::WriteAllText(
        (Join-Path $runtime "session.json"),
        ($session | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )

    if (-not $SkipCompanion) {
        $gstreamer = Join-Path $env:LOCALAPPDATA "Programs\gstreamer\1.0\msvc_x86_64"
        $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
        if (-not (Test-Path -LiteralPath (Join-Path $gstreamer "bin\gstreamer-1.0-0.dll"))) {
            throw "The native companion requires the GStreamer MSVC x64 runtime."
        }
        $env:GSTREAMER_1_0_ROOT_MSVC_X86_64 = $gstreamer
        $env:PKG_CONFIG_PATH = Join-Path $gstreamer "lib\pkgconfig"
        $env:PATH = "$(Join-Path $gstreamer 'bin');$cargoBin;$env:PATH"
        # The phone reaches this same local Worker through Cloudflare. The host
        # stays on loopback so the Expo proof does not depend on public TLS trust.
        $env:BEZI_REMOTE_RELAY_URL = "http://127.0.0.1:$relayPort"
        $env:BEZI_REMOTE_OWNER_TOKEN = $proofToken
        $env:BEZI_REMOTE_PROOF_HOST_ID = $proofHostId
        $env:BEZI_REMOTE_PROOF_PAIRING_ID = $proofPairingId
        $env:BEZI_REMOTE_PROOF_PAIR_SECRET = $proofPairSecret
        $env:BEZI_REMOTE_PROOF_MOBILE_DEVICE_ID = $proofMobileDeviceId
        Start-ProofProcess `
            -Name "companion" `
            -FilePath $pnpm `
            -Arguments @("--dir", "apps/companion", "exec", "tauri", "dev", "--features", "native-streaming") |
            Out-Null
    }

    Write-Host ""
    Write-Host "Bezi Remote proof is ready." -ForegroundColor Green
    Write-Host "Open this in Expo Go:" -ForegroundColor Gray
    Write-Host $expoUrl -ForegroundColor Cyan
    Write-Host ""
    Write-Host "The local relay URL and one-owner token were injected automatically." -ForegroundColor Gray
    Write-Host "Press Ctrl+C to stop the proof session." -ForegroundColor DarkGray

    if ($ExitAfterReady) {
        $env:BEZI_REMOTE_RELAY_URL = $proofUrl
        $env:BEZI_REMOTE_OWNER_TOKEN = $proofToken
        node --use-system-ca scripts/smoke-relay.mjs
        if ($LASTEXITCODE -ne 0) {
            throw "The public Quick Tunnel WebSocket smoke test failed."
        }
        return
    }

    while ($true) {
        foreach ($process in $processes) {
            if ($process.HasExited) {
                throw "Proof process $($process.Id) exited. Review logs in $runtime."
            }
        }
        Start-Sleep -Seconds 2
    }
}
finally {
    for ($index = $processes.Count - 1; $index -ge 0; $index--) {
        $process = $processes[$index]
        if (-not $process.HasExited) {
            Stop-ProofProcessTree -ProcessId $process.Id
        }
    }
}
