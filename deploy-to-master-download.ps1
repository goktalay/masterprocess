# Process Explorer - Deploy to mastertool.download Script
# PowerShell script for automated deployment to mastertool.download
# API: https://mastertool.download with X-Release-Key authentication

param(
    [string]$ReleaseKey = "",
    [string]$Version = "1.0.0",
    [string]$SetupFile = "Process-Explorer-Setup-1.0.0.exe",
    [string]$PortableFile = "Process-Explorer-Portable-1.0.0.exe",
    [switch]$Test = $false,
    [switch]$SkipUpload = $false,
    [switch]$PortableOnly = $false
)

$ErrorActionPreference = "Stop"

# mastertool.download Configuration
$ApiUrl = "https://mastertool.download"
$AppCode = "pe"  # Process Explorer - 2 letter code
$BaseUploadUrl = "$ApiUrl/api/$AppCode/releases/$Version"

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

function Test-ExeFile {
    param([string]$FilePath)
    if (-not (Test-Path $FilePath)) {
        return $false
    }
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    # Check for MZ header
    return ($bytes.Length -ge 2 -and $bytes[0] -eq 0x4D -and $bytes[1] -eq 0x5A)
}

Write-Host ""
Write-Host "========================================" -ForegroundColor $Cyan
Write-Host "Process Explorer - mastertool.download Deploy" -ForegroundColor $Cyan
Write-Host "========================================" -ForegroundColor $Cyan
Write-Host ""

# Check Release Key
if (-not $ReleaseKey) {
    Write-Error-Custom "Release key required! Use -ReleaseKey or set PROCESSEXPLORER_RELEASE_KEY env var"
}
Write-Status "✓ Release key configured" $Green

# Validate EXE files
Write-Status "Validating executable files..." $Yellow

$SetupExists = Test-ExeFile "dist\$SetupFile"
$PortableExists = Test-ExeFile "dist\$PortableFile"

if (-not $SetupExists -and -not $PortableExists) {
    Write-Error-Custom "No valid EXE files found. Setup or Portable exe required."
}

if ($SetupExists) {
    $SetupSize = (Get-Item "dist\$SetupFile").Length / 1MB
    $SetupSha = (Get-FileHash "dist\$SetupFile" -Algorithm SHA256).Hash
    Write-Status "✓ Setup EXE: $SetupFile ($([Math]::Round($SetupSize, 2)) MB)" $Green
    Write-Status "  SHA256: $($SetupSha.Substring(0, 16))..." $Green
} else {
    Write-Status "⚠ Setup EXE not found (required for full installation)" $Yellow
}

if ($PortableExists) {
    $PortableSize = (Get-Item "dist\$PortableFile").Length / 1MB
    $PortableSha = (Get-FileHash "dist\$PortableFile" -Algorithm SHA256).Hash
    Write-Status "✓ Portable EXE: $PortableFile ($([Math]::Round($PortableSize, 2)) MB)" $Green
    Write-Status "  SHA256: $($PortableSha.Substring(0, 16))..." $Green
} else {
    Write-Status "⚠ Portable EXE not found (optional)" $Yellow
}

Write-Host ""
Write-Status "Deployment Info:" $Cyan
Write-Host "  API URL: $ApiUrl"
Write-Host "  App Code: $AppCode"
Write-Host "  Version: $Version"
Write-Host "  Release Endpoint: $BaseUploadUrl"
Write-Host ""

# Upload files
if (-not $Test) {
    if ($SkipUpload) {
        Write-Status "Skipping upload (--SkipUpload flag set)" $Yellow
    } else {
        Write-Status "Uploading to mastertool.download..." $Yellow

        # Setup file upload
        if ($SetupExists) {
            Write-Status "Uploading setup executable..." $Yellow
            $UploadUrl = "$BaseUploadUrl/setup"
            $Headers = @{
                "X-Release-Key" = $ReleaseKey
            }

            # Multipart upload (single file for < 100MB)
            $Form = @{
                file = Get-Item "dist\$SetupFile"
                part = "0"
                parts = "1"
                filename = $SetupFile
                notes = "Process Explorer $Version - Setup Installer"
            }

            try {
                $Response = Invoke-WebRequest -Uri $UploadUrl -Method POST -Headers $Headers `
                    -Form $Form -ErrorAction Stop
                Write-Status "✓ Setup uploaded: $($Response.StatusCode)" $Green
            } catch {
                Write-Host "Upload response: $($_.Exception.Response.StatusCode)" -ForegroundColor $Red
                Write-Host "Error: $($_.Exception.Message)" -ForegroundColor $Red
            }
        }

        # Portable file upload
        if ($PortableExists -and -not $PortableOnly) {
            Write-Status "Uploading portable executable..." $Yellow
            $UploadUrl = "$BaseUploadUrl/portable"
            $Headers = @{
                "X-Release-Key" = $ReleaseKey
            }

            $Form = @{
                file = Get-Item "dist\$PortableFile"
                part = "0"
                parts = "1"
                filename = $PortableFile
            }

            try {
                $Response = Invoke-WebRequest -Uri $UploadUrl -Method POST -Headers $Headers `
                    -Form $Form -ErrorAction Stop
                Write-Status "✓ Portable uploaded: $($Response.StatusCode)" $Green
            } catch {
                Write-Host "Upload response: $($_.Exception.Response.StatusCode)" -ForegroundColor $Red
                Write-Host "Error: $($_.Exception.Message)" -ForegroundColor $Red
            }
        }

        Write-Status "✓ Upload completed" $Green
    }
} else {
    Write-Status "TEST MODE - Simulating deployment" $Yellow
    if ($SetupExists) {
        Write-Status "✓ Would upload: $SetupFile ($([Math]::Round($SetupSize, 2)) MB)" $Green
    }
    if ($PortableExists) {
        Write-Status "✓ Would upload: $PortableFile ($([Math]::Round($PortableSize, 2)) MB)" $Green
    }
}

