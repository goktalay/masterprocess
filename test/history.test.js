'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory } = require('../src/history');

const P = (pid, name, cpu, ws = 0, io = 0, gpu = 0, start = 5000 + pid) => ({ key: `${pid}:${start}`, pid, ppid: 1, name, start, cpu, ws, io, gpu });
const snap = (t, procs, cpu = 10) => ({ t, sys: { cpu, memTotal: 1000, memAvail: 250, ioRead: 30, ioWrite: 12, gpu: 4 }, procs });

test('ilk anlık görüntüde olay üretilmez; sonrakilerde başlayan ve biten süreçler bildirilir', () => {
  const h = createHistory({ capacity: 8 });
  let ev = h.push(snap(10000, [P(1, 'a', 5), P(2, 'b', 1)]));
  assert.deepEqual(ev, { started: [], exited: [] });
  ev = h.push(snap(11000, [P(1, 'a', 7), P(3, 'c', 2)]));
  assert.deepEqual(ev.started.map((e) => [e.pid, e.name, e.t]), [[3, 'c', 11000]]);
  assert.equal(ev.exited.length, 1);
  assert.equal(ev.exited[0].pid, 2);
  assert.equal(ev.exited[0].name, 'b');
  assert.equal(ev.exited[0].lifeMs, 11000 - 5002);
  assert.equal(ev.exited[0].peakCpu, 1);
  assert.equal(h.size(), 2);
});

test('aynı PID yeni başlangıç zamanıyla gelirse eski biter, yenisi başlar', () => {
  const h = createHistory({ capacity: 8 });
  h.push(snap(1, [P(7, 'x', 1, 0, 0, 0, 100)]));
  const ev = h.push(snap(2, [P(7, 'y', 1, 0, 0, 0, 200)]));
  assert.equal(ev.started[0].name, 'y');
  assert.equal(ev.exited[0].name, 'x');
});

test('seriler: en eskiden en yeniye, kapasiteyi aşınca en eski düşer', () => {
  const h = createHistory({ capacity: 4 });
  for (let i = 1; i <= 6; i++) h.push(snap(i * 1000, [P(1, 'a', i, i * 100, i * 10, i)], i));
  const s = h.series('1:5001');
  assert.equal(s.n, 4);
  assert.deepEqual(Array.from(s.cpu), [3, 4, 5, 6]);
  assert.deepEqual(Array.from(s.ws), [300, 400, 500, 600]);
  assert.deepEqual(Array.from(s.io), [30, 40, 50, 60]);
  assert.equal(s.peakCpu, 6);
  const sys = h.sysSeries();
  assert.deepEqual(Array.from(sys.cpu), [3, 4, 5, 6]);
  assert.deepEqual(Array.from(sys.t), [3000, 4000, 5000, 6000]);
  assert.equal(sys.mem[0], 75);
  assert.equal(sys.io[0], 42);
  assert.equal(h.series('yok'), null);
});

test('ağ serileri: süreç ve sistem için gelen / giden ayrı tutulur', () => {
  const h = createHistory({ capacity: 4 });
  for (let i = 1; i <= 3; i++) {
    h.push({ t: i, sys: { cpu: 1, memTotal: 100, memAvail: 50, netRx: i * 100, netTx: i * 10 },
      procs: [{ key: '1:5', pid: 1, name: 'a', start: 5, cpu: 1, net: i * 11, netRx: i * 10, netTx: i }] });
  }
  const s = h.series('1:5');
  assert.deepEqual(Array.from(s.net), [11, 22, 33]);
  assert.deepEqual(Array.from(s.netRx), [10, 20, 30]);
  assert.deepEqual(Array.from(s.netTx), [1, 2, 3]);
  const sys = h.sysSeries();
  assert.deepEqual(Array.from(sys.net), [110, 220, 330]);
  assert.deepEqual(Array.from(sys.netRx), [100, 200, 300]);
  // Ağ serisi olmayan eski döküm: seriler sıfırla, aynı uzunlukta yüklenir
  const d = structuredClone(h.dump());
  delete d.procs['1:5'].net; delete d.sys.netRx;
  const b = createHistory({ capacity: 4 });
  b.load(d);
  assert.deepEqual(Array.from(b.series('1:5').net), [0, 0, 0]);
  assert.deepEqual(Array.from(b.sysSeries().netRx), [0, 0, 0]);
  assert.deepEqual(Array.from(b.series('1:5').netRx), [10, 20, 30]);
});

test('tail: son değerleri verilen tampona yazar', () => {
  const h = createHistory({ capacity: 5 });
  for (let i = 1; i <= 7; i++) h.push(snap(i, [P(1, 'a', i)]));
  const out = new Float32Array(3);
  assert.equal(h.tail('1:5001', 'cpu', out), 3);
  assert.deepEqual(Array.from(out), [5, 6, 7]);
  const big = new Float32Array(10);
  assert.equal(h.tail('1:5001', 'cpu', big), 5);
  assert.deepEqual(Array.from(big.subarray(0, 5)), [3, 4, 5, 6, 7]);
  assert.equal(h.tail('yok', 'cpu', out), 0);
});

test('dump → load: arayüz kopyası aynı serileri verir ve olay üretimi kaldığı yerden sürer', () => {
  const a = createHistory({ capacity: 6 });
  for (let i = 1; i <= 4; i++) a.push(snap(i * 10, [P(1, 'a', i), P(2, 'b', i * 2)]));
  // IPC'nin yapısal kopyasını taklit et
  const d = structuredClone(a.dump());
  const b = createHistory({ capacity: 6 });
  b.load(d);
  assert.deepEqual(Array.from(b.series('2:5002').cpu), [2, 4, 6, 8]);
  assert.deepEqual(Array.from(b.sysSeries().t), [10, 20, 30, 40]);
  const ev = b.push(snap(50, [P(1, 'a', 9)]));
  assert.equal(ev.started.length, 0);
  assert.equal(ev.exited[0].pid, 2);
  assert.equal(ev.exited[0].avgCpu, 5);
});

test('load: kaynak kapasitesi büyükse son örnekler tutulur', () => {
  const a = createHistory({ capacity: 10 });
  for (let i = 1; i <= 10; i++) a.push(snap(i, [P(1, 'a', i)]));
  const b = createHistory({ capacity: 3 });
  b.load(a.dump());
  assert.deepEqual(Array.from(b.series('1:5001').cpu), [8, 9, 10]);
  assert.deepEqual(Array.from(b.sysSeries().t), [8, 9, 10]);
});
