'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createProvider, parseStat, protectOf, niceToPriority } = require('../src/provider-linux');

const linux = { skip: process.platform !== 'linux' && 'yalnız Linux' };
const COLS = ['pid', 'ppid', 'name', 'cpu', 'ws', 'priv', 'ioRead', 'ioWrite', 'gpu', 'gpuDed', 'gpuShr', 'threads', 'handles', 'start', 'session'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseStat: adında boşluk ve parantez olan süreç', () => {
  const st = parseStat('4242 (Web Content (x) y) S 100 4242 4242 0 -1 4194560 10 0 2 0 7 3 0 0 20 0 5 0 12345 1000000 250 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0');
  assert.equal(st.pid, 4242);
  assert.equal(st.comm, 'Web Content (x) y');
  assert.equal(st.ppid, 100);
  assert.equal(st.utime, 7);
  assert.equal(st.stime, 3);
  assert.equal(st.threads, 5);
  assert.equal(st.starttime, 12345);
  assert.equal(st.rss, 250);
});

test('protectOf / niceToPriority eşlemeleri', () => {
  assert.equal(protectOf('r--p'), 0x02);
  assert.equal(protectOf('rw-p'), 0x04);
  assert.equal(protectOf('r-xp'), 0x20);
  assert.equal(protectOf('rwxp'), 0x40);
  assert.equal(protectOf('---p'), 0x01);
  assert.equal(niceToPriority(0), 'normal');
  assert.equal(niceToPriority(19), 'idle');
  assert.equal(niceToPriority(10), 'below');
  assert.equal(niceToPriority(-5), 'above');
  assert.equal(niceToPriority(-10), 'high');
});

test('hello + snapshot: protokol biçimi, kendi sürecimiz listede, ikinci çağrıda oranlar', linux, async () => {
  const p = createProvider();
  const h = await p.start();
  assert.equal(h.protocol, 1);
  assert.equal(h.pid, process.pid);
  assert.ok(h.cpuCount >= 1 && h.totalPhys > 0);
  const a = await p.request('snapshot');
  assert.deepEqual(a.cols, COLS);
  assert.ok(a.procs.every((r) => r.length === COLS.length));
  assert.ok(a.procs.every((r) => r[3] === 0), 'ilk çağrıda oranlar 0');
  const me = a.procs.find((r) => r[0] === process.pid);
  assert.ok(me, 'kendi sürecimiz');
  assert.ok(me[4] > 1e6 && me[11] >= 1 && me[12] >= 3);
  assert.ok(Math.abs(me[13] - (Date.now() - process.uptime() * 1000)) < 5000, 'başlangıç zamanı');
  // Biraz işlemci harca
  const end = Date.now() + 250;
  while (Date.now() < end) Math.sqrt(Math.random());
  const b = await p.request('snapshot');
  const me2 = b.procs.find((r) => r[0] === process.pid);
  assert.ok(me2[3] > 0 && me2[3] <= 100, `cpu ${me2[3]}`);
  assert.ok(b.sys.cpu >= 0 && b.sys.cpu <= 100);
  assert.ok(b.sys.memTotal > b.sys.memAvail && b.sys.memAvail > 0);
});

test('detail / modules / memmap / readmem / handles kendi sürecimiz üzerinde', linux, async () => {
  const p = createProvider();
  await p.start();
  const pid = process.pid;
  const d = await p.request('detail', { pid });
  assert.equal(d.pid, pid);
  assert.equal(d.path, fs.realpathSync(process.execPath));
  assert.equal(d.user, os.userInfo().username);
  assert.equal(d.ppid, process.ppid);
  assert.ok(d.threads.length >= 1 && d.threads.every((t) => t.tid > 0));
  assert.ok(d.counters.ws > 0 && d.counters.virt > d.counters.ws);
  assert.deepEqual(d.windows, []);

  const mods = (await p.request('modules', { pid })).modules;
  assert.ok(mods.some((m) => m.path === d.path));
  assert.ok(mods.every((m) => /^[0-9a-f]+$/.test(m.base) && m.size > 0 && m.size < 2 ** 32));

  const mm = await p.request('memmap', { pid });
  assert.deepEqual(mm.cols, ['base', 'size', 'state', 'protect', 'type', 'wsPages', 'name']);
  // Bölgeler bitişik ve artan: her bölge bir öncekinin bittiği yerde başlar
  let cursor = parseInt(mm.min, 16);
  for (const r of mm.regions) {
    assert.equal(parseInt(r[0], 16), cursor);
    cursor += r[1];
  }
  assert.equal(cursor, parseInt(mm.max, 16) + 1);
  const img = mm.regions.find((r) => r[4] === 3 && r[6] === d.path && r[5] > 0);
  assert.ok(img, 'çalıştırılabilir dosyanın bölgesi');
  assert.ok(mm.totals.ws > 0 && mm.totals.commit > 0 && mm.totals.free > 0);

  const rm = await p.request('readmem', { pid, addr: img[0], len: 256 });
  assert.equal(rm.len, 256);
  assert.equal(Buffer.from(rm.b64, 'base64').subarray(0, 4).toString('latin1'), '\x7fELF');
  await assert.rejects(p.request('readmem', { pid, addr: '0', len: 16 }), (e) => e.code === 'access');
  await assert.rejects(p.request('readmem', { pid, addr: 'zz', len: 16 }), (e) => e.code === 'bad_request');
  await assert.rejects(p.request('readmem', { pid, addr: img[0], len: 70000 }), (e) => e.code === 'bad_request');

  const tmp = path.join(os.tmpdir(), `mp-handles-${pid}.txt`);
  fs.writeFileSync(tmp, 'master process');
  const fd = fs.openSync(tmp, 'r');
  try {
    const hd = await p.request('handles', { pid });
    const f = hd.files.find((x) => x.path === tmp);
    assert.ok(f, 'açık dosyamız listede');
    assert.equal(f.kind, 'file');
    assert.equal(f.size, 14);
    assert.ok(hd.counts.File >= 1);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(tmp);
  }
});

