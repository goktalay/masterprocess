'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STRINGS, LANGUAGES, createT, resolveLanguage } = require('../src/i18n');

// Kodda kullanılan her anahtar sözlükte olmalı (dinamik anahtarlar dahil)
test('i18n: kullanılan anahtarlar sözlükte var', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = ['main.js', ...fs.readdirSync(path.join(dir, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => 'renderer/' + f)];
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\bt\('([\w-]+\.[\w.-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/'((?:auth|keys|col|err)\.[\w.]+)'/g)) used.add(m[1]);
  }
  for (const k of ['idle', 'below', 'normal', 'above', 'high', 'realtime']) used.add('prio.' + k);
  for (const k of ['general', 'perf', 'memory', 'disk', 'gpu', 'window', 'modules', 'threads', 'history']) used.add('tab.' + k);
  for (const k of ['overview', 'history']) used.add('systab.' + k);
  for (const k of ['run', 'ready', 'wait', 'other']) used.add('thr.st.' + k);
  for (const k of ['name', 'pid', 'cpu', 'mem', 'io', 'gpu', 'threads', 'handles']) { used.add('col.' + k); used.add('col.' + k + 'Hint'); }
  // Sağlayıcıların ve ana sürecin döndürebildiği tüm hata kodları
  for (const k of ['access', 'gone', 'bad_request', 'unsupported', 'timeout', 'failed', 'cancelled']) used.add('err.' + k);
  const missing = [...used].filter((k) => !k.endsWith('.') && !(k in STRINGS.en));
  assert.deepStrictEqual(missing, []);
  assert.ok(used.size > 250, 'tarama çalışmıyor');
});

// Mastertool standardı: 8 dil sabit sırayla, hepsinde aynı anahtarlar ve aynı yer tutucular
test('i18n: 8 dil, anahtar ve yer tutucu eşliği', () => {
  assert.deepStrictEqual(Object.keys(LANGUAGES), ['tr', 'en', 'fr', 'de', 'es', 'ar', 'zh', 'ru']);
  assert.strictEqual(LANGUAGES.ar.dir, 'rtl');
  const keys = Object.keys(STRINGS.en).sort();
  const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
  for (const l of Object.keys(LANGUAGES)) {
    assert.deepStrictEqual(Object.keys(STRINGS[l]).sort(), keys, l);
    for (const k of keys) {
      assert.strictEqual(ph(STRINGS[l][k]), ph(STRINGS.en[k]), `${l} ${k}`);
      assert.ok(String(STRINGS[l][k]).trim(), `${l} ${k} boş`);
      if (k !== 'about.family') assert.ok(!/Social Download|IP Tools|Quick Preview|Master 3D/.test(STRINGS[l][k]), `${l} ${k}: başka uygulamanın metni`);
    }
  }
});

// Çevrilmemiş (İngilizcede kalmış) metin kalmasın: uzun cümleler diller arasında aynı olamaz
test('i18n: çevrilmemiş uzun metin yok', () => {
  for (const l of Object.keys(LANGUAGES)) {
    if (l === 'en') continue;
    const same = Object.keys(STRINGS.en).filter((k) => STRINGS[l][k] === STRINGS.en[k] && STRINGS.en[k].replace(/\{\w+\}/g, '').split(/\s+/).filter((w) => /[a-z]{3}/i.test(w)).length >= 4);
    assert.deepStrictEqual(same, [], l);
  }
});

test('i18n: dil çözümleme ve yer tutucu doldurma', () => {
  assert.strictEqual(resolveLanguage('tr-TR'), 'tr');
  assert.strictEqual(resolveLanguage('pt-BR'), 'en');
  assert.strictEqual(resolveLanguage(''), 'en');
  assert.strictEqual(createT('tr')('update.available', { version: '9.9.9' }), STRINGS.tr['update.available'].replace('{version}', '9.9.9'));
  assert.ok(createT('xx')('tray.show').includes('Master Process'));
  assert.strictEqual(createT('en')('yok.anahtar'), 'yok.anahtar');
});
