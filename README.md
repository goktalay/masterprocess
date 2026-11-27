# Master Process

Windows için süreç yöneticisi. Süreç ağacını, süreç başına CPU / bellek / G/Ç / ağ / GPU grafiklerini, sürecin bellek ve
disk yerleşimini, ağ bağlantılarını ve bu bağlantılardan akan veriyi, pencere görüntüsünü, açık dosyalarını, bellek ve
dosya içeriğinin hex dökümünü ve süreç tarihçesini gösterir.
Mastertool ailesinin bir aracıdır; tanıtım ve indirme: <https://mastertool.download/araclar/master-process>

> Ad notu: proje "Process Explorer" çalışma adıyla başladı. Bu ad Microsoft Sysinternals'ın bir ürününe ait olduğu için
> yayın adı **Master Process**'tir.

## Özellikler

- **Süreç ağacı / düz liste**: üst–alt ilişkisi, arama; satır içinde CPU, bellek, G/Ç ve ağ çizgi grafikleri. Ağaçta sütun
  başlığına tıklanınca kökler ve kardeşler dal toplamına (alt süreçleriyle birlikte) göre sıralanır; tümünü aç / tümünü kapat
- **Sistem görünümü**: toplam CPU, bellek, G/Ç, ağ ve GPU grafikleri, en çok kaynak kullanan süreçler
- **Süreç ayrıntıları**: yol, komut satırı, üst süreç, kullanıcı, öncelik, tutamaç / iş parçacığı sayıları
- **Performans**: süreç başına CPU, bellek, G/Ç grafikleri; tepe ve ortalama değerler
- **Bellek**: sanal adres alanı haritası (tür, koruma, fiziksel bellekte bulunma), bölge listesi, bellek içeriğinin hex dökümü
  (canlı yenileme, değişen baytların işaretlenmesi, dizgeler kipi)
- **Disk**: okuma / yazma hızları, sürecin açık tuttuğu dosyalar, seçilen dosyanın birimdeki küme yerleşimi ve içeriğinin hex dökümü;
  disk yüzeyi: birimin doluluk haritası (birimin kendi küme bit eşleminden) üzerinde dosyanın parçaları, her parçanın küme / sektör aralığı
- **Ağ**: süreç başına indirme / yükleme hızı, açık bağlantılar ve dinlenen portlar, porta göre süzme; seçilen sürecin
  **giden ve gelen** verisi ayrı panellerde canlı akış olarak — akıllı görünüm (HTTP iletileri, JSON sözdizimi, resim önizleme,
  sıkıştırılmış gövdelerin açılması), hex, metin, HTML / XML kaynağı, Base64
- **GPU**: süreç başına GPU motoru kullanımı, ayrılmış / paylaşılan GPU belleği
- **Pencere**: sürecin pencereleri ve seçilen pencerenin görüntüsü (isteğe bağlı otomatik yenileme)
- **Modüller ve iş parçacıkları**
- **Tarihçe**: uygulama açıkken başlayan ve sonlanan süreçler (ömür, tepe CPU, tepe bellek)
- **Eylemler**: askıya al / sürdür, öncelik değiştir, sonlandır, ağacı sonlandır, yönetici olarak yeniden başlat
- Gece / gündüz teması, 8 dil (tr, en, fr, de, es, ar, zh, ru), Mastertool hesabıyla giriş (yalnız ayarlar senkronlanır)

## Mimari

```
src/main.js            Electron ana süreci: pencereler, izleme döngüsü, olay günlüğü, IPC
src/provider.js        Sağlayıcı seçimi (Windows: provider-win, Linux: provider-linux)
src/provider-win.js    agent/ içindeki yerel yardımcıyı (mp-agent.exe) başlatır; stdin/stdout üzerinden NDJSON
src/provider-linux.js  Geliştirme ve sınama için /proc tabanlı sağlayıcı (aynı protokol)
src/history.js         Süreç başına halka tampon dizileri (CPU, bellek, G/Ç, ağ, GPU)
src/tree.js            Süreç ağacı ve fark (başlayan / sonlanan) hesabı
src/account.js, sso.js Mastertool hesabı (giriş, ayar senkronu, tek oturum)
src/i18n.js            Çeviri sözlüğü (8 dil)
src/renderer/          Arayüz: süreç tablosu (app.js), ayrıntı bölmesi (detail.js), grafikler (charts.js), hex (hex.js),
                       ağ (network.js; akış çözümleme netparse.js, içerik tanıma netsmart.js, çizim netrender.js)
agent/                 Yerel yardımcı: C# / .NET 8 NativeAOT, win-x64 (Win32 / NT API çağrıları)
docs/agent-protocol.md Arayüz ↔ yardımcı protokolü (v1)
```

