'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../src/renderer/netparse');
const S = require('../src/renderer/netsmart');

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const bin = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x))));
const text = (b) => Buffer.from(b).toString('utf8');

// Gerçek, çözülebilir bir PNG (w x h, RGB) üretir
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = x * 40; raw[o + 1] = y * 60; raw[o + 2] = 200; }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const chunkOf = (over = {}) => Object.assign({ flow: 1, pid: 10, proto: 'tcp', v: 4, local: '127.0.0.1', lport: 50000, remote: '127.0.0.1', rport: 80, dir: 'out', t: 1000, f: 0 }, over);

// ---- depo ----

test('depo: yönler ayrı birikir, parça zamanları korunur', () => {
  const st = P.createStore();
  st.add(chunkOf({ t: 1000 }), enc('GET / '));
  st.add(chunkOf({ t: 1200 }), enc('HTTP/1.1\r\n'));
  st.add(chunkOf({ dir: 'in', t: 1300 }), enc('HTTP/1.1 200 OK\r\n'));
  const out = st.get(1, 'out');
  const inn = st.get(1, 'in');
  assert.equal(text(out.bytes), 'GET / HTTP/1.1\r\n');
  assert.equal(text(inn.bytes), 'HTTP/1.1 200 OK\r\n');
  assert.equal(out.segs.length, 2);
  assert.equal(P.timeAt(out.segs, 0), 1000);
  assert.equal(P.timeAt(out.segs, 6), 1200);
  assert.equal(P.timeAt(out.segs, 9999), 1200);
  assert.equal(st.size, 1);
  assert.equal(st.bytes, 16 + 17);
  assert.equal(st.flow(1).lastT, 1300);
  assert.equal(st.get(2, 'in'), null);
});

test('depo: bayraklar — kapanış, sıfırlama ve boşluk bir sonraki veriye taşınır', () => {
  const st = P.createStore();
  st.add(chunkOf({ f: P.F_SYN }), null);
  st.add(chunkOf(), enc('abc'));
  st.add(chunkOf({ f: P.F_GAP }), null);
  st.add(chunkOf(), enc('def'));
  st.add(chunkOf({ f: P.F_GAP }), enc('ghi'));
  st.add(chunkOf({ f: P.F_FIN }), null);
  const s = st.get(1, 'out');
  assert.deepEqual(s.segs.map((x) => x.gap), [false, true, true]);
  assert.equal(s.gaps, 2);
  assert.equal(s.fin, true);
  assert.equal(s.rst, false);
  st.add(chunkOf({ dir: 'in', f: P.F_RST }), null);
  assert.equal(st.get(1, 'in').rst, true);
  assert.equal(st.get(1, 'in').bytes.length, 0);
});

test('depo: akış sınırı aşılınca en eski baytlar atılır, ofsetler mutlak kalır', () => {
  const st = P.createStore({ maxFlowBytes: 1000 });
  for (let i = 0; i < 20; i++) st.add(chunkOf({ t: 1000 + i }), new Uint8Array(100).fill(i));
  const s = st.get(1, 'out');
  assert.equal(s.total, 2000);
  assert.ok(s.bytes.length <= 1250 && s.bytes.length >= 1000);
  assert.equal(s.base + s.bytes.length, 2000);
  assert.equal(s.bytes[s.bytes.length - 1], 19);
  assert.equal(s.segs[0].off, s.base);
  // Mutlak ofset → göreli konum → doğru bayt
  const seg = s.segs[s.segs.length - 1];
  assert.equal(s.bytes[seg.off - s.base], 19);
  assert.equal(st.bytes, s.bytes.length);
});

test('depo: toplam sınır aşılınca en uzun süredir sessiz akış bırakılır', () => {
  const st = P.createStore({ maxFlowBytes: 4096, maxTotalBytes: 5000 });
  st.add(chunkOf({ flow: 1, t: 100 }), new Uint8Array(2000));
  st.add(chunkOf({ flow: 2, t: 200 }), new Uint8Array(2000));
  st.add(chunkOf({ flow: 3, t: 300 }), new Uint8Array(2000));
  assert.equal(st.flow(1), null);
  assert.ok(st.flow(2) && st.flow(3));
  assert.equal(st.evicted, 1);
  assert.equal(st.bytes, 4000);
  st.clear();
  assert.equal(st.size, 0);
  assert.equal(st.bytes, 0);
});

// ---- HTTP ----

