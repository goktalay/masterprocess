# mp-agent

Master Process arayüzünün Windows'taki yerel yardımcısı. Arayüz onu çocuk süreç olarak başlatır;
stdin/stdout üzerinden satır başına bir JSON nesnesi (NDJSON) konuşulur. Sözleşme: [`docs/agent-protocol.md`](../docs/agent-protocol.md).

## Derleme

Windows + .NET 8 SDK + "Desktop development with C++" (NativeAOT bağlayıcısı için) gerekir.

```
dotnet publish agent/MasterProcess.Agent.csproj -c Release -r win-x64 -o agent-out
agent-out\mp-agent.exe --version
agent-out\mp-agent.exe --selftest
pwsh scripts/agent-session-test.ps1 -Agent agent-out\mp-agent.exe
```

Çıktı tek dosyadır (`mp-agent.exe`, NativeAOT, .NET çalışma zamanı gerekmez). CI: `.github/workflows/agent-ci.yml`
(`v2-agent` dalına her itmede derler, iki sınamayı koşar, exe'yi `mp-agent` adlı artifact olarak yükler).

## Çalıştırma

| Çağrı | Davranış |
| --- | --- |
| `mp-agent.exe` | Sunucu kipi: stdin'den istek satırı okur, stdout'a yanıt satırı yazar; stdin kapanınca 0 ile çıkar. |
| `mp-agent.exe --selftest` | Tüm komutları kendi süreci üzerinde koşar; komut başına `PASS`/`FAIL` satırı, çıkış 0/1. |
| `mp-agent.exe --version` | Sürüm satırı. |

Tanılama iletileri yalnız stderr'e yazılır; stdout'ta protokol dışı hiçbir şey yoktur.

## Dosya düzeni

| Dosya | İçerik |
| --- | --- |
| `Program.cs` | Giriş noktası, istek döngüsü, dağıtıcı, `hello` |
| `Protocol.cs` | Hata kodları, istek alanı okuma, onaltılık / zaman yardımcıları |
| `Native.cs` | Tüm P/Invoke bildirimleri ve yapılar (blittable imzalar) |
| `Snapshot.cs` | Süreç tablosu (`NtQuerySystemInformation`) ve `snapshot` |
| `Gpu.cs` | GPU sayaçları (PDH), bağdaştırıcı listesi (DXGI), `gpudetail` |
| `Detail.cs` | `detail`, `modules`, pencere listesi |
| `Memory.cs` | `memmap`, `readmem`, aygıt yolu → sürücü harfi çevirisi |
| `Handles.cs` | `handles` (sistem tanıtıcı tablosu, zaman aşımlı ad sorgusu) |
| `FileMap.cs` | `filemap`, `readfile` |
| `Capture.cs` | `capture` (`PrintWindow` → BGRA) |
| `Control.cs` | `kill`, `suspend`, `resume`, `priority` |
| `SelfTest.cs` | `--selftest` |
| `Directory.Build.props` | Bilerek boş: depo kökündeki WPF ayarlarının bu projeye miras kalmasını keser |

## Tasarım kuralları

- Yansıma tabanlı JSON, WMI, System.Drawing ve COM birlikte çalışma katmanı kullanılmaz (NativeAOT + kırpma uyumu).
  Çıktı `Utf8JsonWriter` ile elle yazılır, giriş `JsonDocument` ile okunur; DXGI çağrıları ham vtable üzerindendir.
- Bir komutun hatası yalnız o yanıtı etkiler; yardımcı çalışmayı sürdürür.
- `snapshot` oranları (cpu, G/Ç) bir önceki `snapshot` çağrısına göre hesaplanır; ilk çağrıda 0'dır.

## Bilinen sınırlar

- Yalnız win-x64. Korumalı süreçlerde (PPL, System) ayrıntı alanlarının çoğu okunamaz: `detail` kısmi veri döndürür,
  `modules` / `memmap` / `readmem` / `handles` `access` ile yanıtlar. Yönetici olmadan başka kullanıcıların süreçleri de böyledir.
- `handles`: boru ve benzeri eşzamanlı tanıtıcılarda ad sorgusu askıda kalabildiği için bilinen riskli erişim maskeleri
  (`0x0012019f`, `0x001a019f`, `0x00120189`, `0x00100000`) atlanır; bu, yazma erişimiyle açılmış bazı sıradan dosyaları da
  `files` listesinin dışında bırakır (tür sayımı `counts` bundan etkilenmez). Sorgu başına 150 ms, komut başına 5 sn bütçe vardır;
  bütçe aşılırsa `truncated: true`.
- `memmap`: 200 000 bölgeden sonrası kesilir (`truncated: true`). Çalışma kümesi okunamazsa `wsPages` -1 olur.
- `filemap`: ağ sürücülerinde ve küme haritası vermeyen dosya sistemlerinde `unsupported`; en çok 20 000 extent.
- `capture`: simge durumundaki pencere için görüntü üretilmez (`w`/`h` 0). Bazı korumalı / donanım yüzeyli pencereler siyah gelebilir.
- GPU alanları yalnız "GPU Engine" / "GPU Process Memory" sayaçları olan sistemlerde dolar; yoksa değerler 0, `gpudetail` `unsupported`.
- 32 bit süreçlerde `modules` 32 bit modülleri de listeler, `cmdline` okunur; ARM64 üzerinde öykünmeyle çalışma sınanmadı.