Yardımcı bağlantı kurmaz, veri göndermez ve dosya yazmaz; yalnız ana sürecin sorduğu komutlara yanıt verir. Süreç listesi,
dosya yolları, pencere görüntüleri, bellek içeriği, ağ içeriği ve olay günlüğü bilgisayardan dışarı gönderilmez; hesapla
yalnız ayarlar (tema, dil, görünüm) senkronlanır.

Ağ izleme açılışta **kapalıdır**; kullanıcı Ağ sekmesinden başlatır (yönetici hakkı gerekir). Açıkken yardımcı yalnız bu
bilgisayarın kendi arayüzlerinden geçen paketleri okur (ham soket, sürücü kurulmaz, ağ kartı karışık kipe alınmaz).
Yakalanan içerik yardımcının belleğindeki sınırlı bir halkada (en çok 16 MB) tutulur, diske yazılmaz. Yakalanan HTML ve SVG
çalıştırılmaz, yalnız kaynak olarak gösterilir. Şifreli (TLS) trafik şifreli görünür; uygulama araya girmez, çözmez.

## Geliştirme

```bash
npm ci
npm test                 # birim sınamaları (node --test)
npm start                # uygulamayı çalıştırır
```

Windows'ta yerel yardımcı ayrıca derlenir (.NET 8 SDK gerekir):

```powershell
dotnet publish agent/MasterProcess.Agent.csproj -c Release -r win-x64 -o agent-out
agent-out\mp-agent.exe --selftest
npm run dist             # dist\Master-Process-Setup-<sürüm>.exe ve dist\Master-Process-Portable-<sürüm>.exe
```

Uçtan uca sınama ve tanıtım görüntüleri gerçek uygulamayı bu makinenin gerçek süreçleriyle çalıştırır:

```bash
npm run e2e -- --shots shots/e2e
npm run screenshots -- shots/promo --langs tr,en
```

## Yayın

`v<sürüm>` etiketi gönderilince `.github/workflows/release.yml` Windows'ta derler, sınar (birim, yardımcı, kurulum,
uçtan uca), GitHub Release'e ekler ve `scripts/upload-mastertool.sh` ile mastertool.download'a yükler
(depo secret'ı `MASTERPROCESS_RELEASE_KEY`; tanımlı değilse yükleme adımı atlanır).

## Bilinen sınırlar

- Süreç "disk" değerleri Windows'un süreç G/Ç sayaçlarıdır; dosya, ağ ve aygıt G/Ç'sini birlikte içerir.
- Korumalı süreçlerin ve başka kullanıcıların süreçlerinin ayrıntıları yönetici olarak çalıştırılmadıkça okunamaz;
  bazı sistem süreçleri yönetici olarak da okunamaz.
- Ağ içeriği ve süreç başına ağ hızı yalnız IPv4 içindir; IPv6 bağlantıları listelenir ama sayaçları ve içeriği yoktur.
  Ağ hızları izleme açıkken ölçülür. HTTPS gibi şifreli bağlantıların içeriği okunamaz (yalnız TLS kaydı tanınır).
- Windows Güvenlik Duvarı açıkken dışarıdan **gelen** veri, uygulama için gelen izin kuralı yoksa yakalanamaz (giden veri ve
  127.0.0.1 trafiği kuralsız yakalanır). Kuralı uygulama yalnız kullanıcı Ağ sekmesindeki düğmeye basınca ekler; aynı yerden
  kaldırılır, kurulu sürümün kaldırıcısı da siler. Taşınabilir sürüm başka klasöre taşınırsa kural eski yolu gösterir;
  uygulama bunu kural yok sayar, yeniden eklenmesi gerekir.
- Disk yüzeyi birimin küme bit eşlemini gösterir (yönetici hakkı gerekebilir; ağ sürücülerinde ve desteklemeyen dosya
  sistemlerinde gösterilmez); fiziksel plak / hücre yerleşimi değildir.
- Donanım hızlandırmalı (DWM yüzeyli) bazı pencerelerin görüntüsü siyah gelebilir.
- Grafikler ve tarihçe yalnız uygulama açıkken tutulur; kapatınca saklanmaz. 1.0.0 sürümünün `history.db` dosyası kullanılmaz.
- Yalnız Windows 10 / 11 x64. ARM64 üzerinde sınanmadı.

## Lisans

MIT — bkz. [LICENSE.txt](LICENSE.txt)