test('HTTP: ardışık istekler, Content-Length gövdesi', () => {
  const b = enc('POST /api/v1/items?x=1 HTTP/1.1\r\nHost: example.test\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 15\r\n\r\n{"ad":"çay"}  GET /b HTTP/1.1\r\nHost: example.test\r\n\r\n');
  const { messages, end } = P.parseHttp(b);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].method, 'POST');
  assert.equal(messages[0].target, '/api/v1/items?x=1');
  assert.equal(messages[0].contentType, 'application/json');
  assert.equal(messages[0].charset, 'utf-8');
  assert.equal(text(messages[0].body), '{"ad":"çay"}  ');
  assert.equal(messages[0].complete, true);
  assert.equal(messages[1].method, 'GET');
  assert.equal(messages[1].body.length, 0);
  assert.equal(end, b.length);
  assert.equal(P.header(messages[0].headers, 'host'), 'example.test');
});

test('HTTP: yarım gövde ve yarım başlık tamamlanmamış olarak işaretlenir', () => {
  const half = P.parseHttp(enc('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc'));
  assert.equal(half.messages.length, 1);
  assert.equal(half.messages[0].complete, false);
  assert.equal(text(half.messages[0].body), 'abc');
  const head = P.parseHttp(enc('HTTP/1.1 404 Not Found\r\nContent-Type: text/pl'));
  assert.equal(head.messages[0].headOnly, true);
  assert.equal(head.messages[0].status, 404);
  assert.equal(head.messages[0].reason, 'Not Found');
  assert.equal(P.parseHttp(enc('\x16\x03\x01\x02\x00')).messages.length, 0);
  assert.equal(P.parseHttp(enc('GETX nope')).messages.length, 0);
});

test('HTTP: parçalı aktarım çözülür; eksik parça tamamlanmamış sayılır', () => {
  const full = enc('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nmerha\r\n7;ext=1\r\nba dün\r\n0\r\nX-Son: 1\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n');
  const r = P.parseHttp(full);
  assert.equal(r.messages.length, 2);
  assert.equal(text(r.messages[0].body), 'merhaba dün');
  assert.equal(r.messages[0].complete, true);
  assert.equal(r.messages[1].status, 204);
  assert.equal(r.end, full.length);
  const part = P.parseHttp(enc('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nmerha\r\n6\r\nba'));
  assert.equal(part.messages[0].complete, false);
  assert.equal(text(part.messages[0].body), 'merhaba');
  const bad = P.parseHttp(enc('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n'));
  assert.equal(bad.messages[0].malformed, true);
});

test('HTTP: uzunluk bildirmeyen yanıt bağlantı kapanana dek sürer', () => {
  const b = enc('HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nson satır');
  assert.equal(P.parseHttp(b).messages[0].complete, false);
  const m = P.parseHttp(b, { final: true }).messages[0];
  assert.equal(m.complete, true);
  assert.equal(m.untilClose, true);
  assert.equal(text(m.body), 'son satır');
});

