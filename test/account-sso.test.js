'use strict';

// Hesap ve ortak oturum (SSO) akışları — sahte /api/mp sunucusuyla. Mastertool sözleşmesi: şifreyle girişte sso:true,
// ortak kimlikle şifresiz giriş (/auth/sso), çıkışta ortak kimliği silme ve "out" duyurusu, 401'de tüm ailenin kapanması.
// Senkron: yalnız ayarlar (tema, dil, görünüm tercihleri) uçtan uca şifreli ("mpr-enc-v1"); süreç verisi, dosya yolları ve
// olay günlüğü gönderilmez.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { memoryKeyring, tmpDir } = require('./helpers');

const SALT = 'AAECAwQFBgcICQoLDA0ODw==';
const KDF = { alg: 'PBKDF2-SHA256', iter: 1000, salt: SALT }; // testte hızlı olsun diye az tur
const calls = [];
let reply = {}; // uç → (body) => [status, json]

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ route: req.url, method: req.method, body, auth: req.headers.authorization || '' });
    const h = reply[req.url];
    const [status, json] = h ? h(body, req.method) : [404, { code: 'not_found' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

let createAccount;
let encKeyFromMaster;
let deriveKeys;
let decryptLibrary;
let encryptLibrary;
let ENC_INFO;
let APP;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.MP_API = `http://127.0.0.1:${server.address().port}`;
  ({ createAccount, encKeyFromMaster, deriveKeys, decryptLibrary, encryptLibrary, ENC_INFO, APP } = require('../src/account'));
});
test.after(() => server.close());

const { createSso } = require('../src/sso');

function makeApp(kr, stateDir, events = []) {
  const dir = tmpDir('mp-acc-');
  const store = {
    settings: { appTheme: 'system', language: null, view: { refreshMs: 1000, mode: 'tree', sort: { key: 'cpu', dir: -1 } },
      openAtLogin: false, minimizeToTray: true, closeToTray: false, checkUpdates: true },
    events: [{ t: 1, type: 'start', pid: 4242, name: 'gizli.exe', path: 'C:\\Users\\Gizli\\gizli.exe' }], syncMeta: {},
  };
  const sso = createSso({ keyring: kr, stateDir, pollMs: 50 });
  const acc = createAccount({
    userDataDir: dir, appVersion: '1.0.0', sso,
    encrypt: (x) => 'b64:' + Buffer.from(x).toString('base64'),
    decrypt: (x) => Buffer.from(String(x).slice(4), 'base64').toString(),
    getStore: () => store,
    replaceLibrary: ({ settings, syncMeta }) => {
      Object.assign(store.settings, settings);
      store.syncMeta = syncMeta;
      events.push('replace');
    },
    persistStore: () => {}, resetSyncMeta: () => { store.syncMeta = {}; events.push('reset'); },
    onStatus: () => {}, onSessionExpired: (c) => events.push('expired:' + c), onUpdate: () => {},
    onSharedSignIn: () => events.push('sharedIn'), onSharedSignOut: (c) => events.push('sharedOut' + (c ? ':' + c : '')),
  });
  return { acc, sso, events, store };
}

function serverAccepting() {
  reply = {
    '/api/mp/auth/prelogin': () => [200, { kdf: KDF }],
    '/api/mp/auth/login': (b) => [200, { token: 'app-tok-1', sso_token: b.sso ? 'sso-tok-1' : undefined, user: { id: 7, email: 'demo@ornek.com', name: 'Demo' }, sync_enabled: true, kdf: KDF }],
    '/api/mp/auth/sso': (b) => (b.sso_token === 'sso-tok-1'
      ? [200, { token: 'app-tok-2', user: { id: 7, email: 'demo@ornek.com', name: 'Demo' }, sync_enabled: true, kdf: KDF }]
      : [401, { code: 'session_expired' }]),
    '/api/mp/auth/logout': () => [200, { ok: true, sso_ended: true }],
  };
}

test('uygulama kodu "mp" ve anahtar türetme etiketi "mpr-enc-v1"', () => {
  assert.equal(APP, 'mp');
  assert.equal(ENC_INFO, 'mpr-enc-v1');
});

