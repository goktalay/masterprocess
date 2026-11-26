'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/tree');

const COLS = ['pid', 'ppid', 'name', 'cpu', 'ws', 'priv', 'ioRead', 'ioWrite', 'gpu', 'gpuDed', 'gpuShr', 'threads', 'handles', 'start', 'session'];
const row = (pid, ppid, name, cpu = 0, ws = 0, start = 1000 + pid) => [pid, ppid, name, cpu, ws, 0, 10, 5, 0, 0, 0, 1, 1, start, 0];
const sample = () => T.rowsToObjects(COLS, [
  row(4, 0, 'System', 0.1, 100),
  row(100, 4, 'smss.exe', 0, 50),
  row(200, 0, 'explorer.exe', 2, 900),
  row(210, 200, 'chrome.exe', 8, 700),
  row(211, 210, 'chrome.exe', 3, 300),
  row(212, 210, 'chrome.exe', 5, 400),
  row(220, 200, 'notepad.exe', 0, 20),
  row(900, 777, 'orphan.exe', 1, 10),
]);

test('rowsToObjects: sütun adları, anahtar ve toplam G/Ç', () => {
  const p = sample()[3];
  assert.equal(p.pid, 210);
  assert.equal(p.name, 'chrome.exe');
  assert.equal(p.key, '210:1210');
  assert.equal(p.io, 15);
});

test('buildTree: ebeveyni olmayan ve ebeveyni listede bulunmayan süreçler kök olur', () => {
  const { roots, byPid } = T.buildTree(sample());
  assert.deepEqual(roots.map((n) => n.p.pid).sort((a, b) => a - b), [4, 200, 900]);
  assert.deepEqual(byPid.get(210).children.map((n) => n.p.pid).sort(), [211, 212]);
  assert.equal(byPid.get(211).parent.p.pid, 210);
});

test('buildTree: kendine ya da çevrime işaret eden ebeveyn sonsuz döngüye sokmaz', () => {
  const procs = T.rowsToObjects(COLS, [row(1, 1, 'self'), row(2, 3, 'a'), row(3, 2, 'b')]);
  const { roots } = T.buildTree(procs);
  const flat = T.flattenTree(roots);
  assert.equal(flat.length, 3);
  assert.ok(roots.some((n) => n.p.pid === 1));
});

test('flattenTree: derinlik, kardeş sıralaması ve daraltma', () => {
  const { roots } = T.buildTree(sample());
  const flat = T.flattenTree(roots, { sortKey: 'cpu', sortDir: -1 });
  assert.deepEqual(flat.map((r) => r.p.pid), [200, 210, 212, 211, 220, 900, 4, 100]);
  assert.deepEqual(flat.map((r) => r.depth), [0, 1, 2, 2, 1, 0, 0, 1]);
  assert.equal(flat[1].hasChildren, true);
  assert.equal(flat[4].last, true);

  const collapsed = new Set(['210:1210']);
  const c = T.flattenTree(roots, { sortKey: 'cpu', sortDir: -1, collapsed });
  assert.deepEqual(c.map((r) => r.p.pid), [200, 210, 220, 900, 4, 100]);
  assert.equal(c[1].collapsed, true);
});

test('flattenTree: kılavuz çizgileri — son olmayan atanın altında çizgi sürer', () => {
  const { roots } = T.buildTree(sample());
  const flat = T.flattenTree(roots, { sortKey: 'name', sortDir: 1 });
  const r211 = flat.find((r) => r.p.pid === 211);
  // explorer (kök, son değil) → chrome (explorer'ın ilk çocuğu, son değil)
  assert.deepEqual(r211.guides, [true, true]);
});

test('flattenList: tek düzey, ada göre harf duyarsız sıralama', () => {
  const flat = T.flattenList(sample(), { sortKey: 'name', sortDir: 1 });
  assert.equal(flat[0].p.name, 'chrome.exe');
  assert.ok(flat.every((r) => r.depth === 0 && !r.hasChildren));
  assert.equal(flat[flat.length - 1].p.name, 'System');
});

test('filterProcs: ad ve PID eşleşmesi; ağaçta atalar korunur', () => {
  const procs = sample();
  const a = T.filterProcs(procs, 'NOTE');
  assert.deepEqual(a.procs.map((p) => p.pid), [220]);
  const b = T.filterProcs(procs, 'note', { keepAncestors: true });
  assert.deepEqual(b.procs.map((p) => p.pid), [200, 220]);
  assert.ok(b.matched.has(220) && !b.matched.has(200));
  assert.deepEqual(T.filterProcs(procs, '21').procs.map((p) => p.pid), [210, 211, 212]);
  assert.equal(T.filterProcs(procs, '  ').matched, null);
});

test('subtreePids: önce yapraklar, en son kök', () => {
  const { byPid } = T.buildTree(sample());
  const pids = T.subtreePids(byPid, 200);
  assert.equal(pids[pids.length - 1], 200);
  assert.ok(pids.indexOf(211) < pids.indexOf(210));
  assert.equal(pids.length, 5);
  assert.deepEqual(T.subtreePids(byPid, 99999), []);
});

test('subtreeSum: dalın toplamı kökü de içerir', () => {
  const { byPid } = T.buildTree(sample());
  const s = T.subtreeSum(byPid.get(210), ['cpu', 'ws']);
  assert.equal(s.count, 3);
  assert.equal(s.cpu, 16);
  assert.equal(s.ws, 1400);
});
