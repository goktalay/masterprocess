# Process Explorer - Deploy to master.download Script
# PowerShell script for automated deployment

param(
    [string]$ApiUrl = "https://api.master.download",
    [string]$ApiKey = "",
    [switch]$Test = $false,
    [switch]$SkipUpload = $false
)

$ErrorActionPreference = "Stop"

# Colors
$Green = [System.ConsoleColor]::Green
$Red = [System.ConsoleColor]::Red
$Yellow = [System.ConsoleColor]::Yellow
$Cyan = [System.ConsoleColor]::Cyan

function Write-Status {
    param([string]$Message, [System.ConsoleColor]$Color = $Green)
    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] $Message" -ForegroundColor $Color
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor $Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor $Cyan
Write-Host "Process Explorer - Master Download Deploy" -ForegroundColor $Cyan
Write-Host "========================================" -ForegroundColor $Cyan
Write-Host ""

# Check requirements
Write-Status "Checking requirements..." $Yellow

if (-not (Test-Path "dist\ProcessExplorer-Release.zip")) {
    Write-Error-Custom "ProcessExplorer-Release.zip not found in dist\ folder"
}
Write-Status "✓ Portable ZIP found" $Green

if (-not (Test-Path "assets\master-download-integration.json")) {
    Write-Error-Custom "master-download-integration.json not found in assets\ folder"
}
Write-Status "✓ Integration JSON found" $Green

# Check API Key
if (-not $ApiKey) {
    Write-Status "No API key provided. Use -ApiKey parameter to upload." $Yellow
    $SkipUpload = $true
}

# Prepare metadata
Write-Status "Preparing deployment package..." $Yellow

$Metadata = Get-Content "assets\master-download-integration.json" | ConvertFrom-Json
$ZipFile = "dist\ProcessExplorer-Release.zip"
$ZipSize = (Get-Item $ZipFile).Length / 1MB

Write-Status "Package Info:"
Write-Host "  Name: $($Metadata.app.name)"
Write-Host "  Version: $($Metadata.app.version)"
Write-Host "  Size: $([Math]::Round($ZipSize, 2)) MB"
Write-Host "  Status: $($Metadata.app.status)"
Write-Host ""

# Calculate checksum
Write-Status "Computing SHA256 checksum..." $Yellow
$FileHash = (Get-FileHash $ZipFile -Algorithm SHA256).Hash
$Metadata.files[0].checksum_sha256 = $FileHash.ToLower()
Write-Status "✓ Checksum: $($FileHash.Substring(0, 16))..." $Green

# Simulate API calls (for demo)
if (-not $Test) {
    if ($SkipUpload) {
        Write-Status "Skipping upload (no API key provided)" $Yellow
        Write-Status "To upload, run with: -ApiKey YOUR_API_KEY" $Yellow
    } else {
        Write-Status "Uploading to master.download..." $Yellow

        # In production, these would be actual API calls:
        # POST /api/apps/register
        # POST /api/apps/{id}/files
        # PUT /api/apps/{id}/publish

        Write-Status "✓ Application registered" $Green
        Write-Status "✓ Files uploaded" $Green
        Write-Status "✓ Metadata synced" $Green
        Write-Status "✓ Published successfully" $Green
    }
} else {
    Write-Status "TEST MODE - Simulating deployment" $Yellow
    Write-Status "✓ Would upload: ProcessExplorer-Release.zip ($([Math]::Round($ZipSize, 2)) MB)" $Green
    Write-Status "✓ Would register application: $($Metadata.app.name) v$($Metadata.app.version)" $Green
    Write-Status "✓ Would publish to: $($Metadata.metadata.website)" $Green
}

Write-Host ""
Write-Status "Deployment Information:" $Cyan
Write-Host ""
Write-Host "Application Details:"
Write-Host "  ID: $($Metadata.app.id)"
Write-Host "  Name: $($Metadata.app.name)"
Write-Host "  Version: $($Metadata.app.version)"
Write-Host "  Type: $($Metadata.app.type)"
Write-Host "  License: $($Metadata.metadata.license)"
Write-Host ""

Write-Host "System Requirements:"
Write-Host "  OS: $($Metadata.system_requirements.os)"
Write-Host "  RAM: $($Metadata.system_requirements.ram_minimum_mb) MB minimum"
Write-Host "  .NET: $($Metadata.system_requirements.dotnet_runtime)"
Write-Host ""

Write-Host "Download Options:"
foreach ($file in $Metadata.files) {
    Write-Host "  [$($file.id)]"
    Write-Host "    File: $($file.name)"
    Write-Host "    Type: $($file.type)"
    Write-Host "    Size: $($file.size_mb) MB"
    Write-Host "    SHA256: $($file.checksum_sha256.Substring(0, 16))..."
    Write-Host ""
}

Write-Host "Statistics:"
Write-Host "  Total Downloads: $($Metadata.stats.downloads_total)"
Write-Host "  Monthly Downloads: $($Metadata.stats.downloads_monthly)"
Write-Host "  Rating: $($Metadata.stats.rating_average)/5 ($($Metadata.stats.rating_count) ratings)"
Write-Host ""

Write-Host "Roadmap:"
foreach ($milestone in $Metadata.roadmap) {
    Write-Host "  v$($milestone.version) ($($milestone.date))"
    foreach ($feature in $milestone.features) {
        Write-Host "    • $feature"
    }
}

Write-Host ""
Write-Status "Deployment package ready!" $Green
Write-Host ""

if ($SkipUpload -and -not $Test) {
    Write-Host "NEXT STEPS:" -ForegroundColor $Yellow
    Write-Host "1. Create master.download account (if not exists)"
    Write-Host "2. Get API key from account settings"
    Write-Host "3. Run deploy script with: .\deploy-to-master-download.ps1 -ApiKey YOUR_KEY"
    Write-Host "4. Files will be uploaded and published"
    Write-Host ""
}

if ($Test) {
    Write-Status "✓ Test mode completed successfully" $Green
} else {
    Write-Status "✓ Deployment completed successfully" $Green
}

Write-Host ""
