// Tanıtım ekran görüntüleri: gerçek uygulama (Electron ana süreci + platformun gerçek sağlayıcısı) bu makinenin gerçek
// süreçleriyle çalıştırılır; hiçbir veri taklit edilmez. Görüntülerdeki süreçler görüntünün alındığı makinenin süreçleridir
// (yayın derlemesinde bir Windows sınama makinesi). Seçilen süreç betiğin başlattığı test-fixtures/target.js, pencere
// sekmesinde Windows'un Karakter Eşlem (charmap.exe) penceresidir. Hesap çipindeki e-posta örnek değerdir (sahte hesap sunucusu).
// Ağ görüntülerindeki veri, hedef sürecin kendi alt süreciyle 127.0.0.1 üzerinden yaptığı gerçek HTTP alışverişidir
// (JSON, PNG, HTML); yakalama bu makinenin geri döngü arayüzünden yapılır. Ağ içeriği görüntüleri yalnız Windows'ta alınır.
// Kullanım: node scripts/screenshots.js <çıktı klasörü> [--langs tr,en]
//   Çıktı: <klasör>/<dil>/NN-ad-gece|gunduz.png ve <klasör>/<dil>/manifest.json (yalnız gerçekten alınan görüntüler)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const H = require('./harness');

const OUT = path.resolve(process.argv[2] || 'shots');
const li = process.argv.indexOf('--langs');
const LANGS = (li > 0 ? process.argv[li + 1] : 'tr,en').split(',');
const WIN = process.platform === 'win32';
const W = 1600, HGT = 1000;

const TEXT = {
  tr: {
    'surec-agaci': ['Süreç ağacı ve sistem görünümü', 'Üst–alt ilişkisiyle süreçler, satır içi CPU / bellek / G/Ç / ağ grafikleri ve sistem özeti'],
    'agac-sirali': ['Ağaçta dal yüküne göre sıralama', 'Sütun başlığına tıklanınca kökler ve kardeşler, alt süreçleriyle birlikte toplam yüke göre sıralanır; tümünü aç / tümünü kapat düğmeleri'],
    genel: ['Süreç ayrıntıları', 'Yol, komut satırı, üst süreç, öncelik, sayaçlar ve süreç eylemleri'],
    performans: ['Süreç başına performans grafikleri', 'CPU, bellek ve G/Ç için canlı çizgi grafikler; tepe ve ortalama değerler'],
    bellek: ['Bellek yerleşim haritası', 'Sanal adres alanındaki bölgeler: tür, koruma ve fiziksel bellekte bulunma oranı'],
    'bellek-hex': ['Bellek içeriği: hex görüntüleyici', 'Seçilen bölgenin baytları; canlı yenileme, dizgeler kipi ve adrese gitme'],
    disk: ['Disk: G/Ç ve açık dosyalar', 'Okuma / yazma hızları, tutamaç türleri ve sürecin açık tuttuğu dosyalar'],
    'disk-yerlesim': ['Dosyanın diskteki yerleşimi', 'Seçilen dosyanın birimdeki kümeleri, parça sayısı ve içeriğinin hex dökümü'],
    'disk-yuzey': ['Disk yüzeyi ve dosya parçaları', 'Birimin doluluk haritası üzerinde dosyanın kapladığı kümeler; her parçanın başlangıç kümesi, sektörü ve boyutu'],
    ag: ['Ağ: bağlantılar ve portlar', 'Sürecin indirme / yükleme hızı, açık bağlantıları ve dinlediği portlar; porta göre süzme'],
    'ag-akilli': ['Ağ: akıllı görünüm', 'Giden ve gelen veri ayrı panellerde; HTTP iletileri ayrıştırılır, JSON sözdizimi renklendirilir, sıkıştırılmış gövdeler açılır'],
    'ag-resim': ['Ağ: resim önizleme', 'Gönderilen ya da alınan resimler akışın içinde önizlenir; tür, boyut ve çözünürlük bilgisiyle'],
    'ag-hex': ['Ağ: hex dökümü', 'Aynı baytlar hex, düz metin, HTML / XML kaynağı ya da Base64 olarak; duraklatma ve temizleme'],
    gpu: ['GPU kullanımı', 'Süreç başına GPU motoru kullanımı ve ayrılmış / paylaşılan GPU belleği'],
    pencere: ['Pencere görüntüsü', 'Seçilen sürecin pencereleri ve pencerenin o anki görüntüsü'],
    moduller: ['Yüklenen modüller', 'Sürecin yüklediği DLL ve çalıştırılabilir dosyalar; taban adresi ve boyut'],
    'is-parcaciklari': ['İş parçacıkları', 'İş parçacığı başına CPU süresi, öncelik ve durum'],
    tarihce: ['Tarihçe', 'Uygulama açıkken başlayan ve sonlanan süreçler; ömür, tepe CPU ve tepe bellek'],
    ayarlar: ['Ayarlar', 'Tema, dil, başlangıç ve sistem tepsisi seçenekleri'],
  },
};

