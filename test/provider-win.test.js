'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { createProvider, createAgentClient } = require('../src/provider-win');

const FAKE = path.join(__dirname, '..', 'test-fixtures', 'fake-agent.js');
const spawnFn = (exe, args, opts) => spawn(process.execPath, [exe, ...args], opts);

test('istek / yanıt eşlemesi, hata kodları ve protokol dışı satırlar', async () => {
  const c = createAgentClient({ exe: FAKE, spawnFn });
  try {
    const h = await c.request('hello');
    assert.equal(h.agent, 'fake');
    const [a, b] = await Promise.all([c.request('detail', { pid: 7 }), c.request('detail', { pid: 8 })]);
    assert.equal(a.pid, 7);
    assert.equal(b.pid, 8);
    await assert.rejects(c.request('kill', { pid: 7 }), (e) => e.code === 'access' && /denied/.test(e.message));
    assert.deepEqual(await c.request('noise'), { fine: true });
    assert.equal((await c.request('split')).big.length, 5000);
  } finally {
    c.stop();
  }
});

test('zaman aşımı: istek timeout ile reddedilir, yardımcı yeniden başlatılır', async () => {
  const c = createAgentClient({ exe: FAKE, spawnFn });
  try {
    const first = await c.request('hello');
    await assert.rejects(c.request('slow', {}, 150), (e) => e.code === 'timeout');
    await new Promise((r) => setTimeout(r, 150));
    const again = await c.request('hello');
    assert.notEqual(again.pid, first.pid);
  } finally {
    c.stop();
  }
});

test('yardımcı çökerse bekleyen istekler failed olur ve dinleyici bilgilendirilir', async () => {
  const downs = [];
  const c = createAgentClient({ exe: FAKE, spawnFn, onDown: (why) => downs.push(why) });
  try {
    await c.request('hello');
    await assert.rejects(c.request('crash'), (e) => e.code === 'failed');
    assert.equal(downs.length, 1);
    assert.match(downs[0], /code 3/);
    assert.equal((await c.request('hello')).agent, 'fake');
  } finally {
    c.stop();
  }
});

test('sürekli çöken yardımcı sonsuza dek yeniden başlatılmaz', async () => {
  const c = createAgentClient({ exe: FAKE, spawnFn });
  try {
    for (let i = 0; i < 5; i++) await assert.rejects(c.request('crash'), (e) => e.code === 'failed');
    await assert.rejects(c.request('hello'), (e) => e.code === 'failed' && /keeps exiting/.test(e.message));
  } finally {
    c.stop();
  }
});

test('sağlayıcı: anlık görüntü ve ağır sorgular ayrı yardımcı örneklerine gider', async () => {
  const p = createProvider({ exe: FAKE, spawnFn });
  try {
    const h = await p.start();
    const snap = await p.request('snapshot');
    const d = await p.request('detail', { pid: 1 });
    assert.equal(snap.procs[0][0], h.pid);
    assert.notEqual(d.agentPid, h.pid);
  } finally {
    p.stop();
  }
});

test('sağlayıcı: yardımcı dosyası yoksa unsupported', async () => {
  const p = createProvider({ exe: path.join(__dirname, 'yok', 'mp-agent.exe'), spawnFn });
  await assert.rejects(p.start(), (e) => e.code === 'unsupported');
  p.stop();
});
