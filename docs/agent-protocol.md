# mp-agent protokolü (v1)

Master Process 2.x iki parçadır: Electron arayüzü (Mastertool kalıbı) ve Windows'ta süreç verisini okuyan yerel
yardımcı `mp-agent.exe` (C#, .NET 8, NativeAOT, x64). Arayüz yardımcıyı çocuk süreç olarak başlatır ve
stdin/stdout üzerinden satır başına bir JSON (NDJSON, UTF-8, BOM yok) ile konuşur. Yardımcı bağlantı kurmaz, veri
göndermez, dosya yazmaz. Ağ izleme (`netcap`) açıldığında yalnız bu bilgisayarın kendi arayüzlerinden geçen paketleri
**okur**; yakalanan içerik yardımcının belleğindeki sınırlı bir halkada tutulur ve yalnız arayüze (stdout) verilir.

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
{"agent":"1.1.0","protocol":1,"pid":1234,"elevated":false,"debugPrivilege":false,"arch":"x64",
 "os":"10.0.22631","cpuCount":8,"pageSize":4096,"totalPhys":17179869184,
 "gpuCounters":true,"net":true,
 "gpus":[{"luid":"0000000000012a4f","name":"NVIDIA GeForce RTX 3060","dedicated":12884901888,"shared":8589934592,"software":false}]}
```
`gpuCounters`: süreç başına GPU sayaçları (PDH "GPU Engine" / "GPU Process Memory") okunabiliyor mu.
`gpus`: DXGI bağdaştırıcıları (yoksa boş dizi). Yardımcı açılışta SeDebugPrivilege'i etkinleştirmeyi dener.
`net`: ağ komutları (`netcap`, `netconns`, `netwatch`, `netstream`) var mı.

### snapshot
`{"id":2,"cmd":"snapshot"}` → tüm süreçlerin anlık görüntüsü. Oranlar, yardımcının **önceki snapshot çağrısına**
göre hesaplanır (ilk çağrıda oranlar 0).
```json
{"t":1795730000000,
 "sys":{"cpu":12.5,"memTotal":17179869184,"memAvail":8123456789,"commitTotal":1,"commitLimit":2,
        "ioRead":123456,"ioWrite":65432,"gpu":3.2,"gpuDedicated":123,"gpuShared":456,
        "netRx":20480,"netTx":4096,"netCap":false},
 "cols":["pid","ppid","name","cpu","ws","priv","ioRead","ioWrite","gpu","gpuDed","gpuShr","threads","handles","start","session","netRx","netTx"],
 "procs":[[4,0,"System",0.1,151552,45056,0,0,0,0,0,180,3400,1795700000000,0,0,0], ...]}
```
- `cpu`: süreç için yüzde, tüm mantıksal işlemcilere bölünmüş (0–100). `sys.cpu`: sistem geneli meşguliyet.
- `ws`: çalışma kümesi (fiziksel RAM, bayt). `priv`: özel bayt (commit).
- `ioRead`/`ioWrite`: bayt/sn; sürecin **tüm** G/Ç'si (dosya + ağ + aygıt; Windows süreç G/Ç sayaçları).
  `sys.ioRead/ioWrite` süreçlerin toplamıdır.
- `gpu`: yüzde (0–100): motor türü başına toplanır, türler arasında en büyüğü alınır. `gpuDed`/`gpuShr`: bayt.
  Sayaç yoksa 0.
- `netRx`/`netTx` (süreç): bayt/sn, yakalanan paketlerin taşıma katmanı yükünden; **yalnız ağ izleme açıkken**
  (`sys.netCap: true`) dolar, kapalıyken 0'dır. IPv6 trafiği sayılmaz (bkz. `netcap`).
  `sys.netRx`/`sys.netTx`: sistem geneli bayt/sn, ağ arayüzü sayaçlarından (geri döngü hariç); izleme gerektirmez.
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
{"path":"C:\\Users\\ali\\a.txt","volume":"C:\\","clusterSize":4096,"sectorSize":512,"totalClusters":62499999,"freeClusters":1,
 "size":1048576,"extents":[[786432,200],[912000,56]],"fragments":2,"resident":false}
```
`extents`: [başlangıç LCN, küme sayısı]; seyrek/sıkıştırılmış boşluklar (LCN = -1) atlanır. Veri MFT kaydının
içindeyse (çok küçük dosya) `resident:true`, `extents:[]`. Ağ yolu / desteklemeyen dosya sistemi: `unsupported`.
En çok 20 000 extent (`truncated:true`). `sectorSize`: birimin mantıksal sektör boyutu (bayt) —
arayüz küme numarasını sektör numarasına bununla çevirir.

### volmap
`{"cmd":"volmap","path":"C:\\Users\\ali\\a.txt","cells":4096}` → dosyanın bulunduğu birimin doluluk haritası.
```json
{"volume":"C:\\","clusterSize":4096,"sectorSize":512,"totalClusters":62499999,"usedClusters":31250000,"cells":4096,"b64":"..."}
```
Birimin küme bit eşlemi (FSCTL_GET_VOLUME_BITMAP) `cells` hücreye indirgenir (64–16384, varsayılan 4096): her
hücre birimin ardışık bir küme aralığıdır, `b64` içindeki bayt o aralıktaki dolu küme oranıdır (0 = boş,
255 = tümü dolu). Birim hücre sayısından az kümeye sahipse `cells` küme sayısına iner. Yalnız sürücü harfli
yerel birimler; ağ yolu / bit eşlem vermeyen dosya sistemi `unsupported`, yetki yoksa `access`. Linux sağlayıcısı
`unsupported` döner (arayüz bu durumda yalnız dosyanın parçalarını çizer).

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

### netcap
`{"cmd":"netcap"}` durumu döndürür; `{"cmd":"netcap","on":true}` ağ izlemeyi açar, `"on":false` kapatır (izleme
kümesi ve halka boşaltılır). Açılışta izleme **kapalıdır**; kullanıcı açmadıkça hiçbir paket okunmaz.
```json
{"capture":true,"reason":"ok","elevated":true,
 "ifaces":[{"name":"Ethernet","addr":"192.168.1.20","v":4,"mode":"iplevel","packets":1234},
           {"name":"Loopback Pseudo-Interface 1","addr":"127.0.0.1","v":4,"mode":"iplevel","packets":88,"loopback":true}],
 "errors":[]}
```
- Yöntem: her yerel IPv4 adresi için ham soket + `SIO_RCVALL` (sürücü kurulmaz). Yönetici hakkı gerekir.
  `ifaces[].mode`: `iplevel` (`RCVALL_IPLEVEL`; ağ kartı karışık kipe **alınmaz**, yalnız bu bilgisayarın IP
  yığınından geçen paketler) ya da bu kip reddedilirse `on` (`RCVALL_ON`).
- `reason`: `ok` (açık), `off` (kapalı), `elevation` (yönetici hakkı yok), `nonet` (dinlenecek adres yok), `failed`
  (soket açılamadı; `error` Winsock kodu, `errors` adres başına tanılama satırları). Linux sağlayıcısı her zaman
  `{"capture":false,"reason":"unsupported"}` döner.
- **Sınırlar:** IPv6 paketleri yakalanmaz (bağlantılar `netconns`'ta listelenir, sayaçları ve içeriği yoktur).
  Windows Güvenlik Duvarı açıkken dışarıdan **gelen** paketler ham sokete ancak uygulama için gelen izin kuralı
  varsa ulaşır; kuralı arayüz yalnız kullanıcının açık eylemiyle ekler. 127.0.0.1 trafiği kuralsız yakalanır.
  Şifreli (TLS) trafik şifreli görünür; yardımcı araya girmez, çözmez.

### netconns
`{"cmd":"netconns","pid":1234}` (ya da `"pids":[...]` en çok 256, ya da `"all":true`) → bağlantılar ve dinlenen portlar.
```json
{"capture":true,
 "conns":[{"pid":1234,"proto":"tcp","v":4,"local":"192.168.1.20","lport":50123,"remote":"93.184.216.34","rport":443,
           "state":"established","rx":18234,"tx":912,"flow":17},
          {"pid":1234,"proto":"tcp","v":4,"local":"0.0.0.0","lport":8080,"remote":"","rport":0,"state":"listen","rx":0,"tx":0},
          {"pid":1234,"proto":"udp","v":4,"local":"0.0.0.0","lport":5353,"remote":"","rport":0,"state":"bound","rx":0,"tx":0}],
 "truncated":false}
```
- Kaynak: işletim sisteminin TCP / UDP sahiplik tabloları (IPv4 + IPv6); izleme gerektirmez.
- `state` (TCP): `listen`, `syn_sent`, `syn_rcvd`, `established`, `fin_wait1`, `fin_wait2`, `close_wait`, `closing`,
  `last_ack`, `time_wait`, `closed`, `delete_tcb`, `unknown`. UDP uçları `bound`. Tabloda satırı kalmamış ama son
  60 sn içinde yakalanmış akışlar `active` (UDP, uzak ucu yakalamadan bilinir) ya da `closed` (TCP) olarak eklenir.
- `rx`/`tx`: izleme açıldığından beri o bağlantıda yakalanan yük baytı (izleme kapalıysa 0). `flow`: bağlantının
  `netstream` parçalarındaki akış kimliği (yakalanmış veri varsa).
- En çok 2000 satır (`truncated:true`).

### netwatch
`{"cmd":"netwatch","pid":1234}` ya da `{"cmd":"netwatch","pids":[1234,5678],"reset":true}` → içeriği saklanacak
süreçleri belirler: `{"watch":[1234,5678],"capture":true,"next":412}`.
- Yalnız izleme kümesindeki süreçlerin yükü halkaya yazılır; diğer süreçler için yalnız bayt sayılır.
- `pids: []` izlemeyi bırakır ve halkayı boşaltır. Küme değişince yarım kalan TCP sıralama durumu sıfırlanır;
  `reset:true` halkayı da boşaltır. `next`: o an halkadaki son parçanın sıra numarası (`netstream.since` için).

### netstream
`{"cmd":"netstream","since":412,"max":262144}` → `since`'ten sonraki parçalar.
```json
{"watch":[1234],"capture":true,"now":86400123,"first":300,"dropped":0,
 "chunks":[{"seq":413,"t":86400100,"pid":1234,"flow":17,"dir":"out","proto":"tcp","v":4,
            "local":"192.168.1.20","lport":50123,"remote":"93.184.216.34","rport":80,"f":0,"b64":"R0VUIC8gSFRUUC8xLjENCg=="}],
 "next":413,"more":false}
```
- Parça = bir akışın bir yönündeki ardışık yük baytları. TCP parçaları sıra numarasına göre **sıralanmış ve
  yinelenenleri atılmış** olarak verilir; UDP'de her datagram bir parçadır. `dir`: sürece göre `out` (giden) / `in`
  (gelen). İki ucu da bu bilgisayarda olan (geri döngü) paket iki sürece ayrı ayrı yazılır: gönderende `out`,
  alanda `in`.
- `f` bayrakları: 1 akış başı (SYN), 2 FIN, 4 RST, 8 **boşluk** (bu parçadan önce kaçan bayt var; arayüz iletiyi
  bölünmüş sayar).
- `t` ve `now` aynı tekdüze saattir (ms, başlangıcı keyfi); arayüz duvar saatini `Date.now() - (now - t)` ile bulur.
- `max` yanıttaki toplam yük baytı sınırıdır (4096–1048576, varsayılan 262144); en çok 2000 parça. Sınır dolarsa
  `more:true`; arayüz `since = next` ile sürdürür.
- Halka sınırlıdır (32768 parça / 16 MB); taşınca en eski parçalar düşer. `first`: halkadaki en eski sıra
  numarası, `dropped`: düşen parça sayısı. Yardımcı yeniden başlarsa sıra numaraları 1'den başlar
  (`next < since` görülürse arayüz baştan okur).

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
- `mp-agent.exe --netdiag` — ağ tablolarının (arayüzler, TCP / UDP sahiplik tabloları) ham dökümü; izleme açmaz.

Ağ komutları ayrıca `scripts/agent-net-test.ps1` ile sınanır (PowerShell 7, yönetici): betik kendi sürecini izlemeye
alır, kendi trafiğini üretir (127.0.0.1 üzerinde TCP / UDP, şifresiz HTTP, DNS) ve yardımcının bu trafiği doğru
süreçle, doğru yönde ve gönderilenlerle bayt bayt aynı içerikle verdiğini doğrular. Trafiği yardımcı değil betik üretir.
