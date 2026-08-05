param(
    [switch]$SkipCompanion,
    [switch]$ExitAfterReady,
    [switch]$UseBuiltCompanion,
    [switch]$CopyExpoUrl,
    [switch]$LauncherMode,
    [switch]$SkipEmail,
    [ValidateSet("expo-go", "android")]
    [string]$MobileMode = "expo-go",
    [string]$RecipientEmail
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $workspace ".proof"
$relayPort = 8787
$metroPort = 8081
$muxPort = 8090
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$trackedProcesses = [System.Collections.Generic.List[object]]::new()
$activeSessionPath = Join-Path $runtime "active-session.json"
$sessionId = [Guid]::NewGuid().ToString()
$sessionStartedAt = [DateTime]::UtcNow.ToString("o")

function Write-LauncherProgress {
    param([string]$Stage, [string]$Message)
    if ($LauncherMode) {
        Write-Output "BEZI_PROGRESS|$Stage|$Message"
    }
}

function Send-MobileLaunchEmail {
    param(
        [string]$LaunchUrl,
        [string]$Mode,
        [string]$RecipientOverride
    )

    $configPath = Join-Path $env:LOCALAPPDATA "Bezi Remote\gmail-delivery.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return [pscustomobject]@{
            Status = "not-configured"
            Message = "Email delivery is not configured."
        }
    }

    try {
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        $sender = if ($config.senderEmailAddress) {
            [string]$config.senderEmailAddress
        } else {
            [string]$config.emailAddress
        }
        $recipient = if (-not [string]::IsNullOrWhiteSpace($RecipientOverride)) {
            $RecipientOverride.Trim()
        } elseif ($config.recipientEmailAddress) {
            [string]$config.recipientEmailAddress
        } else {
            [string]$config.emailAddress
        }
        if ([string]::IsNullOrWhiteSpace($sender) -or [string]::IsNullOrWhiteSpace($recipient)) {
            throw "Email sender and recipient are not configured."
        }
        [void][Net.Mail.MailAddress]::new($sender)
        [void][Net.Mail.MailAddress]::new($recipient)
        $securePassword = ConvertTo-SecureString $config.encryptedAppPassword
        $credential = [Management.Automation.PSCredential]::new(
            $sender,
            $securePassword
        )
        $encodedUrl = [Net.WebUtility]::HtmlEncode($LaunchUrl)
        $isAndroid = $Mode -eq "android"
        $action = if ($isAndroid) { "Open Bezi Buddy on Android" } else { "Open this link in Expo Go" }
        $subject = if ($isAndroid) {
            "Bezi Buddy Android session is ready"
        } else {
            "Bezi Buddy iOS session is ready - open in Expo Go"
        }
        $body = @"
<p>Bezi Buddy is ready.</p>
<p><a href="$encodedUrl">$action</a></p>
<p style="font-family: monospace;">$encodedUrl</p>
<p>Keep the Bezi Buddy window running on your PC while using the app.</p>
"@
        $message = [Net.Mail.MailMessage]::new(
            $sender,
            $recipient,
            $subject,
            $body
        )
        $smtp = [Net.Mail.SmtpClient]::new("smtp.gmail.com", 587)
        try {
            $message.IsBodyHtml = $true
            $message.SubjectEncoding = [Text.Encoding]::UTF8
            $message.BodyEncoding = [Text.Encoding]::UTF8
            $smtp.EnableSsl = $true
            $smtp.UseDefaultCredentials = $false
            $smtp.Credentials = $credential.GetNetworkCredential()
            $smtp.Timeout = 20000
            $smtp.Send($message)
        }
        finally {
            $message.Dispose()
            $smtp.Dispose()
        }

        return [pscustomobject]@{
            Status = "sent"
            Message = "Launch link emailed to $recipient."
        }
    }
    catch {
        return [pscustomobject]@{
            Status = "failed"
            Message = "Email delivery failed: $($_.Exception.Message)"
        }
    }
}

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
    $startParameters = @{
        FilePath = $FilePath
        WorkingDirectory = $WorkingDirectory
        WindowStyle = "Hidden"
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        PassThru = $true
    }
    if ($Arguments.Count -gt 0) {
        $startParameters.ArgumentList = $Arguments
    }
    $process = Start-Process @startParameters
    $processes.Add($process)
    $trackedProcesses.Add((Get-ProofProcessIdentity -Process $process -Name $Name))
    Write-ActiveSessionManifest
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
    param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 90)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $lastError = "No response was received."
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
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 750
        }
    }
    throw "Timed out waiting for the public endpoint $Url. Last error: $lastError"
}

