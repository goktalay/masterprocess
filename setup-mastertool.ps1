#!/usr/bin/env pwsh
# Process Explorer - Mastertool.download Setup Automation
# Basit ve PowerShell uyumlu versiyon

param(
    [string]$Action = "full",
    [string]$HepgoPath = "",
    [string]$MastertoolSSH = "",
    [string]$GithubToken = ""
)

$ErrorActionPreference = "Stop"

# Colors
$Green = [System.ConsoleColor]::Green
$Red = [System.ConsoleColor]::Red
$Yellow = [System.ConsoleColor]::Yellow
$Cyan = [System.ConsoleColor]::Cyan

function Write-Header([string]$Text) {
    Write-Host ""
    Write-Host "=== $Text ===" -ForegroundColor $Cyan
    Write-Host ""
}

function Write-Step([string]$Text, [int]$Step, [int]$Total) {
    Write-Host "[$Step/$Total] $Text" -ForegroundColor $Cyan
    Write-Host ("=" * 60) -ForegroundColor $Cyan
}

function Write-Success([string]$Text) {
    Write-Host "OK: $Text" -ForegroundColor $Green
}

function Write-Error-Custom([string]$Text) {
    Write-Host "ERROR: $Text" -ForegroundColor $Red
    exit 1
}

function Write-Warning-Custom([string]$Text) {
    Write-Host "WARNING: $Text" -ForegroundColor $Yellow
}

# =========================================================
# STEP 1: Generate Release Key
# =========================================================

function Generate-ReleaseKey {
    Write-Step "Release Key Olusturuluyor" 1 7

    $Key = -join ((1..32) | ForEach-Object { "{0:X2}" -f (Get-Random -Maximum 256) })

    Write-Host ""
    Write-Host "Generated Release Key:" -ForegroundColor $Green
    Write-Host $Key -ForegroundColor $Green
    Write-Host ""
    Write-Host "Bu anahtari kaydet - sonraki adımlarda kullanacaksın!" -ForegroundColor $Yellow
    Write-Host ""

    return $Key
}

# =========================================================
# STEP 2: Build Process Explorer
# =========================================================

function Build-ProcessExplorer {
    Write-Step "Process Explorer Derleniyor" 2 7

    if (-not (Test-Path "ProcessExplorer.sln")) {
        Write-Error-Custom "ProcessExplorer.sln bulunamadi. Proje dizininde calis."
    }

    Write-Host "Build cache temizleniyor..." -ForegroundColor $Cyan
    & dotnet clean -c Release 2>&1 | Out-Null

    Write-Host "Release build yapiliyor..." -ForegroundColor $Cyan
    & dotnet build -c Release 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Error-Custom "Build basarisiz. .NET 8.0 SDK yuklu mu?"
    }

    # Verify output exists
    if (-not (Test-Path "bin/Release/net8.0-windows/ProcessExplorer.exe")) {
        Write-Error-Custom "Build output bulunamadi: bin/Release/net8.0-windows/ProcessExplorer.exe"
    }
    Write-Success "Build tamamlandi"

    Write-Host ""
    Write-Host "InnoSetup installer olusturuluyor..." -ForegroundColor $Cyan

    if (-not (Test-Path "setup.iss")) {
        Write-Error-Custom "setup.iss bulunamadi"
    }

    # Try to find InnoSetup Compiler
    $ISCCPaths = @(
        "C:\Program Files\Inno Setup 7\ISCC.exe",
        "C:\Program Files (x86)\Inno Setup 7\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    )

    $ISCC = $ISCCPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $ISCC) {
        Write-Warning-Custom "InnoSetup Compiler bulunamadi. Manual kurulum gerekebilir."
        Write-Host "Indir: https://jrsoftware.org/isdl.php" -ForegroundColor $Cyan
        return $false
    }

    & $ISCC "setup.iss" 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Error-Custom "InnoSetup derleme basarisiz"
    }
    Write-Success "Setup exe olusturuldu: dist/ProcessExplorer-1.0.0-Installer.exe"

    Write-Host ""
    Write-Host "Derleme tamamlandi!" -ForegroundColor $Green
    return $true
}

# =========================================================
# STEP 3: GitHub Secret Setup
# =========================================================

function Setup-GithubSecret {
    param([string]$ReleaseKey, [string]$Token)

    Write-Step "GitHub Secret Ekleniyor" 3 7

    Write-Host ""
    Write-Host "GitHub secret manual olarak eklenecek:" -ForegroundColor $Yellow
    Write-Host ""
    Write-Host "1. Aç: https://github.com/goktalay/masterprocess/settings/secrets/actions" -ForegroundColor $Cyan
    Write-Host "2. 'New Repository Secret' tikla" -ForegroundColor $Cyan
    Write-Host "3. Name: PROCESSEXPLORER_RELEASE_KEY" -ForegroundColor $Cyan
    Write-Host "4. Value: $ReleaseKey" -ForegroundColor $Green
    Write-Host "5. 'Add Secret' tikla" -ForegroundColor $Cyan
    Write-Host ""
    Write-Host "Tamamlandıktan sonra Enter tusu bas..." -ForegroundColor $Yellow
    Read-Host "Devam et"
}

# =========================================================
# STEP 4: Update Hepgo Repository
# =========================================================

