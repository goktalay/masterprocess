# 🚀 Process Explorer - Build & Deploy Complete Guide

## Hızlı Başlat (5 dakika)

### Windows'ta Build Et

**PowerShell (Önerilen):**
```powershell
cd C:\Users\YourUsername\masterprocess
.\build.ps1 -Package
```

**Command Prompt:**
```batch
cd C:\Users\YourUsername\masterprocess
build.bat package
```

**Output:**
```
✓ dist\ProcessExplorer-Release.zip (Taşınabilir)
✓ ProcessExplorer.exe (Çalıştırılabilir)
```

---

## 📋 Adım Adım Deployment

### Faza 1: Windows'ta Build Et ⏱️ 2-3 dakika

```powershell
# 1. Repoyu aç
cd "C:\Users\Muhammed Kaderoğlu\masterprocess"

# 2. Build scripti çalıştır
.\build.ps1 -Package

# Output:
#   ✓ bin\Release\net8.0-windows\ProcessExplorer.exe
#   ✓ dist\ProcessExplorer-Release.zip
```

**Kontrol:**
- [ ] build.ps1 başarısız olmadı
- [ ] ProcessExplorer.exe mevcut
- [ ] ProcessExplorer-Release.zip oluşturuldu

---

### Faza 2: Installer Oluştur (Opsiyonel) ⏱️ 5 dakika

**InnoSetup kurulum gerekli:**

1. **InnoSetup indir ve kur:**
   ```
   https://jrsoftware.org/isinfo.php
   → Download InnoSetup 6.0+
   ```

2. **Installer oluştur:**
   ```powershell
   # setup.iss dosyasını aç
   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" setup.iss
   
   # Output: dist\ProcessExplorer-1.0.0-Installer.exe
   ```

**Kontrol:**
- [ ] InnoSetup yüklü
- [ ] setup.iss compile edildi
- [ ] ProcessExplorer-1.0.0-Installer.exe oluşturuldu

---

### Faza 3: Screenshots Çek ⏱️ 3-5 dakika

**Uygulamayı çalıştır:**
```bash
bin\Release\net8.0-windows\ProcessExplorer.exe
```

**Screenshots Al:**

1. **Ana Window** (Process list)
   ```
   Win+Shift+S → Fotoğraf al
   assets/screenshots/01-main-window.png olarak kaydet
   ```

2. **Process Details** (Sağ panel)
   ```
   - Bir process seç (örn: explorer.exe)
   - Win+Shift+S → Screenshot
   - assets/screenshots/02-process-details.png
   ```

3. **System Metrics** (Üst bar)
   ```
   - Monitoring aktif
   - Win+Shift+S → Screenshot
   - assets/screenshots/03-system-metrics.png
   ```

4. **Dark Theme** (Genel görünüm)
   ```
   - Tam pencere
   - Win+Shift+S → Screenshot
   - assets/screenshots/04-dark-theme.png
   ```

**Klasör Yapısı:**
```
assets/
├── process-explorer-icon.png (256x256)
├── process-explorer-banner.png (1920x1080)
└── screenshots/
    ├── 01-main-window.png
    ├── 02-process-details.png
    ├── 03-system-metrics.png
    └── 04-dark-theme.png
```

---

### Faza 4: master.download'a Upload Et ⏱️ 10 dakika

**Adım 1: Account'a Giriş Yap**
```
1. master.download website'ine git
2. Admin panel → Applications
3. "New Application" seç
```

**Adım 2: App Bilgilerini Doldur**
```
Name:              Process Explorer
Version:           1.0.0
Category:          System Tools
Description:       Advanced Windows Process Manager with 
                   real-time CPU, Memory, GPU monitoring,
                   performance analysis, and history tracking
Author:            Masterprocess
Website:           https://github.com/goktalay/masterprocess
Support URL:       https://github.com/goktalay/masterprocess/issues
Minimum Windows:   Windows 10 (Build 19041)
Requirements:      .NET 8.0 Runtime
License:           MIT
```

**Adım 3: Files Upload Et**
```
1. Click "Upload Files"
2. dist/ProcessExplorer-Release.zip seç
   - Type: Portable (ZIP)
   - Required: Checked
   
3. dist/ProcessExplorer-1.0.0-Installer.exe seç (eğer var)
   - Type: Installer (EXE)
   - Required: Unchecked (optional)
```

**Adım 4: Screenshots Upload Et**
```
1. Click "Upload Screenshots"
2. assets/screenshots/ klasöründen tüm PNG'leri seç
3. Order: Ayarla (1,2,3,4)
```

**Adım 5: Banner/Icon Upload Et**
```
1. Click "Upload Icon"
   - process-explorer-icon.png (256x256)
   
2. Click "Upload Banner"
   - process-explorer-banner.png (1920x1080)
```

**Adım 6: Yayınla**
```
1. Click "Publish"
2. Status: "Published"
3. Downloads: Enabled
4. Featured: (İsteğe bağlı)
5. Click "Save"
```

---

### Faza 5: mastertool.download Website'inde Göster ⏱️ 5 dakika

**Website Editörüne Giriş Yap:**
```
1. mastertool.download admin panel
2. Applications → Process Explorer
3. Web listing edit et
```

**Sayfa İçeriği:**

