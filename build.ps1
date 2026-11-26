# Process Explorer - Build Script
# PowerShell build script for Windows

param(
    [string]$Configuration = "Release",
    [switch]$Clean = $false,
    [switch]$Test = $false,
    [switch]$Package = $false
)

$ErrorActionPreference = "Stop"
$ProjectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputPath = Join-Path $ProjectPath "bin\Release\net8.0-windows"

Write-Host "================================" -ForegroundColor Cyan
Write-Host "Process Explorer - Build Script" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Check .NET SDK
Write-Host "Checking .NET SDK..." -ForegroundColor Yellow
$dotnetVersion = dotnet --version
Write-Host "✓ .NET SDK version: $dotnetVersion" -ForegroundColor Green
Write-Host ""

# Clean
if ($Clean) {
    Write-Host "Cleaning solution..." -ForegroundColor Yellow
    dotnet clean --configuration $Configuration
    Write-Host "✓ Clean completed" -ForegroundColor Green
    Write-Host ""
}

# Restore
Write-Host "Restoring NuGet packages..." -ForegroundColor Yellow
dotnet restore
Write-Host "✓ Restore completed" -ForegroundColor Green
Write-Host ""

# Build
Write-Host "Building solution ($Configuration)..." -ForegroundColor Yellow
dotnet build --configuration $Configuration --no-restore
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Build completed successfully" -ForegroundColor Green
} else {
    Write-Host "✗ Build failed" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Test
if ($Test) {
    Write-Host "Running tests..." -ForegroundColor Yellow
    if (Test-Path "ProcessExplorer.Tests/ProcessExplorer.Tests.csproj") {
        dotnet test --configuration $Configuration --no-build
        Write-Host "✓ Tests completed" -ForegroundColor Green
    } else {
        Write-Host "⚠ No test project found" -ForegroundColor Yellow
    }
    Write-Host ""
}

# Output
Write-Host "Output files:" -ForegroundColor Cyan
if (Test-Path $OutputPath) {
    $exePath = Join-Path $OutputPath "ProcessExplorer.exe"
    if (Test-Path $exePath) {
        $fileSize = (Get-Item $exePath).Length / 1MB
        Write-Host "  Executable: ProcessExplorer.exe ($([Math]::Round($fileSize, 2)) MB)" -ForegroundColor Green
        Write-Host "  Location: $OutputPath" -ForegroundColor Green
    }
} else {
    Write-Host "✗ Output directory not found" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Package
if ($Package) {
    Write-Host "Creating deployment package..." -ForegroundColor Yellow
    $PackagePath = Join-Path $ProjectPath "dist\ProcessExplorer-Release.zip"
    $DistPath = Join-Path $ProjectPath "dist"

    if (-not (Test-Path $DistPath)) {
        New-Item -ItemType Directory -Path $DistPath | Out-Null
    }

    # Remove old package
    if (Test-Path $PackagePath) {
        Remove-Item $PackagePath
    }

    # Create zip
    Compress-Archive -Path $OutputPath -DestinationPath $PackagePath
    Write-Host "✓ Package created: ProcessExplorer-Release.zip" -ForegroundColor Green
    Write-Host "  Size: $([Math]::Round((Get-Item $PackagePath).Length / 1MB, 2)) MB" -ForegroundColor Green
    Write-Host "  Location: $DistPath" -ForegroundColor Green
}

Write-Host ""
Write-Host "✓ Build completed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Run the executable: $OutputPath\ProcessExplorer.exe" -ForegroundColor Gray
Write-Host "  2. Or use: dotnet run --project ProcessExplorer/ProcessExplorer.csproj" -ForegroundColor Gray
if (-not $Package) {
    Write-Host "  3. Create package: .\build.ps1 -Package" -ForegroundColor Gray
}
Write-Host ""
