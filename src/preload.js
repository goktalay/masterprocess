'use strict';

// Giriş ve ana pencere (yalıtılmış, sandbox; Node erişimi yok)
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  // arayüz dili (açılışta senkron alınır ki ilk çizim doğru dilde olsun)
  lang: ipcRenderer.sendSync('app:lang'),
  version: ipcRenderer.sendSync('app:version'),
  platform: ipcRenderer.sendSync('app:platform'),

  // Mastertool hesabı ve senkron
  accountState: () => ipcRenderer.invoke('account:state'),
  login: (email, password, remember) => ipcRenderer.invoke('account:login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('account:logout'),
  syncNow: () => ipcRenderer.invoke('account:syncNow'),
  setSyncEnabled: (on) => ipcRenderer.invoke('account:setSync', on),
  deleteRemoteLibrary: () => ipcRenderer.invoke('account:deleteRemote'),
  openWeb: (page) => ipcRenderer.invoke('account:openWeb', page), // 'forgot' | 'register' | 'account' | 'tool'
  onAccountStatus: on('account:status'),
  onUpdateAvailable: on('app:update'),
  openMastertool: () => ipcRenderer.invoke('app:openMastertool'),
  about: () => ipcRenderer.invoke('app:about'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openLicenses: () => ipcRenderer.invoke('app:openLicenses'),

  // ayarlar
  getStore: () => ipcRenderer.invoke('store:get'),
  onStoreChanged: on('store:changed'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),

  // izleyici: anlık görüntü akışı, tarihçe, olay günlüğü
  monInit: () => ipcRenderer.invoke('mon:init'),
  monState: () => ipcRenderer.invoke('mon:state'),
  monRetry: () => ipcRenderer.invoke('mon:retry'),
  setPaused: (on) => ipcRenderer.invoke('mon:setPaused', on),
  clearEvents: () => ipcRenderer.invoke('mon:clearEvents'),
  onSnapshot: on('mon:snapshot'),
  onMonState: on('mon:state'),

  // süreç sorguları (salt okunur): detail | modules | memmap | readmem | handles | gpudetail | filemap | volmap | readfile |
  // capture; ağ: netcap | netconns | netwatch | netstream
  query: (cmd, args) => ipcRenderer.invoke('proc:query', { ...(args || {}), cmd }),
  // yönetim: kill | killTree | suspend | resume | priority
  action: (cmd, pid, value) => ipcRenderer.invoke('proc:action', { cmd, pid, value }),
  reveal: (file) => ipcRenderer.invoke('proc:reveal', file),
  elevate: () => ipcRenderer.invoke('app:elevate'),
  // gelen paketlerin yakalanması için güvenlik duvarı kuralı (Windows): status | allow | remove
  firewall: (op) => ipcRenderer.invoke('net:firewall', op),
});