```html
<h1>Process Explorer - Advanced Process Manager</h1>

<p>Gelişmiş Windows sistem izleme ve process yönetim aracı. 
Real-time CPU, GPU, Memory monitoring ile kapsamlı performans 
analizi ve tarihçe tracking.</p>

<h2>Özellikler</h2>
<ul>
  <li>✓ Tüm Windows processlerini listele</li>
  <li>✓ Real-time CPU, Memory, GPU, HDD monitörü</li>
  <li>✓ Process ağacı ve parent-child ilişkileri</li>
  <li>✓ Performans metriklerinin tarihçesi (SQLite)</li>
  <li>✓ Modern dark tema UI</li>
  <li>✓ System-wide performans metrikleri</li>
  <li>✓ Advanced filtering ve sorting</li>
</ul>

<h2>Teknik Bilgi</h2>
<dl>
  <dt>Platform:</dt>
  <dd>Windows 10/11 (x86-64)</dd>
  
  <dt>Requirement:</dt>
  <dd>.NET 8.0 Runtime</dd>
  
  <dt>Boyut:</dt>
  <dd>ZIP: 25 MB | Installer: 30 MB</dd>
  
  <dt>Lisans:</dt>
  <dd>MIT</dd>
  
  <dt>Developer:</dt>
  <dd>Masterprocess Team</dd>
  
  <dt>GitHub:</dt>
  <dd>https://github.com/goktalay/masterprocess</dd>
</dl>

<h2>Fotoğraflar</h2>
[Screenshots otomatik yüklenir]
```

**SEO Meta Tags:**
```
title: Process Explorer - Advanced Process Manager | mastertool.download
description: Advanced Windows process explorer with real-time CPU, GPU, Memory monitoring and performance analysis tools
keywords: process manager, windows, system monitor, task manager
og:title: Process Explorer - Advanced Process Manager
og:description: Real-time Windows process monitoring with performance analysis
og:image: [banner image]
```

---

## 📊 Download Linklerini Kontrol Et

**Test Edilecek URLs:**
```
✓ https://mastertool.download/apps/process-explorer
✓ https://mastertool.download/download/process-explorer/latest/zip
✓ https://mastertool.download/download/process-explorer/latest/installer
✓ Master Download app'inde liste görünsün
✓ Master Download app'inde download çalışsın
```

---

## 🎬 Demo Video Oluştur (Opsiyonel)

**30-60 saniye video:**

```
1. Uygulamayı aç
   - Tüm processler yükleniyor
   
2. Process seç
   - Details panel göster
   
3. Monitoring başlat
   - Start button
   - Real-time update
   
4. System metrics
   - CPU % ve Memory göster
   
5. Kapan
```

**Video kaydı (Windows):**
```
Win+G → Xbox Game Bar
→ Record
→ 30-60 saniye kaydı
→ assets/process-explorer-demo.mp4
```

---

## ✅ Deployment Checklist

**Build:**
- [ ] dotnet build -c Release (başarılı)
- [ ] ProcessExplorer.exe oluşturuldu
- [ ] ProcessExplorer-Release.zip oluşturuldu
- [ ] (Opsiyonel) Installer EXE oluşturuldu

**Media Assets:**
- [ ] Icon (256x256 PNG)
- [ ] Banner (1920x1080 PNG)
- [ ] 4+ screenshots
- [ ] (Opsiyonel) Demo video

**master.download Upload:**
- [ ] Account accessible
- [ ] Application created
- [ ] Files uploaded (ZIP)
- [ ] Screenshots uploaded
- [ ] Banner/Icon uploaded
- [ ] Published & enabled

**mastertool.download Website:**
- [ ] Listing oluşturuldu
- [ ] Açıklama yazıldı
- [ ] Meta tags ayarlandı
- [ ] Screenshots görsün
- [ ] Download linki çalışsın

**Final Testing:**
- [ ] Download linki çalışıyor
- [ ] ZIP içeriği doğru
- [ ] Installer çalışıyor (eğer var)
- [ ] Screenshot'lar görsün
- [ ] Website accessible
- [ ] Master Download app'inde listeleniyor

---

## 🎉 Release Announcement

**GitHub Release Oluştur:**
```bash
# GitHub'a git
https://github.com/goktalay/masterprocess/releases

# "Create a new release"
Tag version: v1.0.0
Release title: Process Explorer v1.0.0 - Initial Release
Description:
  🎉 Process Explorer - Advanced Windows Process Manager
  
  ✨ Features:
  - Real-time process monitoring
  - CPU, Memory, GPU tracking
  - Performance history database
  - Modern dark theme UI
  - System metrics dashboard
  
  📥 Download:
  - https://mastertool.download/apps/process-explorer
  - https://master.download
  
  📝 Installation:
  - Portable ZIP: Extract and run
  - Installer: Run ProcessExplorer-1.0.0-Installer.exe
  
  🐛 Report Issues:
  - https://github.com/goktalay/masterprocess/issues
```

---

## 📞 Support & Feedback

```
GitHub Issues:   https://github.com/goktalay/masterprocess/issues
Discussions:     https://github.com/goktalay/masterprocess/discussions
Wiki:            https://github.com/goktalay/masterprocess/wiki
```

---

## 🎯 Sonraki Faza

Faza 2'ye başlamaya hazır:
```
✓ Real-time performance charts (OxyPlot)
✓ GPU memory visualization
✓ Window screenshot capture
✓ Advanced memory layout analyzer
```

---

## ✨ Success! 🚀

Process Explorer başarıyla built, packaged ve deployed oldu!

```
✓ GitHub: https://github.com/goktalay/masterprocess
✓ master.download: Available for download
✓ mastertool.download: Listed and featured
✓ Ready for users!
```

Tebrikler! 🎊
