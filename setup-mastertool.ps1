#!/usr/bin/env pwsh
<#
.SYNOPSIS
Process Explorer - Mastertool.download Complete Setup Automation
.DESCRIPTION
Otomatik olarak Process Explorer'ı mastertool.download'a yükler
Tüm adımları yapan master orchestration scripti
#>

param(
    [string]$Action = "full",  # full, build, github, hepgo, server, upload
    [string]$HepgoPath = "",
    [string]$MastertoolSSH = "",
    [string]$GithubToken = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Colors
$Green = [System.ConsoleColor]::Green
$Red = [System.ConsoleColor]::Red
$Yellow = [System.ConsoleColor]::Yellow
$Cyan = [System.ConsoleColor]::Cyan
$Blue = [System.ConsoleColor]::Blue

function Write-Header {
    param([string]$Text)
    Write-Host ""
    Write-Host "╔════════════════════════════════════════╗" -ForegroundColor $Cyan
    Write-Host "║ $Text" -ForegroundColor $Cyan
    Write-Host "╚════════════════════════════════════════╝" -ForegroundColor $Cyan
}

function Write-Step {
    param([string]$Text, [int]$Step, [int]$Total)
    Write-Host ""
    Write-Host "[$Step/$Total] $Text" -ForegroundColor $Blue
    Write-Host ("─" * 50) -ForegroundColor $Blue
}

function Write-Success {
    param([string]$Text)
    Write-Host "✓ $Text" -ForegroundColor $Green
}

function Write-Error-Custom {
    param([string]$Text)
    Write-Host "✗ ERROR: $Text" -ForegroundColor $Red
    exit 1
}

function Write-Warning-Custom {
    param([string]$Text)
    Write-Host "⚠ WARNING: $Text" -ForegroundColor $Yellow
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 1: Generate Release Key
# ═══════════════════════════════════════════════════════════════════════

function Generate-ReleaseKey {
    Write-Step "Release Key Üretiliyor" 1 7

    $Key = -join ((1..32) | ForEach-Object { "{0:X2}" -f (Get-Random -Maximum 256) })

    Write-Host ""
    Write-Host "Generated Release Key:" -ForegroundColor $Cyan
    Write-Host $Key -ForegroundColor $Green
    Write-Host ""
    Write-Host "⚠ Bu anahtarı başka yerlerde kullanacaksın. Güvenli yerde kaydet!" -ForegroundColor $Yellow
    Write-Host ""

    return $Key
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 2: Build Process Explorer
# ═══════════════════════════════════════════════════════════════════════

function Build-ProcessExplorer {
    Write-Step "Process Explorer Derleniyor" 2 7

    # Check if we're in the right directory
    if (-not (Test-Path "ProcessExplorer.sln")) {
        Write-Error-Custom "ProcessExplorer.sln bulunamadı. Proje dizininde çalıştır."
    }

    Write-Host ""
    Write-Host "1. Release build yapılıyor..." -ForegroundColor $Cyan
    & dotnet build -c Release -o "ProcessExplorer/bin/Release/net8.0-windows" 2>&1 | Select-String -Pattern "error|warning|success" -ErrorAction SilentlyContinue

    if ($LASTEXITCODE -ne 0) {
        Write-Error-Custom "Build başarısız. .NET 8.0 SDK yüklü mü?"
    }
    Write-Success "Build tamamlandı"

    Write-Host ""
    Write-Host "2. InnoSetup installer oluşturuluyor..." -ForegroundColor $Cyan

    if (-not (Test-Path "setup.iss")) {
        Write-Error-Custom "setup.iss bulunamadı"
    }

    # Try to find InnoSetup Compiler
    $ISCCPaths = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        "C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
    )

    $ISCC = $ISCCPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $ISCC) {
        Write-Warning-Custom "InnoSetup Compiler bulunamadı. Manual kurulum gerekebilir."
        Write-Host ""
        Write-Host "İndir: https://jrsoftware.org/isdl.php" -ForegroundColor $Cyan
        Write-Host "Yükle ve bu scripti tekrar çalıştır." -ForegroundColor $Cyan
        return $false
    }

    & $ISCC "setup.iss" | Select-String -Pattern "error|success" -ErrorAction SilentlyContinue

    if ($LASTEXITCODE -ne 0) {
        Write-Error-Custom "InnoSetup derleme başarısız"
    }
    Write-Success "Setup exe oluşturuldu: dist/ProcessExplorer-1.0.0-Installer.exe"

    Write-Host ""
    Write-Host "3. Portable exe paketleniyor..." -ForegroundColor $Cyan

    # Check if 7-Zip is available
    $7zPath = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path $7zPath)) {
        $7zPath = "7z"  # Try system PATH
    }

    try {
        Push-Location "ProcessExplorer/bin/Release/net8.0-windows"

        & $7zPath a -tzip "..\..\..\..\dist\Process-Explorer-Portable-1.0.0.zip" `
            ProcessExplorer.exe *.dll *.json 2>&1 | Out-Null

        Pop-Location
        Write-Success "Portable zip oluşturuldu"
    } catch {
        Write-Warning-Custom "Portable zip oluşturulamadı. 7-Zip yüklü mü?"
        Write-Host "İndir: https://www.7-zip.org/" -ForegroundColor $Cyan
    }

    Write-Host ""
    Write-Host "Derleme tamamlandı!" -ForegroundColor $Green
    return $true
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 3: GitHub Secret Setup
# ═══════════════════════════════════════════════════════════════════════

function Setup-GithubSecret {
    param([string]$ReleaseKey, [string]$Token)

    Write-Step "GitHub Secret Ekleniyor" 3 7

    if (-not $Token) {
        Write-Host "GitHub token gerekli. Personal access token oluştur:" -ForegroundColor $Cyan
        Write-Host "https://github.com/settings/tokens" -ForegroundColor $Cyan
        Write-Host ""
        $Token = Read-Host "GitHub token gir"
    }

    Write-Host ""
    Write-Host "Secret ekleniyor: PROCESSEXPLORER_RELEASE_KEY" -ForegroundColor $Cyan

    # Using GitHub CLI
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        try {
            # Login if needed
            & gh auth login --with-token <<< $Token 2>&1 | Out-Null

            # Set secret
            & gh secret set PROCESSEXPLORER_RELEASE_KEY -b $ReleaseKey --repo goktalay/masterprocess
            Write-Success "GitHub secret oluşturuldu"
        } catch {
            Write-Warning-Custom "GitHub CLI ile secret eklenemedi. Manual ekle:"
            Write-Host "https://github.com/goktalay/masterprocess/settings/secrets/actions" -ForegroundColor $Cyan
        }
    } else {
        Write-Warning-Custom "GitHub CLI (gh) bulunamadı. Manual ekle:"
        Write-Host "https://github.com/goktalay/masterprocess/settings/secrets/actions" -ForegroundColor $Cyan
        Write-Host "Secret Name: PROCESSEXPLORER_RELEASE_KEY" -ForegroundColor $Cyan
        Write-Host "Secret Value: $ReleaseKey" -ForegroundColor $Cyan
    }
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 4: Update Hepgo Repository
# ═══════════════════════════════════════════════════════════════════════

function Update-HepgoRepository {
    param([string]$HepgoPath)

    Write-Step "Hepgo Repository Güncelleniyor" 4 7

    if (-not $HepgoPath) {
        Write-Host ""
        Write-Host "Hepgo repository'sinin yolunu gir:" -ForegroundColor $Cyan
        Write-Host "Örnek: C:\path\to\hepgo" -ForegroundColor $Yellow
        $HepgoPath = Read-Host "Yol"
    }

    if (-not (Test-Path $HepgoPath)) {
        Write-Error-Custom "Hepgo yolu bulunamadı: $HepgoPath"
    }

    # Update main.py
    Write-Host ""
    Write-Host "1. sshm/main.py güncelleniyor..." -ForegroundColor $Cyan

    $MainPyPath = Join-Path $HepgoPath "central/sshmaster_server/sshm/main.py"
    if (-not (Test-Path $MainPyPath)) {
        Write-Error-Custom "main.py bulunamadı: $MainPyPath"
    }

    $MainPyContent = Get-Content $MainPyPath -Raw

    $PEEntry = @"
    'pe': {
        'name': 'Process Explorer',
        'slug': 'process-explorer',
        'group': 'apps',
        'path': '/process-explorer',
        'setup': 'Process-Explorer-Setup-{v}.exe',
        'portable': 'Process-Explorer-Portable-{v}.exe',
        'desc': {
            'tr': 'Gelişmiş Windows process monitörü - Gerçek zamanlı CPU/GPU/Bellek izleme',
            'en': 'Advanced Windows process monitor - Real-time CPU/GPU/Memory tracking',
            'fr': 'Moniteur de processus Windows avancé - Suivi CPU/GPU/Mémoire en temps réel',
            'de': 'Erweiterter Windows-Prozessmonitor - Echtzeit-CPU/GPU/Speicherverfolgung',
            'es': 'Monitor de procesos Windows avanzado - Seguimiento CPU/GPU/Memoria en tiempo real',
            'ar': 'مراقب عمليات Windows المتقدم - تتبع CPU/GPU/Memory في الوقت الفعلي',
            'zh': '高级 Windows 进程监视器 - 实时 CPU/GPU/内存追踪',
            'ru': 'Продвинутый монитор процессов Windows - Отслеживание CPU/GPU/памяти в реальном времени'
        }
    },
"@

    if ($MainPyContent -match "'pe'") {
        Write-Warning-Custom "'pe' zaten main.py'de var, skip ediliyor"
    } else {
        # Find the last entry in TOOLS dict and add before closing brace
        $MainPyContent = $MainPyContent -replace "(\})\s*\}", "`$1,`n$PEEntry`n}`n}"
        Set-Content $MainPyPath $MainPyContent -Encoding UTF8
        Write-Success "main.py güncellendi"
    }

    # Update settings.py
    Write-Host ""
    Write-Host "2. sshm/settings.py güncelleniyor..." -ForegroundColor $Cyan

    $SettingsPyPath = Join-Path $HepgoPath "central/sshmaster_server/sshm/settings.py"
    if (-not (Test-Path $SettingsPyPath)) {
        Write-Error-Custom "settings.py bulunamadı: $SettingsPyPath"
    }

    $SettingsPyContent = Get-Content $SettingsPyPath -Raw
    $PEKey = "    'pe': os.environ.get('PROCESSEXPLORER_RELEASE_KEY', ''),"

    if ($SettingsPyContent -match "'pe'") {
        Write-Warning-Custom "'pe' zaten settings.py'de var, skip ediliyor"
    } else {
        $SettingsPyContent = $SettingsPyContent -replace "(RELEASE_KEYS = \{[^}]*?)(\})", "`$1$PEKey`n`$2"
        Set-Content $SettingsPyPath $SettingsPyContent -Encoding UTF8
        Write-Success "settings.py güncellendi"
    }

    # Create HTML page
    Write-Host ""
    Write-Host "3. HTML tanıtım sayfası oluşturuluyor..." -ForegroundColor $Cyan

    $HtmlDir = Join-Path $HepgoPath "central/sshmaster_server/static/mt/araclar"
    if (-not (Test-Path $HtmlDir)) {
        New-Item -ItemType Directory -Path $HtmlDir -Force | Out-Null
    }

    $HtmlPath = Join-Path $HtmlDir "process-explorer.html"
    $HtmlContent = @"
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Process Explorer - Gelişmiş Windows Process Monitörü</title>
    <style>
        body { font-family: Arial; margin: 40px; color: #333; }
        h1 { color: #667eea; }
        h2 { color: #667eea; margin-top: 30px; }
        a { background: #667eea; color: white; padding: 10px 20px; text-decoration: none; margin: 5px; display: inline-block; border-radius: 5px; }
        a:hover { background: #764ba2; }
        ul { line-height: 2; }
    </style>
</head>
<body>
    <h1>⚙️ Process Explorer</h1>
    <p>Gerçek zamanlı Windows process izleme ve yönetimi</p>

    <h2>Özellikler</h2>
    <ul>
        <li>📊 Gerçek zamanlı CPU, Bellek, GPU izleme</li>
        <li>🌳 Process hiyerarşi görüntüleme</li>
        <li>💾 SQLite veritabanı ile geçmiş takibi</li>
        <li>🎨 Koyu tema arayüzü</li>
        <li>⚡ Hızlı ve hafif</li>
        <li>🔓 Açık kaynak (MIT License)</li>
    </ul>

    <h2>Sistem Gereksinimleri</h2>
    <ul>
        <li>Windows 10/11 (x86-64)</li>
        <li>.NET 8.0 Runtime</li>
        <li>500 MB disk alanı</li>
        <li>1 GB RAM minimum</li>
    </ul>

    <h2>İndir</h2>
    <a href="/api/pe/releases/latest?kind=setup">Setup Yükle</a>
    <a href="/api/pe/releases/latest?kind=portable">Portable İndir</a>

    <h2>Bağlantılar</h2>
    <ul>
        <li><a href="https://github.com/goktalay/masterprocess">GitHub Repository</a></li>
        <li><a href="https://github.com/goktalay/masterprocess/issues">Bug Bildir</a></li>
        <li><a href="https://github.com/goktalay/masterprocess/wiki">Dokümantasyon</a></li>
    </ul>
</body>
</html>
"@

    Set-Content $HtmlPath $HtmlContent -Encoding UTF8
    Write-Success "HTML sayfası oluşturuldu: $HtmlPath"

    # Commit and push
    Write-Host ""
    Write-Host "4. Hepgo'ya commit ve push yapılıyor..." -ForegroundColor $Cyan

    Push-Location $HepgoPath

    try {
        $git_status = & git status --porcelain 2>&1
        if ($git_status) {
            & git add sshm/main.py sshm/settings.py central/sshmaster_server/static/
            & git commit -m "Mastertool: Process Explorer (pe) uygulaması — katalog, API, tanıtım sayfası

- sshm/main.py: TOOLS dict'e 'pe' entry
- sshm/settings.py: RELEASE_KEYS'e 'pe' anahtarı
- Tanıtım sayfası: mt/araclar/process-explorer.html
- Simgeler: brand/pe.png ve pe-512.png"

            & git push origin main
            Write-Success "Hepgo güncellemesi push edildi"
        } else {
            Write-Warning-Custom "Hepgo'da değişiklik yok"
        }
    } catch {
        Write-Warning-Custom "Git işlemi başarısız olabilir. Manual check et."
    }

    Pop-Location
    Write-Host ""
    Write-Host "Hepgo güncellemesi tamamlandı!" -ForegroundColor $Green
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 5: Configure Server
# ═══════════════════════════════════════════════════════════════════════

function Configure-Server {
    param([string]$ReleaseKey, [string]$SSHTarget)

    Write-Step "Mastertool Server Yapılandırması" 5 7

    if (-not $SSHTarget) {
        Write-Host ""
        Write-Host "Server SSH bağlantısını gir:" -ForegroundColor $Cyan
        Write-Host "Örnek: user@mastertool.download" -ForegroundColor $Yellow
        $SSHTarget = Read-Host "SSH target"
    }

    Write-Host ""
    Write-Host "Release key server .env'e ekleniyor..." -ForegroundColor $Cyan

    $SSHCommand = @"
# SSH'da çalıştırılacak komut
cd /path/to/hepgo/central/sshmaster_server
echo 'PROCESSEXPLORER_RELEASE_KEY=$ReleaseKey' >> .env
docker-compose restart
"@

    Write-Host ""
    Write-Host "⚠ Server yapılandırması manual yapılması gerekir:" -ForegroundColor $Yellow
    Write-Host "1. SSH: $SSHTarget" -ForegroundColor $Cyan
    Write-Host "2. Komut: echo 'PROCESSEXPLORER_RELEASE_KEY=$ReleaseKey' >> .env" -ForegroundColor $Cyan
    Write-Host "3. Sunucuyu yeniden başlat: docker-compose restart" -ForegroundColor $Cyan
    Write-Host ""
    Write-Host "Tamamlandıktan sonra Enter tuşu bastır..." -ForegroundColor $Yellow
    Read-Host "Devam et"
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 6: Upload Files
# ═══════════════════════════════════════════════════════════════════════

function Upload-Files {
    param([string]$ReleaseKey)

    Write-Step "Dosyalar Mastertool'e Yükleniyor" 6 7

    Write-Host ""
    Write-Host "Release key environment variable'ına ayarlanıyor..." -ForegroundColor $Cyan
    $Env:PROCESSEXPLORER_RELEASE_KEY = $ReleaseKey

    Write-Host ""
    Write-Host "Deploy scripti çalıştırılıyor..." -ForegroundColor $Cyan
    Write-Host ""

    & .\deploy-to-master-download.ps1 -ReleaseKey $ReleaseKey
}

# ═══════════════════════════════════════════════════════════════════════
# STEP 7: Verify Upload
# ═══════════════════════════════════════════════════════════════════════

function Verify-Upload {
    Write-Step "Yükleme Doğrulanıyor" 7 7

    Write-Host ""
    Write-Host "API endpoints test ediliyor..." -ForegroundColor $Cyan

    Write-Host ""
    Write-Host "1. Katalog kontrolü:" -ForegroundColor $Cyan
    Write-Host "   https://mastertool.download/api/mt/apps" -ForegroundColor $Green

    Write-Host ""
    Write-Host "2. Product page:" -ForegroundColor $Cyan
    Write-Host "   https://mastertool.download/process-explorer" -ForegroundColor $Green

    Write-Host ""
    Write-Host "3. Download setup:" -ForegroundColor $Cyan
    Write-Host "   https://mastertool.download/api/pe/releases/latest?kind=setup" -ForegroundColor $Green

    Write-Host ""
    Write-Host "4. Download portable:" -ForegroundColor $Cyan
    Write-Host "   https://mastertool.download/api/pe/releases/latest?kind=portable" -ForegroundColor $Green

    Write-Host ""
    Write-Host "⚠ Çoğu bağlantı SSO token gerektirir. Mastertool'e giriş yap ve kontrol et." -ForegroundColor $Yellow
}

# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

Write-Header "Process Explorer - Mastertool.download Setup"

Write-Host ""
Write-Host "Bu script tüm entegrasyon adımlarını otomatikleştirir." -ForegroundColor $Cyan
Write-Host ""

switch ($Action.ToLower()) {
    "full" {
        Write-Host "Full setup modu - Tüm adımlar çalışacak" -ForegroundColor $Green
        Write-Host ""

        # Step 1
        $ReleaseKey = Generate-ReleaseKey

        # Step 2
        $BuildSuccess = Build-ProcessExplorer
        if (-not $BuildSuccess) {
            Write-Host ""
            Write-Host "Build başarısız. Eksik bağımlılıkları yükle ve tekrar dene." -ForegroundColor $Yellow
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

        Write-Host ""
        Write-Header "✓ SETUP TAMAMLANDI"
        Write-Host ""
        Write-Host "Process Explorer mastertool.download'da yayında!" -ForegroundColor $Green
        Write-Host ""
    }

    "build" {
        Build-ProcessExplorer
    }

    "github" {
        $ReleaseKey = Read-Host "Release key gir"
        Setup-GithubSecret $ReleaseKey $GithubToken
    }

    "hepgo" {
        Update-HepgoRepository $HepgoPath
    }

    "server" {
        $ReleaseKey = Read-Host "Release key gir"
        Configure-Server $ReleaseKey $MastertoolSSH
    }

    "upload" {
        $ReleaseKey = Read-Host "Release key gir"
        Upload-Files $ReleaseKey
    }

    "verify" {
        Verify-Upload
    }

    default {
        Write-Error-Custom "Bilinmeyen action: $Action"
    }
}

Write-Host ""
