# Process Explorer - Masterprocess

Gelişmiş Windows sistem izleme ve process yönetim aracı. Windows Task Manager'ın uzantısı gibi çalışan, performans analizi, tarihçe tracking ve detaylı sistem metriklerini sunan desktop uygulaması.

## 🎯 Özellikler

### Foundation (Yapı - Tamamlandı)
- ✅ WPF tabanlı modern UI
- ✅ Gerçek zamanlı process listesi
- ✅ CPU ve Memory kullanımı gösterimi
- ✅ Process ağacı yapısı
- ✅ SQLite tarihçe database
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
./ProcessExplorer/bin/Release/net8.0-windows/ProcessExplorer.exe
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
- Konum: `%APPDATA%\Masterprocess\ProcessExplorer.db`
- Şema: ProcessHistory tablosu (ProcessId, Timestamp, CPU, Memory, GPU, Disk I/O)
- Tarihçe: Son 60 günü tutabilir

## 🔧 Geliştirme

### Dependencies
- **OxyPlot.Wpf**: Real-time grafikleri için
- **System.Data.SQLite**: Tarihçe database
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
4. Performance Counters (Kernel API)
   ↓
5. Models (ProcessInfo objects)
   ↓
6. UI Update (DataGrid binding)
   ↓
7. Database Save (Tarihçe)
```

## 🐛 Bilinen Sınırlamalar

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

Masterprocess - Process Explorer © 2026

## 📞 Destek

Sorular veya sorunlar için GitHub Issues'ı kullan.