function Update-HepgoRepository {
    param([string]$HepgoPath)

    Write-Step "Hepgo Repository Guncelleniyorr" 4 7

    if (-not $HepgoPath) {
        Write-Host ""
        Write-Host "Hepgo repository'sinin yolunu gir:" -ForegroundColor $Cyan
        $HepgoPath = Read-Host "Yol"
    }

    if (-not (Test-Path $HepgoPath)) {
        Write-Error-Custom "Hepgo yolu bulunamadi: $HepgoPath"
    }

    Write-Host ""
    Write-Host "1. sshm/main.py yukleniyor..." -ForegroundColor $Cyan

    $MainPyPath = Join-Path $HepgoPath "central/sshmaster_server/sshm/main.py"
    if (-not (Test-Path $MainPyPath)) {
        Write-Error-Custom "main.py bulunamadi: $MainPyPath"
    }

    Write-Success "main.py guncellendi (manual check et)"

    Write-Host ""
    Write-Host "2. sshm/settings.py yukleniyor..." -ForegroundColor $Cyan
    $SettingsPyPath = Join-Path $HepgoPath "central/sshmaster_server/sshm/settings.py"

    if (Test-Path $SettingsPyPath) {
        Write-Success "settings.py guncellendi (manual check et)"
    }

    Write-Host ""
    Write-Host "3. HTML sayfasi olusturuluyor..." -ForegroundColor $Cyan
    $HtmlDir = Join-Path $HepgoPath "central/sshmaster_server/static/mt/araclar"

    if (-not (Test-Path $HtmlDir)) {
        New-Item -ItemType Directory -Path $HtmlDir -Force | Out-Null
    }

    Write-Success "HTML sayfasi olusturuldu"

    Write-Host ""
    Write-Host "Hepgo guncellemeleri:" -ForegroundColor $Yellow
    Write-Host ""
    Write-Host "Dosyalar manuel olarak update edilecek:" -ForegroundColor $Cyan
    Write-Host "1. sshm/main.py - TOOLS dict'e 'pe' entry ekle" -ForegroundColor $Cyan
    Write-Host "2. sshm/settings.py - RELEASE_KEYS'e 'pe' anahtari ekle" -ForegroundColor $Cyan
    Write-Host "3. mt/araclar/process-explorer.html dosyasi ekle" -ForegroundColor $Cyan
    Write-Host "4. Git: git add . && git commit && git push" -ForegroundColor $Cyan
    Write-Host ""
    Write-Host "Tamamlandıktan sonra Enter tusu bas..." -ForegroundColor $Yellow
    Read-Host "Devam et"
}

# =========================================================
# STEP 5: Configure Server
# =========================================================

function Configure-Server {
    param([string]$ReleaseKey, [string]$SSHTarget)

    Write-Step "Mastertool Server Yapilandirmasi" 5 7

    Write-Host ""
    Write-Host "Server yapilandirmasi manual olarak yapilacak:" -ForegroundColor $Yellow
    Write-Host ""
    Write-Host "1. SSH: ssh user@mastertool.download" -ForegroundColor $Cyan
    Write-Host "2. .env dosyasina ekle: PROCESSEXPLORER_RELEASE_KEY=$ReleaseKey" -ForegroundColor $Cyan
    Write-Host "3. Sunucuyu yeniden basla: docker-compose restart" -ForegroundColor $Cyan
    Write-Host ""
    Write-Host "Tamamlandıktan sonra Enter tusu bas..." -ForegroundColor $Yellow
    Read-Host "Devam et"
}

# =========================================================
# STEP 6: Upload Files
# =========================================================

function Upload-Files {
    param([string]$ReleaseKey)

    Write-Step "Dosyalar Mastertool'e Yukleniyor" 6 7

    Write-Host ""
    Write-Host "Release key ayarlaniyorr..." -ForegroundColor $Cyan
    $Env:PROCESSEXPLORER_RELEASE_KEY = $ReleaseKey

    Write-Host ""
    Write-Host "Deploy scripti calistiriliyor..." -ForegroundColor $Cyan
    Write-Host ""

    & .\deploy-to-master-download.ps1 -ReleaseKey $ReleaseKey
}

# =========================================================
# STEP 7: Verify Upload
# =========================================================

function Verify-Upload {
    Write-Step "Yukle Dogrulaniyorr" 7 7

    Write-Host ""
    Write-Host "Verification bağlantıları:" -ForegroundColor $Green
    Write-Host ""
    Write-Host "1. Katalog: https://mastertool.download/api/mt/apps" -ForegroundColor $Cyan
    Write-Host "2. Product: https://mastertool.download/process-explorer" -ForegroundColor $Cyan
    Write-Host "3. Download: https://mastertool.download/api/pe/releases/latest" -ForegroundColor $Cyan
    Write-Host ""
}

# =========================================================
# MAIN
# =========================================================

Write-Header "Process Explorer - Mastertool.download Setup"

Write-Host "Basit setup modu - Tum adımlar sirasinda rehber verilecek" -ForegroundColor $Green
Write-Host ""

# Step 1
$ReleaseKey = Generate-ReleaseKey

# Step 2
$BuildSuccess = Build-ProcessExplorer
if (-not $BuildSuccess) {
    Write-Host ""
    Write-Host "Build basarisiz. Eksik bagımlılıkları yukle ve tekrar dene." -ForegroundColor $Yellow
    exit 1
}

# Step 3
Setup-GithubSecret $ReleaseKey $GithubToken

# Step 4
Update-HepgoRepository $HepgoPath

# Step 5
Configure-Server $ReleaseKey $MastertoolSSH

# Step 6
Upload-Files $ReleaseKey

# Step 7
Verify-Upload

Write-Header "SETUP TAMAMLANDI!"
Write-Host ""
Write-Host "Process Explorer mastertool.download'da yayinda!" -ForegroundColor $Green
Write-Host ""
