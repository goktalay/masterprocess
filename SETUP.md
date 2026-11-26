# Process Explorer - Kurulum ve Geliştirme Rehberi

## 🖥️ Sistem Gereksinimleri

- **İşletim Sistemi**: Windows 10 (Build 19041+) veya Windows 11
- **.NET Framework**: .NET 8.0 SDK
- **IDE**: Visual Studio 2022 Community/Professional (önerilen)
- **RAM**: Minimum 4 GB (8 GB+ önerilen)
- **Disk**: 500 MB boş alan

## 📥 Adım 1: .NET 8.0 SDK Kurulumu

### Windows İçin:

1. **Resmi site'den indir**:
   - https://dotnet.microsoft.com/download/dotnet/8.0
   - "SDK" seçeneğini indir (not: Runtime değil)

2. **Yükleyiciyi çalıştır**:
   ```bash
   # İndirilen dosyayı çalıştır (örneğin)
   dotnet-sdk-8.0.0-win-x64.exe
   ```

3. **Kurulumun başarılı olduğunu kontrol et**:
   ```bash
   dotnet --version
   # Çıktı: 8.0.0 (veya sonrası)
   ```

## 🔧 Adım 2: Kaynak Kodunu Klonla

```bash
# Git repo'yu klonla
git clone https://github.com/goktalay/masterprocess.git
cd masterprocess

# Veya varsa, içine gir
cd masterprocess
```

## 🏗️ Adım 3: Proje Yapısını Kontrol Et

```
masterprocess/
├── ProcessExplorer/                    # Ana WPF uygulaması
│   ├── Views/                         # UI (XAML)
│   │   └── MainWindow.xaml
│   ├── ViewModels/                    # MVVM Logic
│   │   └── MainViewModel.cs
│   ├── Models/                        # Data classes
│   │   ├── ProcessInfo.cs
│   │   └── PerformanceMetrics.cs
│   ├── Services/                      # Business Logic
│   │   └── ProcessService.cs
│   ├── Utils/                         # Utilities
│   │   └── DatabaseHelper.cs
│   ├── Resources/                     # Styles, Icons
│   │   └── Styles.xaml
│   ├── App.xaml                       # Application root
│   ├── App.xaml.cs
│   └── ProcessExplorer.csproj         # Project file
│
├── ProcessExplorer.sln                # Solution file
├── CLAUDE.md                          # Development guide
├── SETUP.md                           # This file
└── README.md                          # Project info
```

## 🚀 Adım 4: Build ve Çalıştırma

### Option A: Visual Studio IDE (Önerilen)

