'use strict';

// Testler için ortak yardımcılar.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Bellek içi anahtarlık: işletim sistemi kimlik deposunun yerine geçer.
function memoryKeyring() {
  let value = null;
  return { get: () => value, set: (v) => { value = String(v); }, del: () => { value = null; }, peek: () => value };
}

function tmpDir(prefix = 'mp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { memoryKeyring, tmpDir };
