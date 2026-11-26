'use strict';

// Süreç verisi sağlayıcısı: Windows'ta yerel yardımcı (mp-agent.exe), Linux'ta procfs. İkisi de aynı protokolü
// konuşur (docs/agent-protocol.md): start() → hello, request(cmd, args) → data ya da .code'lu Error.
function createProvider(opts) {
  if (process.platform === 'win32') return require('./provider-win').createProvider(opts);
  if (process.platform === 'linux') return require('./provider-linux').createProvider(opts);
  const e = new Error(`unsupported platform: ${process.platform}`);
  e.code = 'unsupported';
  return { kind: 'none', start: () => Promise.reject(e), request: () => Promise.reject(e), stop: () => {}, onExit: () => {} };
}

module.exports = { createProvider };
