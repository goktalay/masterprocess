# Process Explorer - mastertool.download Kurulum Rehberi (Türkçe)

## 🚀 Hızlı Başlangıç

Bu belge Process Explorer'ı mastertool.download'a yüklemenin tüm adımlarını açıklar.

**Toplam Zaman:** ~30 dakika (sunucu dağıtımı hariç)

---

## 📋 Ön Gereksinimler

### Mastertool Erişimi
- ✅ hepgo deposunda commit erişimi
- ✅ mastertool.download sunucusuna SSH erişimi
- ✅ Mevcut mastertool aplikasyonlarından (vm, sm, fm) emin olmak

### Bilgisayarınızda
- ✅ Windows (Build komutlarını çalıştırmak için)
- ✅ PowerShell 5.0+
- ✅ .NET 8.0 SDK (derleme için)

---

## 🔑 Adım 1: Release Key Oluştur

Release key, Process Explorer dosyalarını mastertool.download'a yüklemek için kullanılacak güvenli anahtardır.

### 1.1 Rastgele Anahtar Üret

**Windows PowerShell'de:**

```powershell
# Rastgele 256-bit anahtar üret
$Key = -join ((1..32) | ForEach-Object { "{0:X2}" -f (Get-Random -Maximum 256) })
Write-Host $Key
# Çıktı örneği: A3F5B9C2E7D1A4F6B8C3E5F7A9B1D3E5F7A9C1B3D5E7F9A1B3C5E7F9A1B3
```

**Linux/macOS:**

```bash
openssl rand -hex 32
# Çıktı: a3f5b9c2e7d1a4f6b8c3e5f7a9b1d3e5f7a9c1b3d5e7f9a1b3c5e7f9a1b3
```

### 1.2 Anahtarı Kaydet

Üretilen anahtarı güvenli bir yere not et. Sonraki adımlarda kullanacaksın:
- `$PROCESSEXPLORER_RELEASE_KEY` environment variable
- GitHub Secret
- Server .env

---

## 💻 Adım 2: Dosyaları Derle

Bilgisayarında Process Explorer'ı derleyip exe dosyaları oluştur.

### 2.1 Kaynak Kodunu Klonla

```powershell
git clone https://github.com/goktalay/masterprocess.git
cd masterprocess
```

### 2.2 Installer Exe'yi Oluştur

```powershell
# 1. Release build yap
.\build.ps1 -Package

# 2. InnoSetup installer oluştur (kurulu olmalı)
# ISCC "setup.iss"
# Çıkacak: dist/ProcessExplorer-1.0.0-Installer.exe
```

### 2.3 Portable Exe Oluştur (İsteğe Bağlı)

7-Zip ile Portable exe paketleme:

```powershell
# 1. Release outputu (bin\Release\net8.0-windows) içinde
cd ProcessExplorer\bin\Release\net8.0-windows

# 2. Tüm dosyaları 7-Zip ile sıkıştır
7z a "..\..\..\..\dist\Process-Explorer-Portable-1.0.0.exe" `
  ProcessExplorer.exe `
  *.dll `
  appsettings.json

# 3. Exe başı MZ olarak ayarla (7-Zip tarafından otomatik yapılır)
```

### 2.4 Dosyaları Doğrula

```powershell
dir dist\*.exe -n