Write-Host ""
Write-Status "Process Explorer v$Version - Ready for mastertool.download" $Green
Write-Host ""

Write-Host "BEFORE UPLOADING:" -ForegroundColor $Yellow
Write-Host ""
Write-Host "These files must exist on your computer:"
Write-Host "  • dist\$SetupFile (Installer)"
Write-Host "  • dist\$PortableFile (Portable, optional)"
Write-Host ""

Write-Host "ENVIRONMENT SETUP:" -ForegroundColor $Yellow
Write-Host "1. Set environment variable: PROCESSEXPLORER_RELEASE_KEY=<your-key>"
Write-Host "2. Or pass to script: -ReleaseKey <your-key>"
Write-Host ""

Write-Host "MASTERTOOL INTEGRATION STEPS:" -ForegroundColor $Yellow
Write-Host ""
Write-Host "Before file upload, hepgo repository must be updated:"
Write-Host ""
Write-Host "1. Edit sshm/main.py → Add to TOOLS dict:"
Write-Host "   'pe': {"
Write-Host "       'name': 'Process Explorer',"
Write-Host "       'slug': 'process-explorer',"
Write-Host "       'group': 'apps',"
Write-Host "       'path': '/process-explorer',"
Write-Host "       'setup': 'Process-Explorer-Setup-{v}.exe',"
Write-Host "       'portable': 'Process-Explorer-Portable-{v}.exe'"
Write-Host "   }"
Write-Host ""
Write-Host "2. Add description:"
Write-Host "   TOOLS['pe']['desc'] = 'Advanced Windows process monitor with real-time CPU/GPU/Memory tracking'"
Write-Host ""
Write-Host "3. Edit sshm/settings.py → Add to RELEASE_KEYS:"
Write-Host "   'pe': os.environ.get('PROCESSEXPLORER_RELEASE_KEY', '')"
Write-Host ""
Write-Host "4. Add static files to central/sshmaster_server/static/:"
Write-Host "   • mt/araclar/process-explorer.html (product page)"
Write-Host "   • brand/pe.svg (128x128)"
Write-Host "   • brand/pe.png (128x128)"
Write-Host "   • brand/pe-512.png (512x512)"
Write-Host ""
Write-Host "5. Update server .env with PROCESSEXPLORER_RELEASE_KEY and redeploy"
Write-Host ""

Write-Host "FILE UPLOAD:" -ForegroundColor $Yellow
Write-Host ""
if ($Test) {
    Write-Status "TEST MODE - Simulating uploads" $Cyan
    if ($SetupExists) {
        Write-Host "  POST $BaseUploadUrl/setup"
    }
    if ($PortableExists) {
        Write-Host "  POST $BaseUploadUrl/portable"
    }
} else {
    Write-Host "Upload script will POST to: $BaseUploadUrl/setup and /portable"
}

Write-Host ""
Write-Host "PRODUCTION DEPLOYMENT:" -ForegroundColor $Yellow
Write-Host "1. Merge hepgo changes to main branch"
Write-Host "2. Deploy server (or prod CD pipeline)"
Write-Host "3. Run this script: .\deploy-to-master-download.ps1 -ReleaseKey YOUR_KEY"
Write-Host "4. Files upload and register automatically"
Write-Host "5. App appears on mastertool.download catalog"
Write-Host ""

Write-Host "AFTER UPLOAD:" -ForegroundColor $Cyan
Write-Host "• Verify on: https://mastertool.download/api/mt/apps"
Write-Host "• Download from: https://mastertool.download/api/pe/releases/latest"
Write-Host "• Product page: https://mastertool.download/process-explorer"
Write-Host ""

if ($Test) {
    Write-Status "✓ Test mode completed successfully" $Green
} else {
    Write-Status "✓ Deployment check completed" $Green
}

Write-Host ""
