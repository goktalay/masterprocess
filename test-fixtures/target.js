'use strict';
// Uçtan uca sınama hedefi: bilinen bir dosyayı açık tutar, bellekte bilinen bir dizge barındırır, düzenli olarak biraz
// işlemci ve dosya G/Ç'si üretir ve (istenirse) bir alt süreç başlatır. Yalnız scripts/ altındaki sınama betikleri çalıştırır.
// Alt süreç 127.0.0.1 üzerinde küçük bir HTTP sunucusu açar; üst süreç ona birkaç saniyede bir JSON gönderir, bir PNG indirir,
// aynı PNG'yi yükler ve bir HTML sayfası ister. Trafik gerçektir ve bu makineden dışarı çıkmaz (Ağ sekmesinin sınaması için).
// Kullanım: node target.js <dosya> [--child]
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const file = process.argv[2];
const MARK = 'MASTER PROCESS E2E TARGET';
if (file && !process.argv.includes('--leaf')) {
  const line = Buffer.from(`${MARK} — bu dosya uçtan uca sınama için yazıldı.\n`);
  const fd0 = fs.openSync(file, 'w');
  for (let i = 0; i < 40000; i++) fs.writeSync(fd0, line);
  fs.fsyncSync(fd0); // diskteki yerleşimi hemen oluşsun
  fs.closeSync(fd0);
}
const fd = file ? fs.openSync(file, 'r') : null;
const keep = Buffer.alloc(8 * 1024 * 1024, MARK + ' ');
const buf = Buffer.alloc(256 * 1024);
let child = null;
if (process.argv.includes('--child')) {
  child = spawn(process.execPath, [__filename, file, '--leaf'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', (m) => { if (m && m.port) talk(m.port); });
}

const PNG = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'));
// Sayfadaki betik ve olay özniteliği bilerek var: uygulama yakalanan sayfayı yalnız kaynak olarak göstermeli, çalıştırmamalı
const PAGE = `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>${MARK}</title></head>
<body>
  <h1 class="baslik">Uçtan uca sınama sayfası</h1>
  <p>Bu sayfa <a href="/gorsel/simge.png">simge</a> ile birlikte sunulur.</p>
  <img src="/yok.png" alt="" onerror="window.__mpTargetRan = 'onerror'">
  <script>window.__mpTargetRan = 'script';</script>
</body>
</html>
`;

// Sunucu (alt süreç): yalnız geri döngü adresini dinler
function serve() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = (status, o) => {
        // Yanıt gzip ile sıkıştırılır: görüntüleyici sıkıştırmayı çözüp JSON'u göstermeli
        const z = zlib.gzipSync(Buffer.from(JSON.stringify(o)));
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': z.length });
        res.end(z);
      };
      if (req.method === 'POST' && req.url === '/api/olcumler') {
        let n = -1;
        try { n = JSON.parse(body.toString('utf8')).sira; } catch { /* bozuk gövde */ }
        return json(200, { durum: 'tamam', sira: n, alinan: body.length, sunucu: { pid: process.pid, surum: process.version }, uyarilar: [] });
      }
      if (req.method === 'GET' && req.url === '/gorsel/simge.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
        return res.end(PNG);
      }
      if (req.method === 'PUT' && req.url === '/yukle/simge.png') return json(201, { durum: 'alindi', tur: req.headers['content-type'] || '', boyut: body.length, ayni: body.equals(PNG) });
      if (req.method === 'GET' && req.url === '/sayfa.html') {
        const b = Buffer.from(PAGE);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length });
        return res.end(b);
      }
      return json(404, { durum: 'yok', yol: req.url });
    });
  });
  server.listen(0, '127.0.0.1', () => { if (process.send) process.send({ port: server.address().port }); });
}

// İstemci (üst süreç): her turda yeni bir bağlantı açar, dört isteği aynı bağlantıdan sırayla gönderir. Bağlantı bir
// sonraki tura kadar açık kalır; böylece bağlantı listesinde her an kurulu bir bağlantı görünür.
function talk(port) {
  let agent = null;
  let round = 0;
  let busy = false;
  const ask = (method, url, type, body) => new Promise((resolve) => {
    const headers = { Accept: '*/*', 'Accept-Encoding': 'gzip' };
    if (body) { headers['Content-Type'] = type; headers['Content-Length'] = body.length; }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, agent, headers }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', resolve);
    req.end(body || undefined);
  });
  const run = async () => {
    if (busy) return;
    busy = true;
    if (agent) agent.destroy();
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    round++;
    const m = process.memoryUsage();
    const report = { kaynak: MARK, sira: round, zaman: new Date().toISOString(), pid: process.pid,
      olcumler: { bellekMB: Math.round(m.rss / 104857.6) / 10, yiginMB: Math.round(m.heapUsed / 104857.6) / 10, calismaSn: Math.round(process.uptime()), etkin: true, hata: null },
      etiketler: ['e2e', 'ağ', 'geri döngü'] };
    await ask('POST', '/api/olcumler', 'application/json; charset=utf-8', Buffer.from(JSON.stringify(report)));
    await ask('GET', '/gorsel/simge.png');
    await ask('PUT', '/yukle/simge.png', 'image/png', PNG);
    await ask('GET', '/sayfa.html');
    busy = false;
  };
  run();
  setInterval(run, 5000);
}
let pos = 0;
setInterval(() => {
  // ~%10–15 tek çekirdek + sıralı okuma
  const until = Date.now() + 12;
  let x = 0;
  while (Date.now() < until) x += Math.sqrt(x + keep[x & 1023]);
  if (fd !== null) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    pos = n < buf.length ? 0 : pos + n;
  }
}, 100);
// Alt süreç, üst süreç zorla sonlandırılırsa yetim kalmaz
if (process.argv.includes('--leaf')) {
  serve();
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
    try { process.kill(parent, 0); } catch { process.exit(0); }
  }, 1000);
}
process.on('SIGTERM', () => { if (child) child.kill(); process.exit(0); });
process.stdout.write(`ready ${process.pid}\n`);
