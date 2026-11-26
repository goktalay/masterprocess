'use strict';

// Master Process — ana süreç. Bu bilgisayarda çalışan süreçleri izler: süreç verisini bir sağlayıcıdan alır
// (Windows'ta yerel yardımcı mp-agent.exe, Linux'ta procfs; sözleşme docs/agent-protocol.md), örnek tarihçesini ve
// başlama/bitme olay günlüğünü tutar, arayüze iletir. Süreç listesi, dosya yolları, bellek içeriği, pencere görüntüleri
// ve olay günlüğü yalnız bu bilgisayarda kalır; Mastertool hesabıyla yalnız ayarlar uçtan uca şifreli senkronlanır.

const { app, BrowserWindow, ipcMain, safeStorage, shell, clipboard, nativeTheme, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const I18N = require('./i18n');
const TREE = require('./tree');
const HISTORY = require('./history');
const { createProvider } = require('./provider');
const { createAccount, API_BASE } = require('./account');
const { createSso } = require('./sso');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const APP_NAME = 'Master Process';
const APP_CODE = 'mp';
const LOGIN_ITEM = 'MastertoolMasterProcess';
const REFRESH_CHOICES = [1000, 2000, 5000];
const SORT_KEYS = ['name', 'pid', 'cpu', 'ws', 'priv', 'io', 'gpu', 'threads', 'handles', 'start'];
const HISTORY_CAPACITY = 300; // süreç başına tutulan örnek (1 sn aralıkla 5 dk)
const EVENTS_MAX = 2000; // bellekte tutulan olay
const EVENTS_DAYS = 7; // diskte tutulan gün
const KNOWN_MAX = 50000;

// Tek örnek: ikinci açılış mevcut pencereyi öne getirir
let showMainWindow = () => {};
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showMainWindow());
  main();
}

