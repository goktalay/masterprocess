// Uçtan uca sınama ve ekran görüntüsü betiklerinin ortak düzeneği: sahte hesap sunucusu (/api/mp: prelogin, login, me,
// library, releases), gerçek Electron ana sürecinin başlatılması, giriş penceresinin CDP üzerinden doldurulması ve bilinen
// bir hedef sürecin (test-fixtures/target.js) çalıştırılması. Süreç verisi taklit edilmez: uygulama bu makinenin gerçek
// süreçlerini, platformun gerçek sağlayıcısıyla (Windows: mp-agent.exe, Linux: procfs) gösterir.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function accountServer({ email = 'ornek@example.com', name = 'Örnek Kullanıcı', latest = null } = {}) {
  const KDF = { alg: 'PBKDF2-SHA256', iter: 1000, salt: crypto.randomBytes(16).toString('base64') };
  const state = { library: null, puts: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* boş */ }
      const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      const u = req.url.split('?')[0];
      if (u === '/api/mp/auth/prelogin') return send(200, { kdf: KDF });
      if (u === '/api/mp/auth/login') return send(200, { token: 'e2e-token', user: { id: 1, email: body.email || email, name }, sync_enabled: true, kdf: KDF });
      if (u === '/api/mp/me') return send(200, { user: { id: 1, email, name }, sync_enabled: true, kdf: KDF });
      if (u === '/api/mp/library' && req.method === 'GET') return send(200, state.library || { version: null });
      if (u === '/api/mp/library' && req.method === 'PUT') { state.puts++; state.library = { version: (state.library?.version || 0) + 1, blob: body.blob }; return send(200, { version: state.library.version }); }
      if (u === '/api/mp/releases/latest') return send(200, { version: latest || require(path.join(ROOT, 'package.json')).version });
      if (u === '/api/mp/auth/sso') return send(401, { code: 'sso_invalid' });
      return send(404, { code: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, email, url: `http://127.0.0.1:${server.address().port}` })));
}

// Uygulamayı başlatır. exe verilirse paketlenmiş uygulama (MP_APP_EXE), yoksa node_modules içindeki Electron + depo kökü.
async function launch({ api, settings = {}, exe = process.env.MP_APP_EXE || '' } = {}) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-ud-'));
  fs.writeFileSync(path.join(ud, 'store.json'), JSON.stringify({ settings: { language: 'tr', appTheme: 'dark', checkUpdates: false, ...settings } }));
  const port = 9300 + Math.floor(Math.random() * 600);
  const args = [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--no-sandbox', '--force-device-scale-factor=1'];
  const cmd = exe || path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const proc = spawn(cmd, exe ? args : [ROOT, ...args], { env: { ...process.env, MP_API: api }, stdio: ['ignore', 'pipe', 'pipe'], shell: !exe && process.platform === 'win32' });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  let browser = null;
  // Taşınabilir paket önce kendini geçici klasöre açar; yavaş makinede bir dakikayı bulabilir
  for (let i = 0; i < 180 && !browser; i++) {
    await sleep(500);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { /* henüz yok */ }
  }
  const findPage = async (re, ms = 30000) => {
    const t0 = Date.now();
    while (browser && Date.now() - t0 < ms) {
      for (const c of browser.contexts()) for (const p of c.pages()) if (re.test(p.url())) return p;
      await sleep(300);
    }
    return null;
  };
  const tail = () => log.split('\n').filter((l) => l.trim() && !/bus\.cc|viz_main|gles2_cmd|GroupMarker|dbus|gpu_/.test(l)).slice(-25).join('\n');
  async function close() {
    if (browser) await browser.close().catch(() => {});
    if (process.platform === 'win32') { try { require('child_process').execFileSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { /* kapanmış */ } } else proc.kill();
    await sleep(400);
    fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  return { proc, browser, findPage, tail, close, ud };
}

// Giriş penceresini doldurur, ana pencereyi döndürür; sayfa hataları errors dizisine toplanır
async function signIn(app, { email = 'ornek@example.com', width = 1600, height = 1000 } = {}) {
  const login = await app.findPage(/login\.html$/);
  if (!login) throw new Error('giriş penceresi açılmadı');
  await login.fill('#email', email);
  await login.fill('#password', 'Test1234!');
  await login.click('#submit');
  const main = await app.findPage(/index\.html$/);
  if (!main) throw new Error('ana pencere açılmadı');
  const errors = [];
  main.on('pageerror', (e) => errors.push(e.message));
  main.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Playwright CDP bağlantısında açık temayı dayatır; uygulamanın kendi teması (nativeTheme) geçerli olsun
  await main.emulateMedia({ colorScheme: null }).catch(() => {});
  await main.setViewportSize({ width, height }).catch(() => {});
  return { main, errors };
}

// Bilinen hedef süreç: { pid, file, stop() }
function startTarget({ child = true } = {}) {
  const file = path.join(os.tmpdir(), `mp-e2e-hedef-${process.pid}.txt`);
  const p = spawn(process.execPath, [path.join(ROOT, 'test-fixtures', 'target.js'), file, ...(child ? ['--child'] : [])], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hedef süreç başlamadı')), 15000);
    p.stdout.once('data', () => {
      clearTimeout(timer);
      resolve({
        pid: p.pid, file, proc: p,
        stop() {
          if (process.platform === 'win32') { try { require('child_process').execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { /* kapanmış */ } } else p.kill();
          setTimeout(() => fs.rmSync(file, { force: true }), 500);
        },
      });
    });
  });
}

module.exports = { ROOT, sleep, accountServer, launch, signIn, startTarget };
