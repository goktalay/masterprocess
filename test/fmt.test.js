'use strict';

const test = require('node:test');
const assert = require('node:assert');
const FMT = require('../src/renderer/fmt');

test('bytes: birim ve basamak', () => {
  assert.strictEqual(FMT.bytes(0), '0 B');
  assert.strictEqual(FMT.bytes(999), '999 B');
  assert.strictEqual(FMT.bytes(1024), '1.00 KB');
  assert.strictEqual(FMT.bytes(1536), '1.50 KB');
  assert.strictEqual(FMT.bytes(12.34 * 1024 * 1024), '12.3 MB');
  assert.strictEqual(FMT.bytes(123 * 1024 ** 3), '123 GB');
  assert.strictEqual(FMT.bytes(1024 ** 2 - 1), '1.00 MB');
  assert.strictEqual(FMT.bytes(-1), '—');
  assert.strictEqual(FMT.bytes(NaN), '—');
  assert.strictEqual(FMT.bytes(2 * 1024 ** 4), '2.00 TB');
});

test('rate ve pct', () => {
  assert.strictEqual(FMT.rate(2048), '2.00 KB/s');
  assert.strictEqual(FMT.rate(2048, 'sn'), '2.00 KB/sn');
  assert.strictEqual(FMT.pct(0), '0');
  assert.strictEqual(FMT.pct(0.04), '0');
  assert.strictEqual(FMT.pct(3.14159), '3.1');
  assert.strictEqual(FMT.pct(42.6), '43');
  assert.strictEqual(FMT.pct(250), '100');
});

test('duration: en büyük iki birim', () => {
  assert.strictEqual(FMT.duration(5000), '5s');
  assert.strictEqual(FMT.duration(65000), '1m 5s');
  assert.strictEqual(FMT.duration(3 * 3600e3 + 7 * 60e3), '3h 7m');
  assert.strictEqual(FMT.duration(2 * 86400e3 + 5 * 3600e3), '2d 5h');
  assert.strictEqual(FMT.duration(65000, { m: 'dk', s: 'sn' }), '1dk 5sn');
  assert.strictEqual(FMT.duration(-5), '—');
});

test('addr, addrAdd, protect', () => {
  assert.strictEqual(FMT.addr('7ff6a1b20000'), '00007ff6a1b20000');
  assert.strictEqual(FMT.addr('10000'), '00010000');
  assert.strictEqual(FMT.addr('1f', 8), '0000001f');
  assert.strictEqual(FMT.addrAdd('7ffffffff000', 4096), '800000000000');
  assert.strictEqual(FMT.addrAdd('ffffffffffff0000', 16), 'ffffffffffff0010');
  assert.strictEqual(FMT.protect(0x04), 'RW-');
  assert.strictEqual(FMT.protect(0x20), 'R-X');
  assert.strictEqual(FMT.protect(0x104), 'RW-G');
  assert.strictEqual(FMT.protect(0), '');
});

test('midEllipsis, baseName, b64ToBytes', () => {
  assert.strictEqual(FMT.midEllipsis('kisa', 10), 'kisa');
  const long = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  const cut = FMT.midEllipsis(long, 20);
  assert.strictEqual(cut.length, 20);
  assert.ok(cut.startsWith('C:\\Wind') && cut.endsWith('hosts'));
  assert.strictEqual(FMT.baseName('C:\\a\\b.txt'), 'b.txt');
  assert.strictEqual(FMT.baseName('/usr/bin/node'), 'node');
  assert.deepStrictEqual([...FMT.b64ToBytes('TVo=')], [0x4d, 0x5a]);
  assert.strictEqual(FMT.b64ToBytes('').length, 0);
});