function main() {
  let t = I18N.createT('en');
  const currentLang = () => (store && store.settings.language) || I18N.resolveLanguage(app.getLocale());
  function applyLanguage() { t = I18N.createT(currentLang()); }

  // -------------------------------------------------------------------------
  // Depo (userData/store.json): ayarlar + senkron zaman damgaları
  // -------------------------------------------------------------------------
  const storePath = () => path.join(app.getPath('userData'), 'store.json');
  let store = null;

  const defaultView = () => ({ refreshMs: 1000, mode: 'tree', sort: { key: 'name', dir: 1 } });
  function sanitizeView(v) {
    const d = defaultView();
    const o = v && typeof v === 'object' ? v : {};
    const sort = o.sort && typeof o.sort === 'object' ? o.sort : {};
    return {
      refreshMs: REFRESH_CHOICES.includes(o.refreshMs) ? o.refreshMs : d.refreshMs,
      mode: o.mode === 'list' ? 'list' : 'tree',
      sort: { key: SORT_KEYS.includes(sort.key) ? sort.key : d.sort.key, dir: sort.dir === -1 ? -1 : 1 },
    };
  }

  function defaultStore() {
    return {
      syncMeta: {},
      settings: {
        appTheme: 'system',
        language: null,
        view: defaultView(),
        // cihaza özgü (senkronlanmaz)
        openAtLogin: false,
        minimizeToTray: false,
        closeToTray: false,
        checkUpdates: true,
        trayHintShown: false,
      },
    };
  }

  function loadStore() {
    try {
      store = { ...defaultStore(), ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
      store.settings = { ...defaultStore().settings, ...(store.settings || {}) };
      if (!store.syncMeta) store.syncMeta = {};
    } catch {
      store = defaultStore();
    }
    store.settings.view = sanitizeView(store.settings.view);
    if (!I18N.LANGUAGES[store.settings.language]) store.settings.language = null;
    applyAppTheme();
    applyLanguage();
  }

  let saveTimer = null;
  function saveStore({ sync = true } = {}) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeStore, 150);
    if (sync && account) account.onLocalChange();
  }
  function writeStore() {
    clearTimeout(saveTimer);
    saveTimer = null;
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
  }

  function applyAppTheme() {
    const v = store.settings.appTheme;
    nativeTheme.themeSource = v === 'dark' || v === 'light' ? v : 'system';
  }
  const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#eef2f7');

  function encrypt(text) {
    if (!text) return '';
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
    return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  }
  function decrypt(value) {
    if (!value) return '';
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
    return value;
  }

  function publicSettings() {
    const { trayHintShown, ...rest } = store.settings;
    return { ...rest, language: store.settings.language || currentLang() };
  }
  const publicStore = () => ({ settings: publicSettings() });

  const send = (ch, data) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, data);
  };
  function broadcastStore() {
    send('store:changed', publicStore());
    if (tray) tray.setContextMenu(buildTrayMenu());
  }

  const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
  function applyOpenAtLogin() {
    if (!app.isPackaged || process.platform !== 'win32') return;
    app.setLoginItemSettings({ openAtLogin: !!store.settings.openAtLogin, path: exePath(), args: ['--hidden'], name: LOGIN_ITEM });
  }
  const openAtLoginState = () =>
    (app.isPackaged && process.platform === 'win32'
      ? app.getLoginItemSettings({ path: exePath(), args: ['--hidden'] }).openAtLogin
      : !!store.settings.openAtLogin);

  // -------------------------------------------------------------------------
  // Olay günlüğü: süreç başlama/bitme kayıtları. Bellekte son EVENTS_MAX, diskte gün başına bir dosya
  // (userData/events-YYYY-AA-GG.jsonl), son EVENTS_DAYS gün. Yalnız bu bilgisayarda kalır.
  // -------------------------------------------------------------------------
  let events = [];
  let eventQueue = Promise.resolve();
  const dayOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const eventFile = (day) => path.join(app.getPath('userData'), `events-${day}.jsonl`);

  function loadEvents() {
    events = [];
    let names = [];
    try { names = fs.readdirSync(app.getPath('userData')).filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch { return; }
    const keepFrom = dayOf(Date.now() - (EVENTS_DAYS - 1) * 86400000);
    for (const n of names) {
      const day = n.slice(7, 17);
      if (day < keepFrom) { try { fs.unlinkSync(path.join(app.getPath('userData'), n)); } catch {} continue; }
      let text = '';
      try { text = fs.readFileSync(path.join(app.getPath('userData'), n), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (e && e.type && e.pid != null) events.push(e); } catch {}
      }
    }
    if (events.length > EVENTS_MAX) events = events.slice(events.length - EVENTS_MAX);
  }

  function recordEvents(list) {
    if (!list.length) return;
    for (const e of list) events.push(e);
    if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
    const byDay = new Map();
    for (const e of list) {
      const day = dayOf(e.t);
      byDay.set(day, (byDay.get(day) || '') + JSON.stringify(e) + '\n');
    }
    // Yazmalar sırayla (art arda gelen anlık görüntüler satırları karıştırmasın)
    for (const [day, text] of byDay) {
      eventQueue = eventQueue.then(() => fs.promises.appendFile(eventFile(day), text, 'utf8')).catch(() => {});
    }
  }

  async function clearEvents() {
    events = [];
    await eventQueue;
    let names = [];
    try { names = fs.readdirSync(app.getPath('userData')).filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)); } catch {}
    for (const n of names) { try { fs.unlinkSync(path.join(app.getPath('userData'), n)); } catch {} }
  }

  // -------------------------------------------------------------------------
  // İzleyici: sağlayıcıdan aralıklı anlık görüntü → tarihçe + olay günlüğü → arayüz
  // -------------------------------------------------------------------------
  let provider = null;
  let hello = null;
  let monError = null; // { code, message }
  let monTimer = null;
  let monBusy = false;
  let monPaused = false;
  let monStopped = true;
  let lastSnap = null; // { t, sys, cols, procs (satırlar) }
  let lastProcs = []; // nesneler
  let history = HISTORY.createHistory({ capacity: HISTORY_CAPACITY });

  // Arayüzün dosya/pencere uçlarına verebileceği değerler: yalnız sağlayıcının daha önce döndürdükleri.
  const knownPaths = new Set();
  const knownHwnds = new Set();
  function remember(set, value) {
    if (typeof value !== 'string' || !value) return;
    if (set.size >= KNOWN_MAX) set.clear();
    set.add(value);
  }

  const monState = () => ({
    kind: provider ? provider.kind : null,
    platform: process.platform,
    hello,
    error: monError,
    paused: monPaused,
    refreshMs: store.settings.view.refreshMs,
    capacity: HISTORY_CAPACITY,
  });
  const errOf = (e) => ({ code: (e && e.code) || 'failed', message: String((e && e.message) || e || '') });

  async function startMonitor() {
    if (!monStopped) return;
    monStopped = false;
    monError = null;
    try {
      if (!provider) {
        provider = createProvider();
        provider.onExit(() => {
          // Yardımcı beklenmedik biçimde kapandı: sonraki istek onu yeniden başlatır; oranlar bir tur sıfırdan başlar
        });
      }
      hello = await provider.start();
    } catch (e) {
      monError = errOf(e);
      hello = null;
      monStopped = true;
      send('mon:state', monState());
      return;
    }
    send('mon:state', monState());
    scheduleTick(0);
  }

  function stopMonitor() {
    monStopped = true;
    clearTimeout(monTimer);
    monTimer = null;
    if (provider) { try { provider.stop(); } catch {} }
    provider = null;
    hello = null;
    lastSnap = null;
    lastProcs = [];
    history = HISTORY.createHistory({ capacity: HISTORY_CAPACITY });
    knownPaths.clear();
    knownHwnds.clear();
  }

  function scheduleTick(delay) {
    clearTimeout(monTimer);
    if (monStopped || monPaused) return;
    monTimer = setTimeout(tick, delay);
  }

  async function tick() {
    if (monStopped || monPaused || monBusy || !provider) return;
    monBusy = true;
    const started = Date.now();
    try {
      const snap = await provider.request('snapshot', {}, 20000);
      if (monStopped) return;
      const procs = TREE.rowsToObjects(snap.cols, snap.procs);
      const ev = history.push({ t: snap.t, sys: snap.sys, procs });
      lastSnap = snap;
      lastProcs = procs;
      const list = [];
      for (const s of ev.started) list.push({ type: 'start', ...s });
      for (const x of ev.exited) list.push({ type: 'exit', ...x });
      recordEvents(list);
      if (monError) { monError = null; send('mon:state', monState()); }
      send('mon:snapshot', { t: snap.t, sys: snap.sys, cols: snap.cols, procs: snap.procs, events: list });
      if (tray) tray.setContextMenu(buildTrayMenu());
    } catch (e) {
      if (monStopped) return;
      monError = errOf(e);
      send('mon:state', monState());
    } finally {
      monBusy = false;
      const wait = monError ? 3000 : Math.max(50, store.settings.view.refreshMs - (Date.now() - started));
      scheduleTick(wait);
    }
  }

  function setPaused(on) {
    monPaused = !!on;
    if (monPaused) { clearTimeout(monTimer); monTimer = null; } else scheduleTick(0);
    send('mon:state', monState());
  }

  // -------------------------------------------------------------------------
  // Mastertool hesabı (mastertool.download, /api/mp)
  // -------------------------------------------------------------------------
  let account = null;
  let loginWindow = null;
  let mainWindow = null;
  let loginNotice = null;
  let updateInfo = null;

  function initSso() {
    try { return createSso({ stateDir: path.join(app.getPath('appData'), 'Mastertool') }); } catch { return null; }
  }

  function initAccount() {
    account = createAccount({
      sso: initSso(),
      onSharedSignIn: () => enterApp(),
      onSharedSignOut: (code) => showLogin(code === 'app_disabled' ? t('auth.errAppDisabled') : null),
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      encrypt,
      decrypt,
      getStore: () => store,
      // Senkrondan gelen ayarlar (yeni senkron tetiklemeden)
      replaceLibrary: ({ settings, syncMeta }) => {
        const prevLang = currentLang();
        store.syncMeta = syncMeta;
        Object.assign(store.settings, settings);
        store.settings.view = sanitizeView(store.settings.view);
        if (!I18N.LANGUAGES[store.settings.language]) store.settings.language = null;
        writeStore();
        applyAppTheme();
        applyLanguage();
        if (currentLang() !== prevLang) onLanguageChanged();
        else { broadcastStore(); send('mon:state', monState()); }
      },
      persistStore: writeStore,
      resetSyncMeta: () => { store.syncMeta = {}; writeStore(); },
      onStatus: (st) => send('account:status', st),
      onSessionExpired: (code) =>
        showLogin(t(code === 'app_disabled' ? 'auth.errAppDisabled' : code === 'wrong_app' ? 'auth.errWrongApp' : 'auth.errSessionExpired')),
      onUpdate: (info) => {
        updateInfo = info;
        notifyUpdate(info);
        send('app:update', info);
      },
    });
  }

  function notifyUpdate(info) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: t('update.available', { version: info.version }), body: t('update.hint'), icon: ICON, silent: true });
    n.on('click', () => openWeb('account'));
    n.show();
  }

  function afterStart() {
    account.start().then(() => store.settings.checkUpdates && account.checkUpdate()).catch(() => {});
    startMonitor();
  }

  function enterApp() {
    loginNotice = null;
    if (!mainWindow) createMainWindow();
    if (loginWindow) loginWindow.destroy();
    afterStart();
  }

  const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };

  function createLoginWindow() {
    loginWindow = new BrowserWindow({
      width: 440, height: 640, resizable: false, maximizable: false,
      backgroundColor: windowBg(), title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
    });
    loginWindow.setMenuBarVisibility(false);
    loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!account || !account.isLoggedIn()) quit();
    });
  }

  function showLogin(notice) {
    loginNotice = notice || null;
    stopMonitor(); // oturum yokken süreç verisi okunmaz
    destroyTray();
    if (!loginWindow) createLoginWindow();
    else {
      loginWindow.webContents.reload();
      if (loginWindow.isMinimized()) loginWindow.restore();
      loginWindow.show();
      loginWindow.focus();
    }
    for (const w of BrowserWindow.getAllWindows()) if (w !== loginWindow) w.destroy();
    mainWindow = null;
  }

  // -------------------------------------------------------------------------
  // Ana pencere ve tepsi
  // -------------------------------------------------------------------------
  let tray = null;
  let isQuitting = false;

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1440, height: 880, minWidth: 1040, minHeight: 620,
      backgroundColor: windowBg(), title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('minimize', (e) => {
      if (!store.settings.minimizeToTray) return;
      e.preventDefault();
      hideToTray();
    });
    mainWindow.on('close', (e) => {
      if (store.settings.closeToTray && !isQuitting) {
        e.preventDefault();
        hideToTray();
      }
    });
    mainWindow.on('show', destroyTray);
    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
  }

  showMainWindow = function () {
    if (!account || !account.isLoggedIn()) {
      if (!loginWindow) { showLogin(); return; }
      if (loginWindow.isMinimized()) loginWindow.restore();
      loginWindow.show();
      loginWindow.focus();
      return;
    }
    if (!mainWindow) createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  function hideToTray() {
    ensureTray();
    if (mainWindow) mainWindow.hide();
    if (!store.settings.trayHintShown && tray) {
      store.settings.trayHintShown = true;
      saveStore({ sync: false });
      if (tray.displayBalloon) tray.displayBalloon({ title: APP_NAME, content: t('tray.hiddenHint'), icon: ICON });
    }
  }

  function buildTrayMenu() {
    const cpu = lastSnap && lastSnap.sys ? Math.round(lastSnap.sys.cpu || 0) : 0;
    return Menu.buildFromTemplate([
      { label: t('tray.show'), click: showMainWindow },
      { type: 'separator' },
      { label: t('tray.status', { count: lastProcs.length, cpu }), enabled: false },
      { type: 'separator' },
      { label: t('tray.quit'), click: quit },
    ]);
  }

  function ensureTray() {
    if (tray) { tray.setContextMenu(buildTrayMenu()); return; }
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  }

  function destroyTray() {
    if (tray) { tray.destroy(); tray = null; }
  }

  function quit() {
    isQuitting = true;
    stopMonitor();
    if (saveTimer) writeStore();
    app.quit();
  }

  // -------------------------------------------------------------------------
  // IPC — ortak
  // -------------------------------------------------------------------------
  ipcMain.on('app:lang', (e) => { e.returnValue = currentLang(); });
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.on('app:platform', (e) => { e.returnValue = process.platform; });

  ipcMain.handle('store:get', () => publicStore());

  const DEVICE_SETTINGS = ['openAtLogin', 'minimizeToTray', 'closeToTray', 'checkUpdates'];
  ipcMain.handle('settings:set', (_e, patch) => {
    const p = { ...(patch || {}) };
    const allowed = ['appTheme', 'language', 'view', ...DEVICE_SETTINGS];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) delete p[k];
    if ('appTheme' in p) p.appTheme = ['dark', 'light', 'system'].includes(p.appTheme) ? p.appTheme : 'system';
    if ('language' in p) p.language = I18N.LANGUAGES[p.language] ? p.language : null;
    if ('view' in p) {
      const v = p.view && typeof p.view === 'object' ? p.view : {};
      p.view = sanitizeView({ ...store.settings.view, ...v, sort: { ...store.settings.view.sort, ...(v.sort || {}) } });
    }
    for (const k of DEVICE_SETTINGS) if (k in p) p[k] = !!p[k];
    const prevLang = currentLang();
    const prevRefresh = store.settings.view.refreshMs;
    Object.assign(store.settings, p);
    const loud = Object.keys(p).some((k) => !DEVICE_SETTINGS.includes(k));
    saveStore({ sync: loud });
    if ('appTheme' in p) applyAppTheme();
    if ('openAtLogin' in p) applyOpenAtLogin();
    if (store.settings.view.refreshMs !== prevRefresh) { send('mon:state', monState()); scheduleTick(0); }
    if ('language' in p) {
      applyLanguage();
      if (currentLang() !== prevLang) { onLanguageChanged(); return { ok: true }; }
    }
    broadcastStore();
    return { ok: true };
  });

  function onLanguageChanged() {
    if (tray) tray.setContextMenu(buildTrayMenu());
    for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
  }

  ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text || '').slice(0, 200000)); return { ok: true }; });

  // -------------------------------------------------------------------------
  // IPC — izleyici ve süreç sorguları
  // -------------------------------------------------------------------------
  ipcMain.handle('mon:state', () => monState());
  // Açılışta: o ana dek biriken tarihçe + son anlık görüntü + olay günlüğü (tek sefer)
  ipcMain.handle('mon:init', () => ({
    state: monState(),
    history: history.dump(),
    snapshot: lastSnap ? { t: lastSnap.t, sys: lastSnap.sys, cols: lastSnap.cols, procs: lastSnap.procs, events: [] } : null,
    events,
  }));
  ipcMain.handle('mon:setPaused', (_e, on) => { setPaused(on); return { ok: true }; });
  ipcMain.handle('mon:retry', async () => {
    if (monStopped || monError) { stopMonitor(); await startMonitor(); }
    return monState();
  });
  ipcMain.handle('mon:clearEvents', async () => { await clearEvents(); return { ok: true }; });

  const isPid = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  const isHex = (v) => typeof v === 'string' && /^[0-9a-f]{1,16}$/.test(v);
  const fail = (code, message) => ({ ok: false, code, message: message || code });

  async function ask(cmd, args, timeout) {
    if (!provider || monStopped) return fail('failed', 'monitor is not running');
    try {
      return { ok: true, data: await provider.request(cmd, args, timeout) };
    } catch (e) {
      return { ok: false, ...errOf(e) };
    }
  }

  // Salt okunur sorgular. Yol / pencere argümanları yalnız sağlayıcının daha önce döndürdüğü değerler olabilir.
  ipcMain.handle('proc:query', async (_e, req) => {
    const { cmd, pid, addr, len, offset, hwnd, maxW } = req || {};
    const file = req && req.path;
    switch (cmd) {
      case 'detail': {
        if (!isPid(pid)) return fail('bad_request');
        const r = await ask('detail', { pid });
        if (r.ok) {
          remember(knownPaths, r.data.path);
          for (const w of r.data.windows || []) remember(knownHwnds, w.hwnd);
        }
        return r;
      }
      case 'modules': {
        if (!isPid(pid)) return fail('bad_request');
        const r = await ask('modules', { pid });
        if (r.ok) for (const m of r.data.modules || []) remember(knownPaths, m.path);
        return r;
      }
      case 'memmap': {
        if (!isPid(pid)) return fail('bad_request');
        const r = await ask('memmap', { pid }, 60000);
        if (r.ok) {
          const ni = (r.data.cols || []).indexOf('name');
          if (ni >= 0) for (const row of r.data.regions || []) if (row[ni]) remember(knownPaths, row[ni]);
        }
        return r;
      }
      case 'readmem': {
        if (!isPid(pid) || !isHex(addr) || !Number.isInteger(len) || len < 1 || len > 65536) return fail('bad_request');
        return ask('readmem', { pid, addr, len });
      }
      case 'handles': {
        if (!isPid(pid)) return fail('bad_request');
        const r = await ask('handles', { pid }, 30000);
        if (r.ok) for (const f of r.data.files || []) remember(knownPaths, f.path);
        return r;
      }
      case 'gpudetail': {
        if (!isPid(pid)) return fail('bad_request');
        return ask('gpudetail', { pid });
      }
      case 'filemap': {
        if (!knownPaths.has(file)) return fail('bad_request', 'unknown path');
        return ask('filemap', { path: file }, 30000);
      }
      case 'readfile': {
        if (!knownPaths.has(file)) return fail('bad_request', 'unknown path');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(len) || len < 1 || len > 65536) return fail('bad_request');
        return ask('readfile', { path: file, offset, len });
      }
      case 'capture': {
        if (!knownHwnds.has(hwnd)) return fail('bad_request', 'unknown window');
        const w = Number.isInteger(maxW) ? Math.min(3840, Math.max(64, maxW)) : 1280;
        return ask('capture', { hwnd, maxW: w }, 20000);
      }
      default:
        return fail('bad_request', 'unknown command');
    }
  });

  // Yönetim eylemleri (yalnız bu bilgisayardaki süreçler; onay kutusu arayüzde)
  const PRIORITIES = ['idle', 'below', 'normal', 'above', 'high'];
  ipcMain.handle('proc:action', async (_e, req) => {
    const { cmd, pid, value } = req || {};
    if (!isPid(pid)) return fail('bad_request');
    if (cmd === 'kill' || cmd === 'suspend' || cmd === 'resume') return ask(cmd, { pid }, 15000);
    if (cmd === 'priority') return PRIORITIES.includes(value) ? ask('priority', { pid, value }, 15000) : fail('bad_request');
    if (cmd === 'killTree') {
      // Son anlık görüntüdeki ağaç: önce torunlar, en son kök
      const { byPid } = TREE.buildTree(lastProcs);
      const pids = TREE.subtreePids(byPid, pid);
      if (!pids.length) return fail('gone');
      const failed = [];
      let killed = 0;
      for (const p of pids) {
        const r = await ask('kill', { pid: p }, 15000);
        if (r.ok) killed++;
        else if (r.code !== 'gone') failed.push({ pid: p, code: r.code });
      }
      return { ok: true, data: { total: pids.length, killed, failed } };
    }
    return fail('bad_request', 'unknown command');
  });

  ipcMain.handle('proc:reveal', (_e, file) => {
    if (!knownPaths.has(file) || !path.isAbsolute(file)) return fail('bad_request', 'unknown path');
    if (!fs.existsSync(file)) return fail('gone');
    shell.showItemInFolder(file);
    return { ok: true };
  });

  // Yönetici olarak yeniden başlat (Windows; yalnız yükseltilmemişken). UAC onayı Windows'undur; reddedilirse
  // uygulama olduğu gibi çalışmayı sürdürür.
  ipcMain.handle('app:elevate', () => new Promise((resolve) => {
    if (process.platform !== 'win32' || !hello || hello.elevated) { resolve(fail('unsupported')); return; }
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const args = app.isPackaged ? [] : [app.getAppPath()];
    let ps = `Start-Process -FilePath ${q(exePath())} -Verb RunAs`;
    if (args.length) ps += ` -ArgumentList ${args.map((a) => q(`"${a}"`)).join(',')}`;
    app.releaseSingleInstanceLock(); // yeni (yükseltilmiş) örnek kilidi alabilsin
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true }, (err) => {
      if (err) {
        app.requestSingleInstanceLock();
        resolve(fail('cancelled', String(err.message || '').slice(0, 300)));
        return;
      }
      resolve({ ok: true });
      setTimeout(quit, 150);
    });
  }));

  // --- Hesap --------------------------------------------------------------------
  ipcMain.handle('account:state', () => ({ ...account.state(), notice: loginNotice, appVersion: app.getVersion() }));

  ipcMain.handle('account:login', async (_e, { email, password, remember }) => {
    try {
      await account.login(email, password, remember);
      enterApp();
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code || 'error', message: e.message };
    }
  });

  ipcMain.handle('account:logout', async () => {
    await account.logout();
    showLogin();
  });

  ipcMain.handle('account:syncNow', () => account.syncNow());
  ipcMain.handle('account:setSync', async (_e, on) => {
    try { await account.setSyncEnabled(on); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
  });
  ipcMain.handle('account:deleteRemote', async () => {
    try { await account.deleteRemote(); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
  });

  ipcMain.handle('app:openMastertool', () => {
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    shell.openExternal(`https://mastertool.download/?lang=${encodeURIComponent(currentLang())}&theme=${theme}`);
  });

  function openWeb(page) {
    const allowed = { forgot: '/sifremi-unuttum', register: '/kayit', account: '/hesabim', tool: '/araclar/master-process' };
    if (!allowed[page]) return;
    const q = new URLSearchParams({ lang: currentLang(), theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', app: APP_CODE });
    shell.openExternal(`${API_BASE}${allowed[page]}?${q}`);
  }
  ipcMain.handle('account:openWeb', (_e, page) => openWeb(page));

  ipcMain.handle('app:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    openAtLogin: openAtLoginState(),
    portable: isPortable(),
    packaged: app.isPackaged,
    update: updateInfo,
    agent: hello ? { agent: hello.agent, protocol: hello.protocol, elevated: !!hello.elevated, kind: provider ? provider.kind : null } : null,
  }));

  ipcMain.handle('app:checkUpdate', async () => {
    try {
      return { ok: true, ...(await account.checkUpdate({ manual: true })) };
    } catch (e) {
      return { ok: false, code: e.code || 'error', message: e.message };
    }
  });

  ipcMain.handle('app:openLicenses', () => {
    const file = path.join(path.dirname(process.execPath), 'LICENSES.chromium.html');
    if (fs.existsSync(file)) return shell.openPath(file);
    return shell.openExternal('https://www.electronjs.org/docs/latest#license');
  });

  // -------------------------------------------------------------------------
  app.setAppUserModelId('com.mastertool.masterprocess');

  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopMonitor();
  });
  app.on('window-all-closed', () => {
    if (!tray || !account || !account.isLoggedIn()) quit();
  });

  app.whenReady().then(async () => {
    loadStore();
    loadEvents();
    initAccount();
    applyOpenAtLogin();
    if (!account.isLoggedIn()) {
      const r = await account.trySharedSignIn();
      if (r.code === 'app_disabled') loginNotice = t('auth.errAppDisabled');
    }
    account.watchShared();
    if (account.isLoggedIn()) {
      createMainWindow();
      if (process.argv.includes('--hidden') && store.settings.minimizeToTray) mainWindow.once('ready-to-show', () => hideToTray());
      afterStart();
    } else {
      showLogin(loginNotice);
    }
  });
}
