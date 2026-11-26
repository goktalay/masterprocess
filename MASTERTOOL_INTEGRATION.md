# Process Explorer - mastertool.download Entegrasyonu

**Durum:** Dosya yükleme hazır ✅  
**Sonraki adım:** Hepgo repository kodu güncelleme

---

## 🔑 Önemli Bilgiler

- **API Yapısı:** mastertool.download (FastAPI, SQLite)
- **Uygulama Kodu:** `pe` (2 harfli, Process Explorer)
- **Dosya Kabul:** Yalnız .exe (ZIP yüklenemez!)
- **Yuva:** Setup (kurulum exe) + Portable (tek exe, isteğe bağlı)
- **Kimlik Doğrulama:** X-Release-Key header
- **Katalog:** Sunucu kodunda sabit sözlük - API üzerinden eklenemez

---

## 📋 Adım 1: Hepgo Repository Güncellemesi

### 1.1 `sshm/main.py` → TOOLS Sözlüğüne Satır Ekleme

```python
TOOLS = {
    # ... (mevcut uygulamalar: 'sm', 'fm', 'sq', vb.)
    
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
    }
}
```

### 1.2 `sshm/settings.py` → RELEASE_KEYS Ekleme

```python
RELEASE_KEYS = {
    'sm': os.environ.get('SSHMASTER_RELEASE_KEY', ''),
    'fm': os.environ.get('FTPMASTER_RELEASE_KEY', ''),
    # ... (mevcut anahtarlar)
    'pe': os.environ.get('PROCESSEXPLORER_RELEASE_KEY', ''),
}
```

### 1.3 Tanıtım Sayfası ve Simgeler

**Yol:** `central/sshmaster_server/static/`

#### 1.3a HTML Sayfası: `mt/araclar/process-explorer.html`

```html
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Process Explorer - Gelişmiş Windows Process Monitörü</title>
</head>
<body>
    <div class="app-header">
        <h1>⚙️ Process Explorer</h1>
        <p>Gerçek zamanlı Windows process izleme ve yönetimi</p>
    </div>
    
    <section>
        <h2>Özellikler</h2>
        <ul>
            <li>📊 Gerçek zamanlı CPU, Bellek, GPU izleme</li>
            <li>🌳 Process hiyerarşi görüntüleme</li>
            <li>💾 SQLite veritabanı ile geçmiş takibi</li>
            <li>🎨 Koyu tema arayüzü</li>
            <li>⚡ Hızlı ve hafif</li>
            <li>🔓 Açık kaynak (MIT License)</li>
        </ul>
    </section>
    
    <section>
        <h2>Sistem Gereksinimleri</h2>
        <ul>
            <li>Windows 10/11 (x86-64)</li>
            <li>.NET 8.0 Runtime</li>
            <li>500 MB disk alanı</li>
            <li>1 GB RAM minimum</li>
        </ul>
    </section>
    
    <section>
        <h2>İndirme</h2>
        <a href="/api/pe/releases/latest?kind=setup" class="btn">Setup Yükle</a>
        <a href="/api/pe/releases/latest?kind=portable" class="btn">Portable İndir</a>
    </section>
</body>
</html>
```

#### 1.3b Simgeler

- `brand/pe.svg` → 128x128 pixel SVG (opsiyonel, PNG tercih edilir)
- `brand/pe.png` → 128x128 pixel PNG
- `brand/pe-512.png` → 512x512 pixel PNG

### 1.4 Server .env Güncelleme

```bash
# .env file on mastertool.download server
PROCESSEXPLORER_RELEASE_KEY=your-secure-random-key-here
```

**Örnek anahtar oluştur (256-bit):**
```bash
# Windows PowerShell
$Key = -join ((1..32) | ForEach-Object { "{0:X2}" -f (Get-Random -Maximum 256) })
Write-Host $Key

# Linux/macOS
openssl rand -hex 32
```

---

## 🚀 Adım 2: GitHub Repository Ayarları

### 2.1 GitHub Secret Ekleme

Uygulama deposunda (goktalay/masterprocess):

**Settings → Secrets and variables → Actions**

```
Name: PROCESSEXPLORER_RELEASE_KEY
Value: (same as server .env)
```

---

## 📤 Adım 3: Dosya Yükleme

### 3.1 Yükleme Öncesi Hazırlık

**Gerekli Dosyalar:**

1. **Process-Explorer-Setup-1.0.0.exe** (~30 MB)
   - InnoSetup kurulum exe'si
   - Dosya başı: `4D 5A` (MZ header)

2. **Process-Explorer-Portable-1.0.0.exe** (~25 MB, isteğe bağlı)
   - 7-Zip ile sarılmış taşınabilir versiyon
   - Dosya başı: `4D 5A` (MZ header)

### 3.2 PowerShell Deployment Script

