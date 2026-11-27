// Tanıtım ekran görüntüleri: gerçek uygulama (Electron ana süreci + platformun gerçek sağlayıcısı) bu makinenin gerçek
// süreçleriyle çalıştırılır; hiçbir veri taklit edilmez. Görüntülerdeki süreçler görüntünün alındığı makinenin süreçleridir
// (yayın derlemesinde bir Windows sınama makinesi). Seçilen süreç betiğin başlattığı test-fixtures/target.js, pencere
// sekmesinde Windows'un Karakter Eşlem (charmap.exe) penceresidir. Hesap çipindeki e-posta örnek değerdir (sahte hesap sunucusu).
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
    'surec-agaci': ['Süreç ağacı ve sistem görünümü', 'Üst–alt ilişkisiyle süreçler, satır içi CPU / bellek / G/Ç grafikleri ve sistem özeti'],
    genel: ['Süreç ayrıntıları', 'Yol, komut satırı, üst süreç, öncelik, sayaçlar ve süreç eylemleri'],
    performans: ['Süreç başına performans grafikleri', 'CPU, bellek ve G/Ç için canlı çizgi grafikler; tepe ve ortalama değerler'],
    bellek: ['Bellek yerleşim haritası', 'Sanal adres alanındaki bölgeler: tür, koruma ve fiziksel bellekte bulunma oranı'],
    'bellek-hex': ['Bellek içeriği: hex görüntüleyici', 'Seçilen bölgenin baytları; canlı yenileme, dizgeler kipi ve adrese gitme'],
    disk: ['Disk: G/Ç ve açık dosyalar', 'Okuma / yazma hızları, tutamaç türleri ve sürecin açık tuttuğu dosyalar'],
    'disk-yerlesim': ['Dosyanın diskteki yerleşimi', 'Seçilen dosyanın birimdeki kümeleri, parça sayısı ve içeriğinin hex dökümü'],
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

    if (!(await select(target.pid))) throw new Error('hedef süreç tabloda yok');
    await main.waitForFunction(() => /target\.js/.test(document.querySelector('.d-body').textContent), null, { timeout: 15000 }).catch(() => {});
    await main.waitForTimeout(1500);
    await shot(2, 'genel');

    await tab('perf', 2500);
    await shot(3, 'performans');

    // Bellek: harita, ardından hedefin bilinen tamponunun bulunduğu bölgenin içeriği
    if (want('bellek') || want('bellek-hex')) {
      await tab('memory', 300);
      await main.waitForSelector('.d-body .mm-canvas', { timeout: 70000 }).catch(() => {});
      if (await main.$('.d-body .mm-canvas')) {
        await main.waitForTimeout(800);
        await shot(4, 'bellek');
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
            await shot(5, 'bellek-hex');
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
        await shot(6, 'disk');
        await main.fill('.d-body [data-a="filter"]', path.basename(target.file));
        await main.waitForTimeout(400);
        if (await main.$('.d-body .vl-row')) {
          await main.click('.d-body .vl-row');
          await main.waitForSelector('.d-body [data-r="map"] .chips', { timeout: 20000 }).catch(() => {});
          await main.waitForFunction(() => { const b = document.querySelector('.hexv-body'); return b && b.textContent.length > 200; }, null, { timeout: 15000 }).catch(() => {});
          if (await main.$('.d-body .cm-canvas')) {
            await main.evaluate(() => document.querySelector('.d-body [data-r="file"]').scrollIntoView({ block: 'start' }));
            await main.waitForTimeout(600);
            await shot(7, 'disk-yerlesim');
          }
        }
      }
    }

    if (!only) {
      // GPU: o an GPU motoru kullanan süreçlerden en yoğunu seçilir; motor satırı olmayan (boş) sekmenin görüntüsü alınmaz
      const gtop = await main.evaluate(() => APP.procs.filter((p) => p.gpu >= 1).sort((a, b) => b.gpu - a.gpu).slice(0, 5).map((p) => ({ pid: p.pid, name: p.name, gpu: p.gpu })));
      console.log(`  (gpu: sistem %${await main.evaluate(() => (APP.sys ? APP.sys.gpu : null))} · süreçler ${gtop.map((p) => `${p.name}:${p.pid}=%${p.gpu}`).join(', ') || 'yok'})`);
      if (gtop.length && await select(gtop[0].pid)) {
        await tab('gpu', 3000);
        await main.waitForSelector('.d-body .vl-row', { timeout: 8000 }).catch(() => {});
        if (!(await hasMsg()) && await main.$('.d-body .vl-row')) await shot(8, 'gpu');
        else console.log(`  (gpu atlandı: ${(await main.textContent('.d-body')).trim().replace(/\s+/g, ' ').slice(0, 90)})`);
      } else console.log('  (gpu atlandı: GPU motoru kullanan süreç yok)');
      if (!(await select(target.pid))) throw new Error('hedef süreç tabloda yok');

      await tab('modules', 300);
      await main.waitForSelector('.d-body .vl-row', { timeout: 20000 }).catch(() => {});
      if (await main.$('.d-body .vl-row')) await shot(10, 'moduller');
      await tab('threads', 2500);
      if (await main.$('.d-body .vl-row')) await shot(11, 'is-parcaciklari');

      // Pencere: Karakter Eşlem penceresinin görüntüsü
      if (charmap && charmap.pid && await select(charmap.pid)) {
        await tab('window', 500);
        await main.waitForSelector('.d-body .cap-box canvas', { timeout: 15000 }).catch(() => {});
        if (await main.$('.d-body .cap-box canvas')) { await main.waitForTimeout(600); await shot(9, 'pencere'); }
        else console.log(`  (pencere atlandı: ${(await main.textContent('.d-body')).trim().replace(/\s+/g, ' ').slice(0, 90)})`);
      }

      // Sistem görünümü → Tarihçe
      await main.keyboard.press('Escape');
      await main.waitForTimeout(500);
      await tab('history', 1200);
      if (await main.$('.d-body .vl-row')) await shot(12, 'tarihce');

      await main.click('#btnSettings');
      await main.waitForSelector('.modal .set-nav', { timeout: 5000 });
      await main.waitForTimeout(500);
      await shot(13, 'ayarlar');
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
    for (const [theme, only] of [['dark', null], ['light', ['surec-agaci', 'performans', 'bellek']]]) {
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