function Stop-ProofProcessTree {
    param([int]$ProcessId)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProofProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-ProofProcessIdentity {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Name
    )
    $Process.Refresh()
    $path = $null
    try {
        $path = $Process.MainModule.FileName
    }
    catch {}
    return [pscustomobject]@{
        name = $Name
        processId = $Process.Id
        startedAt = $Process.StartTime.ToUniversalTime().ToString("o")
        executablePath = $path
    }
}

function Test-TrackedProcessIdentity {
    param([object]$Identity)
    if ($null -eq $Identity -or $null -eq $Identity.processId -or $null -eq $Identity.startedAt) {
        return $false
    }
    $process = Get-Process -Id ([int]$Identity.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }
    try {
        $expectedStart = [DateTime]::Parse(
            [string]$Identity.startedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        ).ToUniversalTime()
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -gt 2) {
            return $false
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$Identity.executablePath)) {
            $actualPath = $process.MainModule.FileName
            if (-not $actualPath.Equals(
                [string]$Identity.executablePath,
                [StringComparison]::OrdinalIgnoreCase
            )) {
                return $false
            }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Write-ActiveSessionManifest {
    $controller = Get-Process -Id $PID
    $manifest = [ordered]@{
        schemaVersion = 1
        sessionId = $sessionId
        workspace = $workspace
        startedAt = $sessionStartedAt
        controller = Get-ProofProcessIdentity -Process $controller -Name "controller"
        processes = @($trackedProcesses)
    }
    $temporaryPath = "$activeSessionPath.$sessionId.tmp"
    [IO.File]::WriteAllText(
        $temporaryPath,
        ($manifest | ConvertTo-Json -Depth 6),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $activeSessionPath -Force
}

function Remove-ActiveSessionManifest {
    if (-not (Test-Path -LiteralPath $activeSessionPath)) {
        return
    }
    try {
        $manifest = Get-Content -Raw -LiteralPath $activeSessionPath | ConvertFrom-Json
        if ($manifest.sessionId -eq $sessionId) {
            Remove-Item -LiteralPath $activeSessionPath -Force
        }
    }
    catch {
        # A later launch may be replacing a partially-written legacy manifest.
    }
}

function Stop-TrackedProofSession {
    if (-not (Test-Path -LiteralPath $activeSessionPath)) {
        return
    }
    try {
        $manifest = Get-Content -Raw -LiteralPath $activeSessionPath | ConvertFrom-Json
        if ($manifest.workspace -and -not ([string]$manifest.workspace).Equals(
            $workspace,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            return
        }

        if (Test-TrackedProcessIdentity -Identity $manifest.controller) {
            Stop-ProofProcessTree -ProcessId ([int]$manifest.controller.processId)
            Start-Sleep -Milliseconds 500
        }
        foreach ($identity in @($manifest.processes)) {
            if (Test-TrackedProcessIdentity -Identity $identity) {
                Stop-ProofProcessTree -ProcessId ([int]$identity.processId)
            }
        }
    }
    catch {
        Write-Warning "The previous Bezi Buddy session manifest could not be read: $($_.Exception.Message)"
    }
    finally {
        Remove-Item -LiteralPath $activeSessionPath -Force -ErrorAction SilentlyContinue
    }
}

function Stop-LegacyProofProcesses {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $proofScriptPath = Join-Path $workspace "scripts\Start-ExpoGoProof.ps1"
    $companionPath = Join-Path $workspace "apps\companion\src-tauri\target\release\bezi-remote-companion.exe"
    $escapedWorkspace = [regex]::Escape($workspace)
    $escapedScript = [regex]::Escape($proofScriptPath)
    $selected = [Collections.Generic.HashSet[int]]::new()

    foreach ($process in $all) {
        if ($process.ProcessId -eq $PID) {
            continue
        }
        $commandLine = [string]$process.CommandLine
        $executablePath = [string]$process.ExecutablePath
        $isProofController =
            $process.Name -eq "powershell.exe" -and
            $commandLine -match $escapedScript
        $isCompanion =
            $process.Name -eq "bezi-remote-companion.exe" -and
            $executablePath.Equals($companionPath, [StringComparison]::OrdinalIgnoreCase)
        $isRelay =
            $process.Name -eq "node.exe" -and
            $commandLine -match $escapedWorkspace -and
            $commandLine -match "wrangler" -and
            $commandLine -match "(?:--persist-to|dev\s+--local)"
        $isMetro =
            $process.Name -eq "node.exe" -and
            $commandLine -match $escapedWorkspace -and
            $commandLine -match "[\\/]expo[\\/]bin[\\/]cli" -and
            $commandLine -match "[\s`"]start[\s`"]" -and
            $commandLine -match "[\s`"]--go(?:[\s`"]|$)"
        $isWorkspaceWorker =
            $process.Name -in @("workerd.exe", "esbuild.exe") -and
            $executablePath -match $escapedWorkspace

        if ($isProofController -or $isCompanion -or $isRelay -or $isMetro -or $isWorkspaceWorker) {
            [void]$selected.Add([int]$process.ProcessId)
        }
    }

    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $all) {
            if ($selected.Contains([int]$process.ParentProcessId) -and
                $selected.Add([int]$process.ProcessId)) {
                $changed = $true
            }
        }
    }

    $listeners = @{}
    foreach ($listener in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        $listeners[[int]$listener.LocalPort] = [int]$listener.OwningProcess
    }
    $muxPorts = [Collections.Generic.HashSet[int]]::new()
    foreach ($process in $all) {
        $commandLine = [string]$process.CommandLine
        $match = [regex]::Match(
            $commandLine,
            "scripts[\\/]proof-mux\.mjs\s+--listen\s+(\d+)\s+--metro\s+(\d+)\s+--relay\s+(\d+)"
        )
        if (-not $match.Success) {
            continue
        }
        $listenPort = [int]$match.Groups[1].Value
        $metroOwner = $listeners[[int]$match.Groups[2].Value]
        $relayOwner = $listeners[[int]$match.Groups[3].Value]
        $relayIsOursOrGone =
            $null -eq $relayOwner -or
            $selected.Contains([int]$relayOwner)
        if ($selected.Contains([int]$metroOwner) -and $relayIsOursOrGone) {
            [void]$selected.Add([int]$process.ProcessId)
            [void]$muxPorts.Add($listenPort)
        }
    }
    foreach ($process in $all) {
        if ($process.Name -ne "cloudflared.exe") {
            continue
        }
        $match = [regex]::Match(
            [string]$process.CommandLine,
            "--url\s+http://127\.0\.0\.1:(\d+)"
        )
        if ($match.Success -and $muxPorts.Contains([int]$match.Groups[1].Value)) {
            [void]$selected.Add([int]$process.ProcessId)
        }
    }

    foreach ($processId in @($selected)) {
        Stop-ProofProcessTree -ProcessId $processId
    }
    if ($selected.Count -gt 0) {
        Start-Sleep -Milliseconds 750
    }
}