**Komut (Hepgo güncellemesi yapıldıktan sonra):**

```powershell
# Windows PowerShell
$Env:PROCESSEXPLORER_RELEASE_KEY = "your-release-key"

# Test modu (simülasyon)
.\deploy-to-master-download.ps1 -Test

# Gerçek yükleme
.\deploy-to-master-download.ps1 -ReleaseKey $Env:PROCESSEXPLORER_RELEASE_KEY
```

**Yükleme Uçları:**

- Setup: `POST https://mastertool.download/api/pe/releases/1.0.0/setup`
- Portable: `POST https://mastertool.download/api/pe/releases/1.0.0/portable`

**Header:**
```
X-Release-Key: your-release-key
```

**Multipart Form:**
```
file: (binary)
part: 0
parts: 1
filename: Process-Explorer-Setup-1.0.0.exe
notes: Process Explorer 1.0.0 - Setup Installer
```

### 3.3 Curl Örneği (Manuel Test)

```bash
# Setup yükleme
curl -X POST "https://mastertool.download/api/pe/releases/1.0.0/setup" \
  -H "X-Release-Key: your-release-key" \
  -F "file=@Process-Explorer-Setup-1.0.0.exe" \
  -F "part=0" \
  -F "parts=1" \
  -F "filename=Process-Explorer-Setup-1.0.0.exe" \
  -F "notes=Process Explorer 1.0.0 - Setup Installer"

# Yanıt başarılı:
# {"ok":true,"version":"1.0.0","kind":"setup","sha256":"...","size":31457280}
```

---

## ✅ Adım 4: Doğrulama

### 4.1 Katalogda Kontrol

```bash
# API üzerinden kontrol
curl https://mastertool.download/api/mt/apps \
  -H "Authorization: Bearer sso_token"

# Yanıta "pe" uygulaması dahil olmalı
```

### 4.2 İndirme Testleri

```bash
# En son sürümü indir
curl -O https://mastertool.download/api/pe/releases/latest?kind=setup

# Sha256 doğrula
openssl dgst -sha256 Process-Explorer-Setup-1.0.0.exe
```

### 4.3 Web Sayfasında Görün

- Katalog: https://mastertool.download/
- Product page: https://mastertool.download/process-explorer
- API endpoint: https://mastertool.download/api/pe/releases/latest

---

## 🔧 Hepgo Reposu Şablonu

Referans commit: `goktalay/hepgo` → commit b5081dc

**"Mastertool: Video Master (vm) uygulaması — katalog, hesap uçları, tanıtım sayfası"**

Dosyalar değiştirildi:
- `sshm/main.py` (TOOLS dict)
- `sshm/settings.py` (RELEASE_KEYS)
- `central/sshmaster_server/static/mt/araclar/video-master.html`
- `central/sshmaster_server/static/brand/vm.png` (+512)
- `docs/mastertool-api.md` (dokumentasyon)

---

## 📝 Deployment Kontrol Listesi

- [ ] 2 harfli kod seçildi: `pe`
- [ ] `sshm/main.py` → TOOLS dict güncellendi
- [ ] `sshm/settings.py` → RELEASE_KEYS güncellendi
- [ ] HTML sayfası oluşturuldu: `mt/araclar/process-explorer.html`
- [ ] Simgeler eklendi: `brand/pe.png`, `brand/pe-512.png`
- [ ] Server .env'e anahtar eklendi
- [ ] GitHub secret eklendi
- [ ] Hepgo PR açılıp merge edildi
- [ ] Server yeniden başlatıldı/dağıtıldı
- [ ] `.\deploy-to-master-download.ps1 -Test` çalıştırıldı
- [ ] `.\deploy-to-master-download.ps1 -ReleaseKey ...` çalıştırıldı
- [ ] API kataloğunda `pe` görünüyor
- [ ] İndirme bağlantıları çalışıyor
- [ ] SHA256 doğrulanıyor

---

## 🆘 Sorun Giderme

### "409 exists" Hatası
Sürüm zaten yüklü. Yeni sürüm (1.0.1 vb.) deneyin veya önceki sürümü silin.

### "403 Forbidden"
Release key yanlış veya sunucu .env'de ayarlanmadı. Sunucu yeniden başlatıldı mı?

### "422 not_exe"
Dosya .exe değil veya başı `4D 5A` değil. Dosya türünü kontrol et.

### App kataloğunda görünmüyor
Hepgo güncellemesi merge ve sunucu dağıtımı gerekli. API yalnız dosya yükler, katalog değil.

---

## 📚 Kaynaklar

- API Belgesi: `hepgo/docs/mastertool-api.md`
- Video Master Referansı: `goktalay/videomaster/scripts/upload-videomaster.sh`
- Server Kodu: `goktalay/hepgo/central/sshmaster_server/sshm/`

