'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../src/renderer/netparse');
const S = require('../src/renderer/netsmart');
const R = require('../src/renderer/netrender');
const { createT } = require('../src/i18n');

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x))));
const o = { t: createT('en'), bytes: (n) => `${n} B`, time: (ms) => `t${ms}` };
const meta = { proto: 'tcp', lport: 50000, rport: 80 };
const chunkOf = (over = {}) => Object.assign({ flow: 1, pid: 10, proto: 'tcp', v: 4, local: '127.0.0.1', lport: 50000, remote: '127.0.0.1', rport: 80, dir: 'out', t: 1000, f: 0 }, over);

// Çözülebilir en küçük PNG (1 x 1)
function png() {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]));
}

async function render(dir, bytes) {
  const st = P.createStore();
  st.add(chunkOf({ dir }), bytes);
  const side = st.get(1, dir);
  const result = await S.analyze(side, meta);
  return { side, result, items: R.smartItems(result, side, o, null) };
}

test('hex: 16 bayt / satır, konum sütunu tabandan başlar, işaretler kaçışlanır', () => {
  const html = R.hexHtml(enc('<a>&b\u0000'), 0x1f0);
  assert.ok(html.startsWith('<span class="hx-a">000001f0</span>'), html.slice(0, 60));
  assert.ok(html.includes('3c 61 3e 26 62 <i>00</i>'));
  assert.ok(html.includes('&lt;a&gt;&amp;b<i>.</i>'));
  assert.ok(!html.includes('<a>'));
  assert.equal(R.hexHtml(new Uint8Array(40), 0).split('\n').length, 3);
  assert.equal(R.hexText(enc('AB'), 0).trim().startsWith('00000000'), true);
});

test('metin ve Base64 görünümleri', () => {
  assert.equal(R.textOf(enc('satır\r\n\u0001x')).includes('satır'), true);
  assert.ok(!/[\u0000-\u0008]/.test(R.textOf(new Uint8Array([0, 1, 2, 65]))));
  const b64 = R.base64Of(new Uint8Array(200).fill(255));
  assert.ok(b64.split('\n').every((l) => l.length <= 76));
  assert.deepEqual(Buffer.from(b64.replace(/\n/g, ''), 'base64'), Buffer.alloc(200, 255));
});

test('port süzgeci: tek port, liste, aralık, geçersiz girdi', () => {
  const f = R.portFilter('443, 8000 - 8100');
  assert.equal(f.ok, true);
  assert.equal(f.empty, false);
  assert.deepEqual([443, 8050, 80, 8101].map(f.test), [true, true, false, false]);
  assert.equal(R.portFilter('').empty, true);
  assert.equal(R.portFilter('').test(1), true);
  assert.equal(R.portFilter('9000-8000').test(8500), true);
  for (const bad of ['x', '70000', '80-', '1,,a', '-5']) assert.equal(R.portFilter(bad).ok, false, bad);
});

test('akıllı görünüm: giden JSON isteği sözdizimiyle, gelen PNG önizlemeyle çizilir', async () => {
  const body = '{"ad":"<b>çay</b>","adet":3,"ok":true,"yok":null}';
  const out = await render('out', enc(`POST /ara?q=<x> HTTP/1.1\r\nHost: yerel.test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  assert.equal(out.items.length, 1);
  const h = out.items[0].html;
  assert.ok(h.includes('POST') && h.includes('/ara?q=&lt;x&gt;'), 'istek satırı kaçışlanmış olmalı');
  assert.ok(h.includes('<span class="badge acc">JSON</span>'));
  for (const cls of ['j-k', 'j-s', 'j-n', 'j-b', 'j-z']) assert.ok(h.includes(`class="${cls}"`), cls);
  assert.ok(!h.includes('<b>çay</b>'), 'gövdedeki etiket ham geçmemeli');
  assert.ok(h.includes('&lt;b&gt;çay&lt;/b&gt;'));

  const img = png();
  const inn = await render('in', cat(enc(`HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${img.length}\r\n\r\n`), img));
  const hi = inn.items[0].html;
  assert.ok(hi.includes(`<img alt="" src="data:image/png;base64,${Buffer.from(img).toString('base64')}">`));
  assert.ok(hi.includes('1 × 1') || hi.includes('1×1') || /\b1\D{1,3}1\b/.test(hi), 'boyut yazılmalı');
});

test('akıllı görünüm: HTML ve SVG yalnız kaynak olarak gösterilir, hiçbir etiket çalışır hâlde kalmaz', async () => {
  const page = '<!doctype html><html><body onload="x()"><script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:1">t</a></body></html>';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(3)"><script>alert(4)</script></svg>';
  const inn = await render('in', cat(
    enc(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nX-Evil: <img src=x onerror=1>\r\nContent-Length: ${page.length}\r\n\r\n${page}`),
    enc(`HTTP/1.1 200 OK\r\nContent-Type: image/svg+xml\r\nContent-Length: ${svg.length}\r\n\r\n${svg}`)));
  assert.equal(inn.items.length, 2);
  const all = inn.items.map((i) => i.html).join('\n') + R.markupItems(inn.result, inn.side, o).map((i) => i.html).join('\n');
  // Çıktıda yalnız kendi ürettiğimiz etiketler bulunabilir
  const tags = new Set([...all.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()));
  for (const tag of tags) assert.ok(['div', 'span', 'pre', 'b', 'i', 'dl', 'dt', 'dd', 'details', 'summary', 'figure', 'figcaption', 'img'].includes(tag), `beklenmeyen etiket: ${tag}`);
  assert.ok(!/<img(?![^>]*src="data:image\/(png|jpeg|gif|webp|bmp);base64,)/.test(all), 'yalnız raster data: resimleri');
  assert.ok(!all.includes('data:image/svg'), 'SVG resim olarak önizlenmez');
  assert.ok(!/<[^>]*\son\w+\s*=/.test(all), 'olay özniteliği yok');
  assert.ok(!/<[^>]*(href|srcdoc|style)\s*=/.test(all), 'bağlantı ya da satır içi stil yok');
  assert.ok(all.includes('class="m-t"'), 'işaretleme renklendirilmiş');
  assert.equal(R.markupItems(inn.result, inn.side, o).length >= 1, true);
});

test('akıllı görünüm: bölüm anahtarları kararlı, veri eklenince yalnız değişen bölümün imzası değişir', async () => {
  const st = P.createStore();
  const first = enc('GET /a HTTP/1.1\r\nHost: h\r\n\r\n');
  st.add(chunkOf({ t: 1 }), first);
  let side = st.get(1, 'out');
  const a = R.smartItems(await S.analyze(side, meta), side, o, null);
  st.add(chunkOf({ t: 2 }), enc('POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\nab'));
  side = st.get(1, 'out');
  const b = R.smartItems(await S.analyze(side, meta), side, o, new Set([a[0].key]));
  assert.equal(b.length, 2);
  assert.equal(b[0].key, a[0].key);
  assert.equal(b[0].sig, a[0].sig);
  assert.ok(b[0].html.includes('<details class="ns-hd" open>'), 'açık bırakılan başlık kutusu açık kalır');
  assert.notEqual(b[1].key, b[0].key);
  st.add(chunkOf({ t: 3 }), enc('cd'));
  side = st.get(1, 'out');
  const c = R.smartItems(await S.analyze(side, meta), side, o, null);
  assert.equal(c[1].key, b[1].key);
  assert.notEqual(c[1].sig, b[1].sig);
  assert.equal(R.protocolLabel('http'), 'HTTP');
  assert.equal(R.protocolLabel(''), '');
});