test('şifreyle giriş /api/mp uçlarını kullanır, sso:true gönderir, ortak kimliği yazar ve durumu "in" yapar', async () => {
  serverAccepting();
  calls.length = 0;
  const kr = memoryKeyring();
  const stateDir = tmpDir('mp-st-');
  const { acc, sso } = makeApp(kr, stateDir);
  await acc.login('Demo@Ornek.com', 'Test1234!', true);
  assert.deepEqual(calls.map((c) => c.route), ['/api/mp/auth/prelogin', '/api/mp/auth/login']);
  const login = calls.find((c) => c.route === '/api/mp/auth/login');
  assert.equal(login.body.sso, true);
  assert.equal(login.body.password, undefined); // şifre gönderilmez
  const cred = sso.readCredential();
  assert.equal(cred.sso_token, 'sso-tok-1');
  assert.equal(cred.email, 'demo@ornek.com');
  assert.equal(Buffer.from(cred.master, 'base64').length, 32);
  assert.deepEqual(sso.readState().state, 'in');
  // Ortak kimlikteki master, şifreden türetilenle aynı encKey'i verir (HKDF info "mpr-enc-v1")
  const { encKey } = await deriveKeys('Test1234!', KDF);
  assert.deepEqual(encKeyFromMaster(Buffer.from(cred.master, 'base64')), encKey);
  const crypto = require('crypto');
  assert.deepEqual(encKey, Buffer.from(crypto.hkdfSync('sha256', Buffer.from(cred.master, 'base64'), Buffer.alloc(0), Buffer.from('mpr-enc-v1'), 32)));
});

test('ikinci uygulama ortak kimlikle şifresiz girer', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('mp-st-');
  const a = makeApp(kr, stateDir);
  await a.acc.login('demo@ornek.com', 'Test1234!', true);
  calls.length = 0;
  const b = makeApp(kr, stateDir);
  assert.equal(b.acc.isLoggedIn(), false);
  const r = await b.acc.trySharedSignIn();
  assert.equal(r.ok, true);
  assert.equal(b.acc.isLoggedIn(), true);
  assert.deepEqual(calls.map((c) => c.route), ['/api/mp/auth/sso']); // prelogin/şifre yok
  assert.equal(calls[0].body.sso_token, 'sso-tok-1');
});

test('çıkış: sunucuya bildirilir, ortak kimlik silinir, durum "out"; diğer uygulama da kapanır', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('mp-st-');
  const a = makeApp(kr, stateDir);
  const b = makeApp(kr, stateDir);
  await a.acc.login('demo@ornek.com', 'Test1234!', true);
  await b.acc.trySharedSignIn();
  b.acc.watchShared();
  calls.length = 0;
  await a.acc.logout();
  assert.ok(calls.some((c) => c.route === '/api/mp/auth/logout' && c.auth === 'Bearer app-tok-1'));
  assert.equal(a.sso.readCredential(), null);
  assert.equal(a.sso.readState().state, 'out');
  await new Promise((r) => setTimeout(r, 250)); // izleyici (fs.watch / 50 ms yoklama)
  b.acc.stopWatching();
  assert.equal(b.acc.isLoggedIn(), false);
  assert.deepEqual(b.events, ['sharedOut']);
});

test('başka uygulamada giriş yapılınca giriş ekranındaki uygulama kendiliğinden açılır', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('mp-st-');
  const b = makeApp(kr, stateDir);
  b.acc.watchShared();
  const a = makeApp(kr, stateDir);
  await a.acc.login('demo@ornek.com', 'Test1234!', true);
  await new Promise((r) => setTimeout(r, 300));
  b.acc.stopWatching();
  assert.equal(b.acc.isLoggedIn(), true);
  assert.deepEqual(b.events, ['sharedIn']);
});

test('ortak oturum geçersizse (401) ortak kimlik silinir ve durum "out" olur', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('mp-st-');
  const { sso, acc } = makeApp(kr, stateDir);
  sso.writeCredential({ email: 'demo@ornek.com', user: { id: 7, name: 'Demo' }, sso_token: 'eski', master: Buffer.alloc(32, 1), kdf: KDF });
  const r = await acc.trySharedSignIn();
  assert.deepEqual([r.ok, r.code], [false, 'session_expired']);
  assert.equal(sso.readCredential(), null);
  assert.equal(sso.readState().state, 'out');
});

test('lisans kapalıysa (403 app_disabled) ortak kimlik korunur, diğer uygulamalar etkilenmez', async () => {
  serverAccepting();
  reply['/api/mp/auth/sso'] = () => [403, { code: 'app_disabled' }];
  const kr = memoryKeyring();
  const stateDir = tmpDir('mp-st-');
  const { sso, acc } = makeApp(kr, stateDir);
  sso.writeCredential({ email: 'demo@ornek.com', user: { id: 7, name: 'Demo' }, sso_token: 'sso-tok-1', master: Buffer.alloc(32, 1), kdf: KDF });
  const r = await acc.trySharedSignIn();
  assert.deepEqual([r.ok, r.code], [false, 'app_disabled']);
  assert.ok(sso.readCredential());
  assert.equal(acc.isLoggedIn(), false);
});