function Wait-CompanionRelayConnection {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$RelayPort,
        [int]$Seconds = 30
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "The Bezi companion exited before connecting to the relay."
        }
        $connection = Get-NetTCPConnection `
            -OwningProcess $Process.Id `
            -RemotePort $RelayPort `
            -State Established `
            -ErrorAction SilentlyContinue
        if ($null -ne $connection) {
            return
        }
        Start-Sleep -Milliseconds 300
    }
    throw "The Bezi companion did not connect to the new relay within $Seconds seconds."
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$mutexHash = Get-Sha256Base64Url -Value $workspace.ToLowerInvariant()
$sessionMutex = [Threading.Mutex]::new($false, "Local\BeziBuddy-$($mutexHash.Substring(0, 20))")
$ownsSessionMutex = $false
try {
    try {
        $ownsSessionMutex = $sessionMutex.WaitOne([TimeSpan]::FromSeconds(30))
    }
    catch [Threading.AbandonedMutexException] {
        $ownsSessionMutex = $true
    }
    if (-not $ownsSessionMutex) {
        throw "Another Bezi Buddy launch is still preparing. Try again in a few seconds."
    }
    Write-LauncherProgress -Stage "cleanup" -Message "Closing the previous Bezi Buddy session"
    Stop-TrackedProofSession
    Stop-LegacyProofProcesses
    Write-ActiveSessionManifest
}
finally {
    if ($ownsSessionMutex) {
        $sessionMutex.ReleaseMutex()
    }
    $sessionMutex.Dispose()
}
$relayPort = Get-AvailablePort -PreferredPort $relayPort
$metroPort = Get-AvailablePort -PreferredPort $metroPort
$muxPort = Get-AvailablePort -PreferredPort $muxPort
$cloudflaredCandidates = @(
    (Get-Command cloudflared -ErrorAction SilentlyContinue).Source,
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe"),
    (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$cloudflared = $cloudflaredCandidates | Select-Object -First 1
if (-not $cloudflared) {
    throw "cloudflared is missing. Run Bezi Buddy Setup again to repair prerequisites."
}

$pnpmCandidates = @(
    (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source,
    (Join-Path $env:APPDATA "npm\pnpm.cmd"),
    (Join-Path $env:LOCALAPPDATA "pnpm\pnpm.cmd")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$pnpm = $pnpmCandidates | Select-Object -First 1
if (-not $pnpm) {
    throw "pnpm is missing. Run Bezi Buddy Setup again to repair prerequisites."
}

$nodeCandidates = @(
    (Get-Command node.exe -ErrorAction SilentlyContinue).Source,
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$node = $nodeCandidates | Select-Object -First 1
if (-not $node) {
    throw "Node.js is missing. Run Bezi Buddy Setup again to repair prerequisites."
}
$env:PATH = "$(Split-Path $node);$(Split-Path $pnpm);$(Split-Path $cloudflared);$env:PATH"
$isAndroidMode = $MobileMode -eq "android"
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
    Write-LauncherProgress -Stage "local" -Message "Preparing the secure local relay"
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
    Write-LauncherProgress -Stage "local-ready" -Message "Local relay is ready"

    $proofExpiresAt = [DateTime]::UtcNow.AddMinutes(5).ToString("o")
    $proofHeaders = @{
        Authorization = "Bearer $proofToken"
        Accept = "application/json"
    }
    $pairingBody = @{
        pairingId = $proofPairingId
        hostId = $proofHostId
        hostName = if ($isAndroidMode) {
            "$env:COMPUTERNAME (Android)"
        } else {
            "$env:COMPUTERNAME (Expo Go)"
        }
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
        deviceName = if ($isAndroidMode) { "Bezi Buddy Android" } else { "Expo Go proof phone" }
        keyFingerprint = Get-Sha256Base64Url -Value $proofPairSecret
    } | ConvertTo-Json -Compress
    Invoke-RestMethod `
        -Uri "http://127.0.0.1:$relayPort/v1/pairings/$proofPairingId/claim" `
        -Method Post `
        -Headers $proofHeaders `
        -ContentType "application/json" `
        -Body $claimBody |
        Out-Null

    if ($isAndroidMode) {
        $tunnelOriginPort = $relayPort
    }
    else {
        $mux = Start-ProofProcess `
            -Name "proof-mux" `
            -FilePath $node `
            -Arguments @(
                "scripts/proof-mux.mjs", "--listen", "$muxPort",
                "--metro", "$metroPort", "--relay", "$relayPort"
            )
        Wait-LocalEndpoint -Url "http://127.0.0.1:$muxPort/health" -Process $mux
        $tunnelOriginPort = $muxPort
    }

    $proofTunnel = $null
    $proofUrl = $null
    $tunnelAttempts = 3
    for ($attempt = 1; $attempt -le $tunnelAttempts; $attempt++) {
        Write-LauncherProgress `
            -Stage "cloudflare" `
            -Message "Connecting to Cloudflare (attempt $attempt of $tunnelAttempts)"
        $proofTunnel = Start-ProofProcess `
            -Name "proof-tunnel" `
            -FilePath $cloudflared `
            -Arguments @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$tunnelOriginPort")
        try {
            $proofUrl = Wait-TunnelUrl -Name "proof-tunnel" -Process $proofTunnel
            Write-LauncherProgress `
                -Stage "cloudflare-dns" `
                -Message "Waiting for Cloudflare to publish the mobile URL"
            Wait-PublicEndpoint -Url "$proofUrl/health" -Process $proofTunnel
            Write-LauncherProgress -Stage "cloudflare-ready" -Message "Cloudflare relay is connected"
            break
        }
        catch {
            if (-not $proofTunnel.HasExited) {
                Stop-ProofProcessTree -ProcessId $proofTunnel.Id
                $proofTunnel.WaitForExit(5000) | Out-Null
            }
            if ($attempt -eq $tunnelAttempts) {
                throw
            }
            Write-Warning "Cloudflare Quick Tunnel attempt $attempt did not become reachable. Requesting a fresh hostname."
        }
    }

    if ($isAndroidMode) {
        $bootstrapData = [ordered]@{
            v = 1
            relayUrl = $proofUrl
            ownerToken = $proofToken
            hostId = $proofHostId
            mobileDeviceId = $proofMobileDeviceId
            pairSecret = $proofPairSecret
            expiresAt = [DateTime]::UtcNow.AddHours(24).ToString("o")
        } | ConvertTo-Json -Compress
        $bootstrapBytes = [Text.Encoding]::UTF8.GetBytes($bootstrapData)
        $bootstrapPayload = [Convert]::ToBase64String($bootstrapBytes).
            TrimEnd("=").Replace("+", "-").Replace("/", "_")
        $launchUrl = "$proofUrl/mobile-bootstrap#payload=$bootstrapPayload"
        Write-LauncherProgress -Stage "android-ready" -Message "Android secure setup link is ready"
    }
    else {
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

        Write-LauncherProgress -Stage "expo" -Message "Starting Expo Go for iOS"
        $metro = Start-ProofProcess `
            -Name "metro" `
            -FilePath $pnpm `
            -Arguments @(
                "--dir", "apps/mobile", "exec", "expo", "start",
                "--go", "--offline", "--port", "$metroPort", "--clear"
            )
        Wait-LocalEndpoint -Url "http://127.0.0.1:$metroPort/status" -Process $metro -Seconds 60

        Wait-PublicEndpoint -Url "$proofUrl/status" -Process $proofTunnel
        $launchUrl = $proofUrl.Replace("https://", "exp://")
        Write-LauncherProgress -Stage "expo-ready" -Message "Expo Go for iOS is ready"
    }

    $session = [ordered]@{
        startedAt = [DateTime]::UtcNow.ToString("o")
        mobileMode = $MobileMode
        launchUrl = $launchUrl
        relayUrl = $proofUrl
        ownerToken = $proofToken
    }
    [IO.File]::WriteAllText(
        (Join-Path $runtime "session.json"),
        ($session | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        (Join-Path $runtime "mobile-launch-url.txt"),
        $launchUrl,
        [Text.UTF8Encoding]::new($false)
    )

    if (-not $SkipCompanion) {
        Write-LauncherProgress -Stage "companion" -Message "Launching the Bezi companion"
        $gstreamerCandidates = @(
            (Join-Path $env:LOCALAPPDATA "Programs\gstreamer\1.0\msvc_x86_64"),
            (Join-Path $env:ProgramFiles "gstreamer\1.0\msvc_x86_64"),
            "C:\gstreamer\1.0\msvc_x86_64"
        )
        $gstreamer = $gstreamerCandidates |
            Where-Object { Test-Path -LiteralPath (Join-Path $_ "bin\gstreamer-1.0-0.dll") } |
            Select-Object -First 1
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
        $env:BEZI_REMOTE_START_HIDDEN = "1"
        if ($UseBuiltCompanion) {
            $builtCompanion = Join-Path $workspace "apps\companion\src-tauri\target\release\bezi-remote-companion.exe"
            if (-not (Test-Path -LiteralPath $builtCompanion)) {
                throw "The built companion was not found. Run 'pnpm build:companion:native' once, then launch again."
            }
            $companion = Start-ProofProcess `
                -Name "companion" `
                -FilePath $builtCompanion `
                -Arguments @()
        }
        else {
            $companion = Start-ProofProcess `
                -Name "companion" `
                -FilePath $pnpm `
                -Arguments @("--dir", "apps/companion", "exec", "tauri", "dev", "--features", "native-streaming")
        }
        Write-LauncherProgress -Stage "companion-connect" -Message "Connecting the Bezi companion"
        Wait-CompanionRelayConnection -Process $companion -RelayPort $relayPort
    }

    if ($SkipEmail) {
        $emailDelivery = [pscustomobject]@{
            Status = "not-configured"
            Message = "Email delivery was skipped."
        }
    }
    else {
        Write-LauncherProgress -Stage "email" -Message "Emailing the mobile launch link"
        $emailDelivery = Send-MobileLaunchEmail `
            -LaunchUrl $launchUrl `
            -Mode $MobileMode `
            -RecipientOverride $RecipientEmail
    }
    if ($LauncherMode) {
        Write-Output "BEZI_EMAIL|$($emailDelivery.Status)|$($emailDelivery.Message)"
    }
    elseif ($emailDelivery.Status -eq "sent") {
        Write-Host $emailDelivery.Message -ForegroundColor Green
    }
    elseif ($emailDelivery.Status -eq "failed") {
        Write-Warning $emailDelivery.Message
    }

    $copiedLaunchUrl = $false
    if ($CopyExpoUrl) {
        try {
            Set-Clipboard -Value $launchUrl
            $copiedLaunchUrl = $true
        }
        catch {
            Write-Warning "The mobile launch URL could not be copied to the clipboard: $($_.Exception.Message)"
        }
    }

    Write-Host ""
    if ($LauncherMode) {
        Write-Output "BEZI_READY|$launchUrl|$copiedLaunchUrl|$MobileMode"
    }
    else {
        Write-Host "Bezi Buddy is ready." -ForegroundColor Green
        if ($isAndroidMode) {
            Write-Host "Open this secure link on the Android phone after installing Bezi Buddy:" -ForegroundColor Gray
        }
        else {
            Write-Host "Open this in Expo Go on iPhone:" -ForegroundColor Gray
        }
        Write-Host $launchUrl -ForegroundColor Cyan
        if ($copiedLaunchUrl) {
            Write-Host "Copied to the Windows clipboard." -ForegroundColor Green
        }
        Write-Host ""
        Write-Host "The private relay and pairing credentials were prepared automatically." -ForegroundColor Gray
        Write-Host "Press Ctrl+C to stop the session." -ForegroundColor DarkGray
    }

    if ($ExitAfterReady) {
        $env:BEZI_REMOTE_RELAY_URL = $proofUrl
        $env:BEZI_REMOTE_OWNER_TOKEN = $proofToken
        & $node --use-system-ca scripts/smoke-relay.mjs
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
    Remove-ActiveSessionManifest
}