1. **Visual Studio 2022'yi aç**
2. **Dosya → Aç → Proje/Çözüm**
3. `ProcessExplorer.sln` dosyasını seç
4. **Çözüm yüklensin** (Sol taraf Solution Explorer'da görünecek)
5. **Build menüsünden: Build Solution** (Ctrl+Shift+B)
6. **F5** tuşuna bas veya **Debug → Start Debugging**

### Option B: Command Line

```bash
# 1. Proje dizinine gir
cd masterprocess

# 2. NuGet paketlerini restore et
dotnet restore

# 3. Debug olarak build et
dotnet build

# 4. Çalıştır
dotnet run --project ProcessExplorer/ProcessExplorer.csproj
```

### Option C: Release Build (Üretim için)

```bash
cd masterprocess

# Release build
dotnet build -c Release

# Release exe'yi çalıştır
./ProcessExplorer/bin/Release/net8.0-windows/ProcessExplorer.exe
```

## 📊 Proje Yapısı ve Modüller

### MainWindow.xaml
- **Ana UI penceresi**
- Üst kısım: Sistem metriksleri (CPU, Memory)
- Orta kısım: 2 sütunlu layout
  - Sol: Process DataGrid
  - Sağ: Seçili process detayları
- Alt kısım: Status bar

### MainViewModel.cs
- **MVVM ViewModels**
- Properties:
  - `Processes` - ObservableCollection<ProcessInfo>
  - `SelectedProcess` - Seçili process
  - `SystemCpuUsage` - Sistem CPU kullanımı
  - `IsMonitoring` - Monitoring durumu
- Commands:
  - `StartMonitoringCommand` - Monitoring başlat
  - `StopMonitoringCommand` - Durdur
  - `RefreshProcessListCommand` - Manuel yenileme

### ProcessService.cs
- **Process yönetimi ve veri toplama**
- Temel fonksiyonlar:
  ```csharp
  GetAllProcesses()           // Tüm processler
  GetProcessInfo(pid)         // Spesifik process
  GetProcessTree()            // Parent-child ağacı
  GetCpuUsage(pid)           // CPU yüzdesi
  SaveProcessMetrics()        // Tarihçeye kaydet
  GetProcessCpuHistory(pid)  // Tarihçe sorgula
  ```

### DatabaseHelper.cs
- **SQLite database yönetimi**
- Şema: ProcessHistory tablosu
- Operasyonlar:
  ```csharp
  Initialize()                // DB oluştur
  SaveProcessMetrics()        // Kaydet
  GetProcessCpuHistory()      // Sorgula
  ```

### Models/ProcessInfo.cs
- **Process bilgileri veri sınıfı**
- Properties:
  - ProcessId, Name, Path
  - Memory (WorkingSet, Virtual, Paged)
  - CPU %, GPU %, GPU Memory
  - Thread count, Window title
  - Start time

## 🔧 Konfigürasyon ve Özelleştirme

### Renk Teması Değiştir
Dosya: `ProcessExplorer/Resources/Styles.xaml`

```xaml
<Color x:Key="PrimaryColor">#2E3440</Color>      <!-- Arka plan -->
<Color x:Key="AccentColor">#5E81AC</Color>       <!-- Vurgu -->
<Color x:Key="SuccessColor">#A3BE8C</Color>      <!-- Başarı/OK -->
<Color x:Key="DangerColor">#BF616A</Color>       <!-- Uyarı/Hata -->
```

### Monitoring Interval Değiştir
Dosya: `ProcessExplorer/ViewModels/MainViewModel.cs`

```csharp
_updateTimer = new DispatcherTimer { 
    Interval = TimeSpan.FromSeconds(2)  // 2 saniye (default)
};
```

### Database Konumu
Varsayılan: `%APPDATA%\Masterprocess\ProcessExplorer.db`

Değiştirmek için `DatabaseHelper.cs`'de:
```csharp
private static readonly string DbPath = 
    Path.Combine(Environment.GetFolderPath(...), "YeniYol");
```

## 🐛 Sık Karşılaşılan Sorunlar

### Problem 1: "Could not find a part of the path"
**Çözüm**: 
```bash
# Klasör yapısı eksik olabilir
mkdir -p ProcessExplorer\Views
mkdir -p ProcessExplorer\ViewModels
mkdir -p ProcessExplorer\Models
mkdir -p ProcessExplorer\Services
mkdir -p ProcessExplorer\Utils
mkdir -p ProcessExplorer\Resources
```

### Problem 2: NuGet paketleri yüklenmiyor
**Çözüm**:
```bash
# Paket kaynaklarını temizle ve yeniden restore et
dotnet nuget locals all --clear
dotnet restore
```

### Problem 3: "The TargetFramework 'net8.0-windows' was not recognized"
**Çözüm**: .NET 8.0 SDK'nın tam olarak yüklü olduğunu kontrol et
```bash
dotnet --list-sdks    # 8.0.xxx listelenmelidir
```

### Problem 4: Uygulamada process gösterilmiyor
**Çözüm**: 
- Administrator olarak çalıştırmayı dene
- Windows Defender/Antivirus kısıtlamasını kontrol et

### Problem 5: Database hataları
**Çözüm**:
```bash
# Database dosyasını sil (yeniden oluşturulacak)
del "%APPDATA%\Masterprocess\ProcessExplorer.db"

# Veya manuel silme
rmdir /s "%APPDATA%\Masterprocess"
```

## 📈 Sonraki Adımlar: Faza Planlama

### Faza 1 - Foundation ✅ Tamamlandı
- [x] WPF temel UI
- [x] Process listesi
- [x] CPU/Memory monitoring
- [x] Database infrastructure

### Faza 2 - Real-time Monitoring (Planlı)
- [ ] OxyPlot grafik entegrasyonu
- [ ] Real-time CPU/Memory/GPU/Disk charts
- [ ] Performance trends
- [ ] Tarihçe analizi

### Faza 3 - Advanced Features (Planlı)
- [ ] GPU monitoring (NVIDIA/AMD)
- [ ] Window capture
- [ ] Memory visualizer
- [ ] File handles explorer

### Faza 4 - Deep Analysis (Planlı)
- [ ] Hex dump analyzer
- [ ] Network connections
- [ ] Process integrity checks
- [ ] Export reports (CSV/PDF)

## 📚 Kaynaklar

- **WPF Documentation**: https://docs.microsoft.com/en-us/dotnet/desktop/wpf/
- **C# Latest Features**: https://docs.microsoft.com/en-us/dotnet/csharp/whats-new/
- **OxyPlot**: https://oxyplot.github.io/
- **SQLite .NET**: http://system.data.sqlite.org/

## 💬 Yardım ve Destek

- **GitHub Issues**: https://github.com/goktalay/masterprocess/issues
- **Developer Guide**: Bkz. CLAUDE.md
- **Architecture Decision**: Bkz. README.md (ADR-001 bölümü)

## ✅ Kurulum Checklist

- [ ] .NET 8.0 SDK yüklü
- [ ] Git clone yapıldı
- [ ] `dotnet restore` çalıştırıldı
- [ ] `dotnet build` başarılı
- [ ] `dotnet run` uygulamayı açtı
- [ ] MainWindow görünüyor
- [ ] Process listesi gösteriliypr
- [ ] Monitoring butonları çalışıyor

---

**Tebrikler! Process Explorer'ı başarıyla kurdum. Artık geliştirmeye başlayabilirsiniz!** 🎉