test('ortak kimlik deposu olmadan da (sso yok) normal giriş çalışır', async () => {
  serverAccepting();
  calls.length = 0;
  const acc = createAccount({
    userDataDir: tmpDir('mp-acc-'), appVersion: '1.0.0',
    encrypt: (x) => x, decrypt: (x) => x, getStore: () => ({ settings: {}, syncMeta: {} }),
    replaceLibrary() {}, persistStore() {}, resetSyncMeta() {}, onStatus() {}, onSessionExpired() {}, onUpdate() {},
  });
  await acc.login('demo@ornek.com', 'Test1234!', false);
  assert.equal(acc.isLoggedIn(), true);
  assert.equal(calls.find((c) => c.route === '/api/mp/auth/login').body.sso, false);
  assert.deepEqual(await acc.trySharedSignIn(), { ok: true });
});

// --- Kütüphane senkronu: yalnız ayarlar, uçtan uca şifreli ("mpr-enc-v1") ------------------------------------------------
test('senkron: sunucuya yalnız şifreli ayarlar gider; süreç verisi, olay günlüğü ve cihaza özgü ayarlar gitmez', async () => {
  serverAccepting();
  let lib = { version: null, blob: null };
  reply['/api/mp/me'] = () => [200, { user: { id: 7, email: 'demo@ornek.com' }, sync_enabled: true, kdf: KDF }];
  reply['/api/mp/library'] = (b) => {
    if (b && b.blob) { lib = { version: (lib.version || 0) + 1, blob: b.blob }; return [200, { version: lib.version }]; }
    return [200, lib];
  };
  reply['/api/mp/releases/latest'] = () => [200, { version: '2.1.0', notes: 'yeni' }];
  const { acc, store } = makeApp(memoryKeyring(), tmpDir('mp-st-'));
  store.settings.appTheme = 'dark';
  await acc.login('demo@ornek.com', 'Test1234!', true);
  await acc.syncNow();
  assert.ok(lib.blob, 'blob yüklendi');
  const { encKey } = await deriveKeys('Test1234!', KDF);
  const plain = decryptLibrary(encKey, lib.blob);
  assert.equal(plain.schema, 1);
  assert.deepEqual(plain.items.map((x) => [x.id, x.kind]), [['settings', 'settings']]);
  const s = plain.items[0];
  assert.deepEqual(Object.keys(s.data).sort(), ['appTheme', 'language', 'view']);
  assert.equal(s.data.appTheme, 'dark');
  assert.deepEqual(s.data.view, { refreshMs: 1000, mode: 'tree', sort: { key: 'cpu', dir: -1 } });
  const text = JSON.stringify(plain);
  assert.ok(!text.includes('Gizli') && !text.includes('gizli.exe') && !text.includes('4242'));
  assert.ok(!text.includes('minimizeToTray') && !text.includes('openAtLogin') && !text.includes('closeToTray') && !text.includes('checkUpdates'));
  // başka uygulamanın anahtar türetme etiketi çözemez
  const crypto = require('crypto');
  const other = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(32, 9), Buffer.alloc(0), Buffer.from('sdl-enc-v1'), 32));
  assert.throws(() => decryptLibrary(other, lib.blob), { code: 'decrypt_failed' });
  // güncelleme denetimi /api/mp/releases/latest
  const up = await acc.checkUpdate({ manual: true });
  assert.deepEqual([up.latest, up.newer], ['2.1.0', true]);
  assert.ok(calls.some((c) => c.route === '/api/mp/releases/latest'));
});

test('senkron: yeni cihazda hesaptaki ayarlar yüklenir, cihaza özgü ayarlar korunur', async () => {
  serverAccepting();
  const { encKey } = await deriveKeys('Test1234!', KDF);
  const T = Date.now() - 60000;
  const remote = encryptLibrary(encKey, { schema: 1, items: [
    { id: 'settings', kind: 'settings', updated_at: T, rev: 3, device: 'baska', deleted: false, data: { appTheme: 'light', language: 'de', view: { refreshMs: 2000, mode: 'list' } } },
  ] });
  let put = 0;
  reply['/api/mp/library'] = (b) => (b && b.blob ? (put++, [200, { version: 6 }]) : [200, { version: 5, blob: remote }]);
  const { acc, store, events } = makeApp(memoryKeyring(), tmpDir('mp-st-'));
  await acc.login('demo@ornek.com', 'Test1234!', true);
  await acc.syncNow();
  assert.ok(events.includes('replace'));
  assert.equal(store.settings.appTheme, 'light');
  assert.equal(store.settings.language, 'de');
  assert.deepEqual(store.settings.view, { refreshMs: 2000, mode: 'list' });
  assert.equal(store.settings.minimizeToTray, true, 'cihaza özgü ayar korunur');
  assert.equal(store.events.length, 1, 'olay günlüğüne dokunulmaz');
  assert.equal(put, 0, 'sunucu zaten güncel');
});
