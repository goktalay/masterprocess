// Uçtan uca: gerçek Electron ana süreciyle uygulamayı çalıştırır (ayrıntı: scripts/harness.js). Giriş yapılır, süreç ağacının
// dolduğu görülür, bilinen hedef süreç seçilip bütün sekmeler gezilir (bellek haritası + bellek okuma, açık dosyalar + dosya
// içeriği, modüller, iş parçacıkları, geçmiş), askıya al / sürdür / öncelik / ağacı sonlandır eylemleri hedef üzerinde
// denenir, ayarlar penceresi ve sayfa hataları denetlenir. Süreç verisi gerçektir; başka hiçbir sürece dokunulmaz.
// Kullanım: node scripts/e2e-electron.js [--shots <klasör>]
//   Linux'ta ekran gerekir (DISPLAY). Paketlenmiş uygulama için MP_APP_EXE=<yol>.
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIN = process.platform === 'win32';

let cleanup = async () => {};

(async () => {
  const acct = await H.accountServer();
  const target = await H.startTarget();
  const app = await H.launch({ api: acct.url });
  cleanup = async () => { target.stop(); await app.close(); acct.server.close(); };
  let failed = 0;
  const ok = (m) => console.log('✓', m);
  const bad = (m) => { failed++; console.log('×', m); };
  const check = (cond, m) => (cond ? ok(m) : bad(m));
  const die = async (m) => { console.error('×', m); console.error(app.tail()); target.stop(); await app.close(); acct.server.close(); process.exit(1); };
  if (!app.browser) await die('CDP bağlanamadı');
  let main, errors;
  try { ({ main, errors } = await H.signIn(app)); } catch (e) { await die(e.message); }
  ok('giriş yapıldı, ana pencere açıldı');
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await main.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  const tab = async (id, wait = 1200) => { await main.click(`.d-tabs [data-tab="${id}"]`); await main.waitForTimeout(wait); };
  const bodyMsg = () => main.evaluate(() => { const m = document.querySelector('.d-body .d-msg'); return m ? m.textContent.trim() : ''; });

  // Süreç tablosu
  await main.waitForSelector('#ptRows .pr', { timeout: 30000 }).catch(() => die('süreç tablosu dolmadı'));
  const info = await main.evaluate(() => ({ kind: APP.mon.kind, hello: APP.hello, rows: APP.rows.length, procs: APP.byPid.size, error: APP.mon.error }));
  check(info.procs > 5 && !info.error, `sağlayıcı: ${info.kind} · ${info.hello ? `${info.hello.agent} (protokol ${info.hello.protocol}, yönetici: ${info.hello.elevated})` : '—'} · ${info.procs} süreç, ${info.rows} satır`);
  check(/\d/.test(await main.textContent('#stats')), `özet: ${(await main.textContent('#stats')).trim()}`);
  await main.waitForTimeout(2500);
  check(await main.evaluate(() => !!document.querySelector('.d-body canvas')), 'sistem görünümü: grafikler çizildi');
  await shot('e2e-01-sistem');

  // Hedef süreç: ağaçta görünür, alt süreciyle birlikte
  let found = false;
  for (let i = 0; i < 20 && !found; i++) { found = await main.evaluate((pid) => APP.selectPid(pid), target.pid); if (!found) await main.waitForTimeout(500); }
  if (!found) await die(`hedef süreç (PID ${target.pid}) tabloda yok`);
  await main.waitForSelector('.d-head .d-name');
  const kids = await main.evaluate((pid) => { const n = APP.byPid.get(pid); return n ? n.children.map((c) => c.p.pid) : []; }, target.pid);
  check(kids.length === 1, `hedef seçildi: ${(await main.textContent('.d-head .d-name')).trim()} (PID ${target.pid}), alt süreç: ${kids.join(', ') || 'yok'}`);

  // Genel
  await main.waitForFunction(() => /target\.js/.test(document.querySelector('.d-body').textContent), null, { timeout: 10000 }).catch(() => bad('genel: komut satırı gelmedi'));
  check(!(await bodyMsg()), 'genel: ayrıntılar yüklendi (komut satırı görünüyor)');
  await main.waitForTimeout(3000);
  await shot('e2e-02-genel');

  // Performans
  await tab('perf', 1500);
  check(await main.evaluate(() => document.querySelectorAll('.d-body canvas').length >= 3), 'performans: grafikler');
  const cpu = await main.evaluate((pid) => APP.byPid.get(pid).p.cpu, target.pid);
  check(cpu > 0, `performans: hedefin işlemci kullanımı ölçülüyor (% ${cpu.toFixed(2)})`);
  await shot('e2e-03-performans');

  // Bellek: harita + bölge listesi + bellek okuma
  const ascii = () => main.evaluate(() => [...document.querySelectorAll('.hexv-body .hx-t')].map((e) => e.textContent).join(''));
  // Okunabilir bir bölge seçer; hedefin 8 MB'lik tamponu (bilinen dizge) bulunursa onu
  const probe = (pid) => main.evaluate(async (pid) => {
    const mm = await window.api.query('memmap', { pid });
    if (!mm.ok) return { err: mm.code };
    const c = mm.data.cols; const bi = c.indexOf('base'); const si = c.indexOf('size'); const st = c.indexOf('state');
    const commit = mm.data.regions.filter((r) => r[st] === 1);
    let lastErr = 'bölge yok';
    for (const r of commit) {
      if (r[si] < 8 * 1024 * 1024 || r[si] > 64 * 1024 * 1024) continue;
      const rd = await window.api.query('readmem', { pid, addr: r[bi], len: 4096 });
      if (!rd.ok) { lastErr = rd.code; continue; }
      if (atob(rd.data.b64).includes('MASTER PROCESS E2E TARGET')) return { base: r[bi], size: r[si], hit: true };
    }
    for (const r of commit.slice(0, 40)) {
      const rd = await window.api.query('readmem', { pid, addr: r[bi], len: 256 });
      if (rd.ok) return { base: r[bi], size: r[si], hit: false };
      lastErr = rd.code;
    }
    return { err: lastErr };
  }, pid);
  const hexOn = async (picked, what) => {
    await main.fill('.d-body [data-a="filter"]', picked.base);
    await main.waitForTimeout(400);
    await main.click('.d-body .vl-row');
    await main.waitForFunction(() => { const b = document.querySelector('.hexv-body'); return b && b.textContent.length > 200; }, null, { timeout: 10000 }).catch(() => bad(`${what}: hex görüntüleyici dolmadı`));
    const line = await main.evaluate(() => (document.querySelector('.hexv-body') || { textContent: '' }).textContent.split('\n')[0]);
    check(/^\W*[0-9a-f]{16}\W/.test(line), `${what}: hex görüntüleyici — ${line.replace(/[⁦-⁩]/g, '').slice(0, 70)}`);
    if (picked.hit) check((await ascii()).includes('MASTER PROCESS E2E TARGET'), `${what}: hex görüntüleyicide hedefin bilinen dizgesi okunuyor`);
    await main.click('.hexv [data-m="str"]');
    await main.waitForTimeout(250);
    if (picked.hit) check((await main.textContent('.hexv-body')).includes('MASTER PROCESS E2E TARGET'), `${what}: dizgeler kipi`);
    await main.click('.hexv [data-m="hex"]');
  };
  const openMemory = async () => {
    await tab('memory', 300);
    await main.waitForSelector('.d-body .mm-canvas, .d-body .d-msg:not(:has(.spin))', { timeout: 70000 }).catch(() => {});
    return !!(await main.$('.d-body .mm-canvas'));
  };
  if (await openMemory()) {
    const regions = await main.evaluate(() => document.querySelectorAll('.d-body .vl-row').length);
    check(regions > 3, `bellek: yerleşim haritası ve ${regions}+ bölge satırı`);
    const picked = await probe(target.pid);
    if (!picked.err) {
      ok(`bellek okuma: 0x${picked.base} (${picked.size} bayt)${picked.hit ? ' — hedefin bilinen dizgesi bellekte bulundu' : ''}`);
      await hexOn(picked, 'bellek');
    } else if (WIN || picked.err !== 'access') bad(`bellek okuma: ${picked.err}`);
    else {
      // Linux'ta başka bir sürecin belleği yalnız izin varsa okunur (ptrace_scope); görüntüleyici uygulamanın kendi süreciyle sınanır
      ok('bellek okuma: hedef için erişim reddedildi (Linux ptrace kısıtı) — görüntüleyici uygulamanın kendi süreciyle sınanıyor');
      const self = await main.evaluate((root) => { const n = APP.byPid.get(root); const kid = n && n.children.find((c) => /electron/i.test(c.p.name)); return kid ? kid.p.pid : 0; }, app.proc.pid);
      if (self && await main.evaluate((pid) => APP.selectPid(pid), self) && await openMemory()) {
        const own = await probe(self);
        if (own.err) bad(`bellek okuma (kendi süreci): ${own.err}`);
        else await hexOn(own, 'bellek (kendi süreci)');
      } else bad('uygulamanın kendi süreci bulunamadı');
      await main.evaluate((pid) => APP.selectPid(pid), target.pid);
      await openMemory();
    }
    await main.waitForTimeout(600);
    await shot('e2e-04-bellek');
  } else bad(`bellek: ${await bodyMsg()}`);

  // Disk: açık dosyalar + hedefin açık tuttuğu dosyanın içeriği
  await tab('disk', 300);
  await main.waitForSelector('.d-body .vl', { timeout: 30000 }).catch(() => {});
  if (await main.$('.d-body .vl')) {
    const base = path.basename(target.file);
    await main.fill('.d-body [data-a="filter"]', base);
    await main.waitForTimeout(400);
    const n = await main.evaluate(() => document.querySelectorAll('.d-body .vl-row').length);
    check(n >= 1, `disk: hedefin açık tuttuğu dosya listede (${base})`);
    if (n >= 1) {
      await main.click('.d-body .vl-row');
      await main.waitForFunction(() => { const b = document.querySelector('.hexv-body'); return b && b.textContent.length > 200; }, null, { timeout: 15000 }).catch(() => bad('disk: dosya içeriği gelmedi'));
      check((await ascii()).includes('MASTER PROCESS E2E TARGET'), 'disk: dosya içeriği hex görüntüleyicide okunuyor');
      await main.waitForSelector('.d-body [data-r="map"] .chips', { timeout: 20000 }).catch(() => {});
      const map = await main.evaluate(() => { const m = document.querySelector('.d-body [data-r="map"]'); const chips = m ? [...m.querySelectorAll('.chip')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')).join(' · ') : ''; return (m && m.querySelector('.cm-canvas') ? 'yerleşim haritası çizildi — ' : 'harita yok — ') + (chips || (m ? m.textContent.trim().slice(0, 110) : '')); });
      check(/çizildi/.test(map), `disk: ${map}`);
    }
    await main.waitForTimeout(600);
    await shot('e2e-05-disk');
  } else bad(`disk: ${await bodyMsg()}`);

  // GPU ve pencere: Windows'a özgü; diğer platformlarda "desteklenmiyor" iletisi beklenir
  await tab('gpu', 1500);
  { const m = await bodyMsg(); (WIN ? check : (c, x) => ok(x))(!m, `gpu: ${m || 'sayaçlar gösteriliyor'}`); }
  await shot('e2e-06-gpu');
  {
    // Tanılama: üst şeritteki sistem değeri ile süreç değerleri ve Windows'un kendi sayaçları yan yana
    const g = await main.evaluate(() => ({ sys: APP.sys ? APP.sys.gpu : null, top: APP.procs.filter((p) => p.gpu >= 0.5).sort((a, b) => b.gpu - a.gpu).slice(0, 6).map((p) => `${p.name}:${p.pid}=${p.gpu}`) }));
    ok(`gpu: sistem %${g.sys} · süreçler ${g.top.join(', ') || 'yok'}`);
    if (WIN) {
      try {
        const cmd = "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.CookedValue -gt 0.5 } | Sort-Object CookedValue -Descending | Select-Object -First 8 | ForEach-Object { '{0}={1:N1}' -f $_.InstanceName, $_.CookedValue }";
        const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
        ok(`gpu (Windows sayaçları): ${out.trim().replace(/\s+/g, ' ') || 'etkin örnek yok'}`);
      } catch (e) { ok(`gpu (Windows sayaçları): okunamadı — ${String(e.message).replace(/\s+/g, ' ').slice(0, 120)}`); }
    }
  }
  await tab('window', 1500);
  ok(`pencere: ${(await main.evaluate(() => document.querySelector('.d-body').textContent.trim().replace(/\s+/g, ' ').slice(0, 90)))}`);

  // Modüller, iş parçacıkları
  await tab('modules', 300);
  await main.waitForSelector('.d-body .vl-row', { timeout: 20000 }).catch(() => {});
  check(await main.evaluate(() => document.querySelectorAll('.d-body .vl-row').length >= 3), 'modüller: yüklenen modüller listelendi');
  await shot('e2e-07-moduller');
  await tab('threads', 2500);
  check(await main.evaluate(() => document.querySelectorAll('.d-body .vl-row').length >= 1), 'iş parçacıkları: listelendi');
  await shot('e2e-08-is-parcaciklari');

  // Eylemler (yalnız hedef süreç üzerinde): askıya al → rozet, sürdür, öncelik
  await tab('general', 800);
  const act = async (cmd, value) => main.evaluate(([c, pid, v]) => window.api.action(c, pid, v), [cmd, target.pid, value]);
  const detail = async () => main.evaluate((pid) => window.api.query('detail', { pid }), target.pid);
  let r = await act('suspend');
  let d = await detail();
  check(r.ok && d.ok && d.data.suspended === true, `askıya al: ${r.ok ? 'yapıldı' : r.code}, durum: ${d.ok ? d.data.suspended : d.code}`);
  await main.waitForSelector('.d-head .badge.warn', { timeout: 8000 }).then(() => ok('askıya alındı rozeti görünüyor')).catch(() => bad('askıya alındı rozeti yok'));
  r = await act('resume');
  d = await detail();
  check(r.ok && d.ok && d.data.suspended === false, `sürdür: ${r.ok ? 'yapıldı' : r.code}`);
  r = await act('priority', 'below');
  d = await detail();
  check(r.ok && d.ok && d.data.priority === 'below', `öncelik: ${r.ok ? d.data.priority : r.code}`);

  // Ağacı sonlandır: arayüzden, onay kutusuyla
  await main.click('.d-body [data-a="killTree"]');
  await main.waitForSelector('.modal .danger-primary', { timeout: 5000 }).catch(() => bad('onay kutusu açılmadı'));
  await shot('e2e-09-onay');
  await main.click('.modal .danger-primary');
  await main.waitForFunction((pid) => !APP.byPid.has(pid), target.pid, { timeout: 15000 }).then(() => ok('ağacı sonlandır: hedef ve alt süreci listeden çıktı')).catch(() => bad('hedef hâlâ listede'));
  check(await main.evaluate((pids) => pids.every((p) => !APP.byPid.has(p)), kids), 'alt süreç de sonlandı');
  await main.waitForSelector('.d-head .badge.err', { timeout: 8000 }).then(() => ok('"sonlandı" rozeti görünüyor')).catch(() => bad('"sonlandı" rozeti yok'));
  await tab('history', 1000);
  check(await main.evaluate(() => document.querySelectorAll('.d-body .vl-row').length >= 1), 'geçmiş: hedefin olayları listelendi');
  await shot('e2e-10-gecmis');

  // Sistem görünümüne dönüş, arama, görünüm kipi
  await main.keyboard.press('Escape');
  await main.waitForTimeout(400);
  await main.fill('#search', 'zzzz-yok-boyle-surec');
  await main.waitForTimeout(500);
  check(await main.evaluate(() => !document.querySelector('#ptEmpty').classList.contains('hidden')), 'arama: eşleşme yokken boş durum iletisi');
  await main.fill('#search', '');
  await main.click('#viewMode button:not(.on)');
  await main.waitForTimeout(500);
  check(await main.evaluate(() => APP.view.mode === 'list'), 'görünüm: düz liste');
  await main.click('#viewMode button:not(.on)');

  // Ayarlar penceresi
  await main.click('#btnSettings');
  await main.waitForSelector('.modal .set-nav', { timeout: 5000 }).catch(() => bad('ayarlar açılmadı'));
  const pages = await main.$$eval('.modal .set-nav button', (els) => els.map((e) => e.dataset.tab));
  for (const p of pages) { await main.click(`.modal .set-nav [data-tab="${p}"]`); await main.waitForTimeout(150); }
  ok(`ayarlar: ${pages.join(', ')}`);
  await shot('e2e-11-ayarlar');
  await main.keyboard.press('Escape');

  // Senkron (yalnız ayarlar) ve içerik güvenliği
  await main.waitForTimeout(4000);
  ok(acct.state.library && acct.state.library.blob ? `ayarlar şifreli senkronlandı (v${acct.state.library.version}, ${acct.state.library.blob.length} karakter)` : 'senkron henüz yok');
  const csp = await main.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  check(csp.includes("default-src 'self'"), 'CSP');
  check(!errors.length, errors.length ? `sayfa hataları: ${errors.slice(0, 6).join(' | ')}` : 'sayfa hatası yok');

  if (failed) console.log('\n— ana süreç günlüğü —\n' + app.tail());
  await cleanup();
  console.log(failed ? `\n${failed} denetim başarısız` : '\nTüm denetimler geçti');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