test('readfile + filemap', linux, async () => {
  const p = createProvider();
  await p.start();
  const tmp = path.join(os.tmpdir(), `mp-file-${process.pid}.bin`);
  const data = Buffer.alloc(200000, 7);
  data.write('MASTERPROCESS', 100);
  fs.writeFileSync(tmp, data);
  try {
    const rf = await p.request('readfile', { path: tmp, offset: 100, len: 13 });
    assert.equal(Buffer.from(rf.b64, 'base64').toString(), 'MASTERPROCESS');
    assert.equal(rf.size, 200000);
    const tail = await p.request('readfile', { path: tmp, offset: 199990, len: 100 });
    assert.equal(tail.len, 10);
    await assert.rejects(p.request('readfile', { path: 'goreli/yol', offset: 0, len: 1 }), (e) => e.code === 'bad_request');
    await assert.rejects(p.request('readfile', { path: '/yok/boyle/dosya', offset: 0, len: 1 }), (e) => e.code === 'gone');

    const fm = await p.request('filemap', { path: process.execPath });
    assert.ok(fm.clusterSize >= 512 && fm.totalClusters > fm.freeClusters);
    assert.equal(fm.size, fs.statSync(process.execPath).size);
    assert.equal(fm.fragments, fm.extents.length);
    if (!fm.resident) {
      const bytes = fm.extents.reduce((a, e) => a + e[1], 0) * fm.clusterSize;
      assert.ok(bytes >= fm.size && bytes < fm.size + fm.clusterSize * 2, 'extent toplamı dosya boyutunu karşılar');
      assert.ok(fm.extents.every((e) => e[0] >= 0 && e[0] + e[1] <= fm.totalClusters));
    }
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('yönetim komutları: askıya al / sürdür / öncelik / sonlandır (kendi çocuk sürecimizde)', linux, async () => {
  const p = createProvider();
  await p.start();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r(sig || code)));
  try {
    await sleep(150);
    const pid = child.pid;
    assert.deepEqual(await p.request('suspend', { pid }), { done: true });
    await sleep(50);
    assert.equal((await p.request('detail', { pid })).suspended, true);
    assert.deepEqual(await p.request('resume', { pid }), { done: true });
    await sleep(50);
    assert.equal((await p.request('detail', { pid })).suspended, false);
    assert.deepEqual(await p.request('priority', { pid, value: 'below' }), { done: true });
    assert.equal((await p.request('detail', { pid })).priority, 'below');
    await assert.rejects(p.request('priority', { pid, value: 'realtime' }), (e) => e.code === 'bad_request');
    assert.deepEqual(await p.request('kill', { pid }), { done: true });
    assert.equal(await exited, 'SIGKILL');
    await sleep(50);
    await assert.rejects(p.request('detail', { pid }), (e) => e.code === 'gone');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) { /* bitti */ }
  }
});

test('korunan PID\'ler ve karşılığı olmayan komutlar', linux, async () => {
  const p = createProvider();
  await p.start();
  for (const cmd of ['kill', 'suspend', 'resume']) {
    await assert.rejects(p.request(cmd, { pid: 1 }), (e) => e.code === 'bad_request');
    await assert.rejects(p.request(cmd, { pid: process.pid }), (e) => e.code === 'bad_request');
  }
  await assert.rejects(p.request('capture', { hwnd: '1a' }), (e) => e.code === 'unsupported');
  await assert.rejects(p.request('gpudetail', { pid: process.pid }), (e) => e.code === 'unsupported');
  await assert.rejects(p.request('bilinmeyen'), (e) => e.code === 'bad_request');
  await assert.rejects(p.request('detail', {}), (e) => e.code === 'bad_request');
});
