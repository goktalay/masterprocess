# Master Process

Windows için süreç izleme aracı: çalışan süreçleri bellek, CPU ve iş parçacığı değerleriyle listeler, seçilen sürecin ayrıntılarını gösterir. Mastertool ailesinin bir aracıdır; tanıtım ve indirme: <https://mastertool.download/araclar/master-process>

> Ad notu: proje "Process Explorer" çalışma adıyla başladı (kod ad alanı ve klasör adları hâlâ `ProcessExplorer`). Bu ad Microsoft Sysinternals'ın bir ürününe ait olduğu için yayın adı **Master Process**'tir.

## 🎯 Özellikler

### Foundation (Yapı - Tamamlandı)
- ✅ WPF tabanlı modern UI
- ✅ Gerçek zamanlı process listesi
- ✅ CPU ve Memory kullanımı gösterimi
- ✅ SQLite tarihçe database (izleme sırasında seçili sürecin ölçümleri; arayüzde henüz gösterilmiyor)
- ✅ MVVM mimari

### Faza 1: Temel Monitoring (Planlı)
- 📋 Real-time performance grafikleri (OxyPlot)
- 📊 CPU/RAM/GPU/Disk kullanım charts
- 💾 Tarihçe ve trends analizi
- 🔄 Otomatik monitoring timer

### Faza 2: Advanced Features (Planlı)
- 🎮 GPU Monitoring (NVIDIA/AMD)
- 📸 Window capture ve screenshot
- 🗂️ Disk dosya explorer
- 🔍 Process file handles gösterimi
- 📈 Memory layout visualizer

### Faza 3: Deep Analysis (Planlı)
- 🔎 Hex dump analyzer
- 🌳 Detailed process tree
- 📡 Network connections
- 🔐 Process integrity checks

## 📁 Proje Yapısı

```
ProcessExplorer/
├── Views/                      # XAML UI Views
│   ├── MainWindow.xaml        # Ana pencere
│   ├── MainWindow.xaml.cs
│   ├── ProcessTreeView.xaml   # (Planlı) Process ağacı görünümü
│   └── ChartsView.xaml        # (Planlı) Performans grafikleri
│
├── ViewModels/                # MVVM ViewModels
│   ├── MainViewModel.cs       # Ana logic ve komutlar
│   └── ChartsViewModel.cs     # (Planlı) Grafik viewmodel
│
├── Models/                    # Data models
│   ├── ProcessInfo.cs         # Process bilgileri
│   └── PerformanceMetrics.cs # Performans metrikleri
│
├── Services/                  # Business logic
│   ├── ProcessService.cs      # Process yönetimi
│   ├── PerformanceMonitor.cs # (Planlı) Monitoring service
│   └── WindowCaptureService.cs # (Planlı) Window screenshot
│
├── Utils/                     # Utilities
│   ├── DatabaseHelper.cs      # SQLite database
│   └── NativeInterop.cs       # (Planlı) P/Invoke declarations
│
└── Resources/
    └── Styles.xaml            # Global tema ve stiller
```

## 🚀 Hızlı Başlangıç

### Gereksinimler
- Windows 10/11
- .NET 8.0 SDK
- Visual Studio 2022 (veya VS Code + dotnet CLI)

### Kurulum ve Çalıştırma

#### Option 1: Visual Studio
```bash
# 1. Repoyu aç
cd masterprocess

# 2. Visual Studio'da açıl
start ProcessExplorer.sln

# 3. Debug yapı seç ve F5 tuşuna bas
```

#### Option 2: Command Line
```bash
# 1. Repoyu aç
cd masterprocess

# 2. Restore ve build et
dotnet build

# 3. Çalıştır
dotnet run --project ProcessExplorer/ProcessExplorer.csproj
```

#### Option 3: Release Build
```bash
# Release olarak build et
dotnet build -c Release

# Çalıştır
./ProcessExplorer/bin/Release/net8.0-windows/MasterProcess.exe
```

## 💻 Kullanım

### Ana Ekran
1. **Process Listesi**: Tüm çalışan işlemleri gösterir
   - Ad, PID, Memory, CPU %, Thread sayısı
   - Start time ve window başlığı

2. **System Metrics** (Top bar):
   - Toplam sistem CPU kullanımı
   - Total ve Available RAM
   - Real-time güncelleme

3. **Process Details** (Sağ panel):
   - Seçili process'in detaylı bilgileri
   - File path, threads, GPU memory, window title

4. **Kontrol Butonları**:
   - **Start Monitoring**: 2 sn'de bir otomatik güncelleme
   - **Stop Monitoring**: Monitoring'i durdur
   - **Refresh**: Manual yenileme

### Database
- Konum: `%APPDATA%\Master Process\history.db`
- Şema: ProcessHistory tablosu (ProcessId, Timestamp, CPU, Memory, GPU, Disk I/O)
- Tarihçe: Son 60 günü tutabilir

## 🔧 Geliştirme

