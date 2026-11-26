# Master Process — geliştirme notları

Windows süreç yöneticisi; Mastertool ailesinin Electron kalıbıyla yazılmıştır (bkz. README.md → Mimari).

## Kurallar

- Arayüz dili Türkçe kaynaklıdır; her metin `src/i18n.js` içinde 8 dilde (tr, en, fr, de, es, ar, zh, ru) bulunur.
  `test/i18n.test.js` eksik anahtarı ve yer tutucu uyuşmazlığını yakalar.
- Süreç verisi yalnız sağlayıcıdan gelir (`src/provider-*.js`); arayüz `window.api.query(cmd, args)` ile sorar.
  Protokol değişikliği `docs/agent-protocol.md`, `agent/Protocol.cs`, `src/provider-linux.js` ve
  `test-fixtures/fake-agent.js` içinde birlikte yapılır.
- Yardımcı (`agent/`) NativeAOT derlenir: yansıma ve dinamik kod yok; JSON elle yazılır.
- Yardımcı ağa çıkmaz, dosya yazmaz. Süreç listesi, yollar, pencere görüntüleri, bellek içeriği hesaba gönderilmez.
- Sınamalarda ve ekran görüntülerinde veri taklit edilmez; eylemler (askıya al, sonlandır) yalnız betiğin başlattığı
  `test-fixtures/target.js` süreci üzerinde denenir.
- Renkler ve ölçüler `src/renderer/mastertool.css` değişkenlerinden alınır; gece ve gündüz teması birlikte denetlenir.

## Komutlar

```bash
npm test                                  # birim sınamaları
npm run e2e -- --shots shots/e2e          # gerçek pencereyle uçtan uca (Linux'ta DISPLAY gerekir)
npm run screenshots -- shots/promo        # tanıtım görüntüleri (Windows'ta alınanlar yayımlanır)
```

Yayın: `package.json` sürümü + `v<sürüm>` etiketi → `.github/workflows/release.yml`.
