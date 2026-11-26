# Process Explorer - Deployment Guide

## 📦 Build & Deployment Instructions

### Faza 1: Build Oluştur (Windows'ta)

#### Option A: PowerShell Script (Önerilen)

```powershell
# 1. Repoyu klonla veya aç
cd C:\Users\YourUsername\masterprocess

# 2. Build scripti çalıştır (Release mode)
.\build.ps1

# 3. Paket oluştur
.\build.ps1 -Package

# Output: dist\ProcessExplorer-Release.zip
```

#### Option B: Batch Script

```batch
# 1. Repoyu klonla veya aç
cd C:\Users\YourUsername\masterprocess

# 2. Build scripti çalıştır
build.bat

# 3. Paket oluştur
build.bat package

# Output: dist\ProcessExplorer-Release.zip
```

#### Option C: Manual Build

```bash
dotnet clean
dotnet restore
dotnet build -c Release

# Executable output:
# bin\Release\net8.0-windows\ProcessExplorer.exe
```

---

## 📥 Master Download Sistemine Upload Et

### Step 1: Kurulum Dosyası Hazırla

**İki seçenek:**

1. **ZIP Package** (Taşınabilir)
   ```
   dist/ProcessExplorer-Release.zip
   - Tüm .exe, .dll, ve kütüphaneleri içerir
   - Herhangi bir klasöre çıkartılabilir
   - Kurulum gerektirmez
   ```

2. **Installer Executable** (Installer)
   ```
   # setup.iss dosyasını kullanarak InnoSetup ile:
   
   1. InnoSetup 6.0+ indir: https://jrsoftware.org/isinfo.php
   2. setup.iss dosyasını aç
   3. Compile et
   4. Output: dist/ProcessExplorer-1.0.0-Installer.exe
   ```

---

## 📤 Master Download API Integration

### API Endpoints (Örnek)

```bash
# 1. Application Register
POST /api/apps/register
Content-Type: application/json

{
  "name": "Process Explorer",
  "version": "1.0.0",
  "category": "System Tools",
  "description": "Advanced Windows Process Manager with real-time monitoring",
  "author": "Masterprocess",
  "website": "https://github.com/goktalay/masterprocess",
  "icon_url": "https://mastertool.download/icons/process-explorer.png",
  "requirements": "Windows 10/11, .NET 8.0 Runtime"
}

# 2. Upload Files
POST /api/apps/{app_id}/files
- file: ProcessExplorer-Release.zip
- file: ProcessExplorer-1.0.0-Installer.exe
- checksums: SHA256 for verification

# 3. Create Release
POST /api/apps/{app_id}/releases
{
  "version": "1.0.0",
  "files": ["zip", "exe"],
  "changelog": "Initial release with core monitoring features",
  "published": true
}

# 4. Enable Downloads
PUT /api/apps/{app_id}/status
{
  "status": "published",
  "downloadable": true,
  "featured": false
}
```

---

## 🌐 mastertool.download Website Integration

### Site Configuration

**1. App Listing Page**
```html
<div class="app-card">
  <h3>Process Explorer</h3>
  <p>Advanced Windows Process Manager</p>
  <img src="/images/process-explorer-banner.png" />
  <dl>
    <dt>Version:</dt>
    <dd>1.0.0</dd>
    <dt>Category:</dt>
    <dd>System Tools</dd>
    <dt>Downloads:</dt>
    <dd>File ZIP (25 MB) | Installer EXE (30 MB)</dd>
  </dl>
  <button>Download</button>
</div>
```

**2. Meta Tags**
```html
<meta name="description" content="Advanced Windows process explorer with real-time monitoring, CPU/GPU tracking, and performance analysis">
<meta name="keywords" content="process manager, windows, system monitor, process explorer">
<meta property="og:title" content="Process Explorer - Advanced Process Manager">
<meta property="og:image" content="https://mastertool.download/images/process-explorer-preview.png">
```

**3. Direct Download Links**
```
https://mastertool.download/apps/process-explorer
https://mastertool.download/download/process-explorer/latest/zip
https://mastertool.download/download/process-explorer/latest/installer
```

---

## 📸 Screenshots & Media Assets

### Gerekli Dosyalar

```
assets/
├── process-explorer-icon.png          (256x256, transparent)
├── process-explorer-banner.png        (1920x1080, preview)
├── screenshots/
│   ├── 01-main-window.png             (Process list)
│   ├── 02-process-details.png         (Details panel)
│   ├── 03-system-metrics.png          (CPU/Memory)
│   └── 04-dark-theme.png              (UI theme)
├── videos/
│   └── process-explorer-demo.mp4      (30-60 seconds)
└── README.md                           (Media descriptions)
```

### Screenshot Capture Commands

**Using Windows Screenshot Tool:**
```
# 1. Uygulamayı çalıştır
bin\Release\net8.0-windows\ProcessExplorer.exe

# 2. Win+Shift+S ile screenshot al
# 3. Farklı durumları screenshot'la:
#    - Main window (process list)
#    - Process seçiliyken details
#    - System metrics gösterimi
#    - Dark theme gösterimi
```

---

## 🚀 Release Checklist

- [ ] Code final ve tested (Release build başarılı)
- [ ] Version number updated (1.0.0)
- [ ] README.md updated
- [ ] CHANGELOG.md created
- [ ] Build artifacts created (ZIP + Installer)
- [ ] Screenshots captured (4+ images)
- [ ] Media assets prepared (icon, banner)
- [ ] API documentation ready
- [ ] master.download account accessible
- [ ] mastertool.download website ready
- [ ] Download links tested (both ZIP and EXE)
- [ ] GitHub release created
- [ ] Announcement posted

---

## 📋 Version History

### v1.0.0 (Current) - 2026-11-26
- **Foundation Release**
- Real-time process monitoring
- CPU, Memory, GPU tracking
- SQLite history database
- Dark theme UI
- Process tree structure

### v1.1.0 (Planned)
- Real-time performance charts
- GPU memory visualization
- Window screenshot capture
- Advanced performance analysis

### v2.0.0 (Planned)
- Deep system analysis tools
- Hex dump analyzer
- Network connection monitoring
- System alerts and notifications

---

## 🔗 Important Links

- **GitHub Repository**: https://github.com/goktalay/masterprocess
- **Master Download**: https://master.download
- **Mastertool Website**: https://mastertool.download
- **Issue Tracker**: https://github.com/goktalay/masterprocess/issues
- **Project Wiki**: https://github.com/goktalay/masterprocess/wiki

---

## ✅ Success Criteria

✅ Application builds successfully on Windows  
✅ Portable ZIP package created  
✅ Installer EXE created  
✅ Master Download integration complete  
✅ Website listing published  
✅ Screenshots and media displayed  
✅ Download links working  
✅ User reviews/ratings system active  

---

## 🆘 Troubleshooting

### Build fails
```bash
# Solution: Clean and rebuild
dotnet clean
dotnet restore
dotnet build -c Release
```

### InnoSetup not creating installer
```
1. InnoSetup 6.0+ yükle
2. setup.iss dosyasını aç
3. Build output klasörü kontrol et (bin\Release\net8.0-windows)
4. Compile → Run
```

### Download link broken
```
1. master.download API status kontrol et
2. File checksum doğrula (SHA256)
3. Upload URL'ini test et
4. CDN cache temizle (eğer var ise)
```

---

## 📞 Support

- GitHub Issues: Report bugs ve feature requests
- Email: support@masterprocess.dev (eğer var ise)
- Wiki: https://github.com/goktalay/masterprocess/wiki

**Successfully deployed! 🎉**
