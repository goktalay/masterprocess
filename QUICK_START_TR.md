# ⚡ Process Explorer - Mastertool Setup - Hızlı Başlangıç

Bilgisayarında tek bir PowerShell komutu çalıştır ve otomatik işler biter!

---

## 🚀 1. Gereksinimler (5 dakika)

Bilgisayarında aşağıdakiler kurulu olmalı:

```powershell
# PowerShell'de kontrol et:
dotnet --version          # .NET 8.0+
git --version             # Git
7z.exe --version          # 7-Zip (opsiyonel, portable için)
```

**Eksikse indir:**
- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Git](https://git-scm.com/download/win)
- [7-Zip](https://www.7-zip.org/)
- [InnoSetup](https://jrsoftware.org/isdl.php) (kurulum exe için)

---

## 🔑 2. Release Key Hazırla (1 dakika)

PowerShell'de çalıştır:

```powershell
# Release key üret
$Key = -join ((1..32) | ForEach-Object { "{0:X2}" -f (Get-Random -Maximum 256) })
Write-Host $Key
```

Çıktıyı kopyala. Örnek:
```
A3F5B9C2E7D1A4F6B8C3E5F7A9B1D3E5F7A9C1B3D5E7F9A1B3C5E7F9A1B3
```

---

## 🎯 3. Full Setup Çalıştır (20 dakika)

Bilgisayarında Process Explorer dizininde PowerShell aç:

```powershell
cd C:\path\to\masterprocess

# Script'i çalıştır
.\setup-mastertool.ps1
```

**Ne olacak:**

1. ✅ Release key üretilecek (gösterilecek)
2. ✅ Release build derlenecek
3. ✅ InnoSetup installer oluşturulacak
4. ✅ GitHub secret eklenecek (manual veya otomatik)
5. ✅ Hepgo repository güncellenecek
6. ✅ Server yapılandırması (manual adımlar rehber olarak)
7. ✅ Dosyalar mastertool.download'a yüklenecek
8. ✅ Doğrulama bağlantıları gösterilecek

---

## 📋 4. Manual Adımlar (Sırasında İstenecek)

Script çalışırken aşağıdakiler istenebilir:

### A. GitHub Secret (İsteğe bağlı)

Script automatik ekleyebilir veya manual:

1. https://github.com/goktalay/masterprocess/settings/secrets/actions
2. "New Repository Secret"
3. Name: `PROCESSEXPLORER_RELEASE_KEY`
4. Value: (Adım 2'den anahtar)
5. Add Secret

### B. Hepgo Yolu

```
Hepgo repository'sinin yolunu gir
Örnek: C:\hepgo
```

Script otomatik güncelleyecek:
- `sshm/main.py`
- `sshm/settings.py`
- HTML tanıtım sayfası

### C. Server Yapılandırması

```
SSH target gir: user@mastertool.download
```

Script adımları rehberlik edecek. Sunucu tarafında .env'e anahtar eklenecek ve yeniden başlatılacak.

---

## ✨ 5. Yükleme Başlar

Script otomatik olarak:

```
POST https://mastertool.download/api/pe/releases/1.0.0/setup
POST https://mastertool.download/api/pe/releases/1.0.0/portable
```

Headers:
```
X-Release-Key: (senin anahtar)
```

Çıktı gösterecek:
```
✓ Setup uploaded: 200
✓ Portable uploaded: 200
```

---

## 🎉 6. Doğrulama

Script bitmeden sonra, mastertool.download'da kontrol et:

**Tarayıcıda ziyaret et:**

1. **Katalog:** https://mastertool.download/
   - Uygulamalar → Process Explorer görünüyor mu?

2. **Product Page:** https://mastertool.download/process-explorer
   - Tanıtım sayfası yükleniyor mu?

3. **İndirme Test:**
   ```bash
   # Terminal/PowerShell
   curl -O https://mastertool.download/api/pe/releases/latest?kind=setup
   
   # Dosya oluştu mu?
   ls -lh Process-Explorer-Setup-1.0.0.exe
   ```

---

## 🔧 Modlar

Eğer sadece belli adımları çalıştırmak istersen:

```powershell
# Sadece build
.\setup-mastertool.ps1 -Action build

# Sadece GitHub
.\setup-mastertool.ps1 -Action github -GithubToken "..."

# Sadece Hepgo
.\setup-mastertool.ps1 -Action hepgo -HepgoPath "C:\hepgo"

# Sadece yükleme
.\setup-mastertool.ps1 -Action upload

# Sadece doğrulama
.\setup-mastertool.ps1 -Action verify
```

---

## 🆘 Sorun Giderme

### "Build başarısız"
```
ERROR: Build başarısız. .NET 8.0 SDK yüklü mü?
```
→ [.NET 8.0 indir ve yükle](https://dotnet.microsoft.com/download/dotnet/8.0)

### "InnoSetup bulunamadı"
```
WARNING: InnoSetup Compiler bulunamadı.
```
→ [InnoSetup 6 indir](https://jrsoftware.org/isdl.php) ve yükle

### "7-Zip bulunamadı"
```
WARNING: Portable zip oluşturulamadı. 7-Zip yüklü mü?
```
→ [7-Zip indir](https://www.7-zip.org/) (opsiyonel, portable için)

### "GitHub CLI başarısız"
```
WARNING: GitHub CLI ile secret eklenemedi. Manual ekle:
```
→ Linkde manual olarak secret ekle (tarayıcıda)

### "409 exists - Version already exists"
→ Yeni sürüm (1.0.1) deneyin veya sunucudan sil

### "403 Unauthorized"
→ Release key yanlış veya sunucu .env'de değil. Server yeniden başlatıldı mı?

---

## 📞 Daha Fazla Yardım

- **Teknik Detaylar:** `MASTERTOOL_INTEGRATION.md`
- **Türkçe Rehber:** `MASTERTOOL_SETUP_TR.md`
- **Deploy Script:** `deploy-to-master-download.ps1`

---

## ⏱️ Zaman Tahmini

| Adım | Zaman |
|------|-------|
| Gereksinimler | 5 min |
| Release Key | 1 min |
| Build | 10 min |
| GitHub | 2 min |
| Hepgo | 3 min |
| Server Config | 5 min |
| Upload | 3 min |
| Doğrulama | 2 min |
| **TOPLAM** | **~30 min** |

> Server yeniden başlatması ve ağ bağlantısı eklenebilir

---

## 🎊 Tamamlandı!

Process Explorer mastertool.download'da canlı! 🚀

**İndirme Bağlantıları:**
- Setup: https://mastertool.download/api/pe/releases/latest?kind=setup
- Portable: https://mastertool.download/api/pe/releases/latest?kind=portable

**Sonraki Sürümler:**

```powershell
# 1. Yeni sürüm derle (örn: 1.0.1)
.\build.ps1 -Package

# 2. Upload
$Env:PROCESSEXPLORER_RELEASE_KEY = "..."
.\setup-mastertool.ps1 -Action upload
```

---

**Kontrol:**
```powershell
# Script başarılı mı?
.\setup-mastertool.ps1 -Action verify
```

---

**📝 Not:** Bu script tüm adımları otomatikleştirir ama bazı bölümler (sunucu SSH, GitHub) interaktif olabilir. Hiçbir şey bozulmaz, sadece bilgi verilerek devam eder.

