param(
    [string]$EmailAddress = "danieldavisandrew@gmail.com",
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$configDirectory = Join-Path $env:LOCALAPPDATA "Bezi Remote"
$configPath = Join-Path $configDirectory "gmail-delivery.json"

function Send-GmailMessage {
    param(
        [string]$From,
        [string]$To,
        [Security.SecureString]$AppPassword,
        [string]$Subject,
        [string]$Body
    )

    $credential = [Management.Automation.PSCredential]::new($From, $AppPassword)
    $message = [Net.Mail.MailMessage]::new($From, $To, $Subject, $Body)
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
}

Clear-Host
Write-Host ""
Write-Host "Bezi Buddy email setup" -ForegroundColor Cyan
Write-Host ""
Write-Host "Expo Go links will be sent:" -ForegroundColor Gray
Write-Host "  From: $EmailAddress" -ForegroundColor White
Write-Host "  To:   $EmailAddress" -ForegroundColor White
Write-Host ""
Write-Host "Google requires a dedicated 16-character App Password." -ForegroundColor Gray
Write-Host "Your normal Gmail password will not work and should not be entered." -ForegroundColor Yellow
Write-Host ""

if (-not $NoBrowser) {
    $encodedEmail = [Uri]::EscapeDataString($EmailAddress)
    $appPasswordUrl = "https://myaccount.google.com/apppasswords?authuser=$encodedEmail"
    $chromeCandidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
    $chrome = $chromeCandidates |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($chrome) {
        Start-Process `
            -FilePath $chrome `
            -ArgumentList @("--new-window", $appPasswordUrl)
    }
    else {
        Start-Process $appPasswordUrl
    }
}

$enteredPassword = Read-Host "Create a NEW App Password named 'Bezi Buddy', then paste it here" -AsSecureString
$enteredCredential = [Management.Automation.PSCredential]::new($EmailAddress, $enteredPassword)
$normalizedPassword = $enteredCredential.GetNetworkCredential().Password -replace "\s", ""
if ($normalizedPassword.Length -ne 16) {
    $normalizedPassword = $null
    throw "Google App Passwords contain exactly 16 characters after spaces are removed."
}
$appPassword = ConvertTo-SecureString $normalizedPassword -AsPlainText -Force
$normalizedPassword = $null

Write-Host ""
Write-Host "Testing Gmail delivery..." -ForegroundColor Cyan
Send-GmailMessage `
    -From $EmailAddress `
    -To $EmailAddress `
    -AppPassword $appPassword `
    -Subject "Bezi Buddy email delivery connected" `
    -Body @"
<p>Bezi Buddy can now email Expo Go links to this inbox.</p>
<p>The next link will be sent automatically when the companion and Cloudflare relay are ready.</p>
"@

New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$config = [ordered]@{
    emailAddress = $EmailAddress
    encryptedAppPassword = ConvertFrom-SecureString $appPassword
    configuredAt = [DateTime]::UtcNow.ToString("o")
}
[IO.File]::WriteAllText(
    $configPath,
    ($config | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "Test email sent. Automatic Expo Go delivery is ready." -ForegroundColor Green
Write-Host "Press Enter to continue into Bezi Buddy." -ForegroundColor DarkGray
Read-Host | Out-Null
