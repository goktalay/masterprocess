'use strict';
// Ana sürecin yüklenebilirliği: electron sahte modülle değiştirilir, main.js çalıştırılır; IPC kanallarının preload.js ile
// uyumu, depo oluşturma, giriş penceresinin açılması ve girişsizken izleyicinin çalışmaması doğrulanır.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');

test('main.js sahte electron ile yüklenir, IPC kanallarını kaydeder ve giriş penceresini açar', async () => {
  const userData = tmpDir('mp-main-');
  const handles = new Map();
  const ons = new Map();
  const windows = [];
  const revealed = [];
  let whenReadyResolve;
  const ready = new Promise((r) => (whenReadyResolve = r));

  class FakeWindow {
    constructor(opts) { this.opts = opts; this.webContents = { send() {}, reload() {}, id: windows.length, on() {}, setWindowOpenHandler() {} }; windows.push(this); this.events = {}; }
    setMenuBarVisibility() {}
    loadFile(file) { this.file = file; }
    on(ev, cb) { this.events[ev] = cb; }
    once() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isFocused() { return false; }
    isVisible() { return true; }
    show() {} focus() {} hide() {} destroy() {} restore() {}
    static getAllWindows() { return windows; }
    static fromWebContents() { return windows[0]; }
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, on: () => {}, exit() {}, quit() {}, relaunch() {},
      getPath: (k) => (k === 'userData' ? userData : path.join(userData, k)), getLocale: () => 'tr-TR', getVersion: () => '2.0.0',
      isPackaged: false, setAppUserModelId() {}, setLoginItemSettings() {}, getLoginItemSettings: () => ({ openAtLogin: false }),
      whenReady: () => ready,
    },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (ch, fn) => handles.set(ch, fn), on: (ch, fn) => ons.set(ch, fn) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal() {}, openPath: async () => '', showItemInFolder(f) { revealed.push(f); } },
    dialog: {}, clipboard: { writeText() {} },
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
    Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    Notification: { isSupported: () => false },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    if (request === '@napi-rs/keyring') throw new Error('keyring yok (test)');
    return origLoad.call(this, request, ...rest);
  };
  try {
    require('../src/main.js');
    whenReadyResolve();
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    Module._load = origLoad;
  }
  // preload.js'teki her invoke kanalı ana süreçte kayıtlı
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const invoked = [...preload.matchAll(/invoke\('([\w:]+)'/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 20, String(invoked.length));
  for (const ch of invoked) assert.ok(handles.has(ch), ch);
  assert.ok(ons.has('app:lang') && ons.has('app:version') && ons.has('app:platform'));
  // Girişsiz başlangıç: yalnız giriş penceresi; izleyici çalışmıyor
  assert.equal(windows.length, 1);
  assert.ok(windows[0].file.endsWith(path.join('renderer', 'login.html')));
  assert.deepEqual([windows[0].opts.width, windows[0].opts.height], [440, 640]);
  assert.equal(windows[0].opts.webPreferences.sandbox, true);
  assert.equal(windows[0].opts.webPreferences.contextIsolation, true);
  assert.equal(windows[0].opts.webPreferences.nodeIntegration, false);
  const init = await handles.get('mon:init')();
  assert.equal(init.snapshot, null);
  assert.deepEqual(init.events, []);
  assert.equal(init.state.hello, null);

  // Ayarlar: geçersiz değerler temizlenir, bilinmeyen alanlar atılır
  const s = await handles.get('settings:set')({}, { appTheme: 'zebra', view: { refreshMs: 17, mode: 'x', sort: { key: 'hack', dir: 'up' } }, minimizeToTray: 'evet', hack: 1 });
  assert.equal(s.ok, true);
  const st = await handles.get('store:get')();
  assert.equal(st.settings.appTheme, 'system');
  assert.ok([1000, 2000, 5000].includes(st.settings.view.refreshMs));
  assert.ok(['tree', 'list'].includes(st.settings.view.mode));
  assert.ok([1, -1].includes(st.settings.view.sort.dir));
  assert.notEqual(st.settings.view.sort.key, 'hack');
  assert.equal(st.settings.minimizeToTray, true);
  assert.equal(st.settings.hack, undefined);

  // Sorgular: argümanlar doğrulanır; dosya ve pencere uçları yalnız sağlayıcının daha önce döndürdüğü değerleri kabul eder
  const q = handles.get('proc:query');
  for (const req of [
    null, { cmd: 'yok' }, { cmd: 'detail', pid: '1' }, { cmd: 'detail', pid: -4 }, { cmd: 'modules', pid: 1.5 },
    { cmd: 'readmem', pid: 4, addr: '0x10', len: 16 }, { cmd: 'readmem', pid: 4, addr: '10', len: 70000 },
    { cmd: 'readfile', path: '/etc/passwd', offset: 0, len: 16 }, { cmd: 'filemap', path: 'C:\\Windows\\win.ini' },
    { cmd: 'capture', hwnd: 'a0b1', maxW: 800 },
  ]) {
    const r = await q({}, req);
    assert.deepEqual([r.ok, r.code], [false, 'bad_request'], JSON.stringify(req));
  }
  const a = handles.get('proc:action');
  for (const req of [null, { cmd: 'kill' }, { cmd: 'kill', pid: 'x' }, { cmd: 'priority', pid: 4, value: 'turbo' }, { cmd: 'format', pid: 4 }]) {
    const r = await a({}, req);
    assert.deepEqual([r.ok, r.code], [false, 'bad_request'], JSON.stringify(req));
  }
  const rv = await handles.get('proc:reveal')({}, '/etc/passwd');
  assert.deepEqual([rv.ok, rv.code], [false, 'bad_request']);
  assert.deepEqual(revealed, []);

  const about = await handles.get('app:about')();
  assert.equal(about.version, '2.0.0');
  assert.equal(about.agent, null);
});