test('HTTP: HEAD yanıtı gövde taşımaz; 101 sonrası veri HTTP olarak okunmaz', () => {
  const head = P.parseHttp(enc('HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
  assert.equal(head.messages.length, 2);
  assert.equal(head.messages[0].headReply, true);
  assert.equal(text(head.messages[1].body), 'ok');
  const up = enc('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  const r = P.parseHttp(cat(up, [0x81, 0x02, 0x68, 0x69]));
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].upgrade, 'websocket');
  assert.equal(r.end, up.length);
});

test('sıkıştırma: gzip ve deflate açılır, yarım veri kısmi döner, br desteklenmez', async () => {
  const src = enc(JSON.stringify({ liste: Array.from({ length: 200 }, (_, i) => `öğe-${i}`) }));
  const gz = await P.decompress(new Uint8Array(zlib.gzipSync(src)), 'gzip');
  assert.equal(gz.ok, true);
  assert.deepEqual(Buffer.from(gz.bytes), Buffer.from(src));
  const zl = await P.decompress(new Uint8Array(zlib.deflateSync(src)), 'deflate');
  assert.deepEqual(Buffer.from(zl.bytes), Buffer.from(src));
  const raw = await P.decompress(new Uint8Array(zlib.deflateRawSync(src)), 'deflate');
  assert.deepEqual(Buffer.from(raw.bytes), Buffer.from(src));
  const big = new Uint8Array(zlib.gzipSync(Buffer.from(Array.from({ length: 60000 }, (_, i) => String.fromCharCode(97 + (i * 7919) % 26) + i).join(''))));
  const cutGz = await P.decompress(big.subarray(0, big.length >> 1), 'gzip');
  assert.equal(cutGz.ok, true);
  assert.equal(cutGz.partial, true);
  assert.ok(cutGz.bytes.length > 0);
  const br = await P.decompress(src, 'br');
  assert.equal(br.ok, false);
  assert.equal(br.unsupported, 'br');
  assert.equal((await P.decompress(src, '')).bytes, src);
  assert.equal((await P.decompress(src, 'identity')).ok, true);
});

test('form ve çok parçalı gövde', () => {
  assert.deepEqual(P.parseForm('ad=%C3%87ay+bardak&adet=2&bos=&tek'), [['ad', 'Çay bardak'], ['adet', '2'], ['bos', ''], ['tek', '']]);
  assert.equal(P.looksForm('a=1&b=iki'), true);
  assert.equal(P.looksForm('düz bir cümle = değil'), false);
  const img = png(3, 2);
  const body = cat(enc('--XyZ\r\nContent-Disposition: form-data; name="not"\r\n\r\nmerhaba\r\n--XyZ\r\nContent-Disposition: form-data; name="dosya"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'), img, enc('\r\n--XyZ--\r\n'));
  const parts = P.parseMultipart(body, 'XyZ');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'not');
  assert.equal(text(parts[0].body), 'merhaba');
  assert.equal(parts[1].filename, 'a.png');
  assert.equal(parts[1].contentType, 'image/png');
  assert.deepEqual(Buffer.from(parts[1].body), Buffer.from(img));
  assert.equal(parts[1].complete, true);
  const cutParts = P.parseMultipart(body.subarray(0, body.length - 20), 'XyZ');
  assert.equal(cutParts[1].complete, false);
});

