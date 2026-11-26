# mp-agent protokolü (v1)

Master Process 2.x iki parçadır: Electron arayüzü (Mastertool kalıbı) ve Windows'ta süreç verisini okuyan yerel
yardımcı `mp-agent.exe` (C#, .NET 8, NativeAOT, x64). Arayüz yardımcıyı çocuk süreç olarak başlatır ve
stdin/stdout üzerinden satır başına bir JSON (NDJSON, UTF-8, BOM yok) ile konuşur. Yardımcı ağa çıkmaz, dosya yazmaz.

Aynı protokolü Linux'ta `src/provider-linux.js` (procfs) uygular; arayüz iki sağlayıcıyı ayırt etmez.

## Çerçeve

- İstek : `{"id":<int>,"cmd":"<ad>", ...argümanlar}` + `\n`
- Yanıt : `{"id":<int>,"ok":true,"data":<nesne>}` + `\n`
- Hata  : `{"id":<int>,"ok":false,"err":"<kod>","msg":"<insan için kısa İngilizce açıklama>"}` + `\n`
- Hata kodları: `access` (yetki yok / korumalı süreç), `gone` (süreç ya da pencere artık yok), `bad_request`
  (eksik/yanlış argüman, bilinmeyen komut), `unsupported` (bu sistemde yok), `timeout`, `failed` (diğer; `msg`
  Win32/NTSTATUS kodunu içerir).
- İstekler sırayla işlenir; yanıt sırası istek sırasıdır. Yardımcı kendiliğinden satır göndermez.
- Geçersiz JSON satırı: `{"id":0,"ok":false,"err":"bad_request",...}`. stdin kapanınca yardımcı 0 ile çıkar.
- stdout'a yalnız protokol satırları yazılır; tanılama stderr'e.
- Adresler ve tanıtıcılar (handle, hwnd, taban adres, LUID) **onaltılık dizgedir**, `0x` öneki olmadan, küçük harf
  (ör. `"7ff6a1b20000"`). Boyutlar/baytlar sayı (JSON number; 2^53 altı). Zamanlar Unix epoch **milisaniye**.
- İkili veri base64 (standart alfabe, dolgulu).

## Komutlar

### hello
`{"id":1,"cmd":"hello"}` →
```json
{"agent":"1.0.0","protocol":1,"pid":1234,"elevated":false,"debugPrivilege":false,"arch":"x64",
 "os":"10.0.22631","cpuCount":8,"pageSize":4096,"totalPhys":17179869184,
 "gpuCounters":true,
 "gpus":[{"luid":"0000000000012a4f","name":"NVIDIA GeForce RTX 3060","dedicated":12884901888,"shared":8589934592,"software":false}]}
```
`gpuCounters`: süreç başına GPU sayaçları (PDH "GPU Engine" / "GPU Process Memory") okunabiliyor mu.
`gpus`: DXGI bağdaştırıcıları (yoksa boş dizi). Yardımcı açılışta SeDebugPrivilege'i etkinleştirmeyi dener.

### snapshot
`{"id":2,"cmd":"snapshot"}` → tüm süreçlerin anlık görüntüsü. Oranlar, yardımcının **önceki snapshot çağrısına**
göre hesaplanır (ilk çağrıda oranlar 0).
```json
{"t":1795730000000,
 "sys":{"cpu":12.5,"memTotal":17179869184,"memAvail":8123456789,"commitTotal":1,"commitLimit":2,
        "ioRead":123456,"ioWrite":65432,"gpu":3.2,"gpuDedicated":123,"gpuShared":456},
 "cols":["pid","ppid","name","cpu","ws","priv","ioRead","ioWrite","gpu","gpuDed","gpuShr","threads","handles","start","session"],
 "procs":[[4,0,"System",0.1,151552,45056,0,0,0,0,0,180,3400,1795700000000,0], ...]}
```
- `cpu`: süreç için yüzde, tüm mantıksal işlemcilere bölünmüş (0–100). `sys.cpu`: sistem geneli meşguliyet.
- `ws`: çalışma kümesi (fiziksel RAM, bayt). `priv`: özel bayt (commit).
- `ioRead`/`ioWrite`: bayt/sn; sürecin **tüm** G/Ç'si (dosya + ağ + aygıt; Windows süreç G/Ç sayaçları).
  `sys.ioRead/ioWrite` süreçlerin toplamıdır.
- `gpu`: yüzde (0–100): motor türü başına toplanır, türler arasında en büyüğü alınır. `gpuDed`/`gpuShr`: bayt.
  Sayaç yoksa 0.
- `start`: başlangıç zamanı (ms), bilinmiyorsa 0. `ppid` yeniden kullanılmışsa (ebeveynin başlangıcı çocuğunkinden
  sonra) 0 verilir. PID 0 "System Idle Process" listede **yer almaz**.
- `cols` her yanıtta yer alır; `procs` satırları aynı sırada.

### detail
`{"cmd":"detail","pid":1234}` →
```json
{"pid":1234,"name":"notepad.exe","path":"C:\\Windows\\System32\\notepad.exe","cmdline":"notepad a.txt",
 "user":"PC\\ali","start":1795700000000,"priority":"normal","arch":"x64","elevated":false,"suspended":false,
 "ppid":4321,
 "counters":{"handles":210,"gdi":35,"user":22,"pageFaults":12345,"peakWs":1,"ws":1,"priv":1,"virt":1,
             "ioReadOps":1,"ioWriteOps":1,"ioOtherOps":1,"ioReadBytes":1,"ioWriteBytes":1,"ioOtherBytes":1,
             "kernelMs":120,"userMs":450},
 "file":{"company":"Microsoft Corporation","description":"Notepad","version":"11.2302.26.0","size":201216,"modified":1795000000000},
 "threads":[{"tid":5678,"cpuMs":120,"priority":8,"state":"wait","start":1795700000000}],
 "windows":[{"hwnd":"1a0b3c","title":"a.txt - Notepad","cls":"Notepad","visible":true,"minimized":false,"rect":[100,80,900,600]}]}
```
Okunamayan alanlar `null` (dizgeler) ya da boş dizi olur; süreç hiç açılamıyorsa bile snapshot'tan bilinenler
(ad, sayaçların bir kısmı) döner — komut yalnız süreç yoksa `gone` verir.
`priority`: `idle|below|normal|above|high|realtime`. `arch`: `x64|x86|arm64`. `threads[].state`:
`run|ready|wait|other`. `windows`: sürecin üst düzey pencereleri (görünmeyenler dahil, başlıksız araç pencereleri
hariç tutulabilir); `rect` = [x, y, genişlik, yükseklik].

### modules
`{"cmd":"modules","pid":1234}` → `{"modules":[{"base":"7ff6a1b20000","size":204800,"path":"C:\\...\\notepad.exe"}]}`

### memmap
`{"cmd":"memmap","pid":1234}` → sanal adres uzayı + fiziksel RAM'de bulunan sayfalar.
```json
{"pageSize":4096,"min":"10000","max":"7ffffffeffff",
 "cols":["base","size","state","protect","type","wsPages","name"],
 "regions":[["7ff6a1b20000",4096,1,2,3,1,"C:\\Windows\\System32\\notepad.exe"], ...],
 "totals":{"commit":1,"reserve":1,"free":1,"image":1,"mapped":1,"private":1,"ws":1}}
```
- `state`: 1 commit, 2 reserve, 3 free. `type`: 0 yok (free), 1 private, 2 mapped, 3 image.
- `protect`: Win32 PAGE_* değeri (commit değilse 0). `wsPages`: bölgenin şu an çalışma kümesinde olan sayfa
  sayısı (bilinmiyorsa -1). `name`: image/mapped bölgeler için dosya yolu, yoksa `""`.
- Bitişik ve aynı (state, protect, type, name) özellikli bölgeler **birleştirilmez**; VirtualQueryEx ne verdiyse.
  Free bölgeler de listelenir. Bölge sayısı 200 000'i aşarsa `truncated:true` ile kesilir.

### readmem
`{"cmd":"readmem","pid":1234,"addr":"7ff6a1b20000","len":4096}` → `{"addr":"7ff6a1b20000","len":4096,"b64":"..."}`
`len` en çok 65536. Kısmi okuma: `len` gerçekten okunan bayt sayısıdır; hiç okunamazsa `access`.

### handles
`{"cmd":"handles","pid":1234}` →
```json
{"counts":{"File":42,"Key":18,"Event":60},
 "files":[{"h":"1f4","path":"C:\\Users\\ali\\a.txt","kind":"file","size":1024},
          {"h":"2a0","path":"C:\\Windows\\System32","kind":"dir","size":0}]}
```
`files`: yalnız disk dosyaları ve klasörler (`kind`: `file|dir`); boru/aygıt/ağ tanıtıcıları yalnız `counts`'ta.
Adı okunamayan disk tanıtıcıları atlanır. Yardımcı, boru tanıtıcılarında askıda kalmamak için ad sorgusunu
zaman aşımıyla yapar; komutun tamamı en çok ~5 sn sürer, aşarsa o ana dek bulunanlar `truncated:true` ile döner.

### filemap
`{"cmd":"filemap","path":"C:\\Users\\ali\\a.txt"}` → dosyanın birim üzerindeki fiziksel yerleşimi.
```json
{"path":"C:\\Users\\ali\\a.txt","volume":"C:\\","clusterSize":4096,"totalClusters":62499999,"freeClusters":1,
 "size":1048576,"extents":[[786432,200],[912000,56]],"fragments":2,"resident":false}
```
`extents`: [başlangıç LCN, küme sayısı]; seyrek/sıkıştırılmış boşluklar (LCN = -1) atlanır. Veri MFT kaydının
içindeyse (çok küçük dosya) `resident:true`, `extents:[]`. Ağ yolu / desteklemeyen dosya sistemi: `unsupported`.
En çok 20 000 extent (`truncated:true`).

### readfile
`{"cmd":"readfile","path":"C:\\...","offset":0,"len":4096}` → `{"offset":0,"len":4096,"size":1048576,"b64":"..."}`
`len` en çok 65536. Dosya paylaşım kipiyle (okuma+yazma+silme paylaşımı) açılır; açılamıyorsa `access`.

### capture
`{"cmd":"capture","hwnd":"1a0b3c","maxW":1280}` → pencerenin o anki görüntüsü.
```json
{"hwnd":"1a0b3c","title":"a.txt - Notepad","srcW":1920,"srcH":1080,"w":1280,"h":720,"minimized":false,"format":"bgra","b64":"..."}
```
PrintWindow (PW_RENDERFULLCONTENT). `b64`: yukarıdan aşağıya, satır başına `w*4` bayt, BGRA (alfa 255).
`maxW` (varsayılan 1280, 64–3840): kaynak daha genişse oran korunarak küçültülür. Simge durumundaki pencere
için `minimized:true` döner ve görüntü alınmaz (`w:0,h:0,b64:""`). Pencere yoksa `gone`.

### gpudetail
`{"cmd":"gpudetail","pid":1234}` →
```json
{"engines":[{"luid":"0000000000012a4f","eng":0,"type":"3D","util":12.5}],
 "mem":[{"luid":"0000000000012a4f","dedicated":123456,"shared":7890}]}
```
Sayaç yoksa `unsupported`.

### kill / suspend / resume / priority
- `{"cmd":"kill","pid":1234}` → `{"done":true}` (TerminateProcess, çıkış kodu 1)
- `{"cmd":"suspend","pid":1234}` / `{"cmd":"resume","pid":1234}` → `{"done":true}` (NtSuspendProcess / NtResumeProcess)
- `{"cmd":"priority","pid":1234,"value":"below"}` → `{"done":true}` (`idle|below|normal|above|high`; `realtime` reddedilir: `bad_request`)

Yardımcının kendi PID'i, PID 0 ve 4 için bu dört komut `bad_request` döner.

## Komut satırı

- `mp-agent.exe` — protokol sunucusu (stdin/stdout).
- `mp-agent.exe --selftest` — kendi süreci üzerinde tüm komutları çalıştırır, her biri için bir satır
  `PASS <komut> <özet>` / `FAIL <komut> <neden>` yazar; hepsi geçerse 0, değilse 1 ile çıkar. CI bunu koşar.
- `mp-agent.exe --version` — sürüm satırı.