### Dependencies
- **OxyPlot.Wpf**: Real-time grafikleri için
- **System.Data.SQLite.Core**: Tarihçe database
- **CommunityToolkit.Mvvm**: MVVM binding utilities

### Yapı Mimarisi

#### Services Layer
```csharp
ProcessService          // Process enumeration ve monitoring
├── GetAllProcesses()   // Tüm processler
├── GetProcessInfo()    // Spesifik process detayları
├── GetProcessTree()    // Parent-child ilişkileri
└── GetCpuUsage()       // CPU kullanım hesaplaması
```

#### Database Layer
```csharp
DatabaseHelper          // SQLite yönetimi
├── Initialize()        // DB schema oluştur
├── SaveProcessMetrics() // Metrik kaydet
└── GetProcessCpuHistory() // Tarihçe sorgula
```

#### ViewModel Layer (MVVM)
```csharp
MainViewModel
├── Processes (ObservableCollection)   // UI binding
├── SelectedProcess                     // Seçili process
├── IsMonitoring / SystemCpuUsage      // State properties
└── Commands: Start/Stop/Refresh       // User actions
```

## 📊 Veri Akışı

```
1. User Action (Button Click)
   ↓
2. ViewModel Command (IRelayCommand)
   ↓
3. ProcessService (GetAllProcesses)
   ↓
4. System.Diagnostics.Process + GetSystemTimes (CPU: iki örnek arası işlemci süresi farkı)
   ↓
5. Models (ProcessInfo objects)
   ↓
6. UI Update (DataGrid binding)
   ↓
7. Database Save (Tarihçe)
```

## 📦 Yayın (mastertool.download)

Paketleri `.github/workflows/release.yml` üretir (Windows runner):

- **Kurulum**: `Master-Process-Setup-<sürüm>.exe` — Inno Setup (`setup.iss`), x64, .NET çalışma zamanı pakette. Varsayılan konum `…\Mastertool\Master Process`; kaldırma kaydı adı "Master Process", çalıştırılabilir dosya `Master Process.exe` (Master Tool yüklü uygulamayı bu ikisiyle bulur).
- **Portable**: `Master-Process-Portable-<sürüm>.exe` — tek dosya, kurulum gerektirmez.
- Akış her iki paketi de runner'da çalıştırıp sınar (`scripts/ci-smoke.ps1`: pencere açılıyor mu, izleme başlıyor mu, liste doluyor mu, geçmiş veritabanı oluşuyor mu) ve bir ekran görüntüsü kaydeder.

Sürüm çıkarmak:

```bash
# Directory.Build.props içindeki <Version> değerini güncelle, commit et, sonra:
git tag v1.0.1 && git push origin v1.0.1
```

Etiketle çalışan akış GitHub Release oluşturur ve `scripts/upload-mastertool.sh` ile paketleri
`POST https://mastertool.download/api/mp/releases/<sürüm>/setup|portable` uçlarına yükler (başlık `X-Release-Key`).
Anahtar depo secret'ı `MASTERPROCESS_RELEASE_KEY`'den okunur; tanımlı değilse yükleme adımı uyarı verip atlanır.
Elle çalıştırma (Actions → Run workflow) yalnız derler ve sınar, yükleme yapmaz.

Depodaki `BUILD_AND_DEPLOY.md`, `DEPLOYMENT.md`, `MASTERTOOL_*.md`, `deploy-to-master-download.ps1`, `setup-mastertool.ps1` ve
`hepgo-pe-integration.patch` eski denemelere aittir (`/api/pe/...` uçları yoktur); geçerli süreç bu bölümdür.

## 🐛 Bilinen Sınırlamalar

- Arayüz İngilizce ve tek (koyu) temalı
- Süreç sonlandırma / öncelik değiştirme yok
- Korumalı sistem süreçlerinde dosya yolu, başlangıç zamanı ve CPU değeri boş kalabilir
- Paket x64'tür; Windows ARM64'te öykünmeyle çalışır

- GPU monitoring henüz implement edilmemiş
- Window capture özelliği planlı
- Hex analysis tool henüz yazılmamış
- Network connections gösterimi henüz yok
- Bazı system processes erişim kısıtlı olabilir

## 📝 Sonraki Adımlar

1. **Charts Integration**: OxyPlot grafikleri ekle
2. **GPU Monitoring**: NVIDIA/AMD SDK entegrasyonu
3. **Window Capture**: Screenshot özelliği
4. **Performance Analysis**: Memory/GPU layout visualizer
5. **Deep Analysis Tools**: Hex dump, file handles

## 🤝 Katkılar

Katkılar hoş karşılanır! PR'lar için:
1. Feature branch oluştur (`git checkout -b feature/amazing-feature`)
2. Değişiklikleri commit et (`git commit -m 'Add amazing feature'`)
3. Branch'i push et (`git push origin feature/amazing-feature`)
4. Pull Request aç

## 📄 Lisans

Master Process © 2026 Mastertool

## 📞 Destek

Sorular veya sorunlar için GitHub Issues'ı kullan.