test('metin: ikili veri metin sayılmaz, yarım UTF-8 sonu hata değildir', () => {
  assert.equal(P.isText(enc('düz metin\r\nsatır')), true);
  assert.equal(P.isText(new Uint8Array([1, 2, 3, 0, 5])), false);
  assert.equal(P.isText(png(2, 2)), false);
  const cut = enc('çay');
  assert.equal(P.isText(cut.subarray(0, 1)), true);
  assert.equal(P.decodeText(enc('ağ')), 'ağ');
  assert.equal(P.decodeText(bin('caf\xe9 au lait')), 'café au lait');
  assert.equal(P.decodeText(bin('\xfe'), 'iso-8859-9'), 'ş');
  assert.equal(P.escHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(P.toBase64(enc('merhaba')), Buffer.from('merhaba').toString('base64'));
});

// ---- içerik tanıma ----

test('resim: imzadan tür ve boyut', () => {
  assert.deepEqual(S.imageInfo(png(37, 21)), { mime: 'image/png', w: 37, h: 21 });
  assert.deepEqual(S.imageInfo(bin('GIF89a\x10\x00\x08\x00\x80\x00\x00')), { mime: 'image/gif', w: 16, h: 8 });
  const jpeg = cat([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10], bin('JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'), [0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00]);
  assert.deepEqual(S.imageInfo(jpeg), { mime: 'image/jpeg', w: 64, h: 48 });
  const bmp = new Uint8Array(30); bmp[0] = 0x42; bmp[1] = 0x4D; bmp[14] = 40; bmp[18] = 5; bmp[22] = 0xFD; bmp[23] = 0xFF; bmp[24] = 0xFF; bmp[25] = 0xFF;
  assert.deepEqual(S.imageInfo(bmp), { mime: 'image/bmp', w: 5, h: 3 });
  const webp = cat(bin('RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00'), [99, 0, 0, 49, 0, 0]);
  assert.deepEqual(S.imageInfo(webp), { mime: 'image/webp', w: 100, h: 50 });
  assert.equal(S.imageInfo(enc('PNG değil')), null);
  assert.equal(S.imageInfo(enc('BM ile başlayan düz bir metin, resim değil')), null);
  assert.equal(S.magic(bin('%PDF-1.7')), 'PDF');
  assert.equal(S.magic(bin('MZ\x90\x00')), 'PE (exe / dll)');
  assert.equal(S.magic(enc('düz')), '');
});

test('JSON: belirteçler korunarak girintilenir (büyük sayılar bozulmaz), HTML kaçışlanır', () => {
  const src = '{"id":12345678901234567890,"ad":"<b>çay</b>","ok":true,"yok":null,"liste":[1,2.50,-3e10],"bos":{},"d":[]}';
  const html = S.jsonHtml(src);
  assert.ok(html.includes('<span class="j-n">12345678901234567890</span>'));
  assert.ok(html.includes('<span class="j-n">2.50</span>'));
  assert.ok(html.includes('<span class="j-k">&quot;id&quot;</span>'));
  assert.ok(html.includes('<span class="j-s">&quot;&lt;b&gt;çay&lt;/b&gt;&quot;</span>'));
  assert.ok(html.includes('<span class="j-b">true</span>'));
  assert.ok(html.includes('<span class="j-z">null</span>'));
  assert.ok(html.includes('<span class="j-p">{}</span>'));
  assert.ok(html.includes('<span class="j-p">[]</span>'));
  assert.ok(!html.includes('<b>'));
  // Etiketler atılınca kalan metin aynı veriyi taşır
  const plain = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(plain.replace(/\s+/g, ''), src);
  assert.equal(plain.split('\n')[1], '  "id": 12345678901234567890,');
  assert.ok(plain.includes('\n  "liste": [\n    1,\n    2.50,\n    -3e10\n  ],'));
});

test('JSON: tür — geçerli, satır başına değer, yarım, JSON değil', () => {
  assert.equal(S.jsonKind(' {"a":1} '), 'json');
  assert.equal(S.jsonKind('{"a":1}\n{"a":2}\n'), 'json');
  assert.equal(S.jsonKind('{"a":1,"b":[1,2'), 'partial');
  assert.equal(S.jsonKind('[bu bir not]'), null);
  assert.equal(S.jsonKind('düz metin'), null);
  const nd = S.jsonHtml('{"a":1}\n{"a":2}').replace(/<[^>]+>/g, '');
  assert.equal(nd, '{\n  &quot;a&quot;: 1\n}\n{\n  &quot;a&quot;: 2\n}');
  // Yarım JSON da renklendirilir; kapanmamış dizge taşmaz
  const part = S.jsonHtml('{"a":"yar');
  assert.ok(part.includes('<span class="j-s">&quot;yar</span>'));
  // Dizge içindeki kaçışlı tırnak dizgeyi bitirmez
  assert.ok(S.jsonHtml('{"a":"x\\"y"}').includes('<span class="j-s">&quot;x\\&quot;y&quot;</span>'));
});

test('işaretleme: kaynak renklendirilir, hiçbir etiket çalışır hâlde kalmaz', () => {
  const src = '<!doctype html><html lang="tr"><head><script>alert("x")</script></head><body onload=evil()><!-- not --><img src=x onerror="a<b"> 3 < 5 &amp;</body></html>';
  const html = S.markupHtml(src);
  assert.ok(html.includes('<span class="m-t">html</span>'));
  assert.ok(html.includes('<span class="m-a">lang</span>=<span class="m-v">&quot;tr&quot;</span>'));
  assert.ok(html.includes('<span class="m-c">&lt;!-- not --&gt;</span>'));
  assert.ok(html.includes('<span class="m-d">&lt;!doctype html&gt;</span>'));
  // Çıktıda yalnız kendi span etiketlerimiz var
  const tags = html.match(/<\/?[a-zA-Z][^>]*>/g) || [];
  assert.ok(tags.length > 0);
  for (const t of tags) assert.match(t, /^<span class="m-[a-z]">$|^<\/span>$/);
  const plain = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(plain, src);
  assert.equal(S.markupKind('<!DOCTYPE html><html>'), 'html');
  assert.equal(S.markupKind('<?xml version="1.0"?><a/>'), 'xml');
  assert.equal(S.markupKind('<kayit><ad>x</ad></kayit>'), 'xml');
  assert.equal(S.markupKind('<div class="a">x</div>'), 'html');
  assert.equal(S.markupKind('3 < 5 ve 7 > 2'), null);
  assert.equal(S.markupKind('{}', 'text/html'), 'html');
});

// Elle kurulmuş TLS 1.3 ClientHello (SNI, ALPN, supported_versions)
function clientHello(host) {
  const u16 = (n) => [n >> 8, n & 255];
  const ext = (type, data) => [...u16(type), ...u16(data.length), ...data];
  const name = Array.from(Buffer.from(host, 'latin1'));
  const sni = ext(0, [...u16(name.length + 3), 0, ...u16(name.length), ...name]);
  const alpn = ext(16, [...u16(12), 2, 0x68, 0x32, 8, ...Buffer.from('http/1.1', 'latin1')]);
  const vers = ext(43, [6, 0x7A, 0x7A, 0x03, 0x04, 0x03, 0x03]);
  const exts = [...sni, ...alpn, ...vers];
  const body = [0x03, 0x03, ...new Array(32).fill(7), 0, ...u16(4), 0x13, 0x01, 0x13, 0x02, 1, 0, ...u16(exts.length), ...exts];
  const hs = [1, 0, ...u16(body.length), ...body];
  return new Uint8Array([22, 3, 1, ...u16(hs.length), ...hs]);
}

test('TLS: kayıtlar sayılır, ClientHello açık alanları okunur, içerik çözülmez', () => {
  const hello = clientHello('ornek.example');
  const t = S.parseTls(cat(hello, [20, 3, 3, 0, 1, 1], [23, 3, 3, 0, 4, 9, 9, 9, 9], [23, 3, 3, 0, 8, 1, 2]));
  assert.equal(t.records, 4);
  assert.equal(t.handshake, 1);
  assert.equal(t.ccs, 1);
  assert.equal(t.app, 2);
  assert.equal(t.appBytes, 12);
  assert.equal(t.hello.type, 'client');
  assert.equal(t.hello.sni, 'ornek.example');
  assert.deepEqual(t.hello.alpn, ['h2', 'http/1.1']);
  assert.deepEqual(t.hello.versions, ['TLS 1.3', 'TLS 1.2']);
  assert.equal(t.hello.suites, 2);
  assert.equal(t.bad, false);
  assert.equal(S.parseTls(enc('GET / HTTP/1.1\r\n\r\n')), null);
  // Yarım ClientHello: çökmez
  const cut = S.parseTls(hello.subarray(0, 60));
  assert.equal(cut.hello.type, 'client');
  assert.equal(cut.hello.sni, '');
});

function dnsMsg({ response }) {
  const u16 = (n) => [n >> 8, n & 255];
  const qname = [5, ...Buffer.from('ornek'), 7, ...Buffer.from('example'), 0];
  const head = [0x12, 0x34, ...(response ? [0x81, 0x80] : [0x01, 0x00]), ...u16(1), ...u16(response ? 2 : 0), 0, 0, 0, 0];
  const q = [...qname, ...u16(1), ...u16(1)];
  if (!response) return new Uint8Array([...head, ...q]);
  const a = [0xC0, 12, ...u16(1), ...u16(1), 0, 0, 0, 60, ...u16(4), 192, 0, 2, 7];
  const cname = [0xC0, 12, ...u16(5), ...u16(1), 0, 0, 1, 0, ...u16(6), 3, ...Buffer.from('www'), 0xC0, 12];
  return new Uint8Array([...head, ...q, ...a, ...cname]);
}

test('DNS: soru ve yanıtlar (ad sıkıştırma dahil)', () => {
  const q = S.parseDns(dnsMsg({ response: false }), false);
  assert.equal(q.response, false);
  assert.deepEqual(q.questions, [{ name: 'ornek.example', type: 'A' }]);
  const r = S.parseDns(dnsMsg({ response: true }), false);
  assert.equal(r.id, 0x1234);
  assert.equal(r.response, true);
  assert.equal(r.rcode, 'NOERROR');
  assert.deepEqual(r.answers, [{ name: 'ornek.example', type: 'A', ttl: 60, data: '192.0.2.7' }, { name: 'ornek.example', type: 'CNAME', ttl: 256, data: 'www.ornek.example' }]);
  const m = dnsMsg({ response: true });
  const tcp = S.parseDns(cat([m.length >> 8, m.length & 255], m), true);
  assert.equal(tcp.answers.length, 2);
  assert.equal(S.parseDns(enc('düz metin, DNS değil ...'), false), null);
  // Kendine işaret eden sıkıştırma işaretçisi sonsuz döngüye girmez
  const loop = new Uint8Array([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xC0, 12, 0, 1, 0, 1]);
  assert.equal(S.parseDns(loop, false), null);
});

test('WebSocket: çerçeveler, maske çözme, yarım çerçeve', () => {
  const key = [1, 2, 3, 4];
  const payload = Array.from(Buffer.from('{"a":1}'));
  const masked = [0x81, 0x80 | payload.length, ...key, ...payload.map((b, i) => b ^ key[i & 3])];
  const r = S.parseWebSocket(new Uint8Array([...masked, 0x82, 3, 1, 2, 3, 0x89, 0, 0xC1, 2, 9, 9, 0x81, 126, 0, 200, 65]));
  assert.equal(r.frames.length, 5);
  assert.equal(r.frames[0].op, 'text');
  assert.equal(r.frames[0].masked, true);
  assert.equal(text(r.frames[0].payload), '{"a":1}');
  assert.equal(r.frames[1].op, 'binary');
  assert.deepEqual(Array.from(r.frames[1].payload), [1, 2, 3]);
  assert.equal(r.frames[2].op, 'ping');
  assert.equal(r.frames[3].compressed, true);
  assert.equal(r.frames[4].complete, false);
  assert.equal(r.frames[4].len, 200);
  assert.equal(r.bad, false);
  assert.equal(S.parseWebSocket(new Uint8Array([0x83, 0])).bad, true);
});

test('sınıflandırma: resim, JSON, form, işaretleme, metin, ikili', () => {
  assert.equal(S.classify(png(4, 4)).kind, 'image');
  assert.deepEqual(S.classify(enc('{"a":1}'), { contentType: 'application/json' }).valid, true);
  assert.equal(S.classify(enc('{"a":1')).valid, false);
  assert.equal(S.classify(enc('a=1&b=2')).kind, 'form');
  assert.equal(S.classify(enc('a=1&b=2'), { contentType: 'text/plain' }).kind, 'text');
  assert.equal(S.classify(enc('<!doctype html><html></html>')).kind, 'html');
  const svg = S.classify(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'), { contentType: 'image/svg+xml' });
  assert.equal(svg.kind, 'xml'); // SVG önizlenmez, yalnız kaynak gösterilir
  assert.equal(svg.svg, true);
  assert.equal(S.classify(enc('düz bir satır')).kind, 'text');
  const b = S.classify(bin('%PDF-1.7\x00\x01\x02'));
  assert.equal(b.kind, 'binary');
  assert.equal(b.magic, 'PDF');
  assert.equal(S.classify(new Uint8Array(0)).kind, 'empty');
});

// ---- uçtan uca ----

const sideOf = (bytes, over = {}) => Object.assign({ bytes, base: 0, total: bytes.length, segs: [{ off: 0, len: bytes.length, t: 5000, gap: false }], fin: false, rst: false, gaps: 0 }, over);

test('çözümleme: giden JSON isteği ve gelen gzip JSON + PNG yanıtları', async () => {
  const st = P.createStore();
  const reqBody = '{"sorgu":"çay","adet":3}';
  const req = enc(`POST /ara HTTP/1.1\r\nHost: yerel.test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reqBody)}\r\n\r\n${reqBody}GET /logo.png HTTP/1.1\r\nHost: yerel.test\r\n\r\n`);
  st.add(chunkOf({ t: 1000 }), req.subarray(0, 40));
  st.add(chunkOf({ t: 1010 }), req.subarray(40));
  const gz = zlib.gzipSync(Buffer.from('{"sonuc":[{"id":9007199254740993}]}'));
  const img = png(8, 6);
  const res = cat(enc(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n`), gz,
    enc(`HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${img.length}\r\n\r\n`), img);
  st.add(chunkOf({ dir: 'in', t: 1100 }), res.subarray(0, 100));
  st.add(chunkOf({ dir: 'in', t: 1200 }), res.subarray(100));

  const out = await S.analyze(st.get(1, 'out'), { proto: 'tcp', lport: 50000, rport: 80 });
  assert.equal(out.protocol, 'http');
  assert.equal(out.sections.length, 2);
  assert.equal(out.sections[0].msg.method, 'POST');
  assert.equal(out.sections[0].body.kind, 'json');
  assert.equal(out.sections[0].body.valid, true);
  assert.equal(out.sections[0].body.text, reqBody);
  assert.equal(out.sections[0].t, 1000);
  assert.equal(out.sections[1].msg.target, '/logo.png');
  assert.equal(out.sections[1].t, 1010);

  const inn = await S.analyze(st.get(1, 'in'), { proto: 'tcp', lport: 50000, rport: 80 });
  assert.equal(inn.sections.length, 2);
  assert.equal(inn.sections[0].decoded.encoding, 'gzip');
  assert.equal(inn.sections[0].decoded.ok, true);
  assert.equal(inn.sections[0].body.kind, 'json');
  assert.ok(S.jsonHtml(inn.sections[0].body.text).includes('9007199254740993'));
  assert.equal(inn.sections[1].body.kind, 'image');
  assert.equal(inn.sections[1].body.mime, 'image/png');
  assert.equal(inn.sections[1].body.w, 8);
  assert.deepEqual(Buffer.from(inn.sections[1].body.bytes), Buffer.from(img));
  assert.equal(inn.sections[1].t, 1200);
});

test('çözümleme: çok parçalı yüklemede giden resim tanınır', async () => {
  const img = png(5, 5);
  const body = cat(enc('--s1\r\nContent-Disposition: form-data; name="baslik"\r\n\r\nFoto\r\n--s1\r\nContent-Disposition: form-data; name="f"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n'), img, enc('\r\n--s1--\r\n'));
  const req = cat(enc(`POST /yukle HTTP/1.1\r\nContent-Type: multipart/form-data; boundary=s1\r\nContent-Length: ${body.length}\r\n\r\n`), body);
  const a = await S.analyze(sideOf(req), { proto: 'tcp', lport: 50001, rport: 8080 });
  const b = a.sections[0].body;
  assert.equal(b.kind, 'multipart');
  assert.equal(b.parts.length, 2);
  assert.equal(b.parts[0].section.kind, 'text');
  assert.equal(b.parts[1].filename, 'foto.png');
  assert.equal(b.parts[1].section.kind, 'image');
  assert.equal(b.parts[1].section.w, 5);
});

test('çözümleme: TLS, DNS, WebSocket, ham veri ve başı kırpılmış akış', async () => {
  const tls = await S.analyze(sideOf(clientHello('a.example')), { proto: 'tcp', lport: 50002, rport: 443 });
  assert.equal(tls.protocol, 'tls');
  assert.equal(tls.sections[0].tls.hello.sni, 'a.example');

  const d = dnsMsg({ response: true });
  const dns = await S.analyze({ bytes: d, base: 0, total: d.length, segs: [{ off: 0, len: d.length, t: 7, gap: false }], fin: false, rst: false, gaps: 0 }, { proto: 'udp', lport: 50003, rport: 53 });
  assert.equal(dns.protocol, 'dns');
  assert.equal(dns.sections[0].dns.answers[0].data, '192.0.2.7');
  // Aynı baytlar DNS portu dışında DNS sayılmaz
  const notDns = await S.analyze(sideOf(d), { proto: 'udp', lport: 50003, rport: 9999 });
  assert.equal(notDns.sections[0].kind, 'datagram');

  const up = enc('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  const ws = await S.analyze(sideOf(cat(up, [0x81, 7], enc('{"a":1}'))), { proto: 'tcp', lport: 50004, rport: 80 });
  assert.equal(ws.protocol, 'websocket');
  assert.equal(ws.sections[1].kind, 'ws');
  assert.equal(ws.sections[1].body.kind, 'json');

  const raw = await S.analyze(sideOf(new Uint8Array([0, 1, 2, 3, 250, 251])), { proto: 'tcp', lport: 50005, rport: 9000 });
  assert.equal(raw.protocol, '');
  assert.equal(raw.sections[0].body.kind, 'binary');

  // Baş kırpılmış: ilk parça bir gövdenin kuyruğu, ikinci parça yeni bir istekle başlıyor
  const tail = enc('...önceki gövdenin sonu');
  const next = enc('GET /sonraki HTTP/1.1\r\nHost: x\r\n\r\n');
  const cut = await S.analyze({ bytes: cat(tail, next), base: 4096, total: 4096 + tail.length + next.length,
    segs: [{ off: 4096, len: tail.length, t: 1, gap: false, cut: true }, { off: 4096 + tail.length, len: next.length, t: 2, gap: false }], fin: false, rst: false, gaps: 0 }, { proto: 'tcp', lport: 50006, rport: 80 });
  assert.equal(cut.protocol, 'http');
  assert.equal(cut.skipped, tail.length);
  assert.equal(cut.sections[0].msg.target, '/sonraki');
  assert.equal(cut.sections[0].t, 2);

  const empty = await S.analyze(sideOf(new Uint8Array(0), { segs: [] }), { proto: 'tcp' });
  assert.deepEqual(empty.sections, []);
});