# Çıktı:
# Process-Explorer-Setup-1.0.0.exe     (30 MB)
# Process-Explorer-Portable-1.0.0.exe  (25 MB)
```

---

## 🔧 Adım 3: GitHub Secret Ekle

Process Explorer repository'sine release key ekle.

### 3.1 Repository'ye Git

https://github.com/goktalay/masterprocess/settings/secrets/actions

### 3.2 "New Repository Secret" Tıkla

**Doldur:**

| Alan | Değer |
|------|-------|
| **Name** | `PROCESSEXPLORER_RELEASE_KEY` |
| **Value** | (Adım 1'de üretilen anahtar) |

### 3.3 "Add Secret" Tıkla ✅

---

## 📝 Adım 4: Hepgo Repository Güncelle

Mastertool sunucusunda Process Explorer'ı tanıt.

### 4.1 Hepgo'yu Klonla/Açıkta Bırak

```bash
cd path/to/hepgo
git checkout main
git pull origin main
```

### 4.2 `sshm/main.py` Güncelle

Dosyayı aç: `central/sshmaster_server/sshm/main.py`

TOOLS sözlüğünün sonuna ekle:

```python
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
```

### 4.3 `sshm/settings.py` Güncelle

RELEASE_KEYS sözlüğüne ekle:

```python
'pe': os.environ.get('PROCESSEXPLORER_RELEASE_KEY', ''),
```

### 4.4 Tanıtım Sayfası Oluştur

Yeni dosya: `central/sshmaster_server/static/mt/araclar/process-explorer.html`

İçerik:
```html
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <title>Process Explorer - Gelişmiş Windows Process Monitörü</title>
    <style>
        body { font-family: Arial; margin: 40px; }
        h1 { color: #667eea; }
        a { background: #667eea; color: white; padding: 10px 20px; text-decoration: none; }
    </style>
</head>
<body>
    <h1>⚙️ Process Explorer</h1>
    <p>Gerçek zamanlı Windows process izleme ve yönetimi</p>
    
    <h2>Özellikler</h2>
    <ul>
        <li>📊 CPU, Bellek, GPU izleme</li>
        <li>🌳 Process hiyerarşisi</li>
        <li>💾 Geçmiş takibi (SQLite)</li>
        <li>🎨 Koyu tema</li>
        <li>🔓 Açık kaynak (MIT)</li>
    </ul>
    
    <h2>İndir</h2>
    <a href="/api/pe/releases/latest?kind=setup">Setup Yükle</a>
    <a href="/api/pe/releases/latest?kind=portable">Portable İndir</a>
</body>
</html>
```

### 4.5 Simgeler Ekle

Dosyalar: `central/sshmaster_server/static/brand/`

- `pe.png` (128x128)
- `pe-512.png` (512x512)

(Mevcut simge dosyalarını `pe.png` olarak kaydet)

### 4.6 Commit ve Push

```bash
git add sshm/main.py sshm/settings.py central/sshmaster_server/static/
git commit -m "Mastertool: Process Explorer (pe) uygulaması — katalog, API, tanıtım sayfası

- sshm/main.py: TOOLS dict'e 'pe' entry
- sshm/settings.py: RELEASE_KEYS'e 'pe' anahtarı
- Tanıtım sayfası: mt/araclar/process-explorer.html
- Simgeler: brand/pe.png ve pe-512.png"

git push origin main
```

---

## 🖥️ Adım 5: Server Yapılandırması

Mastertool.download sunucusunu güncelle.

### 5.1 Server .env'e Anahtar Ekle

SSH ile sunucuya bağlan:

```bash
ssh user@mastertool.download
cd /path/to/hepgo/central/sshmaster_server
```

`.env` dosyasını aç ve ekle:

```bash
# .env
PROCESSEXPLORER_RELEASE_KEY=<Adım 1'den anahtar>
```

### 5.2 Sunucuyu Yeniden Başlat

```bash
# Docker kullanıyorsa
docker-compose restart

# Systemd kullanıyorsa
sudo systemctl restart mastertool-download

# Manuel ise
# Çalışan FastAPI process'ini sonlandır ve yeniden başlat
```

### 5.3 Kontrol

```bash
# Sunucunun çalıştığını doğrula
curl https://mastertool.download/api/mt/apps -H "Authorization: Bearer token"

# "pe" uygulaması listelenmiş olmalı
```

---

## 📤 Adım 6: Dosyaları Yükle

Artık Process Explorer exe dosyalarını mastertool.download'a yükleyebilirsin.

### 6.1 Yükleme Script'ini Hazırla

Bilgisayarında masterprocess dizininde:

```powershell
cd C:\path\to\masterprocess
```

### 6.2 Test Modu (Simülasyon)

```powershell
# Çalışıp çalışmadığını test et (yükleme yapmadan)
.\deploy-to-master-download.ps1 -Test

# Çıktı: Yüklenecek dosyaları gösterecek
```

### 6.3 Gerçek Yükleme

Environment variable'ı ayarla:

```powershell
# PowerShell
$Env:PROCESSEXPLORER_RELEASE_KEY = "anahtar-burada"

# Veya
Set-Item -Path Env:PROCESSEXPLORER_RELEASE_KEY -Value "anahtar-burada"
```

Yükle:

```powershell
.\deploy-to-master-download.ps1 -ReleaseKey $Env:PROCESSEXPLORER_RELEASE_KEY

# İzle:
# [HH:mm:ss] Validating executable files...
# [HH:mm:ss] ✓ Setup EXE: Process-Explorer-Setup-1.0.0.exe (30.45 MB)
# [HH:mm:ss] Uploading setup executable...
# [HH:mm:ss] ✓ Setup uploaded: 200
# [HH:mm:ss] Uploading portable executable...
# [HH:mm:ss] ✓ Portable uploaded: 200
```

---

## ✅ Adım 7: Doğrulama

Process Explorer'ın mastertool.download'da görünüp çalıştığını kontrol et.

### 7.1 Katalogda Kontrol

Tarayıcıda ziyaret et:

```
https://mastertool.download/
```

Aç: **Uygulamalar** → **Process Explorer** görünüyor mu?

### 7.2 Product Sayfası

```
https://mastertool.download/process-explorer
```

Sayfa yüklenir ve indirme düğmeleri var mı?

### 7.3 API Kontrolü

```bash
# Katalog listesin
curl https://mastertool.download/api/mt/apps \
  -H "Authorization: Bearer token" | grep -i "process"

# En son sürüm
curl https://mastertool.download/api/pe/releases/latest \
  -H "Authorization: Bearer token"

# Çıktı: version, sha256, setup_size, portable_size
```

### 7.4 İndirme Testi

```bash
# Setup'ı indir
curl -O https://mastertool.download/api/pe/releases/latest?kind=setup

# Dosya oluştu mu ve boyut doğru mu?
ls -lh Process-Explorer-Setup-1.0.0.exe

# SHA256 doğrula
openssl dgst -sha256 Process-Explorer-Setup-1.0.0.exe
```

---

## 🎉 Tamamlandı!

Process Explorer artık mastertool.download'da canlı! 

**Linkler:**
- Katalog: https://mastertool.download/
- Product: https://mastertool.download/process-explorer
- Setup İndir: https://mastertool.download/api/pe/releases/latest?kind=setup
- Portable İndir: https://mastertool.download/api/pe/releases/latest?kind=portable

---

## 🔄 Sonraki Sürümler (1.0.1, 1.1.0 vb.)

Yeni sürüm yayınlamak için:

```powershell
# 1. Yeni sürüm için exe'ler derle
.\build.ps1 -Package

# 2. Dosyaları version ile yeniden adlandır
# Process-Explorer-Setup-1.0.1.exe
# Process-Explorer-Portable-1.0.1.exe

# 3. Yükle
$Env:PROCESSEXPLORER_RELEASE_KEY = "anahtar"
.\deploy-to-master-download.ps1 -Version "1.0.1" -ReleaseKey $Env:PROCESSEXPLORER_RELEASE_KEY
```

Yeni sürüm otomatik olarak master.download ve mastertool.download kataloglarında görünecektir.

---

## 🆘 Sorun Giderme

### "409 Conflict - exists"
Sürüm zaten yüklü. Yeni sürüm (1.0.1) deneyin veya sunucu tarafından sil.

### "403 Unauthorized - X-Release-Key invalid"
Release key yanlış. Sunucudaki .env'de ayarlanmış mı ve server yeniden başlatıldı mı?

### "422 Unprocessable Entity - not_exe"
Dosya .exe değil veya başı doğru değil. `file dist\*.exe` ile kontrol et.

### "404 Not Found - no_release"
Setup henüz yüklenmedi. Portable ilk yüklenmeli mi?

### Product sayfası yüklenmedi
HTML dosyası `mt/araclar/process-explorer.html`'de ve UTF-8 ile kaydedilmiş mi?

---

## 📞 İletişim

Sorular? Hepgo repository'sine issue açabilirsin:
https://github.com/goktalay/hepgo/issues