const sleep = H.sleep;

async function run(lang, theme, only) {
  const dir = path.join(OUT, lang);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = theme === 'dark' ? 'gece' : 'gunduz';
  const acct = await H.accountServer();
  const target = await H.startTarget();
  let charmap = null;
  if (WIN && !only) { try { charmap = spawn('charmap.exe', [], { stdio: 'ignore' }); } catch { charmap = null; } }
  const app = await H.launch({ api: acct.url, settings: { language: lang, appTheme: theme } });
  const taken = [];
  const cleanup = async () => {
    target.stop();
    if (charmap && charmap.pid) { try { execFileSync('taskkill', ['/pid', String(charmap.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { /* kapanmış */ } }
    await app.close();
    acct.server.close();
  };
  try {
    if (!app.browser) throw new Error('CDP bağlanamadı\n' + app.tail());
    const { main, errors } = await H.signIn(app, { width: W, height: HGT });
    await main.waitForSelector('#ptRows .pr', { timeout: 30000 });
    const shot = async (n, key) => {
      if (only && !only.includes(key)) return;
      const file = `${String(n).padStart(2, '0')}-${key}-${suffix}.png`;
      await main.screenshot({ path: path.join(dir, file) });
      taken.push({ file, key, theme });
      console.log(`  ${lang}/${file}`);
    };
    const want = (key) => !only || only.includes(key);
    const tab = async (id, wait = 1200) => { await main.click(`.d-tabs [data-tab="${id}"]`); await main.waitForTimeout(wait); };
    const hasMsg = () => main.evaluate(() => !!document.querySelector('.d-body > .d-msg, .d-body .d-msg'));
    const select = async (pid) => {
      for (let i = 0; i < 30; i++) { if (await main.evaluate((p) => APP.selectPid(p), pid)) return true; await main.waitForTimeout(500); }
      return false;
    };

    // Tarihçede görünecek birkaç kısa ömürlü süreç (betiğin kendi başlattıkları)
    for (const ms of [2500, 6000, 11000]) spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });

    // Grafiklerin dolması için beklenir
    await main.waitForTimeout(only ? 12000 : 35000);
    await shot(1, 'surec-agaci');

    // Ağaç: bellek sütununa göre (dal toplamı, azalan) sıralama; ardından ada göre sıralamaya dönülür
    if (want('agac-sirali')) {
      await main.click('#ptHead .th[data-key="ws"]');
      await main.waitForTimeout(700);
      if (await main.evaluate(() => APP.view.sort.key === 'ws' && APP.view.sort.dir === 1)) { await main.click('#ptHead .th[data-key="ws"]'); await main.waitForTimeout(700); }
      await main.evaluate(() => { document.querySelector('#ptBody, #ptRows').scrollTop = 0; });
      await main.waitForTimeout(400);
      await shot(2, 'agac-sirali');
      await main.click('#ptHead .th[data-key="name"]');
      await main.waitForTimeout(500);
      if (await main.evaluate(() => APP.view.sort.dir !== 1)) { await main.click('#ptHead .th[data-key="name"]'); await main.waitForTimeout(500); }
    }

    if (!(await select(target.pid))) throw new Error('hedef süreç tabloda yok');
    await main.waitForFunction(() => /target\.js/.test(document.querySelector('.d-body').textContent), null, { timeout: 15000 }).catch(() => {});
    await main.waitForTimeout(1500);
    await shot(3, 'genel');

    await tab('perf', 2500);
    await shot(4, 'performans');

    // Bellek: harita, ardından hedefin bilinen tamponunun bulunduğu bölgenin içeriği
    if (want('bellek') || want('bellek-hex')) {
      await tab('memory', 300);
      await main.waitForSelector('.d-body .mm-canvas', { timeout: 70000 }).catch(() => {});
      if (await main.$('.d-body .mm-canvas')) {
        await main.waitForTimeout(800);
        await shot(5, 'bellek');
        const base = await main.evaluate(async (pid) => {
          const mm = await window.api.query('memmap', { pid });
          if (!mm.ok) return null;
          const c = mm.data.cols; const bi = c.indexOf('base'); const si = c.indexOf('size'); const st = c.indexOf('state');
          let any = null;
          for (const r of mm.data.regions) {
            if (r[st] !== 1) continue;
            const rd = await window.api.query('readmem', { pid, addr: r[bi], len: 4096 });
            if (!rd.ok) continue;
            if (r[si] >= 8 * 1024 * 1024 && r[si] <= 64 * 1024 * 1024 && atob(rd.data.b64).includes('MASTER PROCESS E2E TARGET')) return r[bi];
            if (!any && /[A-Za-z]{6}/.test(atob(rd.data.b64))) any = r[bi];
            if (any && r[si] > 64 * 1024 * 1024) break;
          }
          return any;
        }, target.pid);
        if (base) {
          await main.fill('.d-body [data-a="filter"]', base);
          await main.waitForTimeout(400);
          await main.click('.d-body .vl-row');
          await main.waitForFunction(() => { const b = document.querySelector('.hexv-body'); return b && b.textContent.length > 200; }, null, { timeout: 10000 }).catch(() => {});
          if (await main.$('.hexv-body')) {
            await main.evaluate(() => document.querySelector('.hexv').scrollIntoView({ block: 'end' }));
            await main.waitForTimeout(500);
            await shot(6, 'bellek-hex');
          }
        }
      }
    }

    // Disk: G/Ç + açık dosyalar, ardından hedefin açık tuttuğu dosyanın yerleşimi ve içeriği
    if (want('disk') || want('disk-yerlesim')) {
      await tab('disk', 300);
      await main.waitForSelector('.d-body .vl', { timeout: 30000 }).catch(() => {});
      if (await main.$('.d-body .vl')) {
        await main.waitForTimeout(800);
        await shot(7, 'disk');
        await main.fill('.d-body [data-a="filter"]', path.basename(target.file));
        await main.waitForTimeout(400);
        if (await main.$('.d-body .vl-row')) {
          await main.click('.d-body .vl-row');
          await main.waitForSelector('.d-body [data-r="map"] .chips', { timeout: 20000 }).catch(() => {});
          await main.waitForFunction(() => { const b = document.querySelector('.hexv-body'); return b && b.textContent.length > 200; }, null, { timeout: 15000 }).catch(() => {});
          if (await main.$('.d-body .cm-canvas')) {
            await main.evaluate(() => document.querySelector('.d-body [data-r="file"]').scrollIntoView({ block: 'start' }));
            await main.waitForTimeout(600);
            await shot(8, 'disk-yerlesim');
          }
          // Disk yüzeyi: birimin doluluk haritası (okunabildiyse) üzerinde dosyanın parçaları
          await main.waitForSelector('.d-body .dm-canvas', { timeout: 20000 }).catch(() => {});
          if (want('disk-yuzey') && await main.$('.d-body .dm-canvas')) {
            await main.waitForFunction(() => { const n = document.querySelector('.d-body .dm [data-r="scale"]'); return n && n.textContent.trim().length > 0; }, null, { timeout: 15000 }).catch(() => {});
            await main.evaluate(() => document.querySelector('.d-body .dm').scrollIntoView({ block: 'start' }));
            await main.waitForTimeout(700);
            await shot(9, 'disk-yuzey');
          }
        }
      }
    }

    // Ağ: bağlantılar; Windows'ta yakalama açılır ve hedefin geri döngü trafiği dört biçimde görüntülenir
    if (want('ag') || want('ag-akilli')) {
      await tab('network', 600);
      await main.waitForSelector('.d-body .nt-cap .nt-capline', { timeout: 15000 }).catch(() => {});
      if (await main.$('.d-body .nt-cap')) {
        await main.uncheck('.d-body [data-a="children"]');
        if (WIN) {
          if (await main.$('.d-body .nt-cap [data-a="start"]')) await main.click('.d-body .nt-cap [data-a="start"]');
          await main.waitForSelector('.d-body .nt-cap .nt-dot', { timeout: 15000 }).catch(() => {});
        }
        await main.waitForFunction(() => document.querySelectorAll('.d-body .vl-row').length >= 1, null, { timeout: 20000 }).catch(() => {});
        const capOn = WIN && !!(await main.$('.d-body .nt-cap .nt-dot'));
        // hız grafiğinin ve sayaçların dolması için birkaç tur beklenir
        await main.waitForTimeout(capOn ? 14000 : 1500);
        await main.evaluate(() => { document.querySelector('.d-body').scrollTop = 0; });
        if (await main.$('.d-body .vl-row')) await shot(10, 'ag');
        if (capOn) {
          const q = (dir, sel) => `.d-body .nt-pane[data-dir="${dir}"] .nt-body ${sel}`;
          const ready = await main.waitForFunction(() => {
            const g = (dir, sel) => document.querySelector(`.d-body .nt-pane[data-dir="${dir}"] .nt-body ${sel}`);
            const drawn = (i) => i && i.complete && i.naturalWidth > 0;
            return g('out', '.j-k') && drawn(g('out', '.ns-img img')) && g('in', '.j-k') && drawn(g('in', '.ns-img img'));
          }, null, { timeout: 45000 }).then(() => true).catch(() => false);
          if (ready) {
            await main.click('.d-body .nt-stream [data-a="pause"]');
            const top = async () => {
              await main.evaluate(() => { for (const b of document.querySelectorAll('.d-body .nt-body')) b.scrollTop = 0; document.querySelector('.d-body .nt-stream').scrollIntoView({ block: 'start' }); });
              await main.waitForTimeout(600);
            };
            // JSON: iki panelde de ilk JSON gövdesi panelin başına getirilir
            await main.evaluate(() => {
              for (const b of document.querySelectorAll('.d-body .nt-body')) { const k = b.querySelector('.j-k'); const sec = k && k.closest('.ns-sec'); if (sec) b.scrollTop = Math.max(0, sec.offsetTop - b.offsetTop - 4); }
              document.querySelector('.d-body .nt-stream').scrollIntoView({ block: 'start' });
            });
            await main.waitForTimeout(600);
            await shot(11, 'ag-akilli');
            await main.evaluate(() => {
              for (const b of document.querySelectorAll('.d-body .nt-body')) { const im = b.querySelector('.ns-img'); const sec = im && im.closest('.ns-sec'); if (sec) b.scrollTop = Math.max(0, sec.offsetTop - b.offsetTop - 4); }
              document.querySelector('.d-body .nt-stream').scrollIntoView({ block: 'start' });
            });
            await main.waitForTimeout(600);
            await shot(12, 'ag-resim');
            await main.click('.d-body .nt-stream [data-f="hex"]');
            await main.waitForFunction((sel) => /[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}/i.test(document.querySelector(sel).textContent), q('out', ''), { timeout: 15000 }).catch(() => {});
            await top();
            await shot(13, 'ag-hex');
            await main.click('.d-body .nt-stream [data-f="smart"]');
            await main.click('.d-body .nt-stream [data-a="pause"]');
          } else console.log(`  (ağ içeriği atlandı: ${(await main.textContent('.d-body .nt-stream')).trim().replace(/\s+/g, ' ').slice(0, 120)})`);
        }
        await main.check('.d-body [data-a="children"]');
      }
    }

    if (!only) {
      // GPU: o an GPU motoru kullanan süreçlerden en yoğunu seçilir; motor satırı olmayan (boş) sekmenin görüntüsü alınmaz
      const gtop = await main.evaluate(() => APP.procs.filter((p) => p.gpu >= 1).sort((a, b) => b.gpu - a.gpu).slice(0, 5).map((p) => ({ pid: p.pid, name: p.name, gpu: p.gpu })));
      console.log(`  (gpu: sistem %${await main.evaluate(() => (APP.sys ? APP.sys.gpu : null))} · süreçler ${gtop.map((p) => `${p.name}:${p.pid}=%${p.gpu}`).join(', ') || 'yok'})`);
      if (gtop.length && await select(gtop[0].pid)) {
        await tab('gpu', 3000);
        await main.waitForSelector('.d-body .vl-row', { timeout: 8000 }).catch(() => {});
        if (!(await hasMsg()) && await main.$('.d-body .vl-row')) await shot(14, 'gpu');
        else console.log(`  (gpu atlandı: ${(await main.textContent('.d-body')).trim().replace(/\s+/g, ' ').slice(0, 90)})`);
      } else console.log('  (gpu atlandı: GPU motoru kullanan süreç yok)');
      if (!(await select(target.pid))) throw new Error('hedef süreç tabloda yok');

      await tab('modules', 300);
      await main.waitForSelector('.d-body .vl-row', { timeout: 20000 }).catch(() => {});
      if (await main.$('.d-body .vl-row')) await shot(16, 'moduller');
      await tab('threads', 2500);
      if (await main.$('.d-body .vl-row')) await shot(17, 'is-parcaciklari');

      // Pencere: Karakter Eşlem penceresinin görüntüsü
      if (charmap && charmap.pid && await select(charmap.pid)) {
        await tab('window', 500);
        await main.waitForSelector('.d-body .cap-box canvas', { timeout: 15000 }).catch(() => {});
        if (await main.$('.d-body .cap-box canvas')) { await main.waitForTimeout(600); await shot(15, 'pencere'); }
        else console.log(`  (pencere atlandı: ${(await main.textContent('.d-body')).trim().replace(/\s+/g, ' ').slice(0, 90)})`);
      }

      // Sistem görünümü → Tarihçe
      await main.keyboard.press('Escape');
      await main.waitForTimeout(500);
      await tab('history', 1200);
      if (await main.$('.d-body .vl-row')) await shot(18, 'tarihce');

      await main.click('#btnSettings');
      await main.waitForSelector('.modal .set-nav', { timeout: 5000 });
      await main.waitForTimeout(500);
      await shot(19, 'ayarlar');
      await main.keyboard.press('Escape');
    }
    if (errors.length) console.log('  sayfa hataları:', errors.slice(0, 5).join(' | '));
  } finally {
    await cleanup();
  }
  return taken;
}

(async () => {
  let failed = false;
  for (const lang of LANGS) {
    const all = [];
    for (const [theme, only] of [['dark', null], ['light', ['surec-agaci', 'performans', 'bellek', 'ag', 'ag-akilli']]]) {
      console.log(`${lang} · ${theme}`);
      try { all.push(...await run(lang, theme, only)); } catch (e) { failed = true; console.error('×', e.message); }
      await sleep(1500);
    }
    all.sort((a, b) => a.file.localeCompare(b.file));
    const tx = TEXT.tr;
    fs.writeFileSync(path.join(OUT, lang, 'manifest.json'), JSON.stringify(all.map((s) => ({ file: s.file, theme: s.theme, title: tx[s.key][0], caption: tx[s.key][1] })), null, 1));
  }
  process.exit(failed ? 1 : 0);
})();
